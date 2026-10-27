from lagbuster import apps
from lagbuster.gpu import (
    LinuxSysfsBackend,
    aggregate_engine_usage,
    decode_nvidia_throttle,
    parse_adapter_instance,
    parse_engine_instance,
    parse_nvidia_smi,
    primary_gpu,
    GpuStat,
)
from lagbuster.probe import (
    POWER_BALANCED,
    POWER_HIGH,
    POWER_ULTIMATE,
    NetworkCheck,
    PowerInfo,
    parse_powercfg_list,
)
from lagbuster.winapi import GUID, luid_key

LUID = "0x00000000_0x0000d1a6"


def engine(pid, eng=0, engtype="3D", luid="0x00000000_0x0000D1A6"):
    return f"pid_{pid}_luid_{luid}_phys_0_eng_{eng}_engtype_{engtype}"


def test_parse_engine_instance():
    assert parse_engine_instance(engine(1234)) == (1234, LUID, 0, 0, "3D")
    assert parse_engine_instance(engine(7, 3, "VideoDecode")) == (7, LUID, 0, 3, "VideoDecode")
    assert parse_engine_instance("_Total") is None
    assert parse_adapter_instance("luid_0x00000000_0x0000D1A6_phys_0") == LUID
    assert parse_adapter_instance("garbage") is None


def test_aggregate_engine_usage_matches_task_manager_rules():
    values = {
        engine(100, 0, "3D"): 60.0,  # game on the 3D engine
        engine(200, 0, "3D"): 15.0,  # browser also on the 3D engine
        engine(200, 3, "VideoDecode"): 30.0,  # browser decoding video
        engine(300, 0, "3D"): 0.0,  # idle process
        engine(400, 0, "3D", luid="0x00000000_0x0000AAAA"): 5.0,  # other GPU
    }
    usage = aggregate_engine_usage(values)
    assert usage.by_adapter[LUID] == 75.0  # busiest engine = 3D, summed over apps
    assert usage.by_adapter["0x00000000_0x0000aaaa"] == 5.0
    assert usage.by_pid[100] == 60.0
    assert usage.by_pid[200] == 30.0  # its busiest engine
    assert 300 not in usage.by_pid
    assert usage.by_pid_adapter[(100, LUID)] == 60.0


def test_aggregate_caps_at_100():
    usage = aggregate_engine_usage({engine(1): 80.0, engine(2): 70.0})
    assert usage.by_adapter[LUID] == 100.0


def test_parse_nvidia_smi():
    text = "0, NVIDIA GeForce RTX 3060, 45, 5123, 12288, 67, 120.52\n1, Weird, Name, [N/A], 10, 100, [N/A], [Not Supported]\n"
    first, second = parse_nvidia_smi(text)
    assert first.name == "NVIDIA GeForce RTX 3060"
    assert first.util == 45 and first.temp == 67 and first.power_w == 120.52
    assert first.mem_used == 5123 * 1024 * 1024 and first.mem_total == 12288 * 1024 * 1024
    assert first.mem_percent is not None and round(first.mem_percent) == 42
    assert second.name == "Weird, Name"
    assert second.util is None and second.power_w is None and second.temp is None


def test_decode_nvidia_throttle():
    assert decode_nvidia_throttle(0x4) == ()  # power cap is normal under load
    assert decode_nvidia_throttle(0x40) == ("thermal",)
    assert decode_nvidia_throttle(0x20 | 0x08) == ("thermal", "hardware slowdown")


def test_primary_gpu_prefers_dedicated_card():
    igpu = GpuStat("a", "Intel UHD", "Intel", util=50, mem_total=8 * 2**30, integrated=True)
    dgpu = GpuStat("b", "RTX", "NVIDIA", util=10, mem_total=12 * 2**30)
    assert primary_gpu([igpu, dgpu]) is dgpu
    assert primary_gpu([]) is None


def test_linux_sysfs_backend(tmp_path):
    device = tmp_path / "card0" / "device"
    (device / "hwmon" / "hwmon3").mkdir(parents=True)
    (tmp_path / "card0-DP-1").mkdir()
    (device / "vendor").write_text("0x1002\n")
    (device / "gpu_busy_percent").write_text("87\n")
    (device / "mem_info_vram_used").write_text(str(3 * 2**30))
    (device / "mem_info_vram_total").write_text(str(8 * 2**30))
    (device / "product_name").write_text("AMD Radeon RX 6600\n")
    (device / "hwmon" / "hwmon3" / "temp1_input").write_text("64000\n")
    (gpu,) = LinuxSysfsBackend(tmp_path).sample()
    assert gpu.name == "AMD Radeon RX 6600" and gpu.vendor == "AMD"
    assert gpu.util == 87 and gpu.temp == 64.0
    assert gpu.mem_used == 3 * 2**30 and gpu.mem_total == 8 * 2**30 and not gpu.integrated


