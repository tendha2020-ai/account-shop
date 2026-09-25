"""Reusable widgets: live graphs, usage bars, meter cards and a scrollable frame."""

from __future__ import annotations

import sys
import tkinter as tk
from tkinter import ttk

from .theme import Theme, blend, level_color


class Sparkline(tk.Canvas):
    """A small filled line graph of the last ``points`` values (0-100)."""

    def __init__(self, master, theme: Theme, color: str, height: int = 64, points: int = 90) -> None:
        super().__init__(
            master, height=theme.px(height), bg=theme.c["panel"], highlightthickness=0, bd=0, width=theme.px(120)
        )
        self.theme = theme
        self.color = color
        self.fill = blend(color, theme.c["panel"], 0.78)
        self.points = points
        self.values: list[float | None] = []
        self.bind("<Configure>", lambda _event: self.redraw())

    def set_values(self, values: list[float | None]) -> None:
        self.values = list(values)[-self.points :]
        self.redraw()

    def set_color(self, color: str) -> None:
        if color != self.color:
            self.color = color
            self.fill = blend(color, self.theme.c["panel"], 0.78)
            self.redraw()

    def redraw(self) -> None:
        self.delete("all")
        width, height = self.winfo_width(), self.winfo_height()
        if width < 8 or height < 8:
            return
        pad = 2
        usable = height - 2 * pad
        for fraction in (0.25, 0.5, 0.75):
            y = pad + usable * (1 - fraction)
            self.create_line(0, y, width, y, fill=self.theme.c["grid"])
        values = [v for v in self.values]
        if len(values) < 2:
            return
        step = (width - 1) / max(1, self.points - 1)
        start = width - 1 - step * (len(values) - 1)
        coords: list[float] = []
        for index, value in enumerate(values):
            value = 0.0 if value is None else max(0.0, min(100.0, value))
            coords.extend((start + index * step, pad + usable * (1 - value / 100.0)))
        polygon = [coords[0], height] + coords + [coords[-2], height]
        self.create_polygon(polygon, fill=self.fill, outline="")
        self.create_line(coords, fill=self.color, width=max(1, self.theme.px(2)))


class UsageBar(tk.Canvas):
    """A thin horizontal bar showing a percentage."""

    def __init__(self, master, theme: Theme, color: str, height: int = 6, bg: str | None = None) -> None:
        self.theme = theme
        self.background = bg or theme.c["panel"]
        super().__init__(master, height=theme.px(height), bg=self.background, highlightthickness=0, bd=0, width=theme.px(60))
        self.color = color
        self.value: float | None = None
        self.bind("<Configure>", lambda _event: self.redraw())

    def set(self, value: float | None, color: str | None = None) -> None:
        self.value = value
        if color:
            self.color = color
        self.redraw()

    def redraw(self) -> None:
        self.delete("all")
        width, height = self.winfo_width(), self.winfo_height()
        if width < 4:
            return
        self.create_rectangle(0, 0, width, height, fill=self.theme.c["panel2"], outline="")
        if self.value:
            filled = width * max(0.0, min(100.0, self.value)) / 100.0
            self.create_rectangle(0, 0, filled, height, fill=self.color, outline="")


