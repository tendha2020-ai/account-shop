import dataclasses

import pytest

from lagbuster.actions import CloseApp, SetPowerMode, SetPowerScheme, SetPriority, SetRegistryValues, TrimMemory
from lagbuster.advisor import CLOSE, LOWER, ScanInput, advise, apply_saved_choices
from lagbuster.demo import GAME_PID, IGPU_LUID, demo_platform, demo_processes, demo_snapshot
from lagbuster.monitor import Averages, ProcStat
from lagbuster.probe import POWER_BALANCED, POWER_HIGH, NetworkCheck, PowerInfo
from lagbuster.winapi import OVERLAY_BALANCED

GB = 1024**3
MB = 1024**2


def quiet_averages(**changes):
    base = Averages(15.0, 40.0, 60.0, 50.0, 40.0, 65.0, 10_000.0, 5_000.0, 15)
    return dataclasses.replace(base, **changes)


def scan(snapshot=None, platform=None, averages=None, **kwargs):
    snapshot = snapshot or demo_snapshot(1000.0)
    platform = platform or demo_platform()
    result = advise(
        ScanInput(snapshot=snapshot, averages=averages or quiet_averages(), platform=platform, **kwargs)
    )
    apply_saved_choices(result.suggestions, {})
    return result


def by_id(result):
    return {s.id: s for s in result.suggestions}


def test_demo_scan_finds_the_game_and_main_fixes():
    result = scan(averages=quiet_averages(net_recv=2.4 * MB))
    assert result.game is not None and result.game.title == "Fortnite"
    found = by_id(result)
    assert isinstance(found["power"].selected_action(), SetPowerScheme)
    assert found["power"].checked
    assert isinstance(found["gamedvr-background"].selected_action(), SetRegistryValues)
    priority = found["game-priority:fortniteclient-win64-shipping"]
    assert isinstance(priority.selected_action(), SetPriority) and priority.choice == "High"
    assert "tip-defender" in found and "tip-startup" in found and "tip-network-busy" in found
    chrome = found["app:chrome"]
    assert chrome.section == "apps" and chrome.choice == CLOSE and chrome.checked
    assert isinstance(chrome.selected_action(), CloseApp) and chrome.selected_action().force_ok
    assert len(chrome.selected_action().targets) == 14
    discord = found["app:discord"]
    assert discord.choice == LOWER  # voice chat friendly default


def test_never_suggests_the_game_system_or_launcher():
    result = scan(self_pids=frozenset({8100}))
    app_keys = {s.app_key for s in result.suggestions if s.section == "apps"}
    for key in (
        "fortniteclient-win64-shipping",  # the game
        "epicgameslauncher",  # started the game
        "fortnitelauncher",  # ditto
        "easyanticheat_eos",  # anti-cheat (and not the user's process)
        "msmpeng",
        "explorer",
        "dwm",
        "svchost",
        "lagbuster",
    ):
        assert key not in app_keys, key


def test_without_game_the_launcher_can_be_suggested():
    result = scan(game_key="")
    assert result.game is None
    assert not any(s.id.startswith("game-priority") for s in result.suggestions)
    assert "app:epicgameslauncher" in by_id(result)


def test_user_protected_apps_are_skipped():
    result = scan(protected_apps=frozenset({"chrome"}))
    assert "app:chrome" not in by_id(result)


def test_already_optimal_power_plan():
    platform = demo_platform()
    platform.power = PowerInfo("windows", POWER_HIGH, "High performance", {POWER_HIGH: "High performance"})
    found = by_id(scan(platform=platform))
    assert "power" not in found and found["power-ok"].section == "ok"


def test_power_mode_used_when_no_high_performance_plan():
    platform = demo_platform()
    platform.power = PowerInfo("windows", POWER_BALANCED, "Balanced", {POWER_BALANCED: "Balanced"}, OVERLAY_BALANCED)
    found = by_id(scan(platform=platform))
    assert isinstance(found["power-mode"].selected_action(), SetPowerMode)


def test_linux_power_profile():
    platform = demo_platform()
    platform.os = "linux"
    platform.power = PowerInfo("linux", "balanced", "balanced", {"balanced": "balanced", "performance": "performance"})
    found = by_id(scan(platform=platform))
    assert found["power"].actionable
    assert "gamedvr-background" not in found and "tip-defender" not in found  # Windows-only rules


def test_game_bar_and_game_mode():
    platform = demo_platform()
    platform.game_dvr_background = 0
    platform.game_mode = 0
    found = by_id(scan(platform=platform))
    assert "gamedvr-background" not in found and "gamedvr-ok" in found
    assert found["gamemode"].checked