def test_parse_powercfg_list_any_language():
    english = """Existing Power Schemes (* Active)
-----------------------------------
Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced) *
Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance)
Power Scheme GUID: a1841308-3541-4fab-bc81-f71556f20b4a  (Power saver)
"""
    schemes, active = parse_powercfg_list(english)
    assert active == POWER_BALANCED
    assert schemes[POWER_HIGH] == "High performance"
    german = "GUID des Energieschemas: 8C5E7FDA-E8BF-4A96-9A85-A6E23A8C635C  (Höchstleistung) *\n"
    schemes, active = parse_powercfg_list(german)
    assert active == POWER_HIGH and schemes[POWER_HIGH] == "Höchstleistung"
    odd = "Power Scheme GUID: 11111111-2222-3333-4444-555555555555  (AMD Ryzen (TM) Balanced)\n"
    schemes, active = parse_powercfg_list(odd)
    assert active is None and schemes["11111111-2222-3333-4444-555555555555"] == "AMD Ryzen (TM) Balanced"


def test_power_info_helpers():
    info = PowerInfo("windows", POWER_BALANCED, "Balanced", {POWER_BALANCED: "Balanced", POWER_HIGH: "High performance"})
    assert not info.is_performance()
    assert info.performance_plan() == POWER_HIGH
    info.schemes["9999aaaa-0000-0000-0000-000000000000"] = "Ultimate Performance"
    assert info.performance_plan() == "9999aaaa-0000-0000-0000-000000000000"
    assert PowerInfo("windows", POWER_ULTIMATE).is_performance()
    assert PowerInfo("windows", "x", "Höchstleistung").performance_plan() is None
    linux = PowerInfo("linux", "balanced", "balanced", {"balanced": "balanced", "performance": "performance"})
    assert linux.performance_plan() == "performance" and not linux.is_performance()


def test_network_check_stats():
    check = NetworkCheck(samples=[20.0, 30.0, 20.0], lost=1, reachable=1)
    assert check.average == 70.0 / 3
    assert check.jitter == 10.0
    assert check.loss_percent == 25.0
    assert NetworkCheck().average is None and NetworkCheck().loss_percent == 0.0


def test_guid_round_trip_and_luid_format():
    text = "ded574b5-45a0-4f42-8737-46345c09c238"
    assert str(GUID.from_string(text)) == text
    assert luid_key(0, 0xD1A6) == "0x00000000_0x0000d1a6"
    assert luid_key(-1, 1) == "0xffffffff_0x00000001"


def test_game_detection_helpers():
    assert apps.normalize("FortniteClient-Win64-Shipping.EXE") == "fortniteclient-win64-shipping"
    steam_exe = "D:\\SteamLibrary\\steamapps\\common\\Apex Legends\\r5apex_dx12.exe"
    assert apps.game_score("r5apex_dx12", steam_exe, 50) >= 60
    assert apps.game_title("r5apex_dx12", steam_exe, "x") == "Apex Legends"
    unreal = "C:\\Games\\Foo\\Binaries\\Win64\\Foo-Win64-Shipping.exe"
    assert apps.game_score("foo-win64-shipping", unreal, 0) >= 60
    assert apps.game_title("foo-win64-shipping", "C:\\x\\Foo-Win64-Shipping.exe", "x") == "Foo"
    helper = "D:\\SteamLibrary\\steamapps\\common\\Game\\UnityCrashHandler64.exe"
    assert apps.game_score("unitycrashhandler64", helper, 50) == 0
    assert apps.game_score("chrome", "C:\\chrome.exe", 90) == 0  # browsers are never games
    assert apps.game_score("explorer", "C:\\Windows\\explorer.exe", 90) == 0
    assert apps.game_score("mytool", "C:\\tools\\mytool.exe", 0, frozenset({"mytool"})) == 200
    minecraft = "C:\\Users\\a\\AppData\\Roaming\\.minecraft\\runtime\\bin\\javaw.exe"
    assert apps.game_score("javaw", minecraft, 30) >= 60
    assert apps.game_title("javaw", minecraft, "javaw") == "Minecraft (Java Edition)"