class MeterCard(ttk.Frame):
    """Big number + graph for CPU, RAM or GPU on the dashboard."""

    def __init__(self, master, theme: Theme, title: str, color: str, warn_levels: tuple[float, float] | None) -> None:
        super().__init__(master, style="Card.TFrame", padding=theme.px(16))
        self.theme = theme
        self.color = color
        self.warn_levels = warn_levels
        self.columnconfigure(0, weight=1)
        header = ttk.Frame(self, style="Card.TFrame")
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(0, weight=1)
        dot = tk.Canvas(header, width=theme.px(10), height=theme.px(10), bg=theme.c["panel"], highlightthickness=0)
        dot.create_oval(1, 1, theme.px(10) - 1, theme.px(10) - 1, fill=color, outline="")
        dot.grid(row=0, column=0, sticky="w")
        ttk.Label(header, text=title, style="CardTitle.TLabel").grid(row=0, column=0, sticky="w", padx=(theme.px(16), 0))
        self.value_label = tk.Label(header, text="–", font=theme.font["big"], bg=theme.c["panel"], fg=color)
        self.value_label.grid(row=0, column=1, rowspan=2, sticky="e")
        self.sub_label = ttk.Label(self, text="", style="CardBold.TLabel")
        self.sub_label.grid(row=1, column=0, sticky="w", pady=(theme.px(4), 0))
        self.detail_label = ttk.Label(self, text="", style="CardMuted.TLabel")
        self.detail_label.grid(row=2, column=0, sticky="w", pady=(theme.px(2), theme.px(10)))
        self.graph = Sparkline(self, theme, color)
        self.graph.grid(row=3, column=0, sticky="ew")
        self.bar = UsageBar(self, theme, color)
        self.bar.grid(row=4, column=0, sticky="ew", pady=(theme.px(8), 0))

    def update_values(self, value: float | None, sub: str, detail: str, history: list[float | None]) -> None:
        if self.warn_levels:
            color = level_color(value, self.color, *self.warn_levels)
        else:
            color = self.color if value is not None else self.theme.c["faint"]
        self.value_label.configure(text="–" if value is None else f"{value:.0f}%", fg=color)
        self.sub_label.configure(text=sub)
        self.detail_label.configure(text=detail)
        self.graph.set_values(history)
        self.bar.set(value, color)


class ScrollFrame(ttk.Frame):
    """A vertically scrolling container; put children in ``.inner``."""

    def __init__(self, master, theme: Theme, background: str | None = None) -> None:
        super().__init__(master)
        color = background or theme.c["bg"]
        self.canvas = tk.Canvas(self, bg=color, highlightthickness=0, bd=0)
        self.scrollbar = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.inner = ttk.Frame(self.canvas)
        self._window = self.canvas.create_window((0, 0), window=self.inner, anchor="nw")
        self.canvas.configure(yscrollcommand=self.scrollbar.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        self.scrollbar.grid(row=0, column=1, sticky="ns")
        self.rowconfigure(0, weight=1)
        self.columnconfigure(0, weight=1)
        self.inner.bind("<Configure>", lambda _e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfigure(self._window, width=e.width))
        self.canvas.bind("<Enter>", self._bind_wheel)
        self.canvas.bind("<Leave>", self._unbind_wheel)

    def _bind_wheel(self, _event=None) -> None:
        if sys.platform.startswith("linux"):
            self.canvas.bind_all("<Button-4>", self._on_wheel)
            self.canvas.bind_all("<Button-5>", self._on_wheel)
        else:
            self.canvas.bind_all("<MouseWheel>", self._on_wheel)

    def _unbind_wheel(self, _event=None) -> None:
        for sequence in ("<Button-4>", "<Button-5>", "<MouseWheel>"):
            self.canvas.unbind_all(sequence)

    def _on_wheel(self, event) -> None:
        if self.canvas.yview() == (0.0, 1.0):
            return
        if getattr(event, "num", None) == 4:
            steps = -1
        elif getattr(event, "num", None) == 5:
            steps = 1
        else:
            delta = event.delta
            if sys.platform == "darwin":
                steps = -delta
            else:
                steps = -int(delta / 120) or (-1 if delta > 0 else 1)
        self.canvas.yview_scroll(steps, "units")

    def scroll_to_top(self) -> None:
        self.canvas.yview_moveto(0)


def badge(master, theme: Theme, text: str, color: str, background: str | None = None) -> tk.Label:
    """A small colored pill label."""
    bg = background or blend(color, theme.c["panel"], 0.78)
    return tk.Label(
        master,
        text=text,
        font=theme.font["small_bold"],
        fg=color,
        bg=bg,
        padx=theme.px(8),
        pady=theme.px(2),
    )
