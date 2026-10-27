"""The changes LagBuster can make. Nothing runs unless the user picked it.

Every reversible change (power plan, power mode, priorities, Windows settings)
is written to an undo journal on disk, so "Undo all changes" still works after
LagBuster is closed and opened again.
"""

from __future__ import annotations

import collections
import json
import logging
import os
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import psutil

from . import winapi
from .platform_utils import IS_WINDOWS, fmt_bytes, run_command
from .probe import parse_powercfg_list

log = logging.getLogger("lagbuster.actions")

PRIORITY_LABELS = {
    "high": "High",
    "above_normal": "Above normal",
    "normal": "Normal",
    "below_normal": "Below normal",
    "idle": "Low",
}
_WINDOWS_PRIORITY_NAMES = {64: "Low", 16384: "Below normal", 32: "Normal", 32768: "Above normal", 128: "High", 256: "Realtime"}
WINDOWS_RAISED = (128, 256, 32768)  # High, Realtime, Above normal


def priority_value(level: str) -> int:
    if IS_WINDOWS:
        return int(
            {
                "high": psutil.HIGH_PRIORITY_CLASS,
                "above_normal": psutil.ABOVE_NORMAL_PRIORITY_CLASS,
                "normal": psutil.NORMAL_PRIORITY_CLASS,
                "below_normal": psutil.BELOW_NORMAL_PRIORITY_CLASS,
                "idle": psutil.IDLE_PRIORITY_CLASS,
            }[level]
        )
    return {"high": -10, "above_normal": -5, "normal": 0, "below_normal": 10, "idle": 19}[level]


def priority_name(value: int | None, windows: bool = IS_WINDOWS) -> str:
    if value is None:
        return ""
    if windows:
        return _WINDOWS_PRIORITY_NAMES.get(int(value), str(value))
    if value < 0:
        return f"Higher ({value})"
    if value == 0:
        return "Normal"
    return f"Lower (+{value})"


@dataclass(frozen=True)
class ProcTarget:
    pid: int
    create_time: float


@dataclass
class ActionResult:
    ok: bool
    message: str


def live_process(target: ProcTarget) -> psutil.Process | None:
    """The process, unless it exited (or its PID now belongs to something else)."""
    try:
        proc = psutil.Process(target.pid)
        if abs(proc.create_time() - target.create_time) > 1.0:
            return None
        return proc
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


# --------------------------------------------------------------------------
# Undo journal
# --------------------------------------------------------------------------

_IDENTITY = {
    "priority": ("type", "pid", "create_time"),
    "registry": ("type", "root", "path", "name"),
}


class UndoJournal:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._lock = threading.Lock()
        self.entries: list[dict] = self._load()

    def _load(self) -> list[dict]:
        if self.path is None:
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, ValueError) as exc:
            log.warning("ignoring unreadable undo journal: %s", exc)
            return []
        if not isinstance(data, list):
            return []
        return [entry for entry in data if isinstance(entry, dict) and isinstance(entry.get("type"), str)]

    def _save(self) -> None:
        if self.path is None:
            return
        temp = self.path.with_suffix(".tmp")
        try:
            temp.write_text(json.dumps(self.entries, indent=2), encoding="utf-8")
            os.replace(temp, self.path)
        except OSError as exc:
            log.warning("could not save undo journal: %s", exc)

    @staticmethod
    def _identity(entry: dict) -> tuple:
        return tuple(entry.get(key) for key in _IDENTITY.get(entry["type"], ("type",)))

    def record(self, entry: dict) -> None:
        entry = dict(entry)
        entry.setdefault("when", time.time())
        with self._lock:
            identity = self._identity(entry)
            if any(self._identity(existing) == identity for existing in self.entries):
                return  # keep the oldest value: that's how the PC was before LagBuster
            self.entries.append(entry)
            self._save()

    def __len__(self) -> int:
        return len(self.entries)

    def prune(self) -> None:
        """Forget priority changes of apps that have closed since."""
        with self._lock:
            kept = [
                entry
                for entry in self.entries
                if entry["type"] != "priority"
                or live_process(ProcTarget(int(entry.get("pid", 0)), float(entry.get("create_time", 0)))) is not None
            ]
            if len(kept) != len(self.entries):
                self.entries = kept
                self._save()

    def descriptions(self) -> list[str]:
        counts = collections.Counter(entry.get("label") or entry["type"] for entry in self.entries)
        return [label if count == 1 else f"{label} ({count} processes)" for label, count in counts.items()]

    def undo_all(self) -> list[ActionResult]:
        with self._lock:
            entries = list(reversed(self.entries))
        results: list[ActionResult] = []
        keep: list[dict] = []
        restored_priorities: collections.Counter[str] = collections.Counter()
        for entry in entries:
            try:
                result = _revert(entry)
            except Exception as exc:  # noqa: BLE001 - report and carry on
                log.exception("undo failed for %s", entry)
                result = ActionResult(False, f"Couldn't undo “{entry.get('label', entry['type'])}”: {exc}")
            if entry["type"] == "priority":
                if result.ok and result.message:
                    restored_priorities[entry.get("app", "an app")] += 1
                elif not result.ok:
                    results.append(result)  # e.g. Linux needs root to raise priority again
                continue
            if not result.ok:
                keep.append(entry)
            if result.message:
                results.append(result)
        for app, _count in restored_priorities.items():
            results.append(ActionResult(True, f"{app} is back to its normal priority."))
        with self._lock:
            self.entries = [entry for entry in self.entries if entry in keep or entry not in entries]
            self._save()
        return results


