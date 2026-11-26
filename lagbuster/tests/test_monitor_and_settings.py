import json
import os

from lagbuster.monitor import HistoryPoint, SystemMonitor, compute_averages
from lagbuster.settings import Settings


def test_real_monitor_samples_this_computer():
    monitor = SystemMonitor(interval=0.5)
    monitor.start()
    try:
        assert monitor.wait_for_processes(samples=2, timeout=20)
        snap = monitor.latest
        assert snap is not None
        assert 0 <= snap.cpu <= 100
        assert snap.ram_total > 0 and 0 <= snap.ram_percent <= 100
        assert snap.cpu_threads >= 1
        mine = [p for p in snap.processes if p.pid == os.getpid()]
        assert mine and mine[0].mine and mine[0].rss > 0
        assert monitor.history()
        averages = monitor.averages(10)
        assert averages.samples >= 1 and 0 <= averages.cpu <= 100
    finally:
        monitor.stop()


def test_compute_averages():
    points = [
        HistoryPoint(0.0, 10, 50, None, 40, 60, 100, 10),
        HistoryPoint(1.0, 30, 70, 80, 90, 70, 300, 30),
    ]
    averages = compute_averages(points)
    assert averages.cpu == 20 and averages.ram == 60
    assert averages.gpu == 80 and averages.vram_peak == 90 and averages.gpu_temp_peak == 70
    assert averages.net_recv == 200 and averages.seconds == 1.0
    assert compute_averages([]).samples == 0


def test_settings_round_trip(tmp_path):
    path = tmp_path / "settings.json"
    settings = Settings.load(path)
    assert settings.refresh_seconds == 1.0 and settings.protected_apps == []
    settings.add_unique("my_games", "fortniteclient-win64-shipping")
    settings.add_unique("my_games", "fortniteclient-win64-shipping")
    settings.remember_choice("app:chrome", False, "Close it")
    settings.overlay_x = 50
    settings.save()
    loaded = Settings.load(path)
    assert loaded.my_games == ["fortniteclient-win64-shipping"]
    assert loaded.choices["app:chrome"] == {"checked": False, "mode": "Close it"}
    assert loaded.overlay_x == 50 and loaded.overlay_y is None


def test_settings_survive_bad_values(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "refresh_seconds": 99,
                "overlay_opacity": "loud",
                "my_games": ["ok", 5, None],
                "choices": {"a": {"checked": True}, "b": "nope"},
                "undo_on_exit": "yes",
                "overlay_x": True,
            }
        )
    )
    loaded = Settings.load(path)
    assert loaded.refresh_seconds == 5.0
    assert loaded.overlay_opacity == 0.85
    assert loaded.my_games == ["ok"]
    assert list(loaded.choices) == ["a"]
    assert loaded.undo_on_exit is False and loaded.overlay_x is None
    path.write_text("[1, 2")
    assert Settings.load(path).refresh_seconds == 1.0
