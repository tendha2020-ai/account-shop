"""Builds the real window (needs a display; skipped otherwise)."""

import time

import pytest

tk = pytest.importorskip("tkinter")

from lagbuster.ui import app as app_module  # noqa: E402
from lagbuster.ui.app import LagBusterApp  # noqa: E402


@pytest.fixture
def root():
    try:
        window = tk.Tk()
    except tk.TclError as exc:
        pytest.skip(f"no display: {exc}")
    window.withdraw()
    yield window
    try:
        window.destroy()
    except tk.TclError:
        pass


def pump(root, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        root.update()
        time.sleep(0.02)


def test_demo_ui_scan_apply_and_tabs(root, tmp_path, monkeypatch):
    monkeypatch.setattr(app_module.messagebox, "askyesno", lambda *a, **k: True)
    app = LagBusterApp(root, demo=True, data_dir=tmp_path)
    root.deiconify()
    pump(root, 0.5)
    for tab in (app.dashboard, app.boost, app.processes, app.settings_tab):
        app.notebook.select(tab)
        pump(root, 0.3)

    result = app.scan_worker(None)
    app.boost._scan_done(result)
    pump(root, 0.2)
    assert app.boost.rows, "suggestions should be shown"
    selected = [row for row in app.boost.rows if row.var.get()]
    assert selected and all(row.s.recommended for row in selected)
    app.boost.select_none()
    assert str(app.boost.apply_button.cget("state")) == "disabled"
    app.boost.select_recommended()
    assert "Apply selected (" in app.boost.apply_button.cget("text")

    app.boost.start_scan = lambda: None  # don't rescan after applying
    app.boost.apply_selected()
    deadline = time.monotonic() + 10
    while app.boost.busy and time.monotonic() < deadline:
        pump(root, 0.1)
    log = app.boost.log.get("1.0", "end")
    assert "Demo mode, nothing changed" in log
    assert app.settings.choices, "choices are remembered"

    app.toggle_overlay(True)
    pump(root, 1.2)
    assert app.overlay is not None and "CPU" in app.overlay.labels["cpu"].cget("text")
    app.toggle_overlay(False)
    assert app.overlay is None
    assert app.errors == []
    app.close()


def test_real_ui_starts_and_measures(root, tmp_path):
    app = LagBusterApp(root, demo=False, data_dir=tmp_path)
    root.deiconify()
    app.notebook.select(app.processes)
    deadline = time.monotonic() + 20
    while not app.processes.tree.get_children() and time.monotonic() < deadline:
        pump(root, 0.25)
    assert app.monitor.latest is not None
    assert app.processes.tree.get_children(), "the process list should fill in"
    app.notebook.select(app.dashboard)
    pump(root, 1.5)
    assert app.dashboard.cpu.value_label.cget("text").endswith("%")
    assert app.errors == []
    app.close()
