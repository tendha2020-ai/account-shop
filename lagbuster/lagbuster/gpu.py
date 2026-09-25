"""Graphics card monitoring.

Data sources, best first:

* Windows performance counters (any brand, same numbers as Task Manager, and
  per-app GPU usage) plus DXGI for names and video-memory sizes.
* NVIDIA NVML (``nvidia-ml-py``) for NVIDIA temperature, power and throttling.
* ``nvidia-smi`` when NVML's Python package isn't installed.
* Linux sysfs for AMD cards.
"""

from __future__ import annotations

import dataclasses
import logging
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import winapi
from .platform_utils import IS_LINUX, IS_WINDOWS, run_command

log = logging.getLogger("lagbuster.gpu")

GB = 1024**3

VENDORS = {
    0x10DE: "NVIDIA",
    0x1002: "AMD",
    0x1022: "AMD",
    0x8086: "Intel",
    0x1414: "Microsoft",
    0x5143: "Qualcomm",
}


def vendor_name(vendor_id: int | None) -> str:
    return VENDORS.get(vendor_id or 0, "Other")


@dataclass
class GpuStat:
    key: str
    name: str
    vendor: str = "Other"
    util: float | None = None
    mem_used: int | None = None
    mem_total: int | None = None
    temp: float | None = None
    power_w: float | None = None
    throttle: tuple[str, ...] = ()
    integrated: bool = False

    @property
    def mem_percent(self) -> float | None:
        if self.mem_used is None or not self.mem_total:
            return None
        return min(100.0, 100.0 * self.mem_used / self.mem_total)


@dataclass
class EngineUsage:
    """GPU usage from the Windows "GPU Engine" counters, Task Manager style."""

    by_adapter: dict[str, float] = field(default_factory=dict)
    by_pid: dict[int, float] = field(default_factory=dict)
    by_pid_adapter: dict[tuple[int, str], float] = field(default_factory=dict)


_ENGINE_RE = re.compile(
    r"^pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)_engtype_(.*)$", re.IGNORECASE
)
_ADAPTER_RE = re.compile(r"^luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)", re.IGNORECASE)


def parse_engine_instance(name: str) -> tuple[int, str, int, int, str] | None:
    """``pid_1234_luid_0x0_0xD1A6_phys_0_eng_0_engtype_3D`` -> (1234, luid, 0, 0, "3D")."""
    match = _ENGINE_RE.match(name.strip())
    if not match:
        return None
    return (
        int(match.group(1)),
        match.group(2).lower(),
        int(match.group(3)),
        int(match.group(4)),
        match.group(5),
    )


def parse_adapter_instance(name: str) -> str | None:
    match = _ADAPTER_RE.match(name.strip())
    return match.group(1).lower() if match else None


def aggregate_engine_usage(values: dict[str, float]) -> EngineUsage:
    """Turn raw per-process, per-engine counters into usage per GPU and per app.

    Like Task Manager: a GPU's usage is its busiest engine (3D, copy, video...),
    where each engine's load is the sum over all processes; an app's usage is
    its own busiest engine.
    """
    engine_totals: dict[tuple[str, int, int], float] = {}
    pid_engine: dict[tuple[int, str, int, int], float] = {}
    for instance, value in values.items():
        parsed = parse_engine_instance(instance)
        if parsed is None or value <= 0:
            continue
        pid, luid, phys, engine, _engine_type = parsed
        engine_key = (luid, phys, engine)
        engine_totals[engine_key] = engine_totals.get(engine_key, 0.0) + value
        pid_key = (pid, luid, phys, engine)
        pid_engine[pid_key] = pid_engine.get(pid_key, 0.0) + value
    usage = EngineUsage()
    for (luid, _phys, _engine), total in engine_totals.items():
        usage.by_adapter[luid] = max(usage.by_adapter.get(luid, 0.0), min(100.0, total))
    for (pid, luid, _phys, _engine), value in pid_engine.items():
        value = min(100.0, value)
        usage.by_pid[pid] = max(usage.by_pid.get(pid, 0.0), value)
        usage.by_pid_adapter[(pid, luid)] = max(usage.by_pid_adapter.get((pid, luid), 0.0), value)
    return usage


