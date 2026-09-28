import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import worklog  # noqa: E402


def load():
    rules = json.loads((HERE.parent / "rules.json").read_text(encoding="utf-8"))
    emails = [worklog.Email(**d) for d in json.loads((HERE / "sample_emails.json").read_text())]
    return worklog.build_threads(emails, rules, 1)


def test_subject_normalization():
    assert worklog.normalize_subject("RE: FW: Re[2]: Budget") == "Budget"
    assert worklog.normalize_subject("[EXTERNAL] RE: Hi") == "Hi"


def test_strip_quoted():
    assert worklog.strip_quoted("New text\n\nFrom: Bob\nold") == "New text"


def test_grouping_and_categories():
    by_title = {t.title: t for t in load()}
    assert set(by_title) == {"Q1 Sales Dashboard go-live", "Payment system outage",
                             "Onboarding plan for new joiner", "Automate vendor invoice matching"}
    dash = by_title["Q1 Sales Dashboard go-live"]
    assert len(dash.emails) == 3 and dash.my_count == 2
    assert dash.category == "Reporting & Analysis"
    assert dash.recognition and "Sara Ali" in dash.recognition[0]
    assert dash.attachments == ["Dashboard_Guide.pdf"]
    assert by_title["Payment system outage"].category == "Incidents & Support"
    assert by_title["Onboarding plan for new joiner"].category == "Leadership"  # Outlook category wins
    assert by_title["Automate vendor invoice matching"].category == "Process Improvement"


def test_end_to_end(tmp_path):
    worklog.main(["--from-json", str(HERE / "sample_emails.json"), "--start", "2026-01-01",
                  "--end", "2026-12-31", "--out", str(tmp_path)])
    for name in ("worklog.html", "worklog.md", "worklog.csv"):
        assert (tmp_path / name).stat().st_size > 0
    assert "Recognition" in (tmp_path / "worklog.md").read_text(encoding="utf-8")


class _Folders:
    def __init__(self, items):
        self._items = items
        self.Count = len(items)

    def Item(self, key):
        if isinstance(key, int):
            return self._items[key - 1]
        for f in self._items:
            if f.Name.lower() == key.lower():
                return f
        raise KeyError(key)


class _Folder:
    def __init__(self, name, children=()):
        self.Name = name
        self.Folders = _Folders(list(children))


def test_pick_mailbox_and_folders():
    personal = _Folder("me@gmail.com", [_Folder("Inbox"), _Folder("Sent Items")])
    work = _Folder("me@company.com", [_Folder("Inbox", [_Folder("Projects")]), _Folder("Sent Items")])

    class NS:
        Folders = _Folders([personal, work])

    assert worklog._pick_mailbox(NS, "ME@company.com") is work
    assert worklog._pick_mailbox(NS, "company") is work  # partial match
    # _default_folder falls back to folder names when root.Store is unavailable
    assert worklog._resolve_folder(work, "Inbox/Projects").Name == "Projects"
    assert worklog._resolve_folder(work, "Sent Items").Name == "Sent Items"
