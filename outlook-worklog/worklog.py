"""
Outlook Worklog Builder
=======================

Scans your classic Outlook (Windows desktop) mailbox for a date range, groups
the emails into work threads, sorts them into categories, and writes a worklog
you can use for your year-end performance review.

Outputs (in the --out folder):
  worklog.html      - readable report, grouped by category and month
  worklog.md        - same content as Markdown (paste into Word / OneNote)
  worklog.csv       - one row per thread (open in Excel, sort/filter/edit)
  emails.json       - raw scan cache, so you can re-group without rescanning
  ai_summary.md     - (only with --ai) review-ready accomplishment bullets

Examples:
  python worklog.py                                  # this calendar year
  python worklog.py --start 2025-10-01 --end 2026-09-30
  python worklog.py --folders "Inbox" "Sent Items" "Inbox/Projects" --subfolders
  python worklog.py --from-json out/emails.json      # re-group after editing rules.json
  python worklog.py --from-json out/emails.json --ai # add AI-written summary
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Outlook object model constants
OL_FOLDER_INBOX = 6
OL_FOLDER_SENT = 5
OL_MAIL_ITEM = 43
OL_MEETING_CLASSES = {53, 54, 55, 56, 57}  # meeting request/cancel/response items

SUBJECT_PREFIX_RE = re.compile(
    r"^\s*((re|fw|fwd|aw|wg|sv|vs|rv|tr|urgent|important|action required|reminder|fyi)\s*(\[\d+\])?\s*:\s*)+", re.I)
QUOTE_MARKERS = [
    re.compile(r"^-{2,}\s*Original Message\s*-{2,}", re.I | re.M),
    re.compile(r"^From:\s.+$", re.M),
    re.compile(r"^On .+ wrote:\s*$", re.M),
    re.compile(r"^_{10,}\s*$", re.M),
]


@dataclass
class Email:
    subject: str
    date: str  # ISO format
    sender: str
    to: str
    body: str  # your new text only (quoted history stripped), truncated
    folder: str
    from_me: bool
    categories: str = ""
    attachments: list[str] = field(default_factory=list)
    is_meeting: bool = False
    conversation: str = ""


@dataclass
class Thread:
    key: str
    title: str
    emails: list[Email] = field(default_factory=list)
    category: str = "Other"
    recognition: list[str] = field(default_factory=list)

    @property
    def first(self) -> datetime:
        return min(datetime.fromisoformat(e.date) for e in self.emails)

    @property
    def last(self) -> datetime:
        return max(datetime.fromisoformat(e.date) for e in self.emails)

    @property
    def my_count(self) -> int:
        return sum(e.from_me for e in self.emails)

    @property
    def people(self) -> list[str]:
        names: Counter[str] = Counter()
        for e in self.emails:
            # Emails I sent -> the recipients; emails I received -> the sender.
            parts = re.split(r";", e.to) if e.from_me else [e.sender]
            for p in parts:
                p = p.strip().strip("'\"")
                if p:
                    names[p] += 1
        return [n for n, _ in names.most_common(6)]

    @property
    def attachments(self) -> list[str]:
        seen: dict[str, None] = {}
        for e in self.emails:
            if e.from_me:
                for a in e.attachments:
                    if not re.match(r"^image\d*\.(png|jpg|gif)$", a, re.I):
                        seen[a] = None
        return list(seen)

    def my_highlights(self, n: int = 2, width: int = 220) -> list[str]:
        out = []
        for e in sorted(self.emails, key=lambda x: x.date):
            if e.from_me and e.body.strip():
                text = " ".join(e.body.split())
                out.append(text[:width] + ("..." if len(text) > width else ""))
            if len(out) >= n:
                break
        return out


# --------------------------------------------------------------------------- #
# Text helpers
# --------------------------------------------------------------------------- #

def normalize_subject(subject: str) -> str:
    s = SUBJECT_PREFIX_RE.sub("", subject or "").strip()
    s = re.sub(r"^\[(external|ext)\]\s*", "", s, flags=re.I)
    s = SUBJECT_PREFIX_RE.sub("", s).strip()
    return s or "(no subject)"


def strip_quoted(body: str) -> str:
    """Keep only the newly written part of an email, not the quoted chain."""
    body = (body or "").replace("\r\n", "\n")
    cut = len(body)
    for pat in QUOTE_MARKERS:
        m = pat.search(body)
        if m and m.start() > 0:
            cut = min(cut, m.start())
    body = body[:cut]
    lines = [ln for ln in body.split("\n") if not ln.lstrip().startswith(">")]
    return "\n".join(lines).strip()


def parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d")


# --------------------------------------------------------------------------- #
# Outlook scanning (Windows + classic Outlook only)
# --------------------------------------------------------------------------- #

def _naive(dt) -> datetime:
    return datetime(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)


def _open_outlook():
    try:
        import win32com.client  # type: ignore
    except ImportError:
        sys.exit("pywin32 is not installed. Run:  pip install pywin32\n"
                 "(Scanning needs Windows + classic Outlook. On other machines use --from-json.)")
    return win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")


def list_mailboxes() -> None:
    ns = _open_outlook()
    default = ns.GetDefaultFolder(OL_FOLDER_INBOX).Parent.Name
    print("Mailboxes in Outlook (use one with --mailbox):")
    for i in range(1, ns.Folders.Count + 1):
        name = ns.Folders.Item(i).Name
        print(f'  "{name}"' + ("   <- default" if name == default else ""))


def _pick_mailbox(ns, name: str | None):
    """Top folder of the chosen mailbox; the default one if no name is given."""
    if not name:
        return ns.GetDefaultFolder(OL_FOLDER_INBOX).Parent
    stores = [ns.Folders.Item(i) for i in range(1, ns.Folders.Count + 1)]
    want = name.strip().lower()
    for match in (lambda n: n == want, lambda n: want in n):  # exact first, then partial
        found = [f for f in stores if match(f.Name.lower())]
        if found:
            return found[0]
    names = ", ".join(f'"{f.Name}"' for f in stores)
    sys.exit(f'No mailbox matching "{name}". Available: {names}')


def _default_folder(root, kind: int):
    try:
        return root.Store.GetDefaultFolder(kind)
    except Exception:  # older Outlook / some shared mailboxes
        return root.Folders.Item("Inbox" if kind == OL_FOLDER_INBOX else "Sent Items")


def _resolve_folder(root, path: str):
    """'Inbox', 'Sent Items', 'Inbox/Projects/Alpha' or any top-level folder, inside mailbox `root`."""
    parts = [p for p in path.strip().strip("/").split("/") if p]
    first = parts[0].lower()
    if first == "inbox":
        folder = _default_folder(root, OL_FOLDER_INBOX)
    elif first in ("sent", "sent items"):
        folder = _default_folder(root, OL_FOLDER_SENT)
    else:
        folder = root.Folders.Item(parts[0])
    for name in parts[1:]:
        folder = folder.Folders.Item(name)
    return folder


def _walk(folder, include_sub: bool):
    yield folder
    if include_sub:
        for i in range(1, folder.Folders.Count + 1):
            yield from _walk(folder.Folders.Item(i), True)


def scan_outlook(folders: list[str], start: datetime, end: datetime,
                 include_sub: bool, body_chars: int, mailbox: str | None = None) -> list[Email]:
    ns = _open_outlook()
    root = _pick_mailbox(ns, mailbox)
    print(f"Mailbox: {root.Name}")
    me_name = (ns.CurrentUser.Name or "").strip().lower()
    try:
        me_addr = (ns.CurrentUser.AddressEntry.GetExchangeUser().PrimarySmtpAddress or "").lower()
    except Exception:
        me_addr = (ns.CurrentUser.Address or "").lower()
    # The mailbox name is usually its email address, so it identifies "me" too.
    my_addrs = {a for a in (me_addr, root.Name.strip().lower()) if a}
    sent_id = _default_folder(root, OL_FOLDER_SENT).EntryID

    # Outlook's Restrict wants a locale-ish US date string.
    fmt = "%m/%d/%Y %I:%M %p"
    emails: list[Email] = []
    for path in folders:
        try:
            base = _resolve_folder(root, path)
        except Exception as exc:
            print(f"  ! Could not open folder '{path}': {exc}")
            continue
        for folder in _walk(base, include_sub):
            is_sent = folder.EntryID == sent_id
            field_name = "[SentOn]" if is_sent else "[ReceivedTime]"
            flt = f"{field_name} >= '{start.strftime(fmt)}' AND {field_name} < '{end.strftime(fmt)}'"
            try:
                items = folder.Items.Restrict(flt)
            except Exception as exc:
                print(f"  ! Skipping '{folder.FolderPath}': {exc}")
                continue
            total = items.Count
            print(f"  Scanning {folder.FolderPath}  ({total} items)")
            for idx in range(1, total + 1):
                try:
                    item = items.Item(idx)
                    cls = item.Class
                    if cls != OL_MAIL_ITEM and cls not in OL_MEETING_CLASSES:
                        continue
                    when = item.SentOn if is_sent else item.ReceivedTime
                    sender = item.SenderName or ""
                    try:
                        sender_addr = (item.SenderEmailAddress or "").lower()
                    except Exception:
                        sender_addr = ""
                    from_me = is_sent or sender.strip().lower() == me_name or sender_addr in my_addrs
                    attachments = []
                    try:
                        for a in range(1, item.Attachments.Count + 1):
                            attachments.append(item.Attachments.Item(a).FileName)
                    except Exception:
                        pass
                    emails.append(Email(
                        subject=item.Subject or "",
                        date=_naive(when).isoformat(),
                        sender=sender if not from_me else "me",
                        to=item.To or "",
                        body=strip_quoted(item.Body or "")[:body_chars],
                        folder=folder.FolderPath,
                        from_me=bool(from_me),
                        categories=item.Categories or "",
                        attachments=attachments,
                        is_meeting=cls in OL_MEETING_CLASSES,
                        conversation=getattr(item, "ConversationTopic", "") or "",
                    ))
                except Exception as exc:  # corrupt/unsupported item - keep going
                    print(f"    - skipped one item: {exc}")
                if idx % 500 == 0:
                    print(f"    ...{idx}/{total}")
    return emails


# --------------------------------------------------------------------------- #
# Grouping and classification
# --------------------------------------------------------------------------- #

def is_noise(e: Email, rules: dict) -> bool:
    subj = e.subject.strip().lower()
    if any(subj.startswith(p) for p in rules.get("ignore_subject_prefixes", [])):
        return True
    snd = e.sender.lower()
    return any(s in snd for s in rules.get("ignore_senders", []))


def classify(thread: Thread, rules: dict) -> str:
    # 1) Outlook categories you assigned yourself always win.
    tagged = Counter(c.strip() for e in thread.emails for c in e.categories.split(",") if c.strip())
    if tagged:
        return tagged.most_common(1)[0][0]
    # 2) Keyword scoring.
    subject = thread.title.lower()
    body = " ".join(e.body.lower() for e in thread.emails)
    best, best_score = "Other", 0
    for cat, words in rules.get("categories", {}).items():
        score = 0
        for w in words:
            # Keywords match word prefixes ("automat" -> automation); a trailing
            # space in rules.json means whole word only ("po " won't hit "policy").
            w = w.lower()
            pat = re.compile(r"\b" + re.escape(w.strip()) + (r"\b" if w.endswith(" ") else ""))
            score += 2 * len(pat.findall(subject)) + len(pat.findall(body))
        if score > best_score:
            best, best_score = cat, score
    if best == "Other" and all(e.is_meeting for e in thread.emails):
        return "Meetings"
    return best


def find_recognition(thread: Thread, rules: dict) -> list[str]:
    kws = [k.lower() for k in rules.get("recognition_keywords", [])]
    hits = []
    for e in thread.emails:
        if e.from_me:
            continue
        text = " ".join(e.body.split())
        low = text.lower()
        for k in kws:
            i = low.find(k)
            if i >= 0:
                s = max(0, i - 80)
                hits.append(f'{e.sender} ({e.date[:10]}): "...{text[s:i + 140].strip()}..."')
                break
    return hits


def build_threads(emails: list[Email], rules: dict, min_mine: int) -> list[Thread]:
    groups: dict[str, Thread] = {}
    for e in emails:
        if is_noise(e, rules):
            continue
        title = normalize_subject(e.conversation or e.subject)
        key = title.lower()
        groups.setdefault(key, Thread(key=key, title=title)).emails.append(e)

    threads = []
    for t in groups.values():
        t.recognition = find_recognition(t, rules)
        # Keep threads you worked on, plus anything where someone praised you.
        if t.my_count >= min_mine or t.recognition:
            t.category = classify(t, rules)
            threads.append(t)
    threads.sort(key=lambda t: t.first)
    return threads


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #

def _period(t: Thread) -> str:
    a, b = t.first, t.last
    return a.strftime("%d %b") if a.date() == b.date() else f"{a:%d %b} - {b:%d %b}"


def write_csv(threads: list[Thread], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["Category", "Month", "Thread", "Start", "End", "Emails", "Sent by me",
                    "Key people", "My files", "Recognition", "What I did (from my emails)", "Review notes"])
        for t in threads:
            w.writerow([t.category, t.first.strftime("%Y-%m"), t.title, t.first.date(), t.last.date(),
                        len(t.emails), t.my_count, "; ".join(t.people), "; ".join(t.attachments),
                        " | ".join(t.recognition), " | ".join(t.my_highlights()), ""])


def _by_category(threads: list[Thread]) -> dict[str, list[Thread]]:
    cats: dict[str, list[Thread]] = defaultdict(list)
    for t in threads:
        cats[t.category].append(t)
    return dict(sorted(cats.items(), key=lambda kv: (kv[0] == "Other", -sum(t.my_count for t in kv[1]))))


def write_markdown(threads: list[Thread], path: Path, start: datetime, end: datetime) -> None:
    cats = _by_category(threads)
    total_sent = sum(t.my_count for t in threads)
    lines = [f"# Worklog {start:%d %b %Y} - {(end - timedelta(days=1)):%d %b %Y}", "",
             f"**{len(threads)} work threads**, **{total_sent} emails sent by me**, "
             f"**{sum(bool(t.recognition) for t in threads)} threads with recognition**.", "",
             "## Summary by category", "", "| Category | Threads | Emails I sent |", "|---|---:|---:|"]
    for cat, ts in cats.items():
        lines.append(f"| {cat} | {len(ts)} | {sum(t.my_count for t in ts)} |")

    praise = [r for t in threads for r in t.recognition]
    if praise:
        lines += ["", "## Recognition & thanks received", ""]
        lines += [f"- {r}" for r in praise]

    for cat, ts in cats.items():
        lines += ["", f"## {cat}"]
        month = None
        for t in ts:
            m = t.first.strftime("%B %Y")
            if m != month:
                lines += ["", f"### {m}", ""]
                month = m
            lines.append(f"- **{t.title}** ({_period(t)}; {t.my_count} sent / {len(t.emails)} total)")
            if t.people:
                lines.append(f"  - With: {', '.join(t.people)}")
            for h in t.my_highlights():
                lines.append(f"  - I wrote: _{h}_")
            if t.attachments:
                lines.append(f"  - Files I shared: {', '.join(t.attachments[:5])}")
            for r in t.recognition:
                lines.append(f"  - 🏆 {r}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_html(threads: list[Thread], path: Path, start: datetime, end: datetime) -> None:
    esc = html.escape
    cats = _by_category(threads)
    months = Counter(t.first.strftime("%Y-%m") for t in threads)
    y, m = start.year, start.month  # include quiet months so gaps are visible
    while (y, m) <= (end.year, end.month) and datetime(y, m, 1) < end:
        months.setdefault(f"{y}-{m:02d}", 0)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    max_m = max(months.values(), default=1)
    bars = "".join(
        f'<div class="bar"><span style="height:{max(2, 100 * n // max_m) if n else 0}%" title="{n} threads"></span>'
        f'<small>{datetime.strptime(m, "%Y-%m"):%b}</small></div>' for m, n in sorted(months.items()))
    praise = [r for t in threads for r in t.recognition]

    sections = []
    for cat, ts in cats.items():
        rows = []
        for t in ts:
            extra = "".join(f"<li>I wrote: <em>{esc(h)}</em></li>" for h in t.my_highlights())
            if t.attachments:
                extra += f"<li>Files I shared: {esc(', '.join(t.attachments[:5]))}</li>"
            extra += "".join(f'<li class="praise">🏆 {esc(r)}</li>' for r in t.recognition)
            rows.append(
                f'<details><summary><b>{esc(t.title)}</b> <span class="meta">{esc(_period(t))} · '
                f'{t.my_count} sent / {len(t.emails)} total</span></summary>'
                f'<p class="meta">With: {esc(", ".join(t.people)) or "-"}</p><ul>{extra}</ul></details>')
        sections.append(f'<section><h2>{esc(cat)} <span class="count">{len(ts)}</span></h2>{"".join(rows)}</section>')

    praise_html = ""
    if praise:
        praise_html = ('<section class="praise-box"><h2>Recognition &amp; thanks received</h2><ul>'
                       + "".join(f"<li>{esc(r)}</li>" for r in praise) + "</ul></section>")

    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>My Worklog</title>
<style>
:root{{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1f;--muted:#6b6b70;--accent:#2f6fdf;--line:#e3e3e0;--gold:#b7791f}}
@media (prefers-color-scheme:dark){{:root{{--bg:#161618;--card:#202023;--ink:#ececef;--muted:#9a9aa1;--accent:#7aa7ff;--line:#34343a;--gold:#e0b050}}}}
body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,Segoe UI,sans-serif}}
main{{max-width:960px;margin:auto;padding:24px 16px}} h1{{margin:0 0 4px}}
.stats{{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}}
.stat{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px}}
.stat b{{font-size:22px;display:block}} .meta{{color:var(--muted);font-size:13px}}
.chart{{display:flex;align-items:flex-end;gap:6px;height:110px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px}}
.bar{{flex:1;display:flex;flex-direction:column;align-items:center;height:100%;justify-content:flex-end}}
.bar span{{width:70%;background:var(--accent);border-radius:4px 4px 0 0}} .bar small{{color:var(--muted)}}
section{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:16px 0}}
h2{{font-size:18px;margin:4px 0 8px}} .count{{color:var(--muted);font-weight:normal}}
details{{border-top:1px solid var(--line);padding:6px 0}} summary{{cursor:pointer}}
.praise,.praise-box li{{color:var(--gold)}} ul{{margin:4px 0;padding-left:20px}}
</style></head><body><main>
<h1>My Worklog</h1><div class="meta">{start:%d %b %Y} – {(end - timedelta(days=1)):%d %b %Y} · generated {datetime.now():%d %b %Y}</div>
<div class="stats"><div class="stat"><b>{len(threads)}</b>work threads</div>
<div class="stat"><b>{sum(t.my_count for t in threads)}</b>emails I sent</div>
<div class="stat"><b>{len(cats)}</b>categories</div><div class="stat"><b>{len(praise)}</b>thank-yous</div></div>
<div class="meta">Threads started per month</div><div class="chart">{bars}</div>
{praise_html}{"".join(sections)}
</main></body></html>"""
    path.write_text(page, encoding="utf-8")