def test_memory_suggestions_depend_on_pressure():
    snap = demo_snapshot(1000.0)
    found = by_id(scan(snapshot=snap))
    assert isinstance(found["trim-ram"].selected_action(), TrimMemory)
    game_pids = {GAME_PID}
    assert not game_pids & {t.pid for t in found["trim-ram"].selected_action().targets}

    relaxed = dataclasses.replace(snap, ram_used=6 * GB, ram_available=10 * GB, ram_percent=37.5)
    found = by_id(scan(snapshot=relaxed))
    assert "trim-ram" not in found and "ram-ok" in found


def test_hardware_tips():
    snap = demo_snapshot(1000.0)
    gpu = dataclasses.replace(snap.gpus[0], temp=88.0, mem_used=int(11.8 * GB))
    hot = dataclasses.replace(snap, gpus=[gpu, snap.gpus[1]], on_battery=True, swap_total=0, ram_total=8 * GB)
    platform = demo_platform()
    platform.disk_free = 3 * GB
    found = by_id(scan(snapshot=hot, platform=platform))
    for tip in ("tip-battery", "tip-gpu-hot", "tip-vram", "tip-pagefile", "tip-disk", "tip-ram-size"):
        assert tip in found, tip
        assert found[tip].section == "tip"


def test_cpu_maxed_and_gpu_bound_tips():
    found = by_id(scan(averages=quiet_averages(cpu=96.0, gpu=99.0)))
    assert "tip-cpu-max" in found and "tip-gpu-bound" in found


def test_network_quality():
    platform = demo_platform()
    platform.network = NetworkCheck(samples=[20.0, 140.0, 25.0, 160.0], lost=1, reachable=2)
    found = by_id(scan(platform=platform))
    assert found["tip-network-quality"].impact == "high"
    platform.network = NetworkCheck(samples=[20.0, 21.0, 22.0], lost=0, reachable=2)
    assert "net-ok" in by_id(scan(platform=platform))
    platform.network = NetworkCheck()  # test servers blocked: say nothing
    found = by_id(scan(platform=platform))
    assert "net-ok" not in found and "tip-network-quality" not in found


def test_game_on_integrated_graphics():
    snap = demo_snapshot(1000.0)
    usage = dataclasses.replace(snap.gpu_usage, by_pid_adapter={(GAME_PID, IGPU_LUID): 90.0})
    found = by_id(scan(snapshot=dataclasses.replace(snap, gpu_usage=usage)))
    tip = found["tip-igpu:fortniteclient-win64-shipping"]
    assert "Intel" in tip.detail and tip.link[1] == "ms-settings:display-advancedgraphics"


def test_remembered_choices_win_over_recommendations():
    result = scan()
    apply_saved_choices(
        result.suggestions,
        {"app:chrome": {"checked": False, "mode": LOWER}, "power": {"checked": False, "mode": "Apply"}},
    )
    found = by_id(result)
    assert not found["app:chrome"].checked and found["app:chrome"].choice == LOWER
    assert isinstance(found["app:chrome"].selected_action(), SetPriority)
    assert not found["power"].checked
    assert found["gamedvr-background"].checked  # untouched suggestions keep the recommendation


def test_light_apps_are_listed_but_not_ticked():
    found = by_id(scan())
    assert found["app:spotify"].impact == "low" and not found["app:spotify"].checked


def test_unknown_heavy_app_defaults_to_the_safe_choice():
    procs = demo_processes() + [
        ProcStat(4242, "RenderThing.exe", "C:\\Tools\\RenderThing.exe", 5000, 1.0, cpu=22.0, rss=600 * MB, mine=True)
    ]
    snap = dataclasses.replace(demo_snapshot(1000.0), processes=procs)
    suggestion = by_id(scan(snapshot=snap))["app:renderthing"]
    assert suggestion.impact == "high" and suggestion.choice == LOWER
    assert not suggestion.actions[CLOSE].force_ok  # unknown apps are only asked to close


def test_other_users_processes_are_ignored():
    procs = [dataclasses.replace(p, mine=False) for p in demo_processes()]
    snap = dataclasses.replace(demo_snapshot(1000.0), processes=procs)
    found = by_id(scan(snapshot=snap))
    assert not any(s.section == "apps" and s.actionable for s in found.values())


@pytest.mark.parametrize("section", ["fix", "apps", "tip", "ok"])
def test_sections_are_grouped_in_order(section):
    result = scan()
    order = [s.section for s in result.suggestions]
    positions = [i for i, s in enumerate(order) if s == section]
    assert positions == list(range(positions[0], positions[-1] + 1))
