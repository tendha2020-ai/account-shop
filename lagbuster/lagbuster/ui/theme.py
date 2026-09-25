"""Colors, fonts and ttk styles for LagBuster's dark look."""

from __future__ import annotations

import tkinter as tk
from tkinter import font as tkfont
from tkinter import ttk

COLORS = {
    "bg": "#0d1016",
    "panel": "#151a23",
    "panel2": "#1d2431",
    "hover": "#263041",
    "border": "#283243",
    "grid": "#222a37",
    "text": "#e8ecf3",
    "muted": "#98a2b5",
    "faint": "#687388",
    "accent": "#7c5cff",
    "accent_hover": "#9277ff",
    "accent_dim": "#3a2f78",
    "cpu": "#4aa8ff",
    "ram": "#b77dff",
    "gpu": "#2fe0a0",
    "vram": "#ffb454",
    "good": "#3ddc84",
    "warn": "#ffb020",
    "bad": "#ff5d5d",
    "high": "#ff6b6b",
    "medium": "#ffb020",
    "low": "#6fa8ff",
    "select": "#2f2a5c",
}

IMPACT_TEXT = {"high": "High impact", "medium": "Medium impact", "low": "Small impact"}
LOAD_TEXT = {"high": "Heavy", "medium": "Moderate", "low": "Light"}


def blend(color: str, other: str, amount: float) -> str:
    """Mix ``color`` towards ``other`` (amount 0..1)."""
    a = [int(color[i : i + 2], 16) for i in (1, 3, 5)]
    b = [int(other[i : i + 2], 16) for i in (1, 3, 5)]
    mixed = [round(x + (y - x) * amount) for x, y in zip(a, b)]
    return "#" + "".join(f"{v:02x}" for v in mixed)


def level_color(value: float | None, base: str, warn_at: float = 75, bad_at: float = 90) -> str:
    if value is None:
        return COLORS["faint"]
    if value >= bad_at:
        return COLORS["bad"]
    if value >= warn_at:
        return COLORS["warn"]
    return base


