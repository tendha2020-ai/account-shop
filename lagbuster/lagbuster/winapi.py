"""ctypes wrappers for the Windows APIs LagBuster uses.

Nothing here touches Windows at import time, so the module imports (and its
pure helpers can be tested) on any OS. Functions raise ``WinApiError`` when a
feature is unavailable; callers treat that as "not supported on this PC".

Everything used here is a normal, documented user-mode API (the same ones Task
Manager and the Settings app use). LagBuster never reads or writes the memory
of other programs and never injects anything into games.
"""

from __future__ import annotations

import ctypes
import functools
import sys
import uuid
from ctypes import wintypes
from dataclasses import dataclass

IS_WINDOWS = sys.platform == "win32"


class WinApiError(OSError):
    """A Windows API call failed or isn't available on this system."""


def _require_windows() -> None:
    if not IS_WINDOWS:
        raise WinApiError("only available on Windows")


def _load(name: str):
    _require_windows()
    try:
        return ctypes.WinDLL(name, use_last_error=True)  # type: ignore[attr-defined]
    except OSError as exc:
        raise WinApiError(f"{name} is not available: {exc}") from exc


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_uint32),
        ("Data2", ctypes.c_uint16),
        ("Data3", ctypes.c_uint16),
        ("Data4", ctypes.c_ubyte * 8),
    ]

    @classmethod
    def from_string(cls, text: str) -> "GUID":
        return cls.from_buffer_copy(uuid.UUID(text).bytes_le)

    def __str__(self) -> str:
        return str(uuid.UUID(bytes_le=bytes(self)))


# --------------------------------------------------------------------------
# Performance counters (PDH) - the data source behind Task Manager's graphs.
# --------------------------------------------------------------------------

PDH_FMT_DOUBLE = 0x00000200
PDH_FMT_NOCAP100 = 0x00008000
PDH_MORE_DATA = 0x800007D2
_PDH_VALID_STATUS = (0x0, 0x1)  # PDH_CSTATUS_VALID_DATA, PDH_CSTATUS_NEW_DATA


class _PdhValueUnion(ctypes.Union):
    _fields_ = [
        ("longValue", ctypes.c_int32),
        ("doubleValue", ctypes.c_double),
        ("largeValue", ctypes.c_int64),
        ("AnsiStringValue", ctypes.c_char_p),
        ("WideStringValue", ctypes.c_wchar_p),
    ]


class PDH_FMT_COUNTERVALUE(ctypes.Structure):
    _anonymous_ = ("_value",)
    _fields_ = [("CStatus", ctypes.c_uint32), ("_value", _PdhValueUnion)]


class PDH_FMT_COUNTERVALUE_ITEM_W(ctypes.Structure):
    _fields_ = [("szName", ctypes.c_wchar_p), ("FmtValue", PDH_FMT_COUNTERVALUE)]


@functools.lru_cache(maxsize=None)
def _pdh():
    dll = _load("pdh.dll")
    handle = wintypes.HANDLE
    dll.PdhOpenQueryW.argtypes = [wintypes.LPCWSTR, ctypes.c_size_t, ctypes.POINTER(handle)]
    dll.PdhOpenQueryW.restype = ctypes.c_uint32
    dll.PdhAddEnglishCounterW.argtypes = [handle, wintypes.LPCWSTR, ctypes.c_size_t, ctypes.POINTER(handle)]
    dll.PdhAddEnglishCounterW.restype = ctypes.c_uint32
    dll.PdhCollectQueryData.argtypes = [handle]
    dll.PdhCollectQueryData.restype = ctypes.c_uint32
    dll.PdhGetFormattedCounterValue.argtypes = [
        handle,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(PDH_FMT_COUNTERVALUE),
    ]
    dll.PdhGetFormattedCounterValue.restype = ctypes.c_uint32
    dll.PdhGetFormattedCounterArrayW.argtypes = [
        handle,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.POINTER(ctypes.c_uint32),
        ctypes.c_void_p,
    ]
    dll.PdhGetFormattedCounterArrayW.restype = ctypes.c_uint32
    dll.PdhCloseQuery.argtypes = [handle]
    dll.PdhCloseQuery.restype = ctypes.c_uint32
    return dll


