"""Settings tab."""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk

from .. import __version__
from ..platform_utils import IS_WINDOWS, open_target
from .widgets import ScrollFrame

REFRESH_CHOICES = {"Every 0.5 seconds": 0.5, "Every second": 1.0, "Every 2 seconds": 2.0, "Every 5 seconds": 5.0}
OPACITY_CHOICES = {"Solid": 1.0, "Slightly see-through": 0.85, "See-through": 0.7, "Very see-through": 0.5}


class SettingsTab(ttk.Frame):
    def __init__(self, master, app) -> None:
        super().__init__(master, padding=app.theme.px(12))
        self.app = app
        t = app.theme
        self.columnconfigure(0, weight=1)
        self.rowconfigure(0, weight=1)
        scroll = ScrollFrame(self, t)
        scroll.grid(row=0, column=0, sticky="nsew")
        body = scroll.inner
        body.columnconfigure((0, 1), weight=1, uniform="settings")
        self._wrapping: list[ttk.Label] = []
        settings = app.settings

        # Monitoring
        card = self._card(body, 0, 0, "Monitoring")
        ttk.Label(card, text="Update the numbers", style="Card.TLabel").grid(row=1, column=0, sticky="w")
        self.refresh_var = tk.StringVar(value=self._refresh_label(settings.refresh_seconds))
        refresh = ttk.Combobox(card, textvariable=self.refresh_var, values=list(REFRESH_CHOICES), state="readonly", width=18)
        refresh.grid(row=1, column=1, sticky="e")
        refresh.bind("<<ComboboxSelected>>", self._refresh_changed)
        self._hint(card, 2, "Slower updates use even less CPU while you play.")
        self.network_var = tk.BooleanVar(value=settings.network_test)
        ttk.Checkbutton(
            card,
            text="Test my internet connection during scans",
            variable=self.network_var,
            style="Setting.TCheckbutton",
            command=self._save_flags,
        ).grid(row=3, column=0, columnspan=2, sticky="w", pady=(t.px(10), 0))
        self._hint(card, 4, "Measures response time to 1.1.1.1 and 8.8.8.8 (takes about a second).")

        # Overlay
        card = self._card(body, 0, 1, "Mini overlay")
        self.overlay_var = tk.BooleanVar(value=settings.overlay_visible)
        ttk.Checkbutton(
            card,
            text="Show the mini overlay",
            variable=self.overlay_var,
            style="Setting.TCheckbutton",
            command=lambda: app.toggle_overlay(self.overlay_var.get()),
        ).grid(row=1, column=0, columnspan=2, sticky="w")
        ttk.Label(card, text="Visibility", style="Card.TLabel").grid(row=2, column=0, sticky="w", pady=(t.px(10), 0))
        self.opacity_var = tk.StringVar(value=self._opacity_label(settings.overlay_opacity))
        opacity = ttk.Combobox(
            card, textvariable=self.opacity_var, values=list(OPACITY_CHOICES), state="readonly", width=18
        )
        opacity.grid(row=2, column=1, sticky="e", pady=(t.px(10), 0))
        opacity.bind("<<ComboboxSelected>>", self._opacity_changed)
        ttk.Button(card, text="Move overlay back to the corner", command=self._reset_overlay).grid(
            row=3, column=0, columnspan=2, sticky="w", pady=(t.px(10), 0)
        )
        self._hint(card, 4, "Drag the overlay to move it; right-click it for options. Games in exclusive full-screen mode hide it - use borderless mode.")

        # Undo
        card = self._card(body, 1, 0, "Undo")
        self.undo_var = tk.BooleanVar(value=settings.undo_on_exit)
        ttk.Checkbutton(
            card,
            text="Undo my changes when LagBuster closes",
            variable=self.undo_var,
            style="Setting.TCheckbutton",
            command=self._save_flags,
        ).grid(row=1, column=0, columnspan=2, sticky="w")
        self._hint(
            card,
            2,
            "Off: changes stay until you press “Undo all changes” in the Boost tab (they survive a restart of LagBuster). "
            "Priority changes always end when the app closes.",
        )
        ttk.Button(card, text="Forget my remembered ticks", command=self._forget_choices).grid(
            row=3, column=0, columnspan=2, sticky="w", pady=(t.px(10), 0)
        )
        self._hint(card, 4, "LagBuster remembers which suggestions you ticked or unticked and pre-selects them next time.")

        # Administrator
        card = self._card(body, 1, 1, "Administrator rights")
        status = "LagBuster is running as administrator." if app.admin else "LagBuster is running as a normal user (recommended)."
        ttk.Label(card, text=status, style="Card.TLabel").grid(row=1, column=0, columnspan=2, sticky="w")
        self._hint(
            card,
            2,
            "Normal rights are enough for almost everything. Admin rights only help with apps that were "
            "themselves started as administrator.",
        )
        if IS_WINDOWS and not app.admin:
            ttk.Button(card, text="Restart as administrator", command=app.restart_as_admin).grid(
                row=3, column=0, columnspan=2, sticky="w", pady=(t.px(10), 0)
            )

        # Lists
        card = self._card(body, 2, 0, "My games")
        self.games_list = self._listbox(card, 1)
        ttk.Button(card, text="Remove", command=lambda: self._remove("my_games", self.games_list)).grid(
            row=2, column=0, sticky="w", pady=(t.px(8), 0)
        )
        self._hint(card, 3, "Add games in the Apps tab: right-click → “This is my game”.")

        card = self._card(body, 2, 1, "Apps LagBuster never suggests")
        self.protected_list = self._listbox(card, 1)
        ttk.Button(card, text="Remove", command=lambda: self._remove("protected_apps", self.protected_list)).grid(
            row=2, column=0, sticky="w", pady=(t.px(8), 0)
        )
        self._hint(card, 3, "Windows, driver and anti-cheat processes are always protected.")

        # About
        card = self._card(body, 3, 0, "About LagBuster", columnspan=2)
        sources = getattr(getattr(app.monitor, "gpu", None), "sources", None)
        about = (
            f"Version {__version__}. Graphics data from: {', '.join(sources) if sources else 'nothing yet (starting…)'}.\n"
            "LagBuster only uses normal Windows settings and the same system functions as Task Manager. "
            "It never touches game files, never reads or changes game memory, and never injects anything - "
            "so it's safe with anti-cheat games."
        )
        self.about_label = self._hint(card, 1, about)
        buttons = ttk.Frame(card, style="Card.TFrame")
        buttons.grid(row=2, column=0, columnspan=2, sticky="w", pady=(t.px(10), 0))
        ttk.Button(buttons, text="Open data folder", command=lambda: open_target(str(app.data_dir))).pack(side="left")

        body.bind("<Configure>", self._rewrap)
        self.sync()

    # -- helpers ---------------------------------------------------------------------
    def _card(self, parent, row: int, column: int, title: str, columnspan: int = 1) -> ttk.Frame:
        t = self.app.theme
        card = ttk.Frame(parent, style="Card.TFrame", padding=t.px(16))
        card.grid(
            row=row,
            column=column,
            columnspan=columnspan,
            sticky="nsew",
            padx=(0 if column == 0 else t.px(6), 0 if column + columnspan >= 2 else t.px(6)),
            pady=(0, t.px(12)),
        )
        card.columnconfigure(1, weight=1)
        ttk.Label(card, text=title, style="CardH2.TLabel").grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, t.px(8)))
        return card

    def _hint(self, card, row: int, text: str) -> ttk.Label:
        label = ttk.Label(card, text=text, style="CardFaint.TLabel", justify="left")
        label.grid(row=row, column=0, columnspan=2, sticky="w", pady=(self.app.theme.px(4), 0))
        self._wrapping.append(label)
        return label

    def _listbox(self, card, row: int) -> tk.Listbox:
        t, c = self.app.theme, self.app.theme.c
        box = tk.Listbox(
            card,
            height=4,
            bg=c["panel2"],
            fg=c["text"],
            selectbackground=c["accent"],
            selectforeground="#ffffff",
            highlightthickness=0,
            relief="flat",
            activestyle="none",
            font=t.font["base"],
        )
        box.grid(row=row, column=0, columnspan=2, sticky="ew")
        return box

    def _rewrap(self, event) -> None:
        width = max(160, event.width // 2 - self.app.theme.px(60))
        for label in self._wrapping:
            label.configure(wraplength=width)

    @staticmethod
    def _refresh_label(seconds: float) -> str:
        return next((label for label, value in REFRESH_CHOICES.items() if abs(value - seconds) < 0.01), "Every second")

    def sync(self) -> None:
        settings = self.app.settings
        self.overlay_var.set(self.app.overlay is not None)
        for box, values in ((self.games_list, settings.my_games), (self.protected_list, settings.protected_apps)):
            box.delete(0, "end")
            for value in values:
                box.insert("end", value)
        sources = getattr(getattr(self.app.monitor, "gpu", None), "sources", None)
        if sources is not None and "nothing yet" in self.about_label.cget("text"):
            text = self.about_label.cget("text").replace("nothing yet (starting…)", ", ".join(sources) or "not available")
            self.about_label.configure(text=text)

    def _refresh_changed(self, _event=None) -> None:
        seconds = REFRESH_CHOICES.get(self.refresh_var.get(), 1.0)
        self.app.settings.refresh_seconds = seconds
        self.app.monitor.set_interval(seconds)
        self.app.settings.save()

    def _save_flags(self) -> None:
        self.app.settings.network_test = self.network_var.get()
        self.app.settings.undo_on_exit = self.undo_var.get()
        self.app.settings.save()

    @staticmethod
    def _opacity_label(value: float) -> str:
        return min(OPACITY_CHOICES, key=lambda label: abs(OPACITY_CHOICES[label] - value))

    def _opacity_changed(self, _event=None) -> None:
        self.app.settings.overlay_opacity = OPACITY_CHOICES.get(self.opacity_var.get(), 0.85)
        if self.app.overlay is not None:
            self.app.overlay.set_opacity(self.app.settings.overlay_opacity)
        self.app.settings.save()

    def _reset_overlay(self) -> None:
        self.app.settings.overlay_x = None
        self.app.settings.overlay_y = None
        self.app.settings.save()
        if self.app.overlay is not None:
            self.app.overlay.place_default()

    def _forget_choices(self) -> None:
        self.app.settings.choices.clear()
        self.app.settings.save()

    def _remove(self, list_name: str, box: tk.Listbox) -> None:
        for index in reversed(box.curselection()):
            self.app.settings.remove(list_name, box.get(index))
        self.app.settings.save()
        self.app._games_at = 0.0
        self.sync()