class Theme:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.c = COLORS
        families = set(tkfont.families(root))
        self.family = next(
            (
                name
                for name in ("Segoe UI", "Inter", "Cantarell", "Ubuntu", "Noto Sans", "DejaVu Sans", "Helvetica", "Arial")
                if name in families
            ),
            "TkDefaultFont",
        )
        self.mono = next(
            (name for name in ("Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Menlo", "Courier New") if name in families),
            "TkFixedFont",
        )
        self.scale = max(1.0, root.winfo_fpixels("1i") / 96.0)
        family = self.family
        self.font = {
            "base": (family, 10),
            "small": (family, 9),
            "tiny": (family, 8),
            "bold": (family, 10, "bold"),
            "small_bold": (family, 9, "bold"),
            "title": (family, 11, "bold"),
            "h2": (family, 12, "bold"),
            "h1": (family, 17, "bold"),
            "big": (family, 24, "bold"),
            "mono": (self.mono, 10, "bold"),
        }
        self._configure()

    def px(self, value: float) -> int:
        return int(round(value * self.scale))

    def _checkbox_image(self, size: int, gap: int, fill: str, border: str, tick: str | None) -> tk.PhotoImage:
        """A rounded check box drawn pixel by pixel (Tk has no anti-aliased drawing for images)."""
        image = tk.PhotoImage(master=self.root, width=size + gap, height=size)
        image.put(border, to=(0, 0, size, size))
        image.put(fill, to=(1, 1, size - 1, size - 1))
        for x, y in ((0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)):
            image.tk.call(image.name, "transparency", "set", x, y, True)
        if tick:
            thickness = max(2, size // 8)
            points = ((0.24, 0.52), (0.43, 0.71), (0.78, 0.30))
            for (x1, y1), (x2, y2) in zip(points, points[1:]):
                steps = size * 2
                for step in range(steps + 1):
                    fraction = step / steps
                    x = round((x1 + (x2 - x1) * fraction) * size - thickness / 2)
                    y = round((y1 + (y2 - y1) * fraction) * size - thickness / 2)
                    image.put(tick, to=(x, y, x + thickness, y + thickness))
        return image

    def _image_checkboxes(self, style: ttk.Style) -> None:
        c = self.c
        self._images: list[tk.PhotoImage] = []
        for style_name, element, size in (
            ("Card.TCheckbutton", "lbcard.indicator", 19),
            ("Setting.TCheckbutton", "lbsetting.indicator", 16),
        ):
            size, gap = self.px(size), self.px(10)
            off = self._checkbox_image(size, gap, c["panel2"], c["faint"], None)
            hover = self._checkbox_image(size, gap, c["hover"], c["muted"], None)
            on = self._checkbox_image(size, gap, c["accent"], c["accent"], "#ffffff")
            self._images += [off, hover, on]
            try:
                style.element_create(element, "image", off, ("selected", on), ("active", hover))
            except tk.TclError:
                return  # element already exists in this Tk interpreter
            style.layout(
                style_name,
                [
                    (
                        "Checkbutton.padding",
                        {
                            "sticky": "nswe",
                            "children": [
                                (element, {"side": "left", "sticky": ""}),
                                (
                                    "Checkbutton.focus",
                                    {"side": "left", "sticky": "w", "children": [("Checkbutton.label", {"sticky": "nswe"})]},
                                ),
                            ],
                        },
                    )
                ],
            )

    def _configure(self) -> None:
        c, f, root = self.c, self.font, self.root
        root.configure(bg=c["bg"])
        # Named fonts are the defaults for every widget; a global "*Font" option would
        # override the fonts of ttk label styles, so it is deliberately not used.
        for name, size, weight in (
            ("TkDefaultFont", 10, "normal"),
            ("TkTextFont", 10, "normal"),
            ("TkMenuFont", 10, "normal"),
            ("TkHeadingFont", 9, "bold"),
            ("TkCaptionFont", 11, "bold"),
            ("TkTooltipFont", 9, "normal"),
        ):
            try:
                tkfont.nametofont(name, root=root).configure(family=self.family, size=size, weight=weight)
            except tk.TclError:
                pass
        root.option_add("*TCombobox*Listbox.background", c["panel2"])
        root.option_add("*TCombobox*Listbox.foreground", c["text"])
        root.option_add("*TCombobox*Listbox.selectBackground", c["accent"])
        root.option_add("*TCombobox*Listbox.selectForeground", "#ffffff")
        root.option_add("*TCombobox*Listbox.font", f["base"])
        root.option_add("*Menu.background", c["panel2"])
        root.option_add("*Menu.foreground", c["text"])
        root.option_add("*Menu.activeBackground", c["accent"])
        root.option_add("*Menu.activeForeground", "#ffffff")
        root.option_add("*Menu.relief", "flat")

        style = ttk.Style(root)
        style.theme_use("clam")
        style.configure(
            ".",
            background=c["bg"],
            foreground=c["text"],
            font=f["base"],
            bordercolor=c["border"],
            lightcolor=c["panel2"],
            darkcolor=c["panel2"],
            troughcolor=c["panel"],
            focuscolor=c["accent"],
            selectbackground=c["accent"],
            selectforeground="#ffffff",
            fieldbackground=c["panel2"],
            insertcolor=c["text"],
        )
        style.configure("TFrame", background=c["bg"])
        style.configure("Card.TFrame", background=c["panel"])
        style.configure("Inner.TFrame", background=c["panel2"])

        labels = {
            "TLabel": (c["bg"], c["text"], f["base"]),
            "Muted.TLabel": (c["bg"], c["muted"], f["small"]),
            "H1.TLabel": (c["bg"], c["text"], f["h1"]),
            "Section.TLabel": (c["bg"], c["text"], f["h2"]),
            "Card.TLabel": (c["panel"], c["text"], f["base"]),
            "CardBold.TLabel": (c["panel"], c["text"], f["bold"]),
            "CardTitle.TLabel": (c["panel"], c["muted"], f["title"]),
            "CardH2.TLabel": (c["panel"], c["text"], f["h2"]),
            "CardMuted.TLabel": (c["panel"], c["muted"], f["small"]),
            "CardFaint.TLabel": (c["panel"], c["faint"], f["small"]),
            "CardWarn.TLabel": (c["panel"], c["warn"], f["small"]),
            "CardGood.TLabel": (c["panel"], c["good"], f["base"]),
            "CardBig.TLabel": (c["panel"], c["text"], f["big"]),
            "Status.TLabel": (c["panel"], c["muted"], f["small"]),
        }
        for name, (background, foreground, font) in labels.items():
            style.configure(name, background=background, foreground=foreground, font=font)

        button_padding = (self.px(14), self.px(7))
        style.configure(
            "TButton",
            background=c["panel2"],
            foreground=c["text"],
            bordercolor=c["border"],
            lightcolor=c["panel2"],
            darkcolor=c["panel2"],
            focusthickness=0,
            padding=button_padding,
            font=f["bold"],
        )
        style.map(
            "TButton",
            background=[("disabled", c["panel"]), ("pressed", c["hover"]), ("active", c["hover"])],
            foreground=[("disabled", c["faint"])],
            lightcolor=[("active", c["hover"])],
            darkcolor=[("active", c["hover"])],
        )
        style.configure(
            "Accent.TButton",
            background=c["accent"],
            foreground="#ffffff",
            bordercolor=c["accent"],
            lightcolor=c["accent"],
            darkcolor=c["accent"],
            padding=(self.px(18), self.px(8)),
        )
        style.map(
            "Accent.TButton",
            background=[("disabled", c["accent_dim"]), ("pressed", c["accent_hover"]), ("active", c["accent_hover"])],
            foreground=[("disabled", c["muted"])],
            bordercolor=[("disabled", c["accent_dim"]), ("active", c["accent_hover"])],
            lightcolor=[("disabled", c["accent_dim"]), ("active", c["accent_hover"])],
            darkcolor=[("disabled", c["accent_dim"]), ("active", c["accent_hover"])],
        )
        style.configure("Small.TButton", padding=(self.px(11), self.px(5)), font=f["small_bold"])
        style.configure(
            "Link.TButton",
            background=c["panel"],
            foreground=c["accent_hover"],
            bordercolor=c["panel"],
            lightcolor=c["panel"],
            darkcolor=c["panel"],
            padding=(self.px(2), self.px(2)),
            font=f["small_bold"],
        )
        style.map(
            "Link.TButton",
            background=[("active", c["panel"])],
            foreground=[("active", "#ffffff"), ("disabled", c["faint"])],
            lightcolor=[("active", c["panel"])],
            darkcolor=[("active", c["panel"])],
        )

        for name, font, size in (
            ("Card.TCheckbutton", f["title"], 17),
            ("Setting.TCheckbutton", f["base"], 15),
        ):
            style.configure(
                name,
                background=c["panel"],
                foreground=c["text"],
                indicatorbackground=c["panel2"],
                indicatorforeground="#ffffff",
                indicatorsize=self.px(size),
                indicatormargin=(0, 0, self.px(10), 0),
                upperbordercolor=c["faint"],
                lowerbordercolor=c["faint"],
                focusthickness=0,
                font=font,
            )
            style.map(
                name,
                background=[("active", c["panel"])],
                indicatorbackground=[("selected", c["accent"]), ("active", c["hover"])],
                upperbordercolor=[("selected", c["accent"])],
                lowerbordercolor=[("selected", c["accent"])],
            )
        self._image_checkboxes(style)
        style.configure("TCheckbutton", background=c["bg"], foreground=c["text"], indicatorbackground=c["panel2"])
        style.map("TCheckbutton", indicatorbackground=[("selected", c["accent"])], background=[("active", c["bg"])])

        style.configure("TNotebook", background=c["bg"], borderwidth=0, tabmargins=(self.px(10), self.px(6), self.px(10), 0))
        style.configure(
            "TNotebook.Tab",
            background=c["bg"],
            foreground=c["muted"],
            padding=(self.px(18), self.px(8)),
            borderwidth=0,
            bordercolor=c["bg"],
            lightcolor=c["bg"],
            font=f["bold"],
        )
        style.map(
            "TNotebook.Tab",
            background=[("selected", c["panel"]), ("active", c["panel2"])],
            foreground=[("selected", c["text"]), ("active", c["text"])],
            lightcolor=[("selected", c["panel"])],
            bordercolor=[("selected", c["panel"])],
        )

        style.configure(
            "Treeview",
            background=c["panel"],
            fieldbackground=c["panel"],
            foreground=c["text"],
            rowheight=self.px(26),
            borderwidth=0,
            bordercolor=c["panel"],
            lightcolor=c["panel"],
            darkcolor=c["panel"],
        )
        style.map("Treeview", background=[("selected", c["select"])], foreground=[("selected", "#ffffff")])
        style.configure(
            "Treeview.Heading",
            background=c["panel2"],
            foreground=c["muted"],
            relief="flat",
            font=f["small_bold"],
            padding=(self.px(8), self.px(6)),
            bordercolor=c["panel2"],
            lightcolor=c["panel2"],
            darkcolor=c["panel2"],
        )
        style.map("Treeview.Heading", background=[("active", c["hover"])])

        for orient in ("Vertical", "Horizontal"):
            style.configure(
                f"{orient}.TScrollbar",
                background=c["panel2"],
                troughcolor=c["panel"],
                bordercolor=c["panel"],
                arrowcolor=c["muted"],
                lightcolor=c["panel2"],
                darkcolor=c["panel2"],
                gripcount=0,
            )
            style.map(f"{orient}.TScrollbar", background=[("active", c["hover"])])

        style.configure(
            "TCombobox",
            fieldbackground=c["panel2"],
            background=c["panel2"],
            foreground=c["text"],
            arrowcolor=c["text"],
            bordercolor=c["border"],
            lightcolor=c["panel2"],
            darkcolor=c["panel2"],
            padding=(self.px(6), self.px(4)),
        )
        style.map(
            "TCombobox",
            fieldbackground=[("readonly", c["panel2"]), ("disabled", c["panel"])],
            foreground=[("readonly", c["text"]), ("disabled", c["faint"])],
            selectbackground=[("readonly", c["panel2"])],
            selectforeground=[("readonly", c["text"])],
            background=[("active", c["hover"])],
            bordercolor=[("focus", c["accent"])],
        )
        style.configure(
            "TEntry",
            fieldbackground=c["panel2"],
            foreground=c["text"],
            bordercolor=c["border"],
            lightcolor=c["panel2"],
            darkcolor=c["panel2"],
            padding=(self.px(6), self.px(4)),
        )
        style.map("TEntry", bordercolor=[("focus", c["accent"])])
        style.configure("Horizontal.TScale", background=c["accent"], troughcolor=c["panel2"], bordercolor=c["panel"])
        style.configure("TSeparator", background=c["border"])
        style.configure(
            "TMenubutton",
            background=c["panel2"],
            foreground=c["text"],
            arrowcolor=c["text"],
            bordercolor=c["border"],
            lightcolor=c["panel2"],
            darkcolor=c["panel2"],
            padding=(self.px(11), self.px(5)),
            font=f["small_bold"],
        )
        style.map("TMenubutton", background=[("active", c["hover"])])
