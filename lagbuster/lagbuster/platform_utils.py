"""Small cross-platform helpers shared by the rest of LagBuster."""

from __future__ import annotations

import ctypes
import logging
import os
import subprocess
import sys
from pathlib import Path

IS_WINDOWS = sys.platform == "win32"
IS_LINUX = sys.platform.startswith("linux")
IS_MAC = sys.platform == "darwin"

APP_NAME = "LagBuster"
PACKAGE_DIR = Path(__file__).resolve().parent

log = logging.getLogger("lagbuster")


def os_name() -> str:
    if IS_WINDOWS:
        return "windows"
    if IS_MAC:
        return "mac"
    return "linux"


def app_data_dir() -> Path:
    """Folder for settings, the undo journal and the log file.

    ``LAGBUSTER_HOME`` overrides the location (used by the tests).
    """
    override = os.environ.get("LAGBUSTER_HOME")
    if override:
        path = Path(override)
    elif IS_WINDOWS:
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        path = base / APP_NAME
    elif IS_MAC:
        path = Path.home() / "Library" / "Application Support" / APP_NAME
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        path = base / "lagbuster"
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        log.warning("could not create %s: %s", path, exc)
    return path


def asset_path(name: str) -> Path:
    """Path of a bundled asset (works from source and from the PyInstaller exe)."""
    return PACKAGE_DIR / "assets" / name


def decode_console(data: bytes) -> str:
    """Decode output of a console program (Windows tools use the OEM code page)."""
    if not data:
        return ""
    encodings = ("utf-8", "oem", "mbcs") if IS_WINDOWS else ("utf-8",)
    for encoding in encodings:
        try:
            return data.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


def run_command(args: list[str], timeout: float = 10.0) -> tuple[int, str]:
    """Run a console command without flashing a console window.

    Returns ``(exit_code, output)``; ``(-1, "")`` if the program could not run.
    """
    kwargs: dict = {}
    if IS_WINDOWS:
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    try:
        proc = subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            **kwargs,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.debug("command %s failed: %s", args, exc)
        return -1, ""
    return proc.returncode, decode_console(proc.stdout)


def open_target(target: str) -> bool:
    """Open a settings page (``ms-settings:...``), URL, folder or program."""
    try:
        if IS_WINDOWS:
            os.startfile(target)  # type: ignore[attr-defined]
        elif IS_MAC:
            subprocess.Popen(["open", target])
        else:
            subprocess.Popen(["xdg-open", target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except OSError as exc:
        log.warning("could not open %s: %s", target, exc)
        return False


def is_admin() -> bool:
    if IS_WINDOWS:
        try:
            return bool(ctypes.windll.shell32.IsUserAnAdmin())  # type: ignore[attr-defined]
        except (AttributeError, OSError):
            return False
    geteuid = getattr(os, "geteuid", None)
    return bool(geteuid and geteuid() == 0)


def current_user_key() -> str:
    """Lower-case name of the logged-in user, as psutil reports it."""
    name = os.environ.get("USERNAME") or os.environ.get("USER") or ""
    if not name:
        try:
            import getpass

            name = getpass.getuser()
        except (ImportError, KeyError, OSError):
            name = ""
    return name.split("\\")[-1].lower()


def fmt_bytes(value: float | None) -> str:
    if value is None:
        return "–"
    value = float(value)
    if value < 1024:
        return f"{value:.0f} B"
    for unit in ("KB", "MB", "GB", "TB"):
        value /= 1024
        if value < 1024 or unit == "TB":
            if unit in ("KB", "MB"):
                return f"{value:.0f} {unit}"
            return f"{value:.1f} {unit}"
    return f"{value:.1f} TB"


def fmt_rate(bytes_per_second: float | None) -> str:
    if bytes_per_second is None:
        return "–"
    mb = bytes_per_second / (1024 * 1024)
    if mb >= 0.1:
        return f"{mb:.1f} MB/s"
    return f"{bytes_per_second / 1024:.0f} KB/s"


def fmt_pct(value: float | None, digits: int = 0) -> str:
    if value is None:
        return "–"
    return f"{value:.{digits}f}%"
