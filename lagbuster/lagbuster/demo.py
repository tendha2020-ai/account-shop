"""Made-up measurements of a busy Windows gaming PC.

Used by ``--demo`` (try the app without changing anything) and by the tests.
"""

from __future__ import annotations

import math
import threading
import time

from .gpu import EngineUsage, GpuStat
from .monitor import Averages, HistoryPoint, ProcStat, Snapshot, compute_averages
from .probe import POWER_BALANCED, POWER_HIGH, POWER_SAVER, NetworkCheck, PlatformState, PowerInfo
from .winapi import OVERLAY_BALANCED

GB = 1024**3
MB = 1024**2

DGPU_LUID = "0x00000000_0x0000d1a6"
IGPU_LUID = "0x00000000_0x0000c3f2"
GAME_PID = 9120

_EPIC = "C:\\Program Files\\Epic Games"
_GAME_EXE = _EPIC + "\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe"

# (name, exe, pid, ppid, cpu %, RAM MB, GPU %, owned by user)
_PROCESSES = [
    ("FortniteClient-Win64-Shipping.exe", _GAME_EXE, GAME_PID, 9004, 31.0, 5300, 88.0, True),
    ("EasyAntiCheat_EOS.exe", "C:\\Program Files (x86)\\EasyAntiCheat_EOS\\EasyAntiCheat_EOS.exe", 3120, 900, 0.4, 40, 0, False),
    ("FortniteLauncher.exe", _EPIC + "\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteLauncher.exe", 9004, 8800, 0.0, 12, 0, True),
    ("EpicGamesLauncher.exe", _EPIC + "\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe", 8800, 5000, 1.2, 410, 0.5, True),
    ("chrome.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", 7100, 5000, 2.5, 420, 3.5, True),
    *[
        ("chrome.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", 7101 + i, 7100, 0.4, 170, 0.2, True)
        for i in range(13)
    ],
    ("Discord.exe", "C:\\Users\\Alex\\AppData\\Local\\Discord\\app-1.0.9200\\Discord.exe", 6200, 5000, 1.1, 260, 1.5, True),
    *[
        ("Discord.exe", "C:\\Users\\Alex\\AppData\\Local\\Discord\\app-1.0.9200\\Discord.exe", 6201 + i, 6200, 0.3, 120, 0, True)
        for i in range(4)
    ],
    ("Spotify.exe", "C:\\Users\\Alex\\AppData\\Roaming\\Spotify\\Spotify.exe", 6600, 5000, 0.9, 210, 0.3, True),
    ("Spotify.exe", "C:\\Users\\Alex\\AppData\\Roaming\\Spotify\\Spotify.exe", 6601, 6600, 0.2, 140, 0, True),
    ("OneDrive.exe", "C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe", 6900, 5000, 4.6, 165, 0, True),
    ("wallpaper64.exe", "C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe", 7500, 5000, 1.4, 330, 4.0, True),
    ("iCUE.exe", "C:\\Program Files\\Corsair\\CORSAIR iCUE 5 Software\\iCUE.exe", 7700, 5000, 1.6, 290, 0.2, True),
    ("MsMpEng.exe", "C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\MsMpEng.exe", 4100, 900, 9.5, 260, 0, False),
    ("explorer.exe", "C:\\Windows\\explorer.exe", 5000, 4900, 0.6, 180, 0.4, True),
    ("dwm.exe", "C:\\Windows\\System32\\dwm.exe", 1300, 900, 2.2, 140, 6.0, False),
    ("svchost.exe", "C:\\Windows\\System32\\svchost.exe", 1500, 900, 0.8, 90, 0, False),
    ("LagBuster.exe", "C:\\Users\\Alex\\Downloads\\LagBuster.exe", 8100, 5000, 0.3, 48, 0, True),
]


def demo_processes(jitter: float = 0.0) -> list[ProcStat]:
    procs = []
    for index, (name, exe, pid, ppid, cpu, ram_mb, gpu, mine) in enumerate(_PROCESSES):
        wobble = 1.0 + jitter * math.sin(index * 1.7 + time.time() / 3)
        procs.append(
            ProcStat(
                pid=pid,
                name=name,
                exe=exe,
                ppid=ppid,
                create_time=1_700_000_000.0 + pid,
                cpu=max(0.0, cpu * wobble),
                rss=int(ram_mb * MB),
                gpu=max(0.0, gpu * wobble),
                nice=32,
                mine=mine,
            )
        )
    return procs