class PdhQuery:
    """A set of performance counters that are collected together."""

    _FORMAT = PDH_FMT_DOUBLE | PDH_FMT_NOCAP100

    def __init__(self) -> None:
        self._dll = _pdh()
        self._handle = wintypes.HANDLE()
        status = self._dll.PdhOpenQueryW(None, 0, ctypes.byref(self._handle))
        if status != 0:
            raise WinApiError(f"PdhOpenQueryW failed (0x{status:08X})")
        self._counters: dict[str, wintypes.HANDLE] = {}

    def add(self, path: str) -> bool:
        """Add an English counter path such as ``\\Processor(*)\\% Processor Time``."""
        counter = wintypes.HANDLE()
        status = self._dll.PdhAddEnglishCounterW(self._handle, path, 0, ctypes.byref(counter))
        if status != 0:
            return False
        self._counters[path] = counter
        return True

    def collect(self) -> bool:
        return self._dll.PdhCollectQueryData(self._handle) == 0

    def value(self, path: str) -> float | None:
        counter = self._counters.get(path)
        if counter is None:
            return None
        out = PDH_FMT_COUNTERVALUE()
        status = self._dll.PdhGetFormattedCounterValue(counter, self._FORMAT, None, ctypes.byref(out))
        if status != 0 or out.CStatus not in _PDH_VALID_STATUS:
            return None
        return float(out.doubleValue)

    def values(self, path: str) -> dict[str, float]:
        """All instances of a wildcard counter as ``{instance name: value}``."""
        counter = self._counters.get(path)
        if counter is None:
            return {}
        for _attempt in range(4):
            size = ctypes.c_uint32(0)
            count = ctypes.c_uint32(0)
            status = self._dll.PdhGetFormattedCounterArrayW(
                counter, self._FORMAT, ctypes.byref(size), ctypes.byref(count), None
            )
            if status != PDH_MORE_DATA or size.value == 0:
                return {}
            buffer = (ctypes.c_ubyte * size.value)()
            status = self._dll.PdhGetFormattedCounterArrayW(
                counter, self._FORMAT, ctypes.byref(size), ctypes.byref(count), buffer
            )
            if status == PDH_MORE_DATA:
                continue  # instances appeared between the two calls; try again
            if status != 0:
                return {}
            items = ctypes.cast(buffer, ctypes.POINTER(PDH_FMT_COUNTERVALUE_ITEM_W))
            result: dict[str, float] = {}
            for index in range(count.value):
                item = items[index]
                name = item.szName
                if name and item.FmtValue.CStatus in _PDH_VALID_STATUS:
                    result[name] = result.get(name, 0.0) + float(item.FmtValue.doubleValue)
            return result
        return {}

    def close(self) -> None:
        if self._handle:
            self._dll.PdhCloseQuery(self._handle)
            self._handle = wintypes.HANDLE()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:  # noqa: BLE001 - never raise from a finalizer
            pass


# --------------------------------------------------------------------------
# Graphics adapters (DXGI): names, video memory size and LUIDs.
# --------------------------------------------------------------------------

_IID_IDXGIFactory1 = "770aae78-f26f-4dba-a829-253c83d1b387"
_DXGI_ADAPTER_FLAG_SOFTWARE = 2
_VTBL_RELEASE = 2
_VTBL_FACTORY1_ENUM_ADAPTERS1 = 12
_VTBL_ADAPTER1_GET_DESC1 = 10


class _LUID(ctypes.Structure):
    _fields_ = [("LowPart", ctypes.c_uint32), ("HighPart", ctypes.c_int32)]


class _DXGI_ADAPTER_DESC1(ctypes.Structure):
    _fields_ = [
        ("Description", ctypes.c_wchar * 128),
        ("VendorId", ctypes.c_uint32),
        ("DeviceId", ctypes.c_uint32),
        ("SubSysId", ctypes.c_uint32),
        ("Revision", ctypes.c_uint32),
        ("DedicatedVideoMemory", ctypes.c_size_t),
        ("DedicatedSystemMemory", ctypes.c_size_t),
        ("SharedSystemMemory", ctypes.c_size_t),
        ("AdapterLuid", _LUID),
        ("Flags", ctypes.c_uint32),
    ]


