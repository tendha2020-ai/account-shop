"""The main LagBuster window and the glue between the UI and the engine."""

from __future__ import annotations

import logging
import os
import queue
import subprocess
import sys
import time
import tkinter as tk
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tkinter import messagebox, ttk
from typing import Callable

import psutil

from .. import __version__, winapi
from ..actions import Action, ActionContext, ActionResult, UndoJournal, run_actions
from ..advisor import GameCandidate, ScanInput, ScanResult, advise, apply_saved_choices, find_games, group_processes
from ..demo import DemoMonitor, demo_platform
from ..monitor import SystemMonitor
from ..platform_utils import IS_WINDOWS, app_data_dir, asset_path, fmt_bytes, is_admin
from ..probe import probe_platform
from ..settings import Settings
from .boost import BoostTab
from .dashboard import DashboardTab
from .overlay import Overlay
from .processes import ProcessesTab
from .settings_tab import SettingsTab
from .theme import Theme

log = logging.getLogger("lagbuster.ui")


def _self_pids() -> frozenset[int]:
    """Our own process (plus the PyInstaller launcher process, if any)."""
    pids = {os.getpid()}
    try:
        me = psutil.Process()
        parent = me.parent()
        if parent is not None and parent.name().lower() == me.name().lower():
            pids.add(parent.pid)
    except psutil.Error:
        pass
    return frozenset(pids)


