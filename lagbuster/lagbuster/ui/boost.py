"""Boost tab: scan the PC, show suggestions with checkboxes, apply or undo."""

from __future__ import annotations

import time
import tkinter as tk
from tkinter import messagebox, ttk

from ..actions import ActionResult, CloseApp
from ..advisor import ScanResult, Suggestion
from ..platform_utils import open_target
from .theme import IMPACT_TEXT, LOAD_TEXT, blend
from .widgets import ScrollFrame, badge

NO_GAME = "No game running - just check my PC"
PICK_OTHER = "My game isn't listed…"

SECTIONS = (
    ("fix", "Fixes LagBuster can apply", "Tick the ones you want. Every change can be undone with one click."),
    ("apps", "Background apps", "They use your PC's power while you play. Choose: close them, or just lower their priority."),
    ("tip", "Tips - things to check yourself", "LagBuster can't change these for you, but they matter for smooth games."),
    ("ok", "Already good", ""),
)


class SuggestionRow(ttk.Frame):
    def __init__(self, master, tab: "BoostTab", suggestion: Suggestion) -> None:
        t, c = tab.app.theme, tab.app.theme.c
        super().__init__(master, style="Card.TFrame", padding=(t.px(14), t.px(12), t.px(16), t.px(12)))
        self.tab = tab
        self.s = suggestion
        self.columnconfigure(1, weight=1)
        self.var = tk.BooleanVar(value=suggestion.checked)
        if suggestion.actionable:
            check = ttk.Checkbutton(self, variable=self.var, style="Card.TCheckbutton", command=self._changed)
            check.grid(row=0, column=0, sticky="nw", pady=(t.px(1), 0))
        else:
            color = c.get(suggestion.impact, c["low"])
            tk.Label(self, text="ℹ", font=t.font["title"], fg=color, bg=c["panel"], width=2).grid(
                row=0, column=0, sticky="nw", padx=(0, t.px(4))
            )
        title = ttk.Label(self, text=suggestion.title, style="CardBold.TLabel", font=t.font["title"])
        title.grid(row=0, column=1, sticky="w")
        if suggestion.actionable:
            title.bind("<Button-1>", lambda _e: self.toggle())
            title.configure(cursor="hand2")

        right = ttk.Frame(self, style="Card.TFrame")
        right.grid(row=0, column=2, rowspan=4, sticky="ne", padx=(t.px(12), 0))
        labels = LOAD_TEXT if suggestion.section == "apps" else IMPACT_TEXT
        color = c.get(suggestion.impact, c["low"])
        badge(right, t, labels.get(suggestion.impact, suggestion.impact), color).pack(side="top", anchor="e")
        self.choice_var = tk.StringVar(value=suggestion.choice or "")
        if len(suggestion.actions) > 1:
            box = ttk.Combobox(
                right,
                textvariable=self.choice_var,
                values=list(suggestion.actions),
                state="readonly",
                width=20,
            )
            box.pack(side="top", anchor="e", pady=(t.px(8), 0))
            box.bind("<<ComboboxSelected>>", self._choice_changed)
        if suggestion.link:
            text, target = suggestion.link
            ttk.Button(right, text=f"{text} ›", style="Link.TButton", command=lambda: open_target(target)).pack(
                side="top", anchor="e", pady=(t.px(8), 0)
            )

        self.labels: list[ttk.Label] = []
        row = 1
        if suggestion.detail:
            detail = ttk.Label(self, text=suggestion.detail, style="CardMuted.TLabel", justify="left")
            detail.grid(row=row, column=1, sticky="ew", pady=(t.px(4), 0))
            self.labels.append(detail)
            row += 1
        if suggestion.caution:
            caution = ttk.Label(self, text=suggestion.caution, style="CardWarn.TLabel", justify="left")
            caution.grid(row=row, column=1, sticky="ew", pady=(t.px(4), 0))
            self.labels.append(caution)
            row += 1
        if suggestion.app_key:
            ttk.Button(
                self,
                text="Never suggest this app",
                style="Link.TButton",
                command=lambda: tab.never_suggest(self),
            ).grid(row=row, column=1, sticky="w", pady=(t.px(4), 0))
        self.bind("<Configure>", self._rewrap)

    def _rewrap(self, event) -> None:
        width = max(160, event.width - self.tab.app.theme.px(290))
        for label in self.labels:
            label.configure(wraplength=width)

    def toggle(self) -> None:
        self.var.set(not self.var.get())
        self._changed()

    def _changed(self) -> None:
        self.s.checked = self.var.get()
        self.tab.update_apply_button()

    def _choice_changed(self, _event=None) -> None:
        self.s.choice = self.choice_var.get()
        if not self.var.get():
            self.var.set(True)
            self._changed()