@dataclass
class DxgiAdapter:
    name: str
    vendor_id: int
    device_id: int
    dedicated_vram: int
    dedicated_system: int
    shared_memory: int
    luid: str
    software: bool


def luid_key(high: int, low: int) -> str:
    """LUID formatted the way GPU performance-counter instance names show it."""
    return f"0x{high & 0xFFFFFFFF:08x}_0x{low & 0xFFFFFFFF:08x}"


def _com_method(obj: ctypes.c_void_p, index: int, restype, *argtypes):
    vtable = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]
    prototype = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)  # type: ignore[attr-defined]
    return prototype(vtable[index])


def _com_release(obj: ctypes.c_void_p) -> None:
    if obj and obj.value:
        _com_method(obj, _VTBL_RELEASE, ctypes.c_uint32)(obj)


def list_dxgi_adapters() -> list[DxgiAdapter]:
    dxgi = _load("dxgi.dll")
    create = dxgi.CreateDXGIFactory1
    create.argtypes = [ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
    create.restype = ctypes.c_long
    factory = ctypes.c_void_p()
    iid = GUID.from_string(_IID_IDXGIFactory1)
    hr = create(ctypes.byref(iid), ctypes.byref(factory))
    if hr != 0 or not factory.value:
        raise WinApiError(f"CreateDXGIFactory1 failed (0x{hr & 0xFFFFFFFF:08X})")
    adapters: list[DxgiAdapter] = []
    try:
        enum_adapters1 = _com_method(
            factory,
            _VTBL_FACTORY1_ENUM_ADAPTERS1,
            ctypes.c_long,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_void_p),
        )
        for index in range(32):
            adapter = ctypes.c_void_p()
            if enum_adapters1(factory, index, ctypes.byref(adapter)) != 0 or not adapter.value:
                break  # DXGI_ERROR_NOT_FOUND: no more adapters
            try:
                get_desc1 = _com_method(
                    adapter, _VTBL_ADAPTER1_GET_DESC1, ctypes.c_long, ctypes.POINTER(_DXGI_ADAPTER_DESC1)
                )
                desc = _DXGI_ADAPTER_DESC1()
                if get_desc1(adapter, ctypes.byref(desc)) == 0:
                    adapters.append(
                        DxgiAdapter(
                            name=desc.Description.strip(),
                            vendor_id=desc.VendorId,
                            device_id=desc.DeviceId,
                            dedicated_vram=int(desc.DedicatedVideoMemory),
                            dedicated_system=int(desc.DedicatedSystemMemory),
                            shared_memory=int(desc.SharedSystemMemory),
                            luid=luid_key(desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart),
                            software=bool(desc.Flags & _DXGI_ADAPTER_FLAG_SOFTWARE),
                        )
                    )
            finally:
                _com_release(adapter)
    finally:
        _com_release(factory)
    return adapters


# --------------------------------------------------------------------------
# Windows, processes and memory.
# --------------------------------------------------------------------------

WM_CLOSE = 0x0010
PROCESS_SET_QUOTA = 0x0100
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


@functools.lru_cache(maxsize=None)
def _user32():
    dll = _load("user32")
    enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)  # type: ignore[attr-defined]
    dll.EnumWindows.argtypes = [enum_proc, wintypes.LPARAM]
    dll.EnumWindows.restype = wintypes.BOOL
    dll.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    dll.GetWindowThreadProcessId.restype = wintypes.DWORD
    dll.IsWindowVisible.argtypes = [wintypes.HWND]
    dll.IsWindowVisible.restype = wintypes.BOOL
    dll.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    dll.PostMessageW.restype = wintypes.BOOL
    dll.GetForegroundWindow.argtypes = []
    dll.GetForegroundWindow.restype = wintypes.HWND
    return dll, enum_proc


