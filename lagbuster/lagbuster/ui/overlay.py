"""A tiny always-on-top box with live CPU / GPU / RAM numbers for while you play."""

from __future__ import annotations

import tkinter as tk

from ..monitor import Snapshot
from .theme import level_color

_BACKGROUND = "#0a0d13"


class Overlay(tk.Toplevel):
    def __init__(self, app) -> None:
        super().__init__(app.root)
        self.app = app
        t, c = app.theme, app.theme.c
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.set_opacity(app.settings.overlay_opacity)
        self.configure(bg=c["border"])
        frame = tk.Frame(self, bg=_BACKGROUND, padx=t.px(10), pady=t.px(5))
        frame.pack(padx=1, pady=1)
        self.labels: dict[str, tk.Label] = {}
        for key in ("cpu", "gpu", "ram", "vram", "temp"):
            label = tk.Label(frame, text="", font=t.font["mono"], fg=c["text"], bg=_BACKGROUND)
            label.pack(side="left", padx=(0, t.px(10)) if key != "temp" else 0)
            self.labels[key] = label
        self.menu = tk.Menu(self, tearoff=False)
        self.menu.add_command(label="Open LagBuster", command=self._open_app)
        self.menu.add_command(label="Move back to the corner", command=self.place_default)
        self.menu.add_separator()
        self.menu.add_command(label="Hide overlay", command=lambda: app.toggle_overlay(False))
        self._drag_offset = (0, 0)
        for widget in (self, frame, *self.labels.values()):
            widget.bind("<ButtonPress-1>", self._start_drag)
            widget.bind("<B1-Motion>", self._drag)
            widget.bind("<ButtonRelease-1>", self._end_drag)
            widget.bind("<Button-3>", self._show_menu)
        self.labels["cpu"].configure(text="CPU  –")
        self.update_idletasks()
        settings = app.settings
        # Until the user drags it, keep the box glued to the top-right corner even
        # when its width changes (e.g. when VRAM or temperature appear).
        self._auto_place = settings.overlay_x is None or settings.overlay_y is None
        self._placed_width = 0
        if self._auto_place:
            self.place_default()
        else:
            self.geometry(f"+{settings.overlay_x}+{settings.overlay_y}")
        self.after(3000, self._keep_on_top)

    def set_opacity(self, value: float) -> None:
        try:
            self.attributes("-alpha", max(0.3, min(1.0, value)))
        except tk.TclError:
            pass  # some Linux window managers don't support transparency

    def place_default(self) -> None:
        self.update_idletasks()
        self._auto_place = True
        self._placed_width = self.winfo_reqwidth()
        x = self.winfo_screenwidth() - self._placed_width - self.app.theme.px(24)
        y = self.app.theme.px(24)
        self.geometry(f"+{x}+{y}")

    def refresh(self, snap: Snapshot) -> None:
        c = self.app.theme.c
        self.labels["cpu"].configure(text=f"CPU {snap.cpu:3.0f}%", fg=level_color(snap.cpu, c["cpu"], 85, 95))
        gpu = snap.gpu
        if gpu is not None and gpu.util is not None:
            self.labels["gpu"].configure(text=f"GPU {gpu.util:3.0f}%", fg=c["gpu"])
        else:
            self.labels["gpu"].configure(text="GPU  –", fg=c["faint"])
        self.labels["ram"].configure(
            text=f"RAM {snap.ram_percent:3.0f}%", fg=level_color(snap.ram_percent, c["ram"], 80, 90)
        )
        vram = gpu.mem_percent if gpu is not None and not gpu.integrated else None
        self.labels["vram"].configure(
            text=f"VRAM {vram:3.0f}%" if vram is not None else "",
            fg=level_color(vram, c["vram"], 90, 96),
        )
        temp = gpu.temp if gpu is not None else None
        self.labels["temp"].configure(
            text=f"{temp:.0f}°C" if temp is not None else "",
            fg=level_color(temp, c["text"], 80, 86),
        )
        if self._auto_place:
            self.update_idletasks()
            if self.winfo_reqwidth() != self._placed_width:
                self.place_default()

    def _keep_on_top(self) -> None:
        try:
            self.attributes("-topmost", True)
            self.lift()
            self.after(3000, self._keep_on_top)
        except tk.TclError:
            pass

    def _start_drag(self, event) -> None:
        self._drag_offset = (event.x_root - self.winfo_x(), event.y_root - self.winfo_y())

    def _drag(self, event) -> None:
        x = event.x_root - self._drag_offset[0]
        y = event.y_root - self._drag_offset[1]
        self.geometry(f"+{x}+{y}")

    def _end_drag(self, _event) -> None:
        self._auto_place = False
        self.app.settings.overlay_x = self.winfo_x()
        self.app.settings.overlay_y = self.winfo_y()
        self.app.settings.save()

    def _show_menu(self, event) -> None:
        self.menu.tk_popup(event.x_root, event.y_root)

    def _open_app(self) -> None:
        root = self.app.root
        root.deiconify()
        root.lift()
        root.focus_force()

    def close(self) -> None:
        try:
            self.destroy()
        except tk.TclError:
            pass
