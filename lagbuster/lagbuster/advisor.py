"""Turns measurements into suggestions. The user decides which ones to apply.

``advise()`` is a pure function of its input (no system calls), which keeps
every rule easy to test with made-up numbers.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Callable

from . import apps as appdb
from .actions import (
    WINDOWS_RAISED,
    Action,
    CloseApp,
    ProcTarget,
    SetLinuxPowerProfile,
    SetPowerMode,
    SetPowerScheme,
    SetPriority,
    SetRegistryValues,
    TrimMemory,
)
from .gpu import primary_gpu
from .monitor import Averages, ProcStat, Snapshot
from .platform_utils import fmt_bytes, fmt_rate
from .probe import GAMEBAR_KEY, GAMEDVR_KEY, POWER_SAVER, PlatformState
from .winapi import OVERLAY_BEST_PERFORMANCE, OVERLAY_NAMES

MB = 1024**2
GB = 1024**3

CLOSE = "Close it"
LOWER = "Lower its priority"


@dataclass
class AppGroup:
    """All processes of one app (Chrome runs as many processes, for example)."""

    key: str
    display: str
    exe: str
    procs: list[ProcStat]
    cpu: float = 0.0
    rss: int = 0
    gpu: float = 0.0
    mine: bool = False

    @property
    def targets(self) -> list[ProcTarget]:
        return [ProcTarget(p.pid, p.create_time) for p in self.procs]

    @property
    def weight(self) -> float:
        return self.cpu * 3 + self.gpu * 2 + self.rss / GB * 6


def group_key(proc: ProcStat) -> str:
    base = os.path.basename(proc.exe.replace("\\", "/")) if proc.exe else ""
    return appdb.normalize(base or proc.name)


def display_name(group: AppGroup, describe: Callable[[str], str | None] | None = None) -> str:
    known = appdb.KNOWN_APPS.get(group.key)
    if known:
        return known.friendly
    if group.key in appdb.KNOWN_GAMES:
        return appdb.KNOWN_GAMES[group.key]
    if group.key in appdb.SYSTEM_NAMES:
        return appdb.SYSTEM_NAMES[group.key]
    if describe and group.exe:
        text = describe(group.exe)
        if text and 2 <= len(text) <= 48:
            return text
    return appdb.pretty_exe_name(group.procs[0].name if group.procs else group.key)


def group_processes(
    procs: list[ProcStat], describe: Callable[[str], str | None] | None = None
) -> dict[str, AppGroup]:
    groups: dict[str, AppGroup] = {}
    for proc in procs:
        key = group_key(proc)
        group = groups.get(key)
        if group is None:
            group = groups[key] = AppGroup(key=key, display="", exe=proc.exe, procs=[])
        group.procs.append(proc)
        group.cpu += proc.cpu
        group.rss += proc.rss
        group.gpu = min(100.0, group.gpu + proc.gpu)
        group.mine = group.mine or proc.mine
        if not group.exe and proc.exe:
            group.exe = proc.exe
    for group in groups.values():
        group.display = display_name(group, describe)
    return groups


@dataclass
class GameCandidate:
    key: str
    title: str
    score: int
    group: AppGroup


def find_games(groups: dict[str, AppGroup], my_games: frozenset[str] = frozenset()) -> list[GameCandidate]:
    found = []
    for group in groups.values():
        score = appdb.game_score(group.key, group.exe, group.gpu, my_games)
        if score >= 45:
            found.append(GameCandidate(group.key, appdb.game_title(group.key, group.exe, group.display), score, group))
    found.sort(key=lambda c: (-c.score, -c.group.gpu, c.title.lower()))
    return found


AUTO_GAME_SCORE = 60


@dataclass
class Suggestion:
    id: str
    section: str  # "fix", "apps", "tip" or "ok"
    title: str
    detail: str = ""
    impact: str = "low"  # "high", "medium", "low" (for apps: how heavy the app is)
    recommended: bool = False
    actions: dict[str, Action] = field(default_factory=dict)  # choice label -> action
    default_choice: str | None = None
    caution: str = ""
    link: tuple[str, str] | None = None  # (button text, settings page / program to open)
    app_key: str | None = None
    weight: float = 0.0
    checked: bool = False  # what the user ticked (UI state)
    choice: str | None = None  # which way the user picked (UI state)

    @property
    def actionable(self) -> bool:
        return bool(self.actions)

    def selected_action(self) -> Action | None:
        if not self.actions:
            return None
        return self.actions.get(self.choice or "") or self.actions.get(self.default_choice or "") or next(
            iter(self.actions.values())
        )


@dataclass
class ScanInput:
    snapshot: Snapshot
    averages: Averages
    platform: PlatformState
    game_key: str | None = None  # None = pick automatically, "" = no game
    protected_apps: frozenset[str] = frozenset()
    my_games: frozenset[str] = frozenset()
    self_pids: frozenset[int] = frozenset()
    describe: Callable[[str], str | None] | None = None


@dataclass
class ScanResult:
    suggestions: list[Suggestion]
    games: list[GameCandidate]
    game: GameCandidate | None
    groups: dict[str, AppGroup]
    platform: PlatformState


def _dirname(path: str) -> str:
    return os.path.dirname(path.replace("\\", "/")).lower().rstrip("/")


class _Context:
    def __init__(self, inp: ScanInput, groups: dict[str, AppGroup], game: GameCandidate | None) -> None:
        self.inp = inp
        self.snap = inp.snapshot
        self.avg = inp.averages
        self.platform = inp.platform
        self.windows = inp.platform.os == "windows"
        self.groups = groups
        self.game = game
        self.game_related = self._game_related()

    def _game_related(self) -> set[str]:
        """The game, the launcher that started it and helpers installed with it."""
        if not self.game:
            return set()
        related = {self.game.key}
        by_pid = {p.pid: p for group in self.groups.values() for p in group.procs}
        for proc in self.game.group.procs:
            parent = by_pid.get(proc.ppid)
            depth = 0
            while parent is not None and depth < 4 and parent.pid != proc.pid:
                key = group_key(parent)
                if key in appdb.PROTECTED:
                    break
                related.add(key)
                parent = by_pid.get(parent.ppid)
                depth += 1
        game_dir = _dirname(self.game.group.exe)
        if game_dir:
            for group in self.groups.values():
                if group.exe and (_dirname(group.exe) + "/").startswith(game_dir + "/"):
                    related.add(group.key)
        return related

    def touchable(self, group: AppGroup) -> bool:
        return (
            group.mine
            and group.key not in appdb.PROTECTED
            and group.key not in self.inp.protected_apps
            and group.key not in self.game_related
        )

    def cpu_of(self, keys: set[str]) -> float:
        return sum(group.cpu for key, group in self.groups.items() if key in keys)


def _ok(sid: str, title: str) -> Suggestion:
    return Suggestion(id=sid, section="ok", title=title)


def _usage_text(group: AppGroup) -> str:
    parts = [f"{fmt_bytes(group.rss)} of RAM", f"{group.cpu:.0f}% CPU"]
    if group.gpu >= 1:
        parts.append(f"{group.gpu:.0f}% GPU")
    count = len(group.procs)
    extra = f" ({count} processes)" if count > 1 else ""
    return "Uses " + " · ".join(parts) + extra + "."


# --------------------------------------------------------------------------
# Rules
# --------------------------------------------------------------------------


def rule_power(ctx: _Context) -> list[Suggestion]:
    power = ctx.platform.power
    if power is None:
        return []
    caution = "Uses a little more electricity. You can undo it any time."
    if ctx.snap.on_battery:
        caution += " On battery the laptop will drain faster."
    if power.kind == "linux":
        if power.is_performance():
            return [_ok("power-ok", "Power profile: performance")]
        if "performance" not in power.schemes:
            return []
        return [
            Suggestion(
                id="power",
                section="fix",
                title="Switch the power profile to “performance”",
                detail=f"Your PC uses the “{power.active}” profile, which lowers CPU speed to save power.",
                impact="medium",
                recommended=True,
                actions={"Apply": SetLinuxPowerProfile("performance")},
                caution=caution,
                weight=3,
            )
        ]
    if power.is_performance():
        return [_ok("power-ok", f"Power plan: {power.active_name or 'High performance'}")]
    current = power.active_name or "Balanced"
    target = power.performance_plan()
    if target:
        name = power.schemes.get(target) or "High performance"
        return [
            Suggestion(
                id="power",
                section="fix",
                title=f"Switch the power plan to “{name}”",
                detail=(
                    f"Windows uses the “{current}” plan, which slows the processor down between bursts "
                    f"to save power. That can cause stutter and uneven FPS. “{name}” keeps it ready "
                    "at full speed while you play."
                ),
                impact="high" if power.active == POWER_SAVER else "medium",
                recommended=True,
                actions={"Apply": SetPowerScheme(target, name)},
                caution=caution,
                weight=3,
            )
        ]
    if power.overlay == OVERLAY_BEST_PERFORMANCE:
        return [_ok("power-ok", "Power mode: Best performance")]
    if power.overlay is not None:
        return [
            Suggestion(
                id="power-mode",
                section="fix",
                title="Set the Windows power mode to “Best performance”",
                detail=(
                    f"The power mode is “{OVERLAY_NAMES.get(power.overlay, 'Balanced')}”. "
                    "“Best performance” lets the processor speed up faster and stay fast, "
                    "which smooths out frame times."
                ),
                impact="medium",
                recommended=True,
                actions={"Apply": SetPowerMode(OVERLAY_BEST_PERFORMANCE)},
                caution=caution,
                weight=3,
            )
        ]
    return [
        Suggestion(
            id="tip-power",
            section="tip",
            title="Check your power settings",
            detail=f"Windows uses the “{current}” power plan. Choose the fastest power mode in Settings.",
            link=("Open power settings", "ms-settings:powersleep"),
        )
    ]


def rule_game_priority(ctx: _Context) -> list[Suggestion]:
    game = ctx.game
    if game is None:
        return []
    procs = [p for p in game.group.procs if p.mine]
    if not procs:
        return []

    def raised(proc: ProcStat) -> bool:
        if proc.nice is None:
            return False
        return proc.nice in WINDOWS_RAISED if ctx.windows else proc.nice < 0

    if all(raised(p) for p in procs):
        return [_ok(f"game-priority-ok:{game.key}", f"{game.title} already runs at a higher priority")]
    if not ctx.windows and not ctx.platform.is_admin:
        return []  # Linux needs root to raise priority
    targets = [ProcTarget(p.pid, p.create_time) for p in procs]
    return [
        Suggestion(
            id=f"game-priority:{game.key}",
            section="fix",
            title=f"Give {game.title} more CPU priority",
            detail=(
                "When background apps also want the processor, Windows will serve your game first. "
                "This reduces stutter when something wakes up in the background."
            ),
            impact="medium",
            recommended=True,
            actions={
                "High": SetPriority(game.title, targets, "high"),
                "Above normal (gentler)": SetPriority(game.title, targets, "above_normal"),
            },
            default_choice="High",
            caution="Some anti-cheat games block this, which is harmless. It resets when the game restarts.",
            weight=1,
        )
    ]


def rule_game_on_integrated_gpu(ctx: _Context) -> list[Suggestion]:
    if ctx.game is None or not ctx.windows:
        return []
    integrated = {g.key: g for g in ctx.snap.gpus if g.integrated}
    discrete = [g for g in ctx.snap.gpus if not g.integrated]
    if not integrated or not discrete:
        return []
    pids = {p.pid for p in ctx.game.group.procs}
    per_adapter: dict[str, float] = {}
    for (pid, luid), value in ctx.snap.gpu_usage.by_pid_adapter.items():
        if pid in pids:
            per_adapter[luid] = per_adapter.get(luid, 0.0) + value
    if not per_adapter:
        return []
    busiest = max(per_adapter, key=lambda luid: per_adapter[luid])
    if busiest not in integrated or per_adapter[busiest] < 5:
        return []
    fast = primary_gpu(discrete)
    return [
        Suggestion(
            id=f"tip-igpu:{ctx.game.key}",
            section="tip",
            title=f"{ctx.game.title} runs on the slow built-in graphics",
            detail=(
                f"It uses {integrated[busiest].name} instead of your much faster "
                f"{fast.name if fast else 'graphics card'}. Open Graphics settings, add the game, "
                "choose “High performance”, then restart the game."
            ),
            impact="high",
            link=("Open Graphics settings", "ms-settings:display-advancedgraphics"),
        )
    ]


def rule_game_bar(ctx: _Context) -> list[Suggestion]:
    if not ctx.windows:
        return []
    if ctx.platform.game_dvr_background == 1:
        return [
            Suggestion(
                id="gamedvr-background",
                section="fix",
                title="Turn off Xbox Game Bar background recording",
                detail=(
                    "Windows records your gameplay all the time (“Record what happened”) so you can "
                    "save clips. That keeps your graphics card busier and costs FPS. You can still "
                    "record on purpose with Win+Alt+R."
                ),
                impact="high",
                recommended=True,
                actions={
                    "Apply": SetRegistryValues(
                        "Turn off Game Bar background recording",
                        [("HKCU", GAMEDVR_KEY, "HistoricalCaptureEnabled", 0)],
                    )
                },
                caution="You can undo it any time.",
            )
        ]
    return [_ok("gamedvr-ok", "Xbox Game Bar isn't recording in the background")]


def rule_game_mode(ctx: _Context) -> list[Suggestion]:
    if not ctx.windows:
        return []
    if ctx.platform.game_mode == 0:
        return [
            Suggestion(
                id="gamemode",
                section="fix",
                title="Turn Windows Game Mode back on",
                detail=(
                    "Game Mode stops Windows Update from installing drivers or restarting during games "
                    "and gives your game more of the PC's attention. It's normally on, but it was "
                    "turned off on this PC."
                ),
                impact="medium",
                recommended=True,
                actions={
                    "Apply": SetRegistryValues(
                        "Turn on Windows Game Mode",
                        [
                            ("HKCU", GAMEBAR_KEY, "AutoGameModeEnabled", 1),
                            ("HKCU", GAMEBAR_KEY, "AllowAutoGameMode", 1),
                        ],
                    )
                },
                weight=2,
            )
        ]
    return [_ok("gamemode-ok", "Windows Game Mode is on")]


def rule_background_apps(ctx: _Context) -> list[Suggestion]:
    pressure = ctx.snap.ram_percent
    ram_floor = 250 * MB if pressure >= 80 else 400 * MB
    candidates = []
    for group in ctx.groups.values():
        if not ctx.touchable(group):
            continue
        known = appdb.KNOWN_APPS.get(group.key)
        if known and known.action == "leave":
            continue
        if group.cpu < 2.0 and group.gpu < 3.0 and group.rss < ram_floor:
            continue
        candidates.append((group, known))
    candidates.sort(key=lambda item: -item[0].weight)

    suggestions = []
    for group, known in candidates[:12]:
        ram_big = group.rss >= (1.5 * GB if pressure < 75 else 0.5 * GB)
        busy = group.cpu >= 3 or group.gpu >= 3
        if group.cpu >= 10 or group.gpu >= 10 or group.rss >= 3 * GB or (group.rss >= 1.5 * GB and pressure >= 75):
            impact = "high"
        elif group.cpu >= 4 or group.gpu >= 4 or group.rss >= 800 * MB or (group.rss >= 400 * MB and pressure >= 80):
            impact = "medium"
        else:
            impact = "low"
        if known:
            default = CLOSE if known.action == "close" else LOWER
            force_ok = known.force_ok
            caution = known.note
        else:
            default = CLOSE if ram_big and not busy and pressure >= 75 else LOWER
            force_ok = False
            caution = "If you pick “Close it”, LagBuster asks it to close like clicking its X - save your work first."
        detail = _usage_text(group)
        if default == CLOSE:
            detail += " Closing it gives that memory and processor time to your game."
        else:
            detail += " Lowering its priority lets your game use the processor first; the app keeps working."
        if pressure >= 80 and group.rss >= 400 * MB:
            detail += " Your RAM is nearly full, so closing it would help the most."
        suggestions.append(
            Suggestion(
                id=f"app:{group.key}",
                section="apps",
                title=group.display,
                detail=detail,
                impact=impact,
                recommended=impact != "low",
                actions={
                    CLOSE: CloseApp(group.display, group.targets, force_ok),
                    LOWER: SetPriority(group.display, group.targets, "below_normal"),
                },
                default_choice=default,
                caution=caution,
                app_key=group.key,
                weight=group.weight,
            )
        )
    if not suggestions:
        return [_ok("apps-ok", "No heavy background apps are running")]
    return suggestions


def rule_memory(ctx: _Context) -> list[Suggestion]:
    snap = ctx.snap
    pressure = snap.ram_percent
    results: list[Suggestion] = []
    if ctx.windows and pressure >= 80:
        targets = [
            ProcTarget(p.pid, p.create_time)
            for group in ctx.groups.values()
            if ctx.touchable(group)
            for p in group.procs
            if p.rss >= 30 * MB
        ]
        if targets:
            results.append(
                Suggestion(
                    id="trim-ram",
                    section="fix",
                    title="Free up RAM held by background apps",
                    detail=(
                        f"Your RAM is {pressure:.0f}% full ({fmt_bytes(snap.ram_used)} of "
                        f"{fmt_bytes(snap.ram_total)}). When it runs out, Windows swaps to the much "
                        "slower disk and games freeze for a moment. This asks background apps to hand "
                        "back memory they aren't using right now - nothing gets closed."
                    ),
                    impact="high" if pressure >= 90 else "medium",
                    recommended=pressure >= 85,
                    actions={"Apply": TrimMemory(targets)},
                    caution="An app you switch back to may feel slow for a second while it reloads.",
                )
            )
    elif pressure < 70:
        results.append(_ok("ram-ok", f"RAM: {pressure:.0f}% used, plenty free"))
    if snap.ram_total <= 8.5 * GB and (pressure >= 75 or ctx.game):
        results.append(
            Suggestion(
                id="tip-ram-size",
                section="tip",
                title=f"{fmt_bytes(snap.ram_total)} of RAM is tight for today's games",
                detail=(
                    "Closing background apps helps, but upgrading to 16 GB is the real fix if newer "
                    "games still freeze."
                ),
                impact="medium",
            )
        )
    return results


def rule_hardware(ctx: _Context) -> list[Suggestion]:
    snap = ctx.snap
    results: list[Suggestion] = []
    if snap.on_battery:
        results.append(
            Suggestion(
                id="tip-battery",
                section="tip",
                title="Plug in your charger",
                detail=(
                    "Your laptop is running on battery. Laptops slow down the processor and graphics "
                    "card on battery to save power - plugged in, you get full speed."
                ),
                impact="high",
            )
        )
    temps = [g.temp for g in snap.gpus if g.temp is not None]
    if ctx.avg.gpu_temp_peak is not None:
        temps.append(ctx.avg.gpu_temp_peak)
    throttling = any("thermal" in g.throttle for g in snap.gpus)
    hottest = max(temps) if temps else None
    if (hottest is not None and hottest >= 83) or throttling:
        reading = f" ({hottest:.0f} °C)" if hottest is not None else ""
        results.append(
            Suggestion(
                id="tip-gpu-hot",
                section="tip",
                title=f"Your graphics card is running hot{reading}",
                detail=(
                    "Hot graphics cards slow themselves down to stay safe, which causes FPS drops. "
                    "Clean the dust out of the fans, keep the PC's air vents free, or use a laptop "
                    "cooling pad."
                    + (" Right now it is already slowing down because of heat." if throttling else "")
                ),
                impact="high",
            )
        )
    elif hottest is not None:
        results.append(_ok("gpu-temp-ok", f"Graphics card temperature: {hottest:.0f} °C"))
    if snap.cpu_temp is not None and snap.cpu_temp >= 90:
        results.append(
            Suggestion(
                id="tip-cpu-hot",
                section="tip",
                title=f"Your processor is running hot ({snap.cpu_temp:.0f} °C)",
                detail="Clean the fans and check that the cooler is working; hot CPUs slow themselves down.",
                impact="high",
            )
        )
    gpu = snap.gpu
    vram = gpu.mem_percent if gpu else None
    if ctx.avg.vram_peak is not None:
        vram = max(vram or 0.0, ctx.avg.vram_peak)
    if gpu and not gpu.integrated and vram is not None and vram >= 92:
        results.append(
            Suggestion(
                id="tip-vram",
                section="tip",
                title="Your graphics card's memory (VRAM) is full",
                detail=(
                    f"{fmt_bytes(gpu.mem_used)} of {fmt_bytes(gpu.mem_total)} is in use. When VRAM runs "
                    "out, games stutter badly. Lower “Texture quality” in the game's graphics "
                    "settings. Closing browsers and Wallpaper Engine frees some too."
                ),
                impact="high",
            )
        )
    if snap.swap_total < 256 * MB and ctx.windows and snap.ram_total <= 32 * GB:
        results.append(
            Suggestion(
                id="tip-pagefile",
                section="tip",
                title="Virtual memory (the page file) is turned off",
                detail=(
                    "Without it, games can crash or freeze as soon as RAM fills up. In the window "
                    "that opens: Advanced → Change… → tick “Automatically manage paging file size”."
                ),
                impact="medium",
                link=("Open performance settings", "SystemPropertiesPerformance.exe"),
            )
        )
    platform = ctx.platform
    if platform.disk_free is not None and platform.disk_total:
        free, total = platform.disk_free, platform.disk_total
        drive = (platform.system_drive or "").rstrip("\\/") or "system"
        if free < 10 * GB or free / total < 0.08:
            results.append(
                Suggestion(
                    id="tip-disk",
                    section="tip",
                    title=f"Your {drive} drive is almost full ({fmt_bytes(free)} free)",
                    detail=(
                        "Windows needs free space for virtual memory, updates and game shader caches. "
                        "A full system drive causes stutter and failed updates."
                    ),
                    impact="medium",
                    link=("Open Storage settings", "ms-settings:storagesense") if ctx.windows else None,
                )
            )
        else:
            results.append(_ok("disk-ok", f"{drive} drive: {fmt_bytes(free)} free"))
    return results


def rule_bottlenecks(ctx: _Context) -> list[Suggestion]:
    avg = ctx.avg
    cpu = avg.cpu if avg.samples else ctx.snap.cpu
    results: list[Suggestion] = []
    background_cpu = sum(group.cpu for group in ctx.groups.values() if ctx.touchable(group))
    if cpu >= 90:
        if ctx.game:
            if background_cpu >= 8:
                detail = (
                    f"It works at {cpu:.0f}% on average and background apps use about "
                    f"{background_cpu:.0f}% of it. Closing them (see “Background apps”) helps the most."
                )
            else:
                detail = (
                    f"It works at {cpu:.0f}% on average, mostly for the game itself. Lower CPU-heavy "
                    "settings (view distance, crowd or NPC density, physics, shadows) or cap your FPS."
                )
            title = "Your processor (CPU) is maxed out"
        else:
            detail = f"It works at {cpu:.0f}% on average. The Apps tab shows what is using it."
            title = "Your processor is maxed out even without a game"
        results.append(Suggestion(id="tip-cpu-max", section="tip", title=title, detail=detail, impact="high"))
    if ctx.game and avg.gpu is not None and avg.gpu >= 97:
        results.append(
            Suggestion(
                id="tip-gpu-bound",
                section="tip",
                title="Your graphics card is at full power",
                detail=(
                    "That's normal while gaming. If you notice stutter, cap your FPS a little below your "
                    "screen's refresh rate (for example 141 FPS on a 144 Hz screen) in the game or in the "
                    "NVIDIA/AMD control panel. A small cap gives smoother, more even frames."
                ),
                impact="low",
            )
        )
    return results


def rule_windows_busy(ctx: _Context) -> list[Suggestion]:
    if not ctx.windows:
        return []
    results = []
    defender = ctx.cpu_of(appdb.DEFENDER_PROCESSES)
    if defender >= 5:
        results.append(
            Suggestion(
                id="tip-defender",
                section="tip",
                title="Windows Security is scanning your PC",
                detail=(
                    f"The virus scanner is using {defender:.0f}% of your CPU right now. Let the scan "
                    "finish before you play, or schedule scans for another time."
                ),
                impact="medium",
                link=("Open Windows Security", "windowsdefender:"),
            )
        )
    update = ctx.cpu_of(appdb.UPDATE_PROCESSES)
    if update >= 5:
        results.append(
            Suggestion(
                id="tip-windows-update",
                section="tip",
                title="Windows Update is working in the background",
                detail=(
                    f"It's using {update:.0f}% of your CPU (and probably disk and internet). Let it "
                    "finish, or pause updates while you play."
                ),
                impact="medium",
                link=("Open Windows Update", "ms-settings:windowsupdate"),
            )
        )
    indexer = ctx.cpu_of(appdb.INDEXER_PROCESSES)
    if indexer >= 5:
        results.append(
            Suggestion(
                id="tip-indexer",
                section="tip",
                title="Windows Search is indexing your files",
                detail=f"It uses {indexer:.0f}% of your CPU and some disk. It stops by itself when it's done.",
                impact="low",
            )
        )
    return results


def rule_network(ctx: _Context) -> list[Suggestion]:
    results: list[Suggestion] = []
    recv, sent = ctx.avg.net_recv, ctx.avg.net_sent
    if recv >= 1.5 * MB or sent >= 0.5 * MB:
        suspects = [
            group.display
            for group in ctx.groups.values()
            if (known := appdb.KNOWN_APPS.get(group.key)) and known.kind in appdb.NETWORK_HEAVY_KINDS
        ]
        detail = (
            f"Your PC is downloading {fmt_rate(recv)} and uploading {fmt_rate(sent)} right now. "
            "In online games that causes lag spikes and higher ping."
        )
        if suspects:
            detail += " Apps that might be doing it: " + ", ".join(sorted(set(suspects))[:5]) + "."
        else:
            detail += " Pause downloads in game launchers, Windows Update, cloud storage and torrent apps."
        results.append(
            Suggestion(
                id="tip-network-busy",
                section="tip",
                title="Something is using your internet heavily",
                detail=detail,
                impact="high" if recv >= 5 * MB or sent >= 2 * MB else "medium",
            )
        )
    net = ctx.platform.network
    if net is None or not net.reachable or net.average is None:
        return results
    problems = []
    if net.loss_percent > 0:
        problems.append(f"{net.loss_percent:.0f}% of test connections failed")
    if net.average > 80:
        problems.append(f"slow response ({net.average:.0f} ms)")
    if net.jitter is not None and net.jitter > 25:
        problems.append(f"unstable timing (±{net.jitter:.0f} ms)")
    if problems:
        results.append(
            Suggestion(
                id="tip-network-quality",
                section="tip",
                title="Your internet connection looks unstable",
                detail=(
                    "Test result: "
                    + "; ".join(problems)
                    + ". Use an Ethernet cable instead of Wi-Fi if you can, pause downloads and video "
                    "streams on other devices, and restart your router."
                ),
                impact="high" if net.loss_percent > 0 else "medium",
            )
        )
    else:
        results.append(_ok("net-ok", f"Internet: {net.average:.0f} ms response time, stable"))
    return results


def rule_startup(ctx: _Context) -> list[Suggestion]:
    count = ctx.platform.startup_count
    if not ctx.windows or count is None or count < 10:
        return []
    return [
        Suggestion(
            id="tip-startup",
            section="tip",
            title=f"{count} apps start automatically with Windows",
            detail="Each one keeps running in the background while you play. Turn off the ones you don't need.",
            impact="low",
            link=("Open Startup apps", "ms-settings:startupapps"),
        )
    ]


def rule_linux_gamemode(ctx: _Context) -> list[Suggestion]:
    if ctx.platform.os != "linux" or ctx.platform.gamemode_installed is not False or ctx.game is None:
        return []
    return [
        Suggestion(
            id="tip-gamemode-linux",
            section="tip",
            title="Try Feral GameMode",
            detail=(
                "Install the “gamemode” package and start games with “gamemoderun %command%” "
                "(Steam launch options). It switches the PC to performance mode only while you play."
            ),
            impact="low",
        )
    ]


RULES = (
    rule_power,
    rule_game_priority,
    rule_game_on_integrated_gpu,
    rule_game_bar,
    rule_game_mode,
    rule_background_apps,
    rule_memory,
    rule_hardware,
    rule_bottlenecks,
    rule_windows_busy,
    rule_network,
    rule_startup,
    rule_linux_gamemode,
)

_SECTION_ORDER = {"fix": 0, "apps": 1, "tip": 2, "ok": 3}
_IMPACT_ORDER = {"high": 0, "medium": 1, "low": 2}


def advise(inp: ScanInput) -> ScanResult:
    procs = [p for p in (inp.snapshot.processes or []) if p.pid not in inp.self_pids]
    groups = group_processes(procs, inp.describe)
    games = find_games(groups, inp.my_games)
    game: GameCandidate | None = None
    if inp.game_key is None:
        if games and games[0].score >= AUTO_GAME_SCORE:
            game = games[0]
    elif inp.game_key:
        game = next((c for c in games if c.key == inp.game_key), None)
        if game is None and inp.game_key in groups:
            group = groups[inp.game_key]
            game = GameCandidate(group.key, appdb.game_title(group.key, group.exe, group.display), 0, group)
    ctx = _Context(inp, groups, game)
    suggestions: list[Suggestion] = []
    for rule in RULES:
        suggestions.extend(rule(ctx))
    suggestions.sort(
        key=lambda s: (
            _SECTION_ORDER.get(s.section, 9),
            0 if s.section == "apps" else _IMPACT_ORDER.get(s.impact, 9),
            -s.weight,
            not s.recommended,
            s.title.lower(),
        )
    )
    return ScanResult(suggestions, games, game, groups, inp.platform)


def apply_saved_choices(suggestions: list[Suggestion], choices: dict[str, dict]) -> None:
    """Pre-tick suggestions: remembered choices first, otherwise the recommendation."""
    for suggestion in suggestions:
        suggestion.checked = suggestion.recommended and suggestion.actionable
        suggestion.choice = suggestion.default_choice or next(iter(suggestion.actions), None)
        saved = choices.get(suggestion.id)
        if saved and suggestion.actionable:
            suggestion.checked = bool(saved.get("checked", suggestion.checked))
            if saved.get("mode") in suggestion.actions:
                suggestion.choice = saved["mode"]
