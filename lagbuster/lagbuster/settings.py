"""User settings, stored as JSON next to the undo journal."""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

log = logging.getLogger("lagbuster.settings")


@dataclass
class Settings:
    refresh_seconds: float = 1.0
    protected_apps: list[str] = field(default_factory=list)  # never suggest touching these
    my_games: list[str] = field(default_factory=list)  # apps the user marked as games
    last_game: str = ""
    choices: dict[str, dict] = field(default_factory=dict)  # remembered ticks per suggestion
    overlay_visible: bool = False
    overlay_opacity: float = 0.85
    overlay_x: int | None = None
    overlay_y: int | None = None
    undo_on_exit: bool = False
    network_test: bool = True

    path: Path | None = field(default=None, repr=False, compare=False)

    @classmethod
    def load(cls, path: Path) -> "Settings":
        settings = cls(path=path)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return settings
        except (OSError, ValueError) as exc:
            log.warning("ignoring unreadable settings %s: %s", path, exc)
            return settings
        if not isinstance(data, dict):
            return settings

        def number(key, low, high, default):
            value = data.get(key, default)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return default
            return min(high, max(low, float(value)))

        def string_list(key):
            value = data.get(key, [])
            return [str(v) for v in value if isinstance(v, str)] if isinstance(value, list) else []

        def optional_int(key):
            value = data.get(key)
            return int(value) if isinstance(value, int) and not isinstance(value, bool) else None

        settings.refresh_seconds = number("refresh_seconds", 0.5, 5.0, settings.refresh_seconds)
        settings.overlay_opacity = number("overlay_opacity", 0.3, 1.0, settings.overlay_opacity)
        settings.protected_apps = string_list("protected_apps")
        settings.my_games = string_list("my_games")
        settings.last_game = data.get("last_game") if isinstance(data.get("last_game"), str) else ""
        choices = data.get("choices")
        if isinstance(choices, dict):
            settings.choices = {str(k): v for k, v in choices.items() if isinstance(v, dict)}
        for key in ("overlay_visible", "undo_on_exit", "network_test"):
            if isinstance(data.get(key), bool):
                setattr(settings, key, data[key])
        settings.overlay_x = optional_int("overlay_x")
        settings.overlay_y = optional_int("overlay_y")
        return settings

    def save(self) -> None:
        if self.path is None:
            return
        data = asdict(self)
        data.pop("path", None)
        temp = self.path.with_suffix(".tmp")
        try:
            temp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            os.replace(temp, self.path)
        except OSError as exc:
            log.warning("could not save settings: %s", exc)

    def remember_choice(self, suggestion_id: str, checked: bool, mode: str | None) -> None:
        self.choices[suggestion_id] = {"checked": bool(checked), "mode": mode}

    def add_unique(self, list_name: str, value: str) -> None:
        values = getattr(self, list_name)
        if value and value not in values:
            values.append(value)

    def remove(self, list_name: str, value: str) -> None:
        values = getattr(self, list_name)
        if value in values:
            values.remove(value)