def decode_nvidia_throttle(bits: int) -> tuple[str, ...]:
    reasons = []
    if bits & (0x20 | 0x40):  # software / hardware thermal slowdown
        reasons.append("thermal")
    if bits & (0x08 | 0x80):  # hardware slowdown / power brake
        reasons.append("hardware slowdown")
    return tuple(reasons)


def _number(text: str) -> float | None:
    try:
        return float(text.strip())
    except ValueError:
        return None


NVIDIA_SMI_FIELDS = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw"


def parse_nvidia_smi(text: str) -> list[GpuStat]:
    """Parse ``nvidia-smi --query-gpu=<NVIDIA_SMI_FIELDS> --format=csv,noheader,nounits``."""
    stats = []
    for line in text.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 7:
            continue
        index = parts[0]
        util, used, total, temp, power = (_number(p) for p in parts[-5:])
        name = ", ".join(parts[1:-5])
        stats.append(
            GpuStat(
                key=f"nvidia:{index}",
                name=name,
                vendor="NVIDIA",
                util=util,
                mem_used=int(used * 1024 * 1024) if used is not None else None,
                mem_total=int(total * 1024 * 1024) if total is not None else None,
                temp=temp,
                power_w=power,
            )
        )
    return stats


class WindowsCounterBackend:
    ENGINE = r"\GPU Engine(*)\Utilization Percentage"
    DEDICATED = r"\GPU Adapter Memory(*)\Dedicated Usage"
    SHARED = r"\GPU Adapter Memory(*)\Shared Usage"

    def __init__(self) -> None:
        self.adapters = self._load_adapters()
        self.query = winapi.PdhQuery()
        self.has_engine = self.query.add(self.ENGINE)
        self.has_memory = self.query.add(self.DEDICATED)
        self.query.add(self.SHARED)
        self.query.collect()  # rate counters need a first sample
        self._last_refresh = time.monotonic()
        if not self.adapters and not self.has_engine:
            raise RuntimeError("Windows reports no graphics adapters")

    @staticmethod
    def _load_adapters() -> list[winapi.DxgiAdapter]:
        try:
            adapters = winapi.list_dxgi_adapters()
        except OSError as exc:
            log.info("DXGI adapter list unavailable: %s", exc)
            return []
        unique: list[winapi.DxgiAdapter] = []
        seen = set()
        for adapter in adapters:
            # Skip the software renderer and the "Microsoft Basic Display Adapter".
            if adapter.software or adapter.vendor_id == 0x1414 or adapter.luid in seen:
                continue
            seen.add(adapter.luid)
            unique.append(adapter)
        return unique

    @staticmethod
    def _sum_by_adapter(values: dict[str, float]) -> dict[str, float]:
        totals: dict[str, float] = {}
        for instance, value in values.items():
            luid = parse_adapter_instance(instance)
            if luid:
                totals[luid] = totals.get(luid, 0.0) + value
        return totals

    def sample(self) -> tuple[list[GpuStat], EngineUsage]:
        self.query.collect()
        usage = aggregate_engine_usage(self.query.values(self.ENGINE)) if self.has_engine else EngineUsage()
        dedicated = self._sum_by_adapter(self.query.values(self.DEDICATED))
        shared = self._sum_by_adapter(self.query.values(self.SHARED))
        known = {adapter.luid for adapter in self.adapters}
        if set(usage.by_adapter) - known and time.monotonic() - self._last_refresh > 30:
            # A GPU was added or its driver restarted (LUIDs change) - look again.
            self._last_refresh = time.monotonic()
            self.adapters = self._load_adapters() or self.adapters
        stats = []
        for adapter in self.adapters:
            integrated = adapter.dedicated_vram < GB
            if integrated:
                # Built-in graphics mostly use shared system RAM, like Task Manager shows.
                has_data = adapter.luid in dedicated or adapter.luid in shared
                used = dedicated.get(adapter.luid, 0.0) + shared.get(adapter.luid, 0.0) if has_data else None
                total = (adapter.dedicated_vram + adapter.shared_memory) or None
            else:
                used = dedicated.get(adapter.luid)
                total = adapter.dedicated_vram or None
            stats.append(
                GpuStat(
                    key=adapter.luid,
                    name=adapter.name,
                    vendor=vendor_name(adapter.vendor_id),
                    util=usage.by_adapter.get(adapter.luid, 0.0) if self.has_engine else None,
                    mem_used=int(used) if used is not None else None,
                    mem_total=total,
                    integrated=integrated,
                )
            )
        return stats, usage