# --------------------------------------------------------------------------- #
# Optional AI summary (Claude API)
# --------------------------------------------------------------------------- #

def ai_summary(threads: list[Thread], path: Path, model: str, role: str) -> None:
    try:
        import anthropic
    except ImportError:
        sys.exit("The --ai option needs:  pip install anthropic")

    digest = []
    for cat, ts in _by_category(threads).items():
        digest.append(f"\n## {cat}")
        for t in ts:
            digest.append(f"- [{_period(t)}] {t.title} ({t.my_count} emails sent; with {', '.join(t.people[:3])})")
            digest += [f"    my words: {h}" for h in t.my_highlights(2, 300)]
            digest += [f"    PRAISE: {r}" for r in t.recognition]
    prompt = (
        f"I am preparing my year-end performance review{f' as a {role}' if role else ''}. "
        "Below is a worklog extracted from my work email, grouped by category. Write a review-ready "
        "summary in Markdown:\n"
        "1. A 4-6 sentence overall summary of my year.\n"
        "2. 'Key accomplishments': 8-12 bullets, each starting with a strong verb, stating what I did, "
        "who it was for, and the outcome/impact. Only claim what the evidence supports; where impact "
        "isn't stated, add a bracketed prompt like [add metric: time saved?] so I can fill it in.\n"
        "3. 'Recognition received': short quotes with who/when.\n"
        "4. 'Collaboration': the main teams/people I worked with.\n"
        "5. 'Suggested development goals for next year' (3 bullets) based on patterns you see.\n"
        "Ignore newsletters or anything that is clearly not my work.\n\n"
        "WORKLOG:\n" + "\n".join(digest)
    )
    client = anthropic.Anthropic()
    print(f"  Asking {model} to draft your review summary...")
    with client.beta.messages.stream(
        model=model,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        betas=["server-side-fallback-2026-07-01"],
        extra_body={"fallbacks": "default"},
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        sys.exit("The model declined this request; the rest of the worklog files were still written.")
    text = "".join(b.text for b in msg.content if b.type == "text")
    path.write_text(text, encoding="utf-8")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv: list[str] | None = None) -> None:
    today = datetime.now()
    ap = argparse.ArgumentParser(description="Turn your Outlook email into a performance-review worklog.")
    ap.add_argument("--start", type=parse_date, default=datetime(today.year, 1, 1),
                    help="first day, YYYY-MM-DD (default: 1 Jan this year)")
    ap.add_argument("--end", type=parse_date, default=None,
                    help="last day inclusive, YYYY-MM-DD (default: today)")
    ap.add_argument("--mailbox", help='which Outlook mailbox to scan, e.g. "you@company.com" (default: your main one)')
    ap.add_argument("--list-mailboxes", action="store_true", help="show the mailboxes in Outlook and exit")
    ap.add_argument("--folders", nargs="+", default=["Sent Items", "Inbox"],
                    help='Outlook folders to scan, e.g. "Sent Items" "Inbox" "Inbox/Projects"')
    ap.add_argument("--subfolders", action="store_true", help="also scan subfolders of each folder")
    ap.add_argument("--rules", type=Path, default=HERE / "rules.json", help="category/keyword rules file")
    ap.add_argument("--out", type=Path, default=HERE / "out", help="output folder")
    ap.add_argument("--from-json", type=Path, help="skip Outlook; re-use an earlier emails.json scan")
    ap.add_argument("--min-mine", type=int, default=1,
                    help="keep threads where you sent at least N emails (default 1; praise is always kept)")
    ap.add_argument("--body-chars", type=int, default=1500, help="characters of each email body to keep")
    ap.add_argument("--ai", action="store_true",
                    help="also draft review bullets with Claude (sends a digest to the Anthropic API - check your company policy)")
    ap.add_argument("--model", default="claude-opus-5", help="Claude model for --ai")
    ap.add_argument("--role", default="", help='your job title, used by --ai (e.g. "Data Analyst")')
    args = ap.parse_args(argv)

    if args.list_mailboxes:
        list_mailboxes()
        return

    end = (args.end or today).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    start = args.start
    rules = json.loads(args.rules.read_text(encoding="utf-8"))
    args.out.mkdir(parents=True, exist_ok=True)

    if args.from_json:
        emails = [Email(**d) for d in json.loads(args.from_json.read_text(encoding="utf-8"))]
        emails = [e for e in emails if start <= datetime.fromisoformat(e.date) < end]
        print(f"Loaded {len(emails)} emails from {args.from_json}")
    else:
        print(f"Scanning Outlook {start:%Y-%m-%d} to {end - timedelta(days=1):%Y-%m-%d} ...")
        emails = scan_outlook(args.folders, start, end, args.subfolders, args.body_chars, args.mailbox)
        cache = args.out / "emails.json"
        cache.write_text(json.dumps([asdict(e) for e in emails], indent=1), encoding="utf-8")
        print(f"Scanned {len(emails)} emails (cached to {cache})")

    threads = build_threads(emails, rules, args.min_mine)
    write_csv(threads, args.out / "worklog.csv")
    write_markdown(threads, args.out / "worklog.md", start, end)
    write_html(threads, args.out / "worklog.html", start, end)
    print(f"\n{len(threads)} work threads written to {args.out}:")
    for cat, ts in _by_category(threads).items():
        print(f"  {cat:<28} {len(ts):>4} threads")
    if args.ai:
        ai_summary(threads, args.out / "ai_summary.md", args.model, args.role)
        print(f"  AI summary: {args.out / 'ai_summary.md'}")
    print(f"\nOpen {args.out / 'worklog.html'} to review.")


if __name__ == "__main__":
    main()
