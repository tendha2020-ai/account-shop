"""``--selftest``: check every system feature LagBuster relies on.

Nothing on the PC is changed, except a throwaway helper process the test starts
itself (to try priority changes, freeing RAM and closing). CI runs this on real
Windows to verify the ctypes code paths.
"""

from __future__ import annotations

import ctypes
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

import psutil

from . import __version__, winapi
from .actions import ActionContext, CloseApp, ProcTarget, SetPriority, TrimMemory, UndoJournal, priority_value
from .advisor import ScanInput, advise
from .gpu import GpuMonitor
from .monitor import SystemMonitor
from .platform_utils import IS_WINDOWS, os_name
from .probe import probe_platform


class _Checks:
    def __init__(self) -> None:
        self.results: list[dict] = []

    def run(self, name: str, check, required: bool = True) -> object:
        start = time.perf_counter()
        try:
            detail = check()
            ok = True
        except Exception as exc:  # noqa: BLE001 - every failure is reported, not raised
            detail = f"{type(exc).__name__}: {exc}"
            ok = False
        elapsed = round((time.perf_counter() - start) * 1000)
        self.results.append({"name": name, "ok": ok, "required": required, "detail": str(detail), "ms": elapsed})
        mark = "PASS" if ok else ("FAIL" if required else "warn")
        _print(f"[{mark}] {name} ({elapsed} ms): {detail}")
        return detail if ok else None

    @property
    def failed(self) -> list[dict]:
        return [r for r in self.results if r["required"] and not r["ok"]]


def _print(text: str) -> None:
    if sys.stdout is not None:
        try:
            print(text, flush=True)
        except (OSError, UnicodeEncodeError):
            print(text.encode("ascii", "replace").decode(), flush=True)


