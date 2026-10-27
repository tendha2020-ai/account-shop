"""Apps tab: every running process, with close / priority / free-RAM actions."""

from __future__ import annotations

import sys
import tkinter as tk
from tkinter import messagebox, ttk

from ..actions import CloseApp, ProcTarget, SetPriority, TrimMemory, priority_name
from ..advisor import group_key
from ..apps import PROTECTED, pretty_exe_name
from ..monitor import ProcStat, Snapshot
from ..platform_utils import IS_WINDOWS, fmt_bytes

COLUMNS = (
    ("name", "Process", 250, "w"),
    ("pid", "PID", 70, "e"),
    ("cpu", "CPU", 70, "e"),
    ("ram", "RAM", 90, "e"),
    ("gpu", "GPU", 60, "e"),
    ("priority", "Priority", 110, "w"),
)
PRIORITY_MENU = (
    ("High", "high"),
    ("Above normal", "above_normal"),
    ("Normal", "normal"),
    ("Below normal", "below_normal"),
    ("Low", "idle"),
)


class ProcessesTab(ttk.Frame):
    def __init__(self, master, app) -> None:
        super().__init__(master, padding=app.theme.px(12))
        self.app = app
        t, c = app.theme, app.theme.c
        self.sort_column = "cpu"
        self.sort_descending = True
        self.procs: dict[int, ProcStat] = {}
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        bar = ttk.Frame(self, style="Card.TFrame", padding=(t.px(14), t.px(10)))
        bar.grid(row=0, column=0, sticky="ew")
        bar.columnconfigure(3, weight=1)
        ttk.Label(bar, text="Search", style="CardTitle.TLabel").grid(row=0, column=0, sticky="w")
        self.search_var = tk.StringVar()
        search = ttk.Entry(bar, textvariable=self.search_var, width=24)
        search.grid(row=0, column=1, sticky="w", padx=(t.px(8), t.px(16)))
        self.search_var.trace_add("write", lambda *_: self._refresh_now())
        self.mine_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            bar, text="Only my apps", variable=self.mine_var, style="Setting.TCheckbutton", command=self._refresh_now
        ).grid(row=0, column=2, sticky="w")

        buttons = ttk.Frame(bar, style="Card.TFrame")
        buttons.grid(row=1, column=0, columnspan=4, sticky="w", pady=(t.px(10), 0))
        ttk.Label(buttons, text="Selected:", style="CardMuted.TLabel").pack(side="left", padx=(0, t.px(8)))
        ttk.Button(buttons, text="Close", style="Small.TButton", command=lambda: self.close_selected(False)).pack(side="left")
        ttk.Button(buttons, text="Force close", style="Small.TButton", command=lambda: self.close_selected(True)).pack(
            side="left", padx=(t.px(6), 0)
        )
        priority_button = ttk.Menubutton(buttons, text="Priority")
        self.priority_menu = tk.Menu(priority_button, tearoff=False)
        for label, level in PRIORITY_MENU:
            self.priority_menu.add_command(label=label, command=lambda lv=level: self.set_priority(lv))
        priority_button["menu"] = self.priority_menu
        priority_button.pack(side="left", padx=(t.px(6), 0))
        if IS_WINDOWS or app.demo:
            ttk.Button(buttons, text="Free RAM", style="Small.TButton", command=self.trim_selected).pack(
                side="left", padx=(t.px(6), 0)
            )
        ttk.Button(buttons, text="This is my game", style="Small.TButton", command=self.mark_game).pack(
            side="left", padx=(t.px(6), 0)
        )
        ttk.Button(buttons, text="Never suggest it", style="Small.TButton", command=self.never_suggest).pack(
            side="left", padx=(t.px(6), 0)
        )

        table = ttk.Frame(self, style="Card.TFrame", padding=t.px(2))
        table.grid(row=1, column=0, sticky="nsew", pady=(t.px(10), 0))
        table.columnconfigure(0, weight=1)
        table.rowconfigure(0, weight=1)
        self.tree = ttk.Treeview(table, columns=[col[0] for col in COLUMNS], show="headings", selectmode="extended")
        for column, title, width, anchor in COLUMNS:
            self.tree.heading(column, text=title, anchor=anchor, command=lambda col=column: self._sort_by(col))
            self.tree.column(column, width=t.px(width), anchor=anchor, stretch=column == "name")
        self.tree.tag_configure("system", foreground=c["faint"])
        scroll = ttk.Scrollbar(table, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        scroll.grid(row=0, column=1, sticky="ns")
        self._update_headings()

        self.menu = tk.Menu(self, tearoff=False)
        self.menu.add_command(label="Close", command=lambda: self.close_selected(False))
        self.menu.add_command(label="Force close", command=lambda: self.close_selected(True))
        self.menu.add_cascade(label="Priority", menu=self.priority_menu)
        if IS_WINDOWS or app.demo:
            self.menu.add_command(label="Free RAM", command=self.trim_selected)
        self.menu.add_separator()
        self.menu.add_command(label="This is my game", command=self.mark_game)
        self.menu.add_command(label="Never suggest closing this app", command=self.never_suggest)
        self.tree.bind("<Button-3>", self._context_menu)
        if sys.platform == "darwin":
            self.tree.bind("<Button-2>", self._context_menu)

        self.message = ttk.Label(
            self,
            text="Tip: right-click a process for more options. Processes from Windows itself are protected.",
            style="Muted.TLabel",
        )
        self.message.grid(row=2, column=0, sticky="w", pady=(t.px(8), 0))

    # -- table -----------------------------------------------------------------------
    def _refresh_now(self) -> None:
        snap = self.app.monitor.latest
        if snap is not None:
            self.refresh(snap)

    def refresh(self, snap: Snapshot) -> None:
        procs = [p for p in (snap.processes or []) if p.pid not in self.app.self_pids]
        self.procs = {p.pid: p for p in procs}
        query = self.search_var.get().strip().lower()
        only_mine = self.mine_var.get()
        rows: dict[str, tuple] = {}
        sort_values: dict[str, object] = {}
        tags: dict[str, tuple] = {}
        for proc in procs:
            if only_mine and not proc.mine:
                continue
            if query and query not in proc.name.lower():
                continue
            iid = str(proc.pid)
            rows[iid] = (
                pretty_exe_name(proc.name),
                str(proc.pid),
                f"{proc.cpu:.1f}%",
                fmt_bytes(proc.rss),
                f"{proc.gpu:.0f}%" if proc.gpu >= 0.5 else "",
                priority_name(proc.nice, self.app.windows_like),
            )
            sort_values[iid] = {
                "name": proc.name.lower(),
                "pid": proc.pid,
                "cpu": proc.cpu,
                "ram": proc.rss,
                "gpu": proc.gpu,
                "priority": proc.nice if proc.nice is not None else 0,
            }[self.sort_column]
            tags[iid] = ("system",) if group_key(proc) in PROTECTED or not proc.mine else ()
        existing = set(self.tree.get_children())
        for iid in existing - rows.keys():
            self.tree.delete(iid)
        for iid, values in rows.items():
            if iid in existing:
                if tuple(self.tree.item(iid, "values")) != values:
                    self.tree.item(iid, values=values, tags=tags[iid])
            else:
                self.tree.insert("", "end", iid=iid, values=values, tags=tags[iid])
        ordered = sorted(rows, key=lambda iid: sort_values[iid], reverse=self.sort_descending)
        for index, iid in enumerate(ordered):
            if self.tree.index(iid) != index:
                self.tree.move(iid, "", index)

    def _sort_by(self, column: str) -> None:
        if self.sort_column == column:
            self.sort_descending = not self.sort_descending
        else:
            self.sort_column = column
            self.sort_descending = column not in ("name", "pid")
        self._update_headings()
        self._refresh_now()

    def _update_headings(self) -> None:
        for column, title, _width, _anchor in COLUMNS:
            arrow = (" ▼" if self.sort_descending else " ▲") if column == self.sort_column else ""
            self.tree.heading(column, text=title + arrow)

    def _context_menu(self, event) -> None:
        row = self.tree.identify_row(event.y)
        if row and row not in self.tree.selection():
            self.tree.selection_set(row)
        if self.tree.selection():
            self.menu.tk_popup(event.x_root, event.y_root)

    # -- actions ----------------------------------------------------------------------
    def show_message(self, text: str, good: bool = True) -> None:
        c = self.app.theme.c
        self.message.configure(text=text, foreground=c["good"] if good else c["warn"])

    def _selection(self) -> list[ProcStat]:
        procs = [self.procs[int(iid)] for iid in self.tree.selection() if int(iid) in self.procs]
        if not procs:
            self.show_message("Select a process in the list first.", good=False)
        return procs

    @staticmethod
    def _name(procs: list[ProcStat]) -> str:
        names = sorted({pretty_exe_name(p.name) for p in procs})
        return names[0] if len(names) == 1 else f"{len(procs)} processes"

    def _allowed(self, procs: list[ProcStat]) -> bool:
        blocked = sorted({pretty_exe_name(p.name) for p in procs if group_key(p) in PROTECTED})
        if blocked:
            self.show_message(f"LagBuster doesn't touch Windows or driver processes ({', '.join(blocked)}).", good=False)
            return False
        return True

    def _run(self, action) -> None:
        self.show_message(f"{action.describe()}…")
        self.app.apply_actions([action], self._done)

    def _done(self, results) -> None:
        for result in results:
            self.show_message(("✔  " if result.ok else "⚠  ") + result.message, good=result.ok)
        self.app.boost._refresh_banner()

    def close_selected(self, force: bool) -> None:
        procs = self._selection()
        if not procs or not self._allowed(procs):
            return
        name = self._name(procs)
        if force:
            question = f"Force close {name}? It ends immediately and anything unsaved in it is lost."
        else:
            question = f"Close {name}? Save your work in it first."
        if not messagebox.askyesno("Close app?", question, parent=self):
            return
        targets = [ProcTarget(p.pid, p.create_time) for p in procs]
        self._run(CloseApp(name, targets, force_ok=force, grace_seconds=1.5 if force else 6.0))

    def set_priority(self, level: str) -> None:
        procs = self._selection()
        if not procs or not self._allowed(procs):
            return
        self._run(SetPriority(self._name(procs), [ProcTarget(p.pid, p.create_time) for p in procs], level))

    def trim_selected(self) -> None:
        procs = self._selection()
        if procs:
            self._run(TrimMemory([ProcTarget(p.pid, p.create_time) for p in procs]))

    def mark_game(self) -> None:
        procs = self._selection()
        if not procs:
            return
        key = group_key(procs[0])
        if key in PROTECTED:
            self.show_message("That's a Windows process, not a game.", good=False)
            return
        self.app.settings.add_unique("my_games", key)
        self.app.settings.last_game = key
        self.app.settings.save()
        self.app._games_at = 0.0  # re-detect games on the next refresh
        self.app.boost.select_game(key)
        self.app.settings_tab.sync()
        self.show_message(f"Got it - {pretty_exe_name(procs[0].name)} is your game. Run a scan in the Boost tab.")

    def never_suggest(self) -> None:
        procs = self._selection()
        if not procs:
            return
        key = group_key(procs[0])
        self.app.settings.add_unique("protected_apps", key)
        self.app.settings.save()
        self.app.settings_tab.sync()
        self.show_message(f"LagBuster won't suggest closing {pretty_exe_name(procs[0].name)} anymore.")