def demo_gpus(util: float = 96.0) -> list[GpuStat]:
    return [
        GpuStat(
            key=DGPU_LUID,
            name="NVIDIA GeForce RTX 3060",
            vendor="NVIDIA",
            util=util,
            mem_used=int(7.9 * GB),
            mem_total=12 * GB,
            temp=71.0,
            power_w=158.0,
        ),
        GpuStat(
            key=IGPU_LUID,
            name="Intel(R) UHD Graphics 770",
            vendor="Intel",
            util=3.0,
            mem_used=int(0.4 * GB),
            mem_total=int(8.1 * GB),
            integrated=True,
        ),
    ]


def demo_snapshot(t: float | None = None) -> Snapshot:
    t = time.time() if t is None else t
    cpu = 58 + 14 * math.sin(t / 4) + 5 * math.sin(t * 1.3)
    gpu_util = min(99.0, 93 + 5 * math.sin(t / 2.5))
    procs = demo_processes(jitter=0.15)
    usage = EngineUsage(
        by_adapter={DGPU_LUID: gpu_util, IGPU_LUID: 3.0},
        by_pid={p.pid: p.gpu for p in procs if p.gpu},
        by_pid_adapter={(p.pid, DGPU_LUID): p.gpu for p in procs if p.gpu},
    )
    total = 16 * GB
    used = int(13.2 * GB + 0.2 * GB * math.sin(t / 7))
    return Snapshot(
        ts=t,
        cpu=cpu,
        per_cpu=[max(0.0, min(100.0, cpu + 20 * math.sin(i + t))) for i in range(12)],
        cpu_threads=12,
        cpu_cores=6,
        cpu_temp=None,
        ram_total=total,
        ram_used=used,
        ram_available=total - used,
        ram_percent=100.0 * used / total,
        swap_total=4 * GB,
        swap_used=int(1.1 * GB),
        gpus=demo_gpus(gpu_util),
        gpu_usage=usage,
        net_recv=2.4 * MB + 0.6 * MB * math.sin(t),
        net_sent=90 * 1024,
        disk_read=3 * MB,
        disk_write=1 * MB,
        battery_percent=None,
        on_battery=None,
        self_cpu=0.3,
        self_rss=46 * MB,
        processes=procs,
        processes_ts=t,
    )


def demo_platform() -> PlatformState:
    return PlatformState(
        os="windows",
        is_admin=False,
        power=PowerInfo(
            kind="windows",
            active=POWER_BALANCED,
            active_name="Balanced",
            schemes={POWER_BALANCED: "Balanced", POWER_HIGH: "High performance", POWER_SAVER: "Power saver"},
            overlay=OVERLAY_BALANCED,
        ),
        game_dvr_background=1,
        game_dvr_capture=1,
        game_mode=1,
        startup_count=13,
        system_drive="C:\\",
        disk_free=int(64 * GB),
        disk_total=int(476 * GB),
        network=NetworkCheck(samples=[21.0, 23.5, 22.1, 58.0, 22.9, 21.7, 24.2, 23.0], lost=0, reachable=2),
    )


class DemoMonitor:
    """Same interface as ``SystemMonitor`` but with the fake data above."""

    class _Gpu:
        sources = ["demo data"]

    def __init__(self, interval: float = 1.0) -> None:
        self.interval = interval
        self.gpu = self._Gpu()
        self.ready = threading.Event()
        self.ready.set()
        self._start = time.time()

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass

    def set_interval(self, seconds: float) -> None:
        self.interval = seconds

    def enable_process_sampling(self, enabled: bool) -> None:
        pass

    @property
    def latest(self) -> Snapshot:
        return demo_snapshot()

    @property
    def process_samples(self) -> int:
        return 99

    def wait_for_processes(self, samples: int = 2, timeout: float = 8.0) -> bool:
        time.sleep(min(1.0, timeout))
        return True

    def history(self, seconds: float | None = None) -> list[HistoryPoint]:
        now = time.time()
        span = int(seconds or 120)
        points = []
        for back in range(span, 0, -1):
            snap_t = now - back
            cpu = 58 + 14 * math.sin(snap_t / 4) + 5 * math.sin(snap_t * 1.3)
            gpu = min(99.0, 93 + 5 * math.sin(snap_t / 2.5))
            points.append(
                HistoryPoint(
                    ts=snap_t,
                    cpu=cpu,
                    ram=82 + 1.2 * math.sin(snap_t / 7),
                    gpu=gpu,
                    vram=66.0,
                    gpu_temp=71.0,
                    net_recv=2.4 * MB + 0.6 * MB * math.sin(snap_t),
                    net_sent=90 * 1024,
                )
            )
        return points

    def averages(self, seconds: float = 15.0) -> Averages:
        return compute_averages(self.history(seconds))
