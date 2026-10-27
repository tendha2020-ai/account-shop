"""Background sampler for CPU, RAM, GPU, disk, network and per-app usage."""

from __future__ import annotations

import collections
import logging
import os
import threading
import time
from dataclasses import dataclass

import psutil

from .gpu import EngineUsage, GpuMonitor, GpuStat, primary_gpu
from .platform_utils import IS_LINUX, IS_WINDOWS, current_user_key

log = logging.getLogger("lagbuster.monitor")


@dataclass
class ProcStat:
    pid: int
    name: str
    exe: str
    ppid: int
    create_time: float
    cpu: float  # % of the whole CPU (all cores), smoothed
    rss: int  # bytes of RAM in use (working set)
    gpu: float = 0.0  # % of the busiest GPU engine (Windows only)
    nice: int | None = None
    mine: bool = False  # owned by the logged-in user


@dataclass
class Snapshot:
    ts: float
    cpu: float
    per_cpu: list[float]
    cpu_threads: int
    cpu_cores: int | None
    cpu_temp: float | None
    ram_total: int
    ram_used: int
    ram_available: int
    ram_percent: float
    swap_total: int
    swap_used: int
    gpus: list[GpuStat]
    gpu_usage: EngineUsage
    net_recv: float  # bytes per second
    net_sent: float
    disk_read: float
    disk_write: float
    battery_percent: float | None
    on_battery: bool | None
    self_cpu: float
    self_rss: int
    processes: list[ProcStat] | None = None
    processes_ts: float | None = None

    @property
    def gpu(self) -> GpuStat | None:
        return primary_gpu(self.gpus)


@dataclass
class HistoryPoint:
    ts: float
    cpu: float
    ram: float
    gpu: float | None
    vram: float | None
    gpu_temp: float | None
    net_recv: float
    net_sent: float


@dataclass
class Averages:
    seconds: float
    cpu: float
    ram: float
    gpu: float | None
    vram_peak: float | None
    gpu_temp_peak: float | None
    net_recv: float
    net_sent: float
    samples: int = 0


def compute_averages(points: list[HistoryPoint]) -> Averages:
    if not points:
        return Averages(0.0, 0.0, 0.0, None, None, None, 0.0, 0.0, 0)

    def mean(values):
        values = [v for v in values if v is not None]
        return sum(values) / len(values) if values else None

    def peak(values):
        values = [v for v in values if v is not None]
        return max(values) if values else None

    return Averages(
        seconds=max(0.0, points[-1].ts - points[0].ts),
        cpu=mean(p.cpu for p in points) or 0.0,
        ram=mean(p.ram for p in points) or 0.0,
        gpu=mean(p.gpu for p in points),
        vram_peak=peak(p.vram for p in points),
        gpu_temp_peak=peak(p.gpu_temp for p in points),
        net_recv=mean(p.net_recv for p in points) or 0.0,
        net_sent=mean(p.net_sent for p in points) or 0.0,
        samples=len(points),
    )


_PROC_ATTRS = ["pid", "name", "exe", "ppid", "create_time", "memory_info", "cpu_percent", "nice"]