def visible_windows(pids) -> list[int]:
    """Handles of the visible top-level windows that belong to ``pids``."""
    dll, enum_proc = _user32()
    wanted = set(pids)
    found: list[int] = []

    def callback(hwnd, _lparam):
        pid = wintypes.DWORD()
        dll.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in wanted and dll.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    dll.EnumWindows(enum_proc(callback), 0)
    return found


def close_windows(pids) -> int:
    """Politely ask apps to close (like clicking their X button). Returns windows asked."""
    dll, _ = _user32()
    asked = 0
    for hwnd in visible_windows(pids):
        if dll.PostMessageW(hwnd, WM_CLOSE, 0, 0):
            asked += 1
    return asked


def foreground_pid() -> int | None:
    dll, _ = _user32()
    hwnd = dll.GetForegroundWindow()
    if not hwnd:
        return None
    pid = wintypes.DWORD()
    dll.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value or None


@functools.lru_cache(maxsize=None)
def _kernel32():
    dll = _load("kernel32")
    dll.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    dll.OpenProcess.restype = wintypes.HANDLE
    dll.CloseHandle.argtypes = [wintypes.HANDLE]
    dll.CloseHandle.restype = wintypes.BOOL
    dll.K32EmptyWorkingSet.argtypes = [wintypes.HANDLE]
    dll.K32EmptyWorkingSet.restype = wintypes.BOOL
    return dll


def empty_working_set(pid: int) -> bool:
    """Ask Windows to move a process's idle memory out of RAM (like RAMMap/Mem Reduct)."""
    dll = _kernel32()
    handle = dll.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA, False, pid)
    if not handle:
        return False
    try:
        return bool(dll.K32EmptyWorkingSet(handle))
    finally:
        dll.CloseHandle(handle)


@functools.lru_cache(maxsize=None)
def _version_dll():
    dll = _load("version")
    dll.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    dll.GetFileVersionInfoSizeW.restype = wintypes.DWORD
    dll.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    dll.GetFileVersionInfoW.restype = wintypes.BOOL
    dll.VerQueryValueW.argtypes = [
        ctypes.c_void_p,
        wintypes.LPCWSTR,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_uint32),
    ]
    dll.VerQueryValueW.restype = wintypes.BOOL
    return dll