def _helper_process() -> subprocess.Popen:
    if IS_WINDOWS:
        return subprocess.Popen(
            ["ping", "-n", "60", "127.0.0.1"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=0x08000000,
        )
    return subprocess.Popen(["sleep", "60"])


def _target(proc: subprocess.Popen) -> ProcTarget:
    return ProcTarget(proc.pid, psutil.Process(proc.pid).create_time())


def run_selftest(report_path: str | None = None) -> int:
    checks = _Checks()
    _print(f"LagBuster {__version__} self-test on {platform.platform()} / Python {platform.python_version()}")
    monitor = SystemMonitor(interval=0.5)
    monitor.start()

    def check_monitor():
        if not monitor.wait_for_processes(samples=2, timeout=15):
            raise RuntimeError("no process samples")
        snap = monitor.latest
        assert snap is not None
        assert 0.0 <= snap.cpu <= 100.0, snap.cpu
        assert snap.ram_total > 0 and 0 <= snap.ram_percent <= 100
        pids = {p.pid for p in snap.processes or []}
        assert os.getpid() in pids, "own process missing from the process list"
        mine = sum(1 for p in snap.processes or [] if p.mine)
        assert mine >= 1, "no processes recognised as the user's"
        return f"cpu {snap.cpu:.0f}%, ram {snap.ram_percent:.0f}%, {len(pids)} processes ({mine} mine)"

    checks.run("system monitor", check_monitor)

    def check_gpu():
        gpu = GpuMonitor()
        gpus, usage = gpu.sample()
        names = ", ".join(f"{g.name} util={g.util} mem={g.mem_used}/{g.mem_total} temp={g.temp}" for g in gpus)
        return f"sources={gpu.sources or 'none'}; gpus=[{names}]; apps using GPU={len(usage.by_pid)}"

    checks.run("graphics card monitoring", check_gpu, required=False)

    state_holder: dict = {}

    def check_probe():
        state = probe_platform(network_test=True)
        state_holder["state"] = state
        power = state.power
        if IS_WINDOWS:
            assert power is not None and power.active, "could not read the power plan"
        net = state.network
        return (
            f"power={power.active_name if power else None} ({power.active if power else None}), "
            f"overlay={power.overlay if power else None}, schemes={len(power.schemes) if power else 0}, "
            f"gamedvr_bg={state.game_dvr_background}, game_mode={state.game_mode}, "
            f"startup={state.startup_count}, disk_free={state.disk_free}, "
            f"net={'%.0f ms' % net.average if net and net.average else 'unreachable'}"
        )

    checks.run("read system settings", check_probe)

    def check_advisor():
        snap = monitor.latest
        state = state_holder.get("state") or probe_platform(network_test=False)
        result = advise(ScanInput(snapshot=snap, averages=monitor.averages(10), platform=state, self_pids=frozenset({os.getpid()})))
        return f"{len(result.suggestions)} suggestions: " + "; ".join(f"[{s.section}] {s.title}" for s in result.suggestions[:12])

    checks.run("suggestions", check_advisor)

    if IS_WINDOWS:
        def check_struct_sizes():
            if ctypes.sizeof(ctypes.c_void_p) == 8:
                assert ctypes.sizeof(winapi.PDH_FMT_COUNTERVALUE_ITEM_W) == 24
                assert ctypes.sizeof(winapi._DXGI_ADAPTER_DESC1) == 312
            return "ok"

        checks.run("Windows structure sizes", check_struct_sizes)

        def check_pdh():
            query = winapi.PdhQuery()
            path = r"\Processor(*)\% Processor Time"
            assert query.add(path), "counter not accepted"
            assert query.add(r"\Memory\Available Bytes")
            query.collect()
            time.sleep(0.5)
            query.collect()
            values = query.values(path)
            assert "_Total" in values, f"instances: {sorted(values)[:5]}"
            assert all(-0.5 <= v <= 101 for v in values.values()), values
            available = query.value(r"\Memory\Available Bytes")
            assert available and available > 0
            query.close()
            return f"{len(values)} CPU instances, total {values['_Total']:.0f}%, available RAM {available / 2**30:.1f} GB"

        checks.run("performance counters (PDH)", check_pdh)

        def check_gpu_counters():
            query = winapi.PdhQuery()
            engine_path = r"\GPU Engine(*)\Utilization Percentage"
            engine = query.add(engine_path)
            memory = query.add(r"\GPU Adapter Memory(*)\Dedicated Usage")
            query.collect()
            time.sleep(0.5)
            query.collect()
            instances = len(query.values(engine_path))
            return f"engine counter={engine} ({instances} instances), memory counter={memory}"

        checks.run("GPU performance counters", check_gpu_counters, required=False)

        def check_dxgi():
            adapters = winapi.list_dxgi_adapters()
            assert adapters, "no adapters at all"
            return "; ".join(
                f"{a.name} (vendor 0x{a.vendor_id:04x}, vram {a.dedicated_vram >> 20} MB, luid {a.luid}, software={a.software})"
                for a in adapters
            )

        checks.run("graphics adapters (DXGI)", check_dxgi)
        checks.run("power mode (overlay) read", lambda: winapi.get_power_overlay(), required=False)

        def check_registry():
            major = winapi.reg_read_dword("HKLM", r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentMajorVersionNumber")
            assert major == 10, major
            return f"Windows major version {major}"

        checks.run("registry", check_registry)

        def check_description():
            notepad = str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "notepad.exe")
            description = winapi.file_description(notepad)
            assert description, "no description"
            return f"notepad.exe = {description!r}"

        checks.run("app names from .exe files", check_description)

        def check_foreground():
            return f"foreground pid {winapi.foreground_pid()}"

        checks.run("foreground window", check_foreground, required=False)

        def check_close_window():
            notepad = subprocess.Popen(["notepad.exe"])
            try:
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline and not winapi.visible_windows([notepad.pid]):
                    time.sleep(0.2)
                windows = winapi.visible_windows([notepad.pid])
                if not windows:
                    return "notepad window not visible here (no desktop session?) - skipped"
                action = CloseApp("Notepad", [_target(notepad)], force_ok=False, grace_seconds=6)
                result = action.run(ActionContext(UndoJournal(None)))
                assert result.ok, result.message
                return result.message
            finally:
                if notepad.poll() is None:
                    notepad.kill()

        checks.run("close an app politely (WM_CLOSE)", check_close_window, required=False)

    def check_process_actions():
        helper = _helper_process()
        try:
            time.sleep(0.5)
            target = _target(helper)
            try:
                # Build servers run jobs at a lowered priority that child processes inherit.
                psutil.Process(helper.pid).nice(priority_value("normal"))
            except psutil.AccessDenied:
                pass
            journal = UndoJournal(None)
            context = ActionContext(journal)
            result = SetPriority("helper", [target], "below_normal").run(context)
            assert result.ok, result.message
            assert int(psutil.Process(helper.pid).nice()) == priority_value("below_normal")
            undo = journal.undo_all()
            now = int(psutil.Process(helper.pid).nice())
            restored = now == priority_value("normal")
            if IS_WINDOWS or os.geteuid() == 0:  # type: ignore[attr-defined]
                assert restored, f"priority after undo: {now} ({[r.message for r in undo]})"
            details = [result.message, "undo ok" if restored else "undo needs root on Linux"]
            if IS_WINDOWS:
                trim = TrimMemory([target]).run(context)
                assert trim.ok, trim.message
                details.append(trim.message)
            close = CloseApp("helper", [target], force_ok=True, grace_seconds=1).run(context)
            assert close.ok, close.message
            assert helper.wait(timeout=5) is not None
            details.append(close.message)
            return " | ".join(details)
        finally:
            if helper.poll() is None:
                helper.kill()

    checks.run("priority / free RAM / close on a helper process", check_process_actions)

    monitor.stop()
    failed = checks.failed
    _print(f"\n{len(checks.results) - len(failed)} of {len(checks.results)} checks passed" + (f"; FAILED: {[f['name'] for f in failed]}" if failed else ""))
    if report_path:
        Path(report_path).write_text(
            json.dumps(
                {"version": __version__, "os": os_name(), "platform": platform.platform(), "results": checks.results},
                indent=2,
            ),
            encoding="utf-8",
        )
    return 1 if failed else 0