class BoostTab(ttk.Frame):
    def __init__(self, master, app) -> None:
        super().__init__(master, padding=app.theme.px(12))
        self.app = app
        t, c = app.theme, app.theme.c
        self.rows: list[SuggestionRow] = []
        self.result: ScanResult | None = None
        self.busy = False
        self._game_keys: dict[str, str | None] = {}
        self._user_game: str | None = None  # key the user picked ("" = no game)
        self.columnconfigure(0, weight=1)
        self.rowconfigure(2, weight=1)

        top = ttk.Frame(self, style="Card.TFrame", padding=(t.px(16), t.px(12)))
        top.grid(row=0, column=0, sticky="ew")
        top.columnconfigure(3, weight=1)
        ttk.Label(top, text="Your game", style="CardTitle.TLabel").grid(row=0, column=0, sticky="w", padx=(0, t.px(10)))
        self.game_var = tk.StringVar(value=NO_GAME)
        self.game_box = ttk.Combobox(top, textvariable=self.game_var, state="readonly", width=44)
        self.game_box.grid(row=0, column=1, sticky="w")
        self.game_box.bind("<<ComboboxSelected>>", self._game_selected)
        self.scan_button = ttk.Button(top, text="Scan my PC", style="Accent.TButton", command=self.start_scan)
        self.scan_button.grid(row=0, column=4, sticky="e")
        self.status = ttk.Label(
            top,
            text="Tip: start your game first (then Alt+Tab here) - LagBuster can then tune things for it.",
            style="CardMuted.TLabel",
        )
        self.status.grid(row=1, column=0, columnspan=5, sticky="w", pady=(t.px(8), 0))

        self.banner = ttk.Frame(self, style="Card.TFrame", padding=(t.px(16), t.px(10)))
        self.banner.columnconfigure(0, weight=1)
        self.banner_label = ttk.Label(self.banner, text="", style="CardWarn.TLabel", justify="left")
        self.banner_label.grid(row=0, column=0, sticky="w")
        ttk.Button(self.banner, text="Undo them", command=self.undo_all).grid(row=0, column=1, sticky="e")
        self._refresh_banner()

        self.list = ScrollFrame(self, t)
        self.list.grid(row=2, column=0, sticky="nsew", pady=(t.px(10), t.px(10)))
        self.list.inner.columnconfigure(0, weight=1)
        self._show_intro()

        bottom = ttk.Frame(self, style="Card.TFrame", padding=(t.px(16), t.px(10)))
        bottom.grid(row=3, column=0, sticky="ew")
        bottom.columnconfigure(2, weight=1)
        self.recommended_button = ttk.Button(bottom, text="Tick recommended", command=self.select_recommended)
        self.recommended_button.grid(row=0, column=0)
        self.none_button = ttk.Button(bottom, text="Untick all", command=self.select_none)
        self.none_button.grid(row=0, column=1, padx=(t.px(6), 0))
        self.undo_button = ttk.Button(bottom, text="Undo all changes", command=self.undo_all)
        self.undo_button.grid(row=0, column=3, padx=(0, t.px(6)))
        self.apply_button = ttk.Button(
            bottom, text="Apply selected", style="Accent.TButton", command=self.apply_selected, state="disabled"
        )
        self.apply_button.grid(row=0, column=4)
        self.log = tk.Text(
            bottom,
            height=3,
            bg=c["panel"],
            fg=c["muted"],
            relief="flat",
            wrap="word",
            font=t.font["small"],
            highlightthickness=0,
            bd=0,
            padx=0,
            pady=t.px(4),
        )
        self.log.tag_configure("ok", foreground=c["good"])
        self.log.tag_configure("fail", foreground=c["warn"])
        self.log.tag_configure("info", foreground=c["muted"])
        self.log.grid(row=1, column=0, columnspan=5, sticky="ew", pady=(t.px(8), 0))
        self.log.configure(state="disabled")
        self.log.grid_remove()  # shown once there is something to report

    # -- game selection ---------------------------------------------------------
    def selected_game_key(self) -> str | None:
        """None = pick automatically, "" = no game, otherwise the app key."""
        return self._user_game

    def refresh_games(self) -> None:
        games = self.app.detected_games
        options: dict[str, str | None] = {}
        for game in games:
            exe = game.group.procs[0].name if game.group.procs else game.key
            options[f"{game.title}   ({exe})"] = game.key
        options[NO_GAME] = ""
        options[PICK_OTHER] = None
        if list(options) != list(self._game_keys):
            self._game_keys = options
            self.game_box.configure(values=list(options))
        wanted = self._user_game
        if wanted is None:
            top = games[0] if games and games[0].score >= 60 else None
            wanted = top.key if top else ""
        label = next((text for text, key in options.items() if key == wanted), NO_GAME)
        if self.game_var.get() != label:
            self.game_var.set(label)

    def _game_selected(self, _event=None) -> None:
        label = self.game_var.get()
        if label == PICK_OTHER:
            self.app.notebook.select(self.app.processes)
            self.app.processes.show_message(
                "Find your game in the list, right-click it and choose “This is my game”.", good=True
            )
            self.refresh_games()
            return
        key = self._game_keys.get(label, "")
        self._user_game = key
        self.app.settings.last_game = key or ""
        if key:
            self.app.settings.add_unique("my_games", key)
        self.app.settings.save()
        self.app._update_game_pill()

    def select_game(self, key: str) -> None:
        self._user_game = key
        self.refresh_games()
        self.app._update_game_pill()

    # -- scanning -------------------------------------------------------------------
    def _show_intro(self) -> None:
        t = self.app.theme
        card = ttk.Frame(self.list.inner, style="Card.TFrame", padding=t.px(22))
        card.grid(row=0, column=0, sticky="ew")
        card.columnconfigure(0, weight=1)
        ttk.Label(card, text="Press “Scan my PC” to find what slows your games down", style="CardH2.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        text = (
            "LagBuster measures your PC for a few seconds and then lists what it found:\n\n"
            "  •  apps running in the background that eat RAM, CPU or GPU power\n"
            "  •  Windows power settings that slow the processor down\n"
            "  •  Xbox Game Bar recording in the background, Game Mode switched off\n"
            "  •  RAM or graphics memory running out (the usual cause of freezes)\n"
            "  •  overheating, a nearly full drive, and internet hogs that cause lag spikes\n\n"
            "You decide what to do with each one. Nothing changes until you press “Apply selected”, "
            "and “Undo all changes” puts everything back."
        )
        label = ttk.Label(card, text=text, style="CardMuted.TLabel", justify="left")
        label.grid(row=1, column=0, sticky="w", pady=(t.px(8), 0))
        card.bind("<Configure>", lambda e: label.configure(wraplength=max(200, e.width - t.px(50))))

    def start_scan(self) -> None:
        if self.busy:
            return
        self._set_busy(True, "Scanning…")
        self.status.configure(text="Measuring your PC for a few seconds…")
        self.app.run_background(lambda: self.app.scan_worker(self._user_game), self._scan_done, self._scan_failed)

    def _scan_failed(self, error: Exception) -> None:
        self._set_busy(False)
        self.status.configure(text=f"The scan didn't work: {error}")

    def _scan_done(self, result: ScanResult) -> None:
        self._set_busy(False)
        self.result = result
        if self._user_game is None and result.game is not None:
            self.refresh_games()
        self.render(result)
        fixes = sum(1 for s in result.suggestions if s.section in ("fix", "apps"))
        tips = sum(1 for s in result.suggestions if s.section == "tip")
        game = f" for {result.game.title}" if result.game else ""
        when = time.strftime("%H:%M")
        if fixes or tips:
            summary = f"Scanned at {when}{game}: {fixes} fix(es) to choose from and {tips} tip(s)."
        else:
            summary = f"Scanned at {when}{game}: everything looks good!"
        self.status.configure(text=summary)
        self._refresh_banner()

    def render(self, result: ScanResult) -> None:
        t, c = self.app.theme, self.app.theme.c
        for child in self.list.inner.winfo_children():
            child.destroy()
        self.rows = []
        row_index = 0
        for section, title, subtitle in SECTIONS:
            items = [s for s in result.suggestions if s.section == section]
            if not items:
                continue
            header = ttk.Frame(self.list.inner)
            header.grid(row=row_index, column=0, sticky="ew", pady=(t.px(14) if row_index else 0, t.px(6)))
            ttk.Label(header, text=title, style="Section.TLabel").pack(side="left")
            if subtitle:
                ttk.Label(header, text="   " + subtitle, style="Muted.TLabel").pack(side="left", pady=(t.px(3), 0))
            row_index += 1
            if section == "ok":
                card = ttk.Frame(self.list.inner, style="Card.TFrame", padding=(t.px(16), t.px(10)))
                card.grid(row=row_index, column=0, sticky="ew")
                card.columnconfigure((0, 1), weight=1, uniform="ok")
                for index, item in enumerate(items):
                    tk.Label(
                        card,
                        text="✔  " + item.title,
                        font=t.font["base"],
                        fg=c["good"],
                        bg=c["panel"],
                        anchor="w",
                    ).grid(row=index // 2, column=index % 2, sticky="w", pady=t.px(3))
                row_index += 1
                continue
            for item in items:
                suggestion_row = SuggestionRow(self.list.inner, self, item)
                suggestion_row.grid(row=row_index, column=0, sticky="ew", pady=(0, t.px(6)))
                self.rows.append(suggestion_row)
                row_index += 1
        self.list.scroll_to_top()
        self.update_apply_button()

    # -- selection ----------------------------------------------------------------------
    def _selected_rows(self) -> list[SuggestionRow]:
        return [row for row in self.rows if row.s.actionable and row.var.get()]

    def update_apply_button(self) -> None:
        count = len(self._selected_rows())
        self.apply_button.configure(
            text=f"Apply selected ({count})" if count else "Apply selected",
            state="normal" if count and not self.busy else "disabled",
        )

    def select_recommended(self) -> None:
        for row in self.rows:
            if row.s.actionable:
                row.var.set(row.s.recommended)
                row.s.checked = row.s.recommended
        self.update_apply_button()

    def select_none(self) -> None:
        for row in self.rows:
            row.var.set(False)
            row.s.checked = False
        self.update_apply_button()

    def never_suggest(self, row: SuggestionRow) -> None:
        key = row.s.app_key
        if not key:
            return
        self.app.settings.add_unique("protected_apps", key)
        self.app.settings.save()
        row.destroy()
        self.rows.remove(row)
        self.update_apply_button()
        self._log([ActionResult(True, f"LagBuster won't suggest {row.s.title} again (undo this in Settings).")])
        self.app.settings_tab.sync()

    # -- apply / undo ---------------------------------------------------------------------
    def apply_selected(self) -> None:
        chosen = self._selected_rows()
        if not chosen:
            return
        closing = [row.s.title for row in chosen if isinstance(row.s.selected_action(), CloseApp)]
        if closing:
            message = (
                "These apps will be closed:\n\n  •  "
                + "\n  •  ".join(closing)
                + "\n\nSave anything you're working on in them first. Continue?"
            )
            if not messagebox.askyesno("Close apps?", message, parent=self):
                return
        for row in self.rows:
            if row.s.actionable:
                self.app.settings.remember_choice(row.s.id, row.var.get(), row.s.choice)
        self.app.settings.save()
        actions = [action for action in (row.s.selected_action() for row in chosen) if action is not None]
        self._set_busy(True, "Applying…")
        self._log([], clear=True)
        self.status.configure(text="Applying your choices…")
        self.app.apply_actions(actions, self._applied, progress=self._progress)

    def _progress(self, text: str) -> None:
        self.status.configure(text=f"{text}…")

    def _applied(self, results: list[ActionResult]) -> None:
        self._set_busy(False)
        self._log(results)
        worked = sum(1 for r in results if r.ok)
        self.status.configure(text=f"Done: {worked} of {len(results)} change(s) worked. Checking again…")
        self._refresh_banner()
        self.after(1200, self.start_scan)

    def undo_all(self) -> None:
        if self.busy:
            return
        if not len(self.app.journal) and not self.app.demo:
            self._log([ActionResult(True, "There's nothing to undo - LagBuster hasn't changed anything.")], clear=True)
            return
        self._set_busy(True, "Undoing…")
        self.status.configure(text="Putting everything back the way it was…")
        self.app.undo_all(self._undone)

    def _undone(self, results: list[ActionResult]) -> None:
        self._set_busy(False)
        self._log(results or [ActionResult(True, "Everything is back the way it was.")], clear=True)
        self.status.configure(text="Undo finished.")
        self._refresh_banner()

    # -- helpers ------------------------------------------------------------------------------
    def _refresh_banner(self) -> None:
        items = self.app.journal.descriptions()
        if items:
            shown = items[:4]
            more = f"\n  …and {len(items) - len(shown)} more" if len(items) > len(shown) else ""
            self.banner_label.configure(
                text="These LagBuster changes are active:\n  •  " + "\n  •  ".join(shown) + more
            )
            self.banner.grid(row=1, column=0, sticky="ew", pady=(self.app.theme.px(10), 0))
        else:
            self.banner.grid_remove()

    def _set_busy(self, busy: bool, button_text: str | None = None) -> None:
        self.busy = busy
        state = "disabled" if busy else "normal"
        self.scan_button.configure(state=state, text=button_text if busy and button_text else ("Scan again" if self.result else "Scan my PC"))
        for button in (self.undo_button, self.recommended_button, self.none_button):
            button.configure(state=state)
        self.update_apply_button()

    def _log(self, results: list[ActionResult], clear: bool = False) -> None:
        self.log.grid()
        self.log.configure(state="normal")
        if clear:
            self.log.delete("1.0", "end")
        for result in results:
            if not result.message:
                continue
            separator = "\n" if self.log.get("1.0", "end-1c") else ""
            self.log.insert("end", separator + ("✔  " if result.ok else "⚠  ") + result.message, "ok" if result.ok else "fail")
        lines = int(self.log.index("end-1c").split(".")[0])
        self.log.configure(height=max(1, min(7, lines)))
        self.log.see("end-1c")
        self.log.configure(state="disabled")
        self.log.configure(fg=blend(self.app.theme.c["muted"], self.app.theme.c["text"], 0.2))