class NvmlBackend:
    def __init__(self) -> None:
        import pynvml  # provided by the optional "nvidia-ml-py" package

        pynvml.nvmlInit()
        self.nv = pynvml
        count = pynvml.nvmlDeviceGetCount()
        self.handles = [pynvml.nvmlDeviceGetHandleByIndex(i) for i in range(count)]
        if not self.handles:
            pynvml.nvmlShutdown()
            raise RuntimeError("no NVIDIA GPUs")
        self.names = []
        for handle in self.handles:
            name = pynvml.nvmlDeviceGetName(handle)
            self.names.append(name.decode(errors="replace") if isinstance(name, bytes) else str(name))
        self._reasons = getattr(pynvml, "nvmlDeviceGetCurrentClocksEventReasons", None) or getattr(
            pynvml, "nvmlDeviceGetCurrentClocksThrottleReasons", None
        )

    def sample(self) -> list[GpuStat]:
        nv = self.nv
        stats = []
        for index, handle in enumerate(self.handles):
            stat = GpuStat(key=f"nvidia:{index}", name=self.names[index], vendor="NVIDIA")
            try:
                stat.util = float(nv.nvmlDeviceGetUtilizationRates(handle).gpu)
            except Exception:  # noqa: BLE001 - any NVML error just means "unknown"
                pass
            try:
                memory = nv.nvmlDeviceGetMemoryInfo(handle)
                stat.mem_used, stat.mem_total = int(memory.used), int(memory.total)
            except Exception:  # noqa: BLE001
                pass
            try:
                stat.temp = float(nv.nvmlDeviceGetTemperature(handle, nv.NVML_TEMPERATURE_GPU))
            except Exception:  # noqa: BLE001
                pass
            try:
                stat.power_w = nv.nvmlDeviceGetPowerUsage(handle) / 1000.0
            except Exception:  # noqa: BLE001
                pass
            if self._reasons is not None:
                try:
                    stat.throttle = decode_nvidia_throttle(int(self._reasons(handle)))
                except Exception:  # noqa: BLE001
                    pass
            stats.append(stat)
        return stats


def _find_nvidia_smi() -> str | None:
    found = shutil.which("nvidia-smi")
    if found:
        return found
    if IS_WINDOWS:
        for candidate in (
            r"C:\Windows\System32\nvidia-smi.exe",
            r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe",
        ):
            if Path(candidate).exists():
                return candidate
    return None


class NvidiaSmiBackend:
    def __init__(self, min_interval: float = 2.0) -> None:
        self.exe = _find_nvidia_smi()
        if not self.exe:
            raise RuntimeError("nvidia-smi not found")
        self.min_interval = min_interval
        self._cache = self._query()
        if not self._cache:
            raise RuntimeError("nvidia-smi returned no GPUs")
        self._last = time.monotonic()

    def _query(self) -> list[GpuStat]:
        code, output = run_command(
            [self.exe, f"--query-gpu={NVIDIA_SMI_FIELDS}", "--format=csv,noheader,nounits"], timeout=5
        )
        return parse_nvidia_smi(output) if code == 0 else []

    def sample(self) -> list[GpuStat]:
        if time.monotonic() - self._last >= self.min_interval:
            self._last = time.monotonic()
            self._cache = self._query() or self._cache
        return [dataclasses.replace(stat) for stat in self._cache]


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text().strip() or None
    except OSError:
        return None


def _read_int(path: Path | None, base: int = 10) -> int | None:
    if path is None:
        return None
    text = _read_text(path)
    if text is None:
        return None
    try:
        return int(text, base)
    except ValueError:
        return None


