"""Reads the system settings that matter for gaming (power plan, Game Bar, ...).

Everything here only *reads*; changes happen in ``actions.py``.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import socket
import time
from dataclasses import dataclass, field
from pathlib import Path

import psutil

from . import winapi
from .platform_utils import IS_LINUX, IS_WINDOWS, is_admin, os_name, run_command

log = logging.getLogger("lagbuster.probe")

POWER_BALANCED = "381b4222-f694-41f0-9685-ff5bb260df2e"
POWER_HIGH = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"
POWER_ULTIMATE = "e9a42b02-d5df-448d-aa00-03f14749eb61"
POWER_SAVER = "a1841308-3541-4fab-bc81-f71556f20b4a"

GAMEDVR_KEY = r"Software\Microsoft\Windows\CurrentVersion\GameDVR"
GAMECONFIG_KEY = r"System\GameConfigStore"
GAMEBAR_KEY = r"Software\Microsoft\GameBar"


@dataclass
class PowerInfo:
    kind: str  # "windows" or "linux"
    active: str | None = None  # Windows plan GUID, or Linux power profile
    active_name: str | None = None
    schemes: dict[str, str] = field(default_factory=dict)  # GUID/profile -> name
    overlay: str | None = None  # Windows "power mode" (only used with the Balanced plan)

    def performance_plan(self) -> str | None:
        """The best "maximum performance" plan that exists on this PC."""
        if self.kind == "linux":
            return "performance" if "performance" in self.schemes else None
        for guid, name in self.schemes.items():
            if guid == POWER_ULTIMATE or "ultimate" in name.lower():
                return guid
        if POWER_HIGH in self.schemes:
            return POWER_HIGH
        for guid, name in self.schemes.items():
            if "high perf" in name.lower():
                return guid
        return None

    def is_performance(self) -> bool:
        if self.kind == "linux":
            return self.active == "performance"
        if self.active in (POWER_HIGH, POWER_ULTIMATE):
            return True
        name = (self.active_name or "").lower()
        return "high perf" in name or "ultimate" in name


@dataclass
class NetworkCheck:
    """TCP connection times to two big public servers (a stand-in for ping)."""

    samples: list[float] = field(default_factory=list)  # milliseconds, from reachable servers
    lost: int = 0  # failed attempts to servers that otherwise answered
    reachable: int = 0  # how many servers answered at all

    @property
    def average(self) -> float | None:
        return sum(self.samples) / len(self.samples) if self.samples else None

    @property
    def jitter(self) -> float | None:
        if len(self.samples) < 2:
            return None
        diffs = [abs(a - b) for a, b in zip(self.samples, self.samples[1:])]
        return sum(diffs) / len(diffs)

    @property
    def loss_percent(self) -> float:
        total = len(self.samples) + self.lost
        return 100.0 * self.lost / total if total else 0.0


@dataclass
class PlatformState:
    os: str
    is_admin: bool = False
    power: PowerInfo | None = None
    game_dvr_background: int | None = None  # "Record what happened" (1 = on)
    game_dvr_capture: int | None = None
    game_mode: int | None = None  # AutoGameModeEnabled (missing = on)
    startup_count: int | None = None
    system_drive: str | None = None
    disk_free: int | None = None
    disk_total: int | None = None
    network: NetworkCheck | None = None
    gamemode_installed: bool | None = None  # Feral GameMode on Linux


_GUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
_SCHEME_LINE = re.compile(rf"({_GUID})\s*(?:\((.*)\))?\s*(\*)?\s*$")


def parse_powercfg_list(text: str) -> tuple[dict[str, str], str | None]:
    """Parse ``powercfg /list`` (any language) into ({guid: name}, active guid)."""
    schemes: dict[str, str] = {}
    active = None
    for line in text.splitlines():
        match = _SCHEME_LINE.search(line.strip())
        if not match:
            continue
        guid = match.group(1).lower()
        schemes[guid] = (match.group(2) or "").strip()
        if match.group(3):
            active = guid
    return schemes, active


def windows_power_info() -> PowerInfo | None:
    code, output = run_command(["powercfg", "/list"])
    if code != 0:
        return None
    schemes, active = parse_powercfg_list(output)
    if active is None:
        code, output = run_command(["powercfg", "/getactivescheme"])
        if code == 0:
            found, _ = parse_powercfg_list(output)
            active = next(iter(found), None)
            schemes.update(found)
    overlay = None
    try:
        overlay = winapi.get_power_overlay()
    except OSError as exc:
        log.info("power mode not readable: %s", exc)
    return PowerInfo("windows", active, schemes.get(active or ""), schemes, overlay)


_PROFILE_LINE = re.compile(r"^\s*\*?\s*([a-z][a-z-]*):\s*$", re.MULTILINE)


def linux_power_info() -> PowerInfo | None:
    exe = shutil.which("powerprofilesctl")
    if not exe:
        return None
    code, output = run_command([exe, "get"])
    if code != 0 or not output.strip():
        return None
    active = output.strip().splitlines()[0].strip()
    code, listing = run_command([exe, "list"])
    profiles = _PROFILE_LINE.findall(listing) if code == 0 else []
    if not profiles:
        profiles = [active]
    return PowerInfo("linux", active, active, {p: p for p in profiles})


def network_check(
    servers: tuple[tuple[str, int], ...] = (("1.1.1.1", 443), ("8.8.8.8", 443)),
    attempts: int = 4,
    timeout: float = 1.0,
) -> NetworkCheck:
    result = NetworkCheck()
    for host, port in servers:
        times: list[float] = []
        failures = 0
        for _ in range(attempts):
            start = time.perf_counter()
            try:
                with socket.create_connection((host, port), timeout=timeout):
                    pass
                times.append((time.perf_counter() - start) * 1000.0)
            except OSError:
                failures += 1
                if not times and failures >= 2:
                    break  # blocked or unreachable - don't waste the user's time
            time.sleep(0.05)
        if times:
            result.reachable += 1
            result.samples.extend(times)
            result.lost += failures
    return result


def windows_startup_count() -> int | None:
    """How many apps start with Windows (enabled entries only)."""
    approved = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved"
    sources = [
        ("HKCU", r"Software\Microsoft\Windows\CurrentVersion\Run", approved + r"\Run"),
        ("HKLM", r"Software\Microsoft\Windows\CurrentVersion\Run", approved + r"\Run"),
        ("HKLM", r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run", approved + r"\Run32"),
    ]

    def disabled(root: str, path: str) -> set[str]:
        return {
            name.lower()
            for name, data in winapi.reg_values(root, path)
            if isinstance(data, bytes) and data and data[0] & 1
        }

    try:
        count = 0
        for root, run_key, approved_key in sources:
            off = disabled(root, approved_key)
            count += sum(1 for name, _ in winapi.reg_values(root, run_key) if name and name.lower() not in off)
        off = disabled("HKCU", approved + r"\StartupFolder") | disabled("HKLM", approved + r"\StartupFolder")
        folders = [
            Path(os.environ.get("APPDATA", "")) / r"Microsoft\Windows\Start Menu\Programs\Startup",
            Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / r"Microsoft\Windows\Start Menu\Programs\StartUp",
        ]
        for folder in folders:
            if folder.is_dir():
                count += sum(
                    1
                    for item in folder.iterdir()
                    if item.name.lower() != "desktop.ini" and item.name.lower() not in off
                )
        return count
    except OSError as exc:
        log.info("startup apps not readable: %s", exc)
        return None


def probe_platform(network_test: bool = True) -> PlatformState:
    state = PlatformState(os=os_name(), is_admin=is_admin())
    drive = (os.environ.get("SystemDrive", "C:") + "\\") if IS_WINDOWS else "/"
    try:
        usage = psutil.disk_usage(drive)
        state.system_drive, state.disk_free, state.disk_total = drive, int(usage.free), int(usage.total)
    except OSError:
        state.system_drive = drive
    if IS_WINDOWS:
        state.power = windows_power_info()
        try:
            state.game_dvr_background = winapi.reg_read_dword("HKCU", GAMEDVR_KEY, "HistoricalCaptureEnabled")
            state.game_dvr_capture = winapi.reg_read_dword("HKCU", GAMEDVR_KEY, "AppCaptureEnabled")
            state.game_mode = winapi.reg_read_dword("HKCU", GAMEBAR_KEY, "AutoGameModeEnabled")
        except OSError as exc:
            log.info("registry not readable: %s", exc)
        state.startup_count = windows_startup_count()
    elif IS_LINUX:
        state.power = linux_power_info()
        state.gamemode_installed = bool(shutil.which("gamemoderun"))
    if network_test:
        state.network = network_check()
    return state
