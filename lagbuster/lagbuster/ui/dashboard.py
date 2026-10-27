"""Dashboard tab: live CPU / RAM / GPU cards and the heaviest apps."""

from __future__ import annotations

from tkinter import ttk

from .. import winapi
from ..advisor import display_name
from ..monitor import HistoryPoint, Snapshot
from ..platform_utils import IS_WINDOWS, fmt_bytes, fmt_rate
from .widgets import MeterCard


def _shorten(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


class DashboardTab(ttk.Frame):
    def __init__(self, master, app) -> None:
        super().__init__(master, padding=app.theme.px(12))
        self.app = app
        t, c = app.theme, app.theme.c
        self.columnconfigure((0, 1, 2), weight=1, uniform="cards")
        self.rowconfigure(1, weight=1)

        self.cpu = MeterCard(self, t, "CPU", c["cpu"], (75, 90))
        self.ram = MeterCard(self, t, "RAM", c["ram"], (80, 90))
        self.gpu = MeterCard(self, t, "GPU", c["gpu"], None)
        for column, card in enumerate((self.cpu, self.ram, self.gpu)):
            card.grid(row=0, column=column, sticky="nsew", padx=(0 if column == 0 else t.px(6), 0 if column == 2 else t.px(6)))

        lower = ttk.Frame(self)
        lower.grid(row=1, column=0, columnspan=3, sticky="nsew", pady=(t.px(12), 0))
        lower.columnconfigure(0, weight=3)
        lower.columnconfigure(1, weight=2)
        lower.rowconfigure(0, weight=1)

        apps_card = ttk.Frame(lower, style="Card.TFrame", padding=t.px(16))
        apps_card.grid(row=0, column=0, sticky="nsew", padx=(0, t.px(6)))
        apps_card.columnconfigure(0, weight=1)
        apps_card.rowconfigure(2, weight=1)
        ttk.Label(apps_card, text="What's using your PC right now", style="CardH2.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(
            apps_card,
            text="Apps with all their processes added together. Manage them in the Apps tab.",
            style="CardMuted.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(t.px(2), t.px(10)))
        self.top = ttk.Treeview(apps_card, columns=("app", "cpu", "ram", "gpu"), show="headings", height=8, selectmode="none")
        for column, title, width, anchor in (
            ("app", "App", 260, "w"),
            ("cpu", "CPU", 70, "e"),
            ("ram", "RAM", 90, "e"),
            ("gpu", "GPU", 70, "e"),
        ):
            self.top.heading(column, text=title, anchor=anchor)
            self.top.column(column, width=t.px(width), anchor=anchor, stretch=column == "app")
        self.top.tag_configure("game", foreground=c["good"])
        self.top.grid(row=2, column=0, sticky="nsew")

        side = ttk.Frame(lower, style="Card.TFrame", padding=t.px(16))
        side.grid(row=0, column=1, sticky="nsew", padx=(t.px(6), 0))
        side.columnconfigure(0, weight=1)
        ttk.Label(side, text="Make your games smoother", style="CardH2.TLabel").grid(row=0, column=0, sticky="w")
        self._wrapping: list[ttk.Label] = []
        intro = ttk.Label(
            side,
            text=(
                "LagBuster checks your PC and lists what could cause lag or freezes. "
                "You pick which fixes to use - nothing changes until you press Apply, "
                "and every change can be undone."
            ),
            style="CardMuted.TLabel",
            justify="left",
        )
        intro.grid(row=1, column=0, sticky="ew", pady=(t.px(4), t.px(12)))
        self._wrapping.append(intro)
        ttk.Button(side, text="⚡  Find lag fixes", style="Accent.TButton", command=app.show_boost_and_scan).grid(
            row=2, column=0, sticky="ew"
        )
        self.overlay_button = ttk.Button(side, text="Show mini overlay", command=app.toggle_overlay)
        self.overlay_button.grid(row=3, column=0, sticky="ew", pady=(t.px(8), 0))
        overlay_hint = ttk.Label(
            side,
            text="A small always-on-top box with CPU, GPU and RAM usage while you play. "
            "Works when the game runs in borderless or windowed mode. Drag it anywhere.",
            style="CardFaint.TLabel",
            justify="left",
        )
        overlay_hint.grid(row=4, column=0, sticky="ew", pady=(t.px(4), t.px(12)))
        self._wrapping.append(overlay_hint)
        ttk.Separator(side).grid(row=5, column=0, sticky="ew", pady=(0, t.px(10)))
        self.io_label = ttk.Label(side, text="", style="CardMuted.TLabel", justify="left")
        self.io_label.grid(row=6, column=0, sticky="w")
        self.changes_label = ttk.Label(side, text="", style="CardWarn.TLabel", justify="left")
        self.changes_label.grid(row=7, column=0, sticky="w", pady=(t.px(6), 0))
        self._wrapping.append(self.changes_label)
        side.bind("<Configure>", self._rewrap)

    def _rewrap(self, event) -> None:
        width = max(120, event.width - self.app.theme.px(34))
        for label in self._wrapping:
            label.configure(wraplength=width)

    def update_overlay_button(self) -> None:
        self.overlay_button.configure(text="Hide mini overlay" if self.app.overlay else "Show mini overlay")

    def refresh(self, snap: Snapshot, history: list[HistoryPoint]) -> None:
        cores = f"{snap.cpu_cores} cores · {snap.cpu_threads} threads" if snap.cpu_cores else f"{snap.cpu_threads} threads"
        if snap.cpu_temp is not None:
            cores += f" · {snap.cpu_temp:.0f} °C"
        self.cpu.update_values(
            snap.cpu,
            cores,
            f"LagBuster itself uses {snap.self_cpu:.1f}% of it",
            [p.cpu for p in history],
        )
        swap = f" · page file {fmt_bytes(snap.swap_used)} used" if snap.swap_total else ""
        self.ram.update_values(
            snap.ram_percent,
            f"{fmt_bytes(snap.ram_used)} of {fmt_bytes(snap.ram_total)} in use",
            f"{fmt_bytes(snap.ram_available)} free{swap}",
            [p.ram for p in history],
        )
        gpu = snap.gpu
        if gpu is not None:
            parts = []
            if gpu.mem_total:
                parts.append(f"{'Memory' if gpu.integrated else 'VRAM'} {fmt_bytes(gpu.mem_used)} / {fmt_bytes(gpu.mem_total)}")
            if gpu.temp is not None:
                parts.append(f"{gpu.temp:.0f} °C")
            if gpu.power_w:
                parts.append(f"{gpu.power_w:.0f} W")
            others = len(snap.gpus) - 1
            name = _shorten(gpu.name, 36) + (f"  (+{others} more)" if others > 0 else "")
            self.gpu.update_values(gpu.util, name, " · ".join(parts) or "Load only", [p.gpu for p in history])
        else:
            hint = "Update your graphics driver to see GPU data" if IS_WINDOWS else "No supported graphics card found"
            self.gpu.update_values(None, "No graphics card data", hint, [])

        self._refresh_top(snap)
        self.io_label.configure(
            text=f"Internet  ↓ {fmt_rate(snap.net_recv)}   ↑ {fmt_rate(snap.net_sent)}\n"
            f"Disk      read {fmt_rate(snap.disk_read)}   write {fmt_rate(snap.disk_write)}"
            + (f"\nBattery   {snap.battery_percent:.0f}%{' (on battery!)' if snap.on_battery else ''}" if snap.battery_percent is not None else "")
        )
        active = self.app.journal.descriptions()
        self.changes_label.configure(
            text=(f"{len(active)} LagBuster change(s) active - see the Boost tab to undo." if active else "")
        )
        self.update_overlay_button()

    def _refresh_top(self, snap: Snapshot) -> None:
        groups = self.app.groups
        if not groups:
            return
        total = snap.ram_total or 1
        ranked = sorted(
            groups.values(),
            key=lambda g: g.cpu * 2 + g.gpu + 100.0 * g.rss / total,
            reverse=True,
        )[:8]
        game = self.app.current_game()
        wanted = []
        for group in ranked:
            name = group.display
            if IS_WINDOWS and group.key not in ("system", "registry", "memory compression"):
                name = display_name(group, winapi.file_description)
            if len(group.procs) > 1:
                name += f"  ({len(group.procs)})"
            values = (
                name,
                f"{group.cpu:.1f}%",
                fmt_bytes(group.rss),
                f"{group.gpu:.0f}%" if group.gpu >= 0.5 else "",
            )
            wanted.append((group.key, values, ("game",) if game and group.key == game.key else ()))
        existing = set(self.top.get_children())
        keep = {key for key, _, _ in wanted}
        for iid in existing - keep:
            self.top.delete(iid)
        for index, (key, values, tags) in enumerate(wanted):
            if key in existing:
                self.top.item(key, values=values, tags=tags)
                self.top.move(key, "", index)
            else:
                self.top.insert("", index, iid=key, values=values, tags=tags)