class LinuxSysfsBackend:
    """AMD (amdgpu) cards expose load, VRAM and temperature in sysfs."""

    def __init__(self, root: str | Path = "/sys/class/drm") -> None:
        self.cards = []
        for card in sorted(Path(root).glob("card*")):
            if not card.name[4:].isdigit():
                continue  # connectors like card0-DP-1
            device = card / "device"
            if not (device / "gpu_busy_percent").exists():
                continue
            vendor_id = _read_int(device / "vendor", 16)
            name = _read_text(device / "product_name") or f"{vendor_name(vendor_id)} graphics ({card.name})"
            temps = sorted(device.glob("hwmon/hwmon*/temp1_input"))
            self.cards.append((card.name, name, vendor_id, device, temps[0] if temps else None))
        if not self.cards:
            raise RuntimeError("no GPUs with sysfs load information")

    def sample(self) -> list[GpuStat]:
        stats = []
        for key, name, vendor_id, device, temp_path in self.cards:
            util = _read_int(device / "gpu_busy_percent")
            total = _read_int(device / "mem_info_vram_total")
            temp = _read_int(temp_path)
            stats.append(
                GpuStat(
                    key=f"drm:{key}",
                    name=name,
                    vendor=vendor_name(vendor_id),
                    util=float(util) if util is not None else None,
                    mem_used=_read_int(device / "mem_info_vram_used"),
                    mem_total=total,
                    temp=temp / 1000.0 if temp is not None else None,
                    integrated=bool(total is not None and total < GB),
                )
            )
        return stats


def _try(factory, label: str):
    try:
        backend = factory()
    except Exception as exc:  # noqa: BLE001 - a missing backend is normal
        log.info("GPU source %s unavailable: %s", label, exc)
        return None
    log.info("GPU source %s active", label)
    return backend


class GpuMonitor:
    """Combines whatever GPU data sources work on this PC."""

    def __init__(self) -> None:
        self.windows = _try(WindowsCounterBackend, "windows-counters") if IS_WINDOWS else None
        self.nvml = _try(NvmlBackend, "nvml")
        self.smi = None
        if self.nvml is None:
            interval = 5.0 if self.windows else 2.0
            self.smi = _try(lambda: NvidiaSmiBackend(min_interval=interval), "nvidia-smi")
        self.sysfs = _try(LinuxSysfsBackend, "sysfs") if IS_LINUX else None
        self._errors: dict[str, int] = {}

    @property
    def sources(self) -> list[str]:
        names = []
        if self.windows:
            names.append("Windows performance counters")
        if self.nvml:
            names.append("NVIDIA NVML")
        if self.smi:
            names.append("nvidia-smi")
        if self.sysfs:
            names.append("Linux sysfs")
        return names

    def _failed(self, name: str, exc: Exception) -> None:
        count = self._errors.get(name, 0) + 1
        self._errors[name] = count
        log.warning("GPU source %s failed (%d): %s", name, count, exc)
        if count >= 5:
            setattr(self, name, None)

    def sample(self) -> tuple[list[GpuStat], EngineUsage]:
        gpus: list[GpuStat] = []
        usage = EngineUsage()
        if self.windows:
            try:
                gpus, usage = self.windows.sample()
            except Exception as exc:  # noqa: BLE001
                self._failed("windows", exc)
        nvidia: list[GpuStat] = []
        for name in ("nvml", "smi"):
            backend = getattr(self, name)
            if backend:
                try:
                    nvidia = backend.sample()
                except Exception as exc:  # noqa: BLE001
                    self._failed(name, exc)
                break
        if gpus:
            targets = [gpu for gpu in gpus if gpu.vendor == "NVIDIA"]
            for gpu, extra in zip(targets, nvidia):
                gpu.temp = extra.temp
                gpu.power_w = extra.power_w
                gpu.throttle = extra.throttle
                if gpu.util is None:
                    gpu.util = extra.util
                if gpu.mem_used is None:
                    gpu.mem_used = extra.mem_used
                if gpu.mem_total is None:
                    gpu.mem_total = extra.mem_total
        else:
            gpus = nvidia
        if self.sysfs:
            try:
                gpus = gpus + self.sysfs.sample()
            except Exception as exc:  # noqa: BLE001
                self._failed("sysfs", exc)
        return gpus, usage


def primary_gpu(gpus: list[GpuStat]) -> GpuStat | None:
    """The card games normally run on: a dedicated one if there is one."""
    if not gpus:
        return None
    return max(gpus, key=lambda gpu: (not gpu.integrated, gpu.mem_total or 0))