@functools.lru_cache(maxsize=1024)
def file_description(path: str) -> str | None:
    """The "File description" of an .exe (e.g. "Google Chrome"), if it has one."""
    if not IS_WINDOWS or not path:
        return None
    try:
        dll = _version_dll()
        size = dll.GetFileVersionInfoSizeW(path, None)
        if not size:
            return None
        data = ctypes.create_string_buffer(size)
        if not dll.GetFileVersionInfoW(path, 0, size, ctypes.byref(data)):
            return None
        pointer = ctypes.c_void_p()
        length = ctypes.c_uint32()
        languages: list[tuple[int, int]] = []
        if (
            dll.VerQueryValueW(ctypes.byref(data), "\\VarFileInfo\\Translation", ctypes.byref(pointer), ctypes.byref(length))
            and pointer.value
            and length.value >= 4
        ):
            words = (ctypes.c_uint16 * (length.value // 2)).from_address(pointer.value)
            languages = [(words[i], words[i + 1]) for i in range(0, len(words) - 1, 2)]
        languages += [(0x0409, 0x04B0), (0x0409, 0x04E4), (0x0000, 0x04B0)]
        for language, codepage in languages:
            key = f"\\StringFileInfo\\{language:04x}{codepage:04x}\\FileDescription"
            if (
                dll.VerQueryValueW(ctypes.byref(data), key, ctypes.byref(pointer), ctypes.byref(length))
                and pointer.value
                and length.value
            ):
                text = ctypes.wstring_at(pointer.value, length.value).split("\x00", 1)[0].strip()
                if text:
                    return text
    except (OSError, ValueError):
        return None
    return None


# --------------------------------------------------------------------------
# Power mode ("Best performance" slider in Settings > System > Power).
# --------------------------------------------------------------------------

OVERLAY_BEST_EFFICIENCY = "961cc777-2547-4f9d-8174-7d86181b8a7a"
OVERLAY_BALANCED = "00000000-0000-0000-0000-000000000000"
OVERLAY_BEST_PERFORMANCE = "ded574b5-45a0-4f42-8737-46345c09c238"

OVERLAY_NAMES = {
    OVERLAY_BEST_EFFICIENCY: "Best power efficiency",
    "3af9b8d9-7c97-431d-ad78-34a8bfea439f": "Better battery",
    OVERLAY_BALANCED: "Balanced",
    OVERLAY_BEST_PERFORMANCE: "Best performance",
}


@functools.lru_cache(maxsize=None)
def _powrprof():
    return _load("powrprof.dll")


def get_power_overlay() -> str | None:
    dll = _powrprof()
    for function_name in ("PowerGetActualOverlayScheme", "PowerGetEffectiveOverlayScheme"):
        try:
            function = getattr(dll, function_name)
        except AttributeError:
            continue
        function.argtypes = [ctypes.POINTER(GUID)]
        function.restype = ctypes.c_uint32
        guid = GUID()
        if function(ctypes.byref(guid)) == 0:
            return str(guid)
    return None


def set_power_overlay(guid_text: str) -> bool:
    dll = _powrprof()
    try:
        function = dll.PowerSetActiveOverlayScheme
    except AttributeError:
        return False
    function.argtypes = [GUID]
    function.restype = ctypes.c_uint32
    return function(GUID.from_string(guid_text)) == 0


# --------------------------------------------------------------------------
# Registry (current-user settings such as Game Mode and Game Bar captures).
# --------------------------------------------------------------------------


def _hive(root: str):
    import winreg

    return {"HKCU": winreg.HKEY_CURRENT_USER, "HKLM": winreg.HKEY_LOCAL_MACHINE}[root]


def reg_read(root: str, path: str, name: str) -> tuple[object, int] | None:
    """``(value, type)`` or ``None`` when the value doesn't exist."""
    _require_windows()
    import winreg

    try:
        with winreg.OpenKey(_hive(root), path) as key:
            value, kind = winreg.QueryValueEx(key, name)
    except OSError:
        return None
    return value, kind


def reg_read_dword(root: str, path: str, name: str) -> int | None:
    found = reg_read(root, path, name)
    import winreg

    if found is None or found[1] != winreg.REG_DWORD:
        return None
    return int(found[0])  # type: ignore[call-overload]


def reg_write(root: str, path: str, name: str, value: object, kind: int | None = None) -> None:
    _require_windows()
    import winreg

    with winreg.CreateKeyEx(_hive(root), path, 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, name, 0, winreg.REG_DWORD if kind is None else kind, value)


def reg_delete(root: str, path: str, name: str) -> None:
    _require_windows()
    import winreg

    try:
        with winreg.OpenKey(_hive(root), path, 0, winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, name)
    except FileNotFoundError:
        pass


def reg_values(root: str, path: str) -> list[tuple[str, object]]:
    _require_windows()
    import winreg

    values: list[tuple[str, object]] = []
    try:
        with winreg.OpenKey(_hive(root), path) as key:
            index = 0
            while True:
                try:
                    name, value, _kind = winreg.EnumValue(key, index)
                except OSError:
                    break
                values.append((name, value))
                index += 1
    except OSError:
        return []
    return values


# --------------------------------------------------------------------------
# Misc.
# --------------------------------------------------------------------------


def relaunch_as_admin(executable: str, params: str, cwd: str | None = None) -> bool:
    """Start a new elevated copy of LagBuster (shows the normal UAC prompt)."""
    shell32 = _load("shell32")
    function = shell32.ShellExecuteW
    function.argtypes = [
        wintypes.HWND,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        ctypes.c_int,
    ]
    function.restype = ctypes.c_void_p
    result = function(None, "runas", executable, params, cwd, 1)
    return (result or 0) > 32


def prepare_process() -> None:
    """Sharp text on high-DPI screens and our own taskbar icon."""
    if not IS_WINDOWS:
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        try:
            ctypes.windll.user32.SetProcessDPIAware()  # type: ignore[attr-defined]
        except (AttributeError, OSError):
            pass
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("LagBuster.App")  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        pass