def _set_power_scheme(guid: str) -> bool:
    code, _ = run_command(["powercfg", "/setactive", guid])
    return code == 0


def _powerprofilesctl() -> str | None:
    return shutil.which("powerprofilesctl")


def _revert(entry: dict) -> ActionResult:
    kind = entry["type"]
    if kind == "priority":
        proc = live_process(ProcTarget(int(entry["pid"]), float(entry["create_time"])))
        if proc is None:
            return ActionResult(True, "")  # the app was closed; nothing left to undo
        try:
            proc.nice(int(entry["old"]))
        except psutil.AccessDenied:
            return ActionResult(
                False,
                f"Couldn't restore {entry.get('app', 'an app')}'s priority without admin rights - "
                "it goes back to normal when the app restarts.",
            )
        except psutil.NoSuchProcess:
            return ActionResult(True, "")
        return ActionResult(True, "restored")
    if kind == "power_scheme":
        name = entry.get("old_name") or "your previous plan"
        if _set_power_scheme(entry["old"]):
            return ActionResult(True, f"Power plan is back to “{name}”.")
        return ActionResult(False, f"Couldn't switch the power plan back to “{name}”.")
    if kind == "power_overlay":
        name = winapi.OVERLAY_NAMES.get(entry["old"], "your previous setting")
        if winapi.set_power_overlay(entry["old"]):
            return ActionResult(True, f"Power mode is back to “{name}”.")
        return ActionResult(False, f"Couldn't set the power mode back to “{name}”.")
    if kind == "linux_profile":
        exe = _powerprofilesctl()
        if exe and run_command([exe, "set", entry["old"]])[0] == 0:
            return ActionResult(True, f"Power profile is back to “{entry['old']}”.")
        return ActionResult(False, f"Couldn't set the power profile back to “{entry['old']}”.")
    if kind == "registry":
        if entry.get("existed"):
            winapi.reg_write(entry["root"], entry["path"], entry["name"], entry["old"], entry.get("old_type"))
        else:
            winapi.reg_delete(entry["root"], entry["path"], entry["name"])
        return ActionResult(True, f"Undone: {entry.get('label', 'Windows setting')}.")
    return ActionResult(True, "")


# --------------------------------------------------------------------------
# Actions
# --------------------------------------------------------------------------


@dataclass
class ActionContext:
    journal: UndoJournal
    dry_run: bool = False
    progress: Callable[[str], None] | None = None


class Action:
    order = 50

    def describe(self) -> str:
        raise NotImplementedError

    def run(self, ctx: ActionContext) -> ActionResult:
        raise NotImplementedError


def run_actions(actions: list[Action], ctx: ActionContext) -> list[ActionResult]:
    results = []
    for action in sorted(actions, key=lambda a: a.order):
        if ctx.progress:
            ctx.progress(action.describe())
        if ctx.dry_run:
            results.append(ActionResult(True, f"Demo mode, nothing changed: {action.describe()}"))
            continue
        try:
            results.append(action.run(ctx))
        except Exception as exc:  # noqa: BLE001 - one failed fix must not stop the others
            log.exception("action failed: %s", action.describe())
            results.append(ActionResult(False, f"{action.describe()} failed: {exc}"))
    return results