def _as_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class SystemMonitor:
    """Samples the system on a background thread; the UI only reads results."""

    def __init__(self, interval: float = 1.0, gpu_factory=GpuMonitor) -> None:
        self.interval = interval
        self.gpu: GpuMonitor | None = None
        self._gpu_factory = gpu_factory
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._history: collections.deque[HistoryPoint] = collections.deque(maxlen=900)
        self._latest: Snapshot | None = None
        self._process_sampling = True
        self._process_every = 2.0
        self._last_process_sample = 0.0
        self._process_samples = 0
        self._process_event = threading.Condition()
        self._cpu_ema: dict[tuple[int, float], float] = {}
        self._mine: dict[tuple[int, float], bool] = {}
        self._me = current_user_key()
        self._self = psutil.Process()
        self._threads = psutil.cpu_count(logical=True) or 1
        self._cores = psutil.cpu_count(logical=False)
        self._io_last = None
        self._battery: tuple[float | None, bool | None] = (None, None)
        self._battery_at = 0.0
        self._temp: float | None = None
        self._temp_at = 0.0
        self.ready = threading.Event()

    # -- control ---------------------------------------------------------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="lagbuster-monitor", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)

    def set_interval(self, seconds: float) -> None:
        self.interval = min(5.0, max(0.5, float(seconds)))

    def enable_process_sampling(self, enabled: bool) -> None:
        """Per-app numbers cost a little CPU, so they pause while the window is minimized."""
        self._process_sampling = enabled

    # -- data access -----------------------------------------------------
    @property
    def latest(self) -> Snapshot | None:
        return self._latest

    def history(self, seconds: float | None = None) -> list[HistoryPoint]:
        with self._lock:
            points = list(self._history)
        if seconds is not None and points:
            cutoff = points[-1].ts - seconds
            points = [p for p in points if p.ts >= cutoff]
        return points

    def averages(self, seconds: float = 15.0) -> Averages:
        return compute_averages(self.history(seconds))

    @property
    def process_samples(self) -> int:
        return self._process_samples

    def wait_for_processes(self, samples: int = 2, timeout: float = 8.0) -> bool:
        """Block until ``samples`` fresh per-app measurements exist (for scans)."""
        target = self._process_samples + samples
        self._process_sampling = True
        deadline = time.monotonic() + timeout
        with self._process_event:
            while self._process_samples < target:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._process_event.wait(remaining)
        return True

    # -- sampling --------------------------------------------------------
    def _run(self) -> None:
        try:
            self.gpu = self._gpu_factory()
        except Exception:  # noqa: BLE001 - GPU info is optional
            log.exception("GPU monitor failed to start")
            self.gpu = None
        psutil.cpu_percent(percpu=True)
        try:
            self._self.cpu_percent()
        except psutil.Error:
            pass
        self._stop.wait(0.5)
        next_time = time.monotonic()
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception:  # noqa: BLE001 - keep monitoring no matter what
                log.exception("sampling failed")
            self.ready.set()
            next_time += self.interval
            delay = next_time - time.monotonic()
            if delay < 0:
                next_time = time.monotonic()
                delay = 0.05
            self._stop.wait(delay)

    def _tick(self) -> None:
        now = time.time()
        per_cpu = psutil.cpu_percent(percpu=True)
        cpu = sum(per_cpu) / len(per_cpu) if per_cpu else 0.0
        memory = psutil.virtual_memory()
        try:
            swap = psutil.swap_memory()
            swap_total, swap_used = int(swap.total), int(swap.used)
        except (psutil.Error, OSError, RuntimeError):
            swap_total = swap_used = 0
        gpus: list[GpuStat] = []
        usage = EngineUsage()
        if self.gpu is not None:
            try:
                gpus, usage = self.gpu.sample()
            except Exception:  # noqa: BLE001
                log.exception("GPU sampling failed")
        net_recv, net_sent, disk_read, disk_write = self._io_rates()
        battery_percent, on_battery = self._battery_state()
        try:
            self_cpu = self._self.cpu_percent() / self._threads
            self_rss = int(self._self.memory_info().rss)
        except psutil.Error:
            self_cpu, self_rss = 0.0, 0

        previous = self._latest
        processes = previous.processes if previous else None
        processes_ts = previous.processes_ts if previous else None
        if self._process_sampling and time.monotonic() - self._last_process_sample >= self._process_every:
            processes = self._sample_processes(usage)
            processes_ts = now
            self._last_process_sample = time.monotonic()
            with self._process_event:
                self._process_samples += 1
                self._process_event.notify_all()

        total = int(memory.total)
        available = int(memory.available)
        snapshot = Snapshot(
            ts=now,
            cpu=cpu,
            per_cpu=list(per_cpu),
            cpu_threads=self._threads,
            cpu_cores=self._cores,
            cpu_temp=self._cpu_temperature(),
            ram_total=total,
            ram_used=total - available,
            ram_available=available,
            ram_percent=float(memory.percent),
            swap_total=swap_total,
            swap_used=swap_used,
            gpus=gpus,
            gpu_usage=usage,
            net_recv=net_recv,
            net_sent=net_sent,
            disk_read=disk_read,
            disk_write=disk_write,
            battery_percent=battery_percent,
            on_battery=on_battery,
            self_cpu=self_cpu,
            self_rss=self_rss,
            processes=processes,
            processes_ts=processes_ts,
        )
        main = snapshot.gpu
        point = HistoryPoint(
            ts=now,
            cpu=cpu,
            ram=snapshot.ram_percent,
            gpu=main.util if main else None,
            vram=main.mem_percent if main else None,
            gpu_temp=max((g.temp for g in gpus if g.temp is not None), default=None),
            net_recv=net_recv,
            net_sent=net_sent,
        )
        with self._lock:
            self._latest = snapshot
            self._history.append(point)

    def _sample_processes(self, usage: EngineUsage) -> list[ProcStat]:
        results: list[ProcStat] = []
        alive: set[tuple[int, float]] = set()
        for proc in psutil.process_iter(_PROC_ATTRS, ad_value=None):
            info = proc.info
            pid = info.get("pid")
            if not pid:
                continue  # pid 0 is the "System Idle Process"
            created = float(info.get("create_time") or 0.0)
            key = (pid, created)
            alive.add(key)
            raw_cpu = float(info.get("cpu_percent") or 0.0) / self._threads
            previous = self._cpu_ema.get(key)
            cpu = raw_cpu if previous is None else previous * 0.4 + raw_cpu * 0.6
            self._cpu_ema[key] = cpu
            memory = info.get("memory_info")
            results.append(
                ProcStat(
                    pid=pid,
                    name=info.get("name") or f"pid {pid}",
                    exe=info.get("exe") or "",
                    ppid=info.get("ppid") or 0,
                    create_time=created,
                    cpu=cpu,
                    rss=int(getattr(memory, "rss", 0) or 0),
                    gpu=usage.by_pid.get(pid, 0.0),
                    nice=_as_int(info.get("nice")),
                    mine=self._is_mine(proc, key),
                )
            )
        self._cpu_ema = {k: v for k, v in self._cpu_ema.items() if k in alive}
        self._mine = {k: v for k, v in self._mine.items() if k in alive}
        return results

    def _is_mine(self, proc: psutil.Process, key: tuple[int, float]) -> bool:
        cached = self._mine.get(key)
        if cached is not None:
            return cached
        mine = False
        try:
            if IS_WINDOWS:
                user = proc.username() or ""
                mine = bool(user) and user.split("\\")[-1].lower() == self._me
            else:
                mine = proc.uids().real == os.getuid()
        except (psutil.Error, OSError):
            mine = False
        self._mine[key] = mine
        return mine

    def _io_rates(self) -> tuple[float, float, float, float]:
        now = time.monotonic()
        try:
            net = psutil.net_io_counters()
        except (psutil.Error, OSError, RuntimeError):
            net = None
        try:
            disk = psutil.disk_io_counters()
        except (psutil.Error, OSError, RuntimeError):
            disk = None
        rates = (0.0, 0.0, 0.0, 0.0)
        if self._io_last is not None:
            then, last_net, last_disk = self._io_last
            elapsed = max(1e-3, now - then)
            recv = sent = read = write = 0.0
            if net and last_net:
                recv = max(0, net.bytes_recv - last_net.bytes_recv) / elapsed
                sent = max(0, net.bytes_sent - last_net.bytes_sent) / elapsed
            if disk and last_disk:
                read = max(0, disk.read_bytes - last_disk.read_bytes) / elapsed
                write = max(0, disk.write_bytes - last_disk.write_bytes) / elapsed
            rates = (recv, sent, read, write)
        self._io_last = (now, net, disk)
        return rates

    def _battery_state(self) -> tuple[float | None, bool | None]:
        if time.monotonic() - self._battery_at < 15 and self._battery_at:
            return self._battery
        self._battery_at = time.monotonic()
        try:
            battery = psutil.sensors_battery()
        except (psutil.Error, OSError, RuntimeError, AttributeError):
            battery = None
        if battery is None:
            self._battery = (None, None)
        else:
            plugged = battery.power_plugged
            self._battery = (float(battery.percent), None if plugged is None else not plugged)
        return self._battery

    def _cpu_temperature(self) -> float | None:
        if not IS_LINUX or not hasattr(psutil, "sensors_temperatures"):
            return None
        if time.monotonic() - self._temp_at < 5 and self._temp_at:
            return self._temp
        self._temp_at = time.monotonic()
        self._temp = None
        try:
            sensors = psutil.sensors_temperatures()
        except (OSError, RuntimeError):
            return None
        for chip in ("coretemp", "k10temp", "zenpower", "cpu_thermal", "acpitz"):
            entries = sensors.get(chip)
            if not entries:
                continue
            for entry in entries:
                if entry.label in ("Package id 0", "Tctl", "Tdie"):
                    self._temp = float(entry.current)
                    return self._temp
            self._temp = float(max(entry.current for entry in entries))
            return self._temp
        return None
