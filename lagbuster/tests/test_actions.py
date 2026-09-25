import json
import os
import subprocess
import sys
import time

import psutil
import pytest

from lagbuster.actions import (
    Action,
    ActionContext,
    ActionResult,
    CloseApp,
    ProcTarget,
    SetPriority,
    UndoJournal,
    priority_name,
    priority_value,
    run_actions,
)

IS_WINDOWS = sys.platform == "win32"
IS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0


@pytest.fixture
def helper():
    kwargs = {"creationflags": 0x08000000} if IS_WINDOWS else {}
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], **kwargs)
    time.sleep(0.3)
    try:
        # CI runners start jobs at a lowered priority, which child processes inherit.
        psutil.Process(proc.pid).nice(priority_value("normal"))
    except psutil.AccessDenied:
        pass
    yield proc
    if proc.poll() is None:
        proc.kill()
        proc.wait(5)


def target(proc):
    return ProcTarget(proc.pid, psutil.Process(proc.pid).create_time())


def test_journal_keeps_the_original_value_and_persists(tmp_path):
    path = tmp_path / "undo.json"
    journal = UndoJournal(path)
    journal.record({"type": "power_scheme", "old": "balanced-guid", "label": "Power plan"})
    journal.record({"type": "power_scheme", "old": "high-guid", "label": "Power plan"})  # second switch
    journal.record({"type": "registry", "root": "HKCU", "path": "a", "name": "x", "old": 1, "label": "Setting"})
    assert len(journal) == 2
    assert journal.entries[0]["old"] == "balanced-guid"
    reloaded = UndoJournal(path)
    assert [e["type"] for e in reloaded.entries] == ["power_scheme", "registry"]
    assert json.loads(path.read_text())[0]["old"] == "balanced-guid"


def test_journal_ignores_garbage(tmp_path):
    path = tmp_path / "undo.json"
    path.write_text("{not json")
    assert UndoJournal(path).entries == []
    path.write_text(json.dumps([{"type": "priority"}, "junk", {"no": "type"}]))
    assert len(UndoJournal(path).entries) == 1


def test_journal_descriptions_group_processes():
    journal = UndoJournal(None)
    for pid in (1, 2, 3):
        journal.record({"type": "priority", "pid": pid, "create_time": 1.0, "old": 32, "app": "Chrome", "label": "Chrome: lower priority"})
    journal.record({"type": "power_scheme", "old": "x", "label": "Power plan: Balanced → High performance"})
    assert journal.descriptions() == ["Chrome: lower priority (3 processes)", "Power plan: Balanced → High performance"]


def test_journal_prune_forgets_closed_apps():
    journal = UndoJournal(None)
    journal.record({"type": "priority", "pid": 999_999, "create_time": 1.0, "old": 0, "label": "gone"})
    journal.record({"type": "power_scheme", "old": "x", "label": "plan"})
    journal.prune()
    assert [e["type"] for e in journal.entries] == ["power_scheme"]


def test_lower_priority_and_undo(helper):
    start = int(psutil.Process(helper.pid).nice())
    assert start == priority_value("normal")
    journal = UndoJournal(None)
    result = SetPriority("helper", [target(helper)], "below_normal").run(ActionContext(journal))
    assert result.ok, result.message
    assert int(psutil.Process(helper.pid).nice()) == priority_value("below_normal")
    assert len(journal) == 1
    again = SetPriority("helper", [target(helper)], "below_normal").run(ActionContext(journal))
    assert again.ok and "already" in again.message
    results = journal.undo_all()
    now = int(psutil.Process(helper.pid).nice())
    if IS_WINDOWS or IS_ROOT:
        assert now == priority_value("normal")
        assert any("normal priority" in r.message for r in results)
    else:  # Linux users can lower a priority but not raise it back
        assert any(not r.ok for r in results)
    assert len(journal) == 0


def test_close_app(helper):
    # On Windows a console helper has no window, so it needs the force step.
    action = CloseApp("helper", [target(helper)], force_ok=IS_WINDOWS, grace_seconds=3)
    result = action.run(ActionContext(UndoJournal(None)))
    assert result.ok, result.message
    assert helper.wait(timeout=5) is not None


def test_close_app_that_already_exited():
    result = CloseApp("ghost", [ProcTarget(999_999, 1.0)], force_ok=True).run(ActionContext(UndoJournal(None)))
    assert result.ok and "already closed" in result.message


def test_pid_reuse_is_detected(helper):
    before = int(psutil.Process(helper.pid).nice())
    wrong_time = ProcTarget(helper.pid, psutil.Process(helper.pid).create_time() - 100)
    result = SetPriority("helper", [wrong_time], "below_normal").run(ActionContext(UndoJournal(None)))
    assert result.ok and "isn't running" in result.message
    assert int(psutil.Process(helper.pid).nice()) == before


class Recorder(Action):
    def __init__(self, name, order, log, fail=False):
        self.name, self.order, self.log, self.fail = name, order, log, fail

    def describe(self):
        return self.name

    def run(self, ctx):
        self.log.append(self.name)
        if self.fail:
            raise RuntimeError("boom")
        return ActionResult(True, self.name)


def test_run_actions_order_errors_and_demo_mode():
    log = []
    actions = [Recorder("trim", 60, log), Recorder("close", 30, log, fail=True), Recorder("power", 10, log)]
    progress = []
    results = run_actions(actions, ActionContext(UndoJournal(None), progress=progress.append))
    assert log == ["power", "close", "trim"]
    assert [r.ok for r in results] == [True, False, True]
    assert "boom" in results[1].message
    assert progress == ["power", "close", "trim"]

    log.clear()
    journal = UndoJournal(None)
    results = run_actions(actions, ActionContext(journal, dry_run=True))
    assert log == [] and len(journal) == 0
    assert all(r.ok and r.message.startswith("Demo mode") for r in results)


def test_priority_names():
    assert priority_name(32, windows=True) == "Normal"
    assert priority_name(128, windows=True) == "High"
    assert priority_name(0, windows=False) == "Normal"
    assert priority_name(10, windows=False) == "Lower (+10)"
    assert priority_name(None) == ""