@dataclass
class SetPowerScheme(Action):
    target: str
    target_name: str
    order = 10

    def describe(self) -> str:
        return f"Switch the power plan to “{self.target_name}”"

    def run(self, ctx: ActionContext) -> ActionResult:
        code, output = run_command(["powercfg", "/getactivescheme"])
        found, _ = parse_powercfg_list(output) if code == 0 else ({}, None)
        current = next(iter(found), None)
        if current == self.target:
            return ActionResult(True, f"The power plan is already “{self.target_name}”.")
        if not _set_power_scheme(self.target):
            return ActionResult(False, "Windows didn't allow switching the power plan.")
        if current:
            old_name = found.get(current) or "previous plan"
            ctx.journal.record(
                {
                    "type": "power_scheme",
                    "old": current,
                    "old_name": old_name,
                    "label": f"Power plan: {old_name} → {self.target_name}",
                }
            )
        return ActionResult(True, f"Power plan switched to “{self.target_name}”.")


@dataclass
class SetPowerMode(Action):
    target: str
    order = 11

    def describe(self) -> str:
        return f"Set the Windows power mode to “{winapi.OVERLAY_NAMES.get(self.target, 'Best performance')}”"

    def run(self, ctx: ActionContext) -> ActionResult:
        name = winapi.OVERLAY_NAMES.get(self.target, "Best performance")
        current = winapi.get_power_overlay()
        if current == self.target:
            return ActionResult(True, f"The power mode is already “{name}”.")
        if not winapi.set_power_overlay(self.target):
            return ActionResult(False, "Windows didn't accept the power mode change.")
        if current is not None:
            old_name = winapi.OVERLAY_NAMES.get(current, "previous mode")
            ctx.journal.record({"type": "power_overlay", "old": current, "label": f"Power mode: {old_name} → {name}"})
        return ActionResult(True, f"Power mode set to “{name}”.")


@dataclass
class SetLinuxPowerProfile(Action):
    target: str
    order = 10

    def describe(self) -> str:
        return f"Switch the power profile to “{self.target}”"

    def run(self, ctx: ActionContext) -> ActionResult:
        exe = _powerprofilesctl()
        if not exe:
            return ActionResult(False, "powerprofilesctl is not installed.")
        code, output = run_command([exe, "get"])
        current = output.strip() if code == 0 else ""
        if current == self.target:
            return ActionResult(True, f"The power profile is already “{self.target}”.")
        code, output = run_command([exe, "set", self.target])
        if code != 0:
            return ActionResult(False, f"Couldn't switch the power profile: {output.strip() or code}")
        if current:
            ctx.journal.record(
                {"type": "linux_profile", "old": current, "label": f"Power profile: {current} → {self.target}"}
            )
        return ActionResult(True, f"Power profile switched to “{self.target}”.")


@dataclass
class SetRegistryValues(Action):
    title: str
    values: list[tuple[str, str, str, int]]  # (root, key path, value name, DWORD)
    order = 20

    def describe(self) -> str:
        return self.title

    def run(self, ctx: ActionContext) -> ActionResult:
        import winreg

        changed = 0
        for root, path, name, value in self.values:
            old = winapi.reg_read(root, path, name)
            if old is not None and old[1] != winreg.REG_DWORD:
                return ActionResult(False, f"{self.title}: unexpected existing setting, left unchanged.")
            if old is not None and int(old[0]) == value:  # type: ignore[call-overload]
                continue
            winapi.reg_write(root, path, name, value)
            ctx.journal.record(
                {
                    "type": "registry",
                    "root": root,
                    "path": path,
                    "name": name,
                    "existed": old is not None,
                    "old": old[0] if old is not None else None,
                    "old_type": old[1] if old is not None else None,
                    "label": self.title,
                }
            )
            changed += 1
        return ActionResult(True, f"{self.title}: done." if changed else f"{self.title}: already set.")


def _total_rss(procs: list[psutil.Process]) -> int:
    total = 0
    for proc in procs:
        try:
            total += proc.memory_info().rss
        except psutil.Error:
            pass
    return total