class LagBusterApp:
    def __init__(
        self,
        root: tk.Tk,
        *,
        demo: bool = False,
        data_dir: Path | None = None,
        auto_close_after: float | None = None,
        scan_on_start: bool = False,
    ) -> None:
        self.root = root
        self.demo = demo
        self.windows_like = IS_WINDOWS or demo
        data = data_dir or app_data_dir()
        self.data_dir = data
        self.settings = Settings.load(data / "settings.json")
        self.journal = UndoJournal(None if demo else data / "undo.json")
        if not demo:
            self.journal.prune()
        interval = self.settings.refresh_seconds
        self.monitor = DemoMonitor(interval) if demo else SystemMonitor(interval)
        self.admin = False if demo else is_admin()
        self.self_pids = _self_pids()
        self.theme = Theme(root)
        self.events: queue.Queue = queue.Queue()
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="lagbuster")
        self.errors: list[str] = []
        self.overlay: Overlay | None = None
        self.groups: dict = {}
        self.detected_games: list[GameCandidate] = []
        self._games_at = 0.0
        self._closing = False

        root.title("LagBuster" + (" - demo mode" if demo else ""))
        root.geometry(f"{self.theme.px(1100)}x{self.theme.px(740)}")
        root.minsize(self.theme.px(920), self.theme.px(620))
        root.report_callback_exception = self._on_tk_error
        self._set_icon()
        self._build()
        root.protocol("WM_DELETE_WINDOW", self.close)
        self.monitor.start()
        root.after(150, self._tick)
        root.after(100, self._poll_events)
        if self.settings.overlay_visible:
            root.after(800, lambda: self.toggle_overlay(True))
        if scan_on_start:
            root.after(600, self.show_boost_and_scan)
        if auto_close_after:
            root.after(int(auto_close_after * 1000), self.close)

    # -- window setup ------------------------------------------------------
    def _set_icon(self) -> None:
        self.logo = None
        try:
            icon = tk.PhotoImage(file=str(asset_path("icon.png")))
            self.root.iconphoto(True, icon)
            factor = max(1, round(icon.width() / self.theme.px(44)))
            self.logo = icon.subsample(factor)
            self._icon_image = icon
        except tk.TclError as exc:
            log.info("icon not loaded: %s", exc)
        if IS_WINDOWS:
            try:
                self.root.iconbitmap(default=str(asset_path("icon.ico")))
            except tk.TclError:
                pass

    def _build(self) -> None:
        t, c, root = self.theme, self.theme.c, self.root
        root.columnconfigure(0, weight=1)
        root.rowconfigure(1, weight=1)

        header = ttk.Frame(root, padding=(t.px(20), t.px(14), t.px(20), t.px(2)))
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(1, weight=1)
        if self.logo is not None:
            tk.Label(header, image=self.logo, bg=c["bg"]).grid(row=0, column=0, rowspan=2, padx=(0, t.px(12)))
        ttk.Label(header, text="LagBuster", style="H1.TLabel").grid(row=0, column=1, sticky="sw")
        ttk.Label(
            header,
            text="See what slows your games down - and choose what to fix.",
            style="Muted.TLabel",
        ).grid(row=1, column=1, sticky="nw")
        self.game_pill = tk.Label(
            header,
            text="Looking for a game…",
            font=t.font["bold"],
            bg=c["panel2"],
            fg=c["muted"],
            padx=t.px(14),
            pady=t.px(6),
        )
        self.game_pill.grid(row=0, column=2, rowspan=2, sticky="e")
        if self.demo:
            tk.Label(
                header,
                text="DEMO - simulated data, nothing is changed",
                font=t.font["small_bold"],
                bg=c["accent_dim"],
                fg="#ffffff",
                padx=t.px(10),
                pady=t.px(6),
            ).grid(row=0, column=3, rowspan=2, sticky="e", padx=(t.px(10), 0))

        self.notebook = ttk.Notebook(root)
        self.notebook.grid(row=1, column=0, sticky="nsew", padx=t.px(12), pady=(t.px(6), 0))
        self.dashboard = DashboardTab(self.notebook, self)
        self.boost = BoostTab(self.notebook, self)
        self.processes = ProcessesTab(self.notebook, self)
        self.settings_tab = SettingsTab(self.notebook, self)
        self.notebook.add(self.dashboard, text="Dashboard")
        self.notebook.add(self.boost, text="⚡ Boost")
        self.notebook.add(self.processes, text="Apps")
        self.notebook.add(self.settings_tab, text="Settings")
        self.notebook.bind("<<NotebookTabChanged>>", lambda _e: self._tick(reschedule=False))

        status = ttk.Frame(root, style="Card.TFrame", padding=(t.px(18), t.px(6)))
        status.grid(row=2, column=0, sticky="ew", pady=(t.px(8), 0))
        status.columnconfigure(0, weight=1)
        self.status_left = ttk.Label(status, text="Starting…", style="Status.TLabel")
        self.status_left.grid(row=0, column=0, sticky="w")
        self.status_right = ttk.Label(status, text="", style="Status.TLabel")
        self.status_right.grid(row=0, column=1, sticky="e")

    # -- periodic refresh ---------------------------------------------------
    def _tick(self, reschedule: bool = True) -> None:
        if self._closing:
            return
        try:
            visible = self.root.state() not in ("iconic", "withdrawn")
            self.monitor.enable_process_sampling(visible)
            snap = self.monitor.latest
            if snap is not None:
                if visible:
                    if snap.processes and time.monotonic() - self._games_at > 2.5:
                        self._games_at = time.monotonic()
                        procs = [p for p in snap.processes if p.pid not in self.self_pids]
                        self.groups = group_processes(procs)
                        self.detected_games = find_games(self.groups, frozenset(self.settings.my_games))
                        self._update_game_pill()
                        self.boost.refresh_games()
                    selected = self.notebook.select()
                    if selected == str(self.dashboard):
                        self.dashboard.refresh(snap, self.monitor.history(120))
                    elif selected == str(self.processes):
                        self.processes.refresh(snap)
                    self._update_status(snap)
                if self.overlay is not None:
                    self.overlay.refresh(snap)
        finally:
            if reschedule and not self._closing:
                self.root.after(int(self.monitor.interval * 1000), self._tick)

    def current_game(self) -> GameCandidate | None:
        key = self.boost.selected_game_key()
        if key == "":
            return None
        if key:
            return next((game for game in self.detected_games if game.key == key), None)
        top = self.detected_games[0] if self.detected_games else None
        return top if top and top.score >= 60 else None

    def _update_game_pill(self) -> None:
        c = self.theme.c
        game = self.current_game()
        if game:
            self.game_pill.configure(text=f"●  Playing: {game.title}", fg=c["good"])
        else:
            self.game_pill.configure(text="No game detected", fg=c["muted"])

    def _update_status(self, snap) -> None:
        left = (
            f"Live · updates every {self.monitor.interval:g} s · LagBuster itself uses "
            f"{snap.self_cpu:.1f}% CPU and {fmt_bytes(snap.self_rss)} RAM"
        )
        if len(self.journal):
            left += f" · {len(self.journal.descriptions())} change(s) active (undo in Boost)"
        self.status_left.configure(text=left)
        admin = "Administrator" if self.admin else "Standard user"
        self.status_right.configure(text=f"{admin} · v{__version__}")

    # -- background work ------------------------------------------------------
    def post(self, callback: Callable, value=None) -> None:
        """Run ``callback(value)`` on the UI thread (safe to call from any thread)."""
        self.events.put((callback, value, None))

    def run_background(self, work: Callable, on_done: Callable | None = None, on_error: Callable | None = None) -> None:
        def task():
            try:
                result = work()
            except Exception as exc:  # noqa: BLE001 - shown to the user, never crashes the app
                log.exception("background task failed")
                self.events.put((on_error, None, exc))
                return
            self.events.put((on_done, result, None))

        self.executor.submit(task)

    def _poll_events(self) -> None:
        try:
            while True:
                callback, value, error = self.events.get_nowait()
                try:
                    if error is not None:
                        self.errors.append(repr(error))
                        if callback:
                            callback(error)
                        else:
                            self.status_left.configure(text=f"Something went wrong: {error}")
                    elif callback:
                        callback(value)
                except Exception:  # noqa: BLE001
                    log.exception("UI callback failed")
                    self.errors.append("UI callback failed")
        except queue.Empty:
            pass
        if not self._closing:
            self.root.after(100, self._poll_events)

    def _on_tk_error(self, exc_type, exc, tb) -> None:
        log.error("UI error", exc_info=(exc_type, exc, tb))
        self.errors.append(f"{exc_type.__name__}: {exc}")
        try:
            self.status_left.configure(text=f"Something went wrong: {exc} (details in the log file)")
        except tk.TclError:
            pass

    # -- engine glue ----------------------------------------------------------
    def scan_worker(self, game_key: str | None) -> ScanResult:
        self.monitor.wait_for_processes(samples=2, timeout=8.0)
        platform = demo_platform() if self.demo else probe_platform(network_test=self.settings.network_test)
        snapshot = self.monitor.latest
        if snapshot is None:
            raise RuntimeError("no measurements yet - try again in a moment")
        inp = ScanInput(
            snapshot=snapshot,
            averages=self.monitor.averages(15),
            platform=platform,
            game_key=game_key,
            protected_apps=frozenset(self.settings.protected_apps),
            my_games=frozenset(self.settings.my_games),
            self_pids=self.self_pids,
            describe=winapi.file_description if IS_WINDOWS else None,
        )
        result = advise(inp)
        apply_saved_choices(result.suggestions, self.settings.choices)
        return result

    def apply_actions(self, actions: list[Action], on_done: Callable, progress: Callable | None = None) -> None:
        context = ActionContext(
            self.journal,
            dry_run=self.demo,
            progress=(lambda text: self.post(progress, text)) if progress else None,
        )
        self.run_background(lambda: run_actions(actions, context), on_done, lambda exc: on_done([ActionResult(False, str(exc))]))

    def undo_all(self, on_done: Callable) -> None:
        if self.demo:
            self.post(on_done, [ActionResult(True, "Demo mode: nothing was changed, so there's nothing to undo.")])
            return
        self.run_background(self.journal.undo_all, on_done, lambda exc: on_done([ActionResult(False, str(exc))]))

    # -- actions used by several tabs -------------------------------------------
    def show_boost_and_scan(self) -> None:
        self.notebook.select(self.boost)
        self.boost.start_scan()

    def toggle_overlay(self, show: bool | None = None) -> None:
        show = (self.overlay is None) if show is None else show
        if show and self.overlay is None:
            self.overlay = Overlay(self)
            snap = self.monitor.latest
            if snap is not None:
                self.overlay.refresh(snap)
        elif not show and self.overlay is not None:
            self.overlay.close()
            self.overlay = None
        self.settings.overlay_visible = show
        self.settings.save()
        self.dashboard.update_overlay_button()
        self.settings_tab.sync()

    def restart_as_admin(self) -> None:
        if not IS_WINDOWS:
            return
        if getattr(sys, "frozen", False):
            executable, params, cwd = sys.executable, subprocess.list2cmdline(sys.argv[1:]), None
        else:
            executable = sys.executable
            pythonw = Path(executable).with_name("pythonw.exe")
            if pythonw.exists():
                executable = str(pythonw)
            script = Path(sys.argv[0]).resolve()
            if script.name == "__main__.py":
                params, cwd = "-m lagbuster", str(script.parent.parent)
            else:
                params, cwd = subprocess.list2cmdline([str(script), *sys.argv[1:]]), str(script.parent)
        try:
            started = winapi.relaunch_as_admin(executable, params, cwd)
        except OSError:
            started = False
        if started:
            self.close()
        else:
            messagebox.showinfo("LagBuster", "LagBuster wasn't restarted as administrator.", parent=self.root)

    def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        try:
            if self.settings.undo_on_exit and len(self.journal) and not self.demo:
                self.journal.undo_all()
            self.settings.save()
        except Exception:  # noqa: BLE001
            log.exception("error while closing")
        finally:
            self.monitor.stop()
            self.executor.shutdown(wait=False, cancel_futures=True)
            try:
                self.root.destroy()
            except tk.TclError:
                pass


def run_app(demo: bool = False, auto_close_after: float | None = None, scan_on_start: bool = False) -> int:
    winapi.prepare_process()
    root = tk.Tk()
    app = LagBusterApp(root, demo=demo, auto_close_after=auto_close_after, scan_on_start=scan_on_start)
    root.mainloop()
    if app.errors:
        log.error("finished with errors: %s", app.errors)
        return 1
    return 0