@dataclass
class CloseApp(Action):
    app_name: str
    targets: list[ProcTarget]
    force_ok: bool
    grace_seconds: float = 6.0
    order = 30

    def describe(self) -> str:
        return f"Close {self.app_name}"

    def run(self, ctx: ActionContext) -> ActionResult:
        procs = [proc for proc in (live_process(t) for t in self.targets) if proc is not None]
        if not procs:
            return ActionResult(True, f"{self.app_name} was already closed.")
        before = _total_rss(procs)
        asked = 0
        if IS_WINDOWS:
            try:
                asked = winapi.close_windows([proc.pid for proc in procs])
            except OSError as exc:
                log.info("could not ask %s to close: %s", self.app_name, exc)
        else:
            for proc in procs:
                try:
                    proc.terminate()  # SIGTERM: the app can save and exit cleanly
                    asked += 1
                except psutil.Error:
                    pass
        alive = procs
        if asked:
            _gone, alive = psutil.wait_procs(procs, timeout=self.grace_seconds)
        if alive and self.force_ok:
            for proc in alive:
                try:
                    proc.kill()
                except psutil.Error:
                    pass
            _gone, alive = psutil.wait_procs(alive, timeout=3)
        if not alive:
            return ActionResult(True, f"Closed {self.app_name} - about {fmt_bytes(before)} of RAM freed.")
        if len(alive) < len(procs):
            return ActionResult(
                True, f"Closed most of {self.app_name}; {len(alive)} background part(s) are still running."
            )
        if not asked:
            return ActionResult(
                False,
                f"{self.app_name} is running in the background (near the clock). "
                "Right-click its icon there and choose Quit or Exit.",
            )
        return ActionResult(
            False, f"{self.app_name} didn't close - it may be asking you to save something. Check its window."
        )


@dataclass
class SetPriority(Action):
    app_name: str
    targets: list[ProcTarget]
    level: str
    order = 40

    def describe(self) -> str:
        return f"Set {self.app_name} to {PRIORITY_LABELS[self.level].lower()} priority"

    def run(self, ctx: ActionContext) -> ActionResult:
        value = priority_value(self.level)
        label = PRIORITY_LABELS[self.level].lower()
        changed = denied = alive = 0
        for target in self.targets:
            proc = live_process(target)
            if proc is None:
                continue
            alive += 1
            try:
                old = int(proc.nice())
                if old == value:
                    continue
                proc.nice(value)
            except psutil.AccessDenied:
                denied += 1
                continue
            except psutil.NoSuchProcess:
                continue
            ctx.journal.record(
                {
                    "type": "priority",
                    "pid": target.pid,
                    "create_time": target.create_time,
                    "old": old,
                    "app": self.app_name,
                    "label": f"{self.app_name}: {label} priority",
                }
            )
            changed += 1
        if changed:
            return ActionResult(True, f"{self.app_name} now runs at {label} priority.")
        if denied:
            if self.level in ("high", "above_normal"):
                return ActionResult(
                    False,
                    f"{self.app_name} didn't allow a priority change. Games with anti-cheat often "
                    "block this - that's normal and harmless.",
                )
            return ActionResult(False, f"{self.app_name} didn't allow a priority change (it may need admin rights).")
        if not alive:
            return ActionResult(True, f"{self.app_name} isn't running anymore.")
        return ActionResult(True, f"{self.app_name} already runs at {label} priority.")


@dataclass
class TrimMemory(Action):
    targets: list[ProcTarget]
    order = 60

    def describe(self) -> str:
        return "Free up RAM held by background apps"

    def run(self, ctx: ActionContext) -> ActionResult:
        if not IS_WINDOWS:
            return ActionResult(False, "Freeing RAM this way only works on Windows.")
        before = psutil.virtual_memory().available
        trimmed = 0
        for target in self.targets:
            if live_process(target) is None:
                continue
            try:
                if winapi.empty_working_set(target.pid):
                    trimmed += 1
            except OSError:
                pass
        time.sleep(0.8)
        freed = max(0, psutil.virtual_memory().available - before)
        message = f"Asked {trimmed} background processes to hand back memory they weren't using."
        # Windows may first write some of it to disk, so the gain can show up a bit later.
        if freed >= 50 * 1024 * 1024:
            message += f" About {fmt_bytes(freed)} of RAM is free again."
        return ActionResult(True, message)
