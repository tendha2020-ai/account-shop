# Outlook Worklog Builder

Scans your **classic Outlook** mailbox (Windows desktop app) and turns a year of
work email into a **worklog for your performance review**: emails are grouped
into threads, sorted into categories (Projects, Incidents, Reporting, Process
Improvement, and so on), laid out by month, and any **thank-yous or praise** you
received are pulled out.

Everything runs on your PC through the Outlook app you're already signed into.
It needs no passwords or IT setup, and nothing leaves your machine unless you
use the optional `--ai` flag.

## Setup (one time)

1. Install Python 3.10 or newer from https://www.python.org/downloads/ and tick **"Add Python to PATH"**.
2. Copy this `outlook-worklog` folder to your work PC.
3. In a terminal in that folder, run: `pip install pywin32`

## Run it

Keep classic Outlook open, then either **double-click `run_worklog.bat`** or run:

```bat
python worklog.py                                   :: 1 Jan this year to today, Sent Items + Inbox
python worklog.py --start 2025-10-01 --end 2026-09-30   :: a custom review period
python worklog.py --folders "Sent Items" "Inbox" --subfolders   :: include your filed sub-folders
python worklog.py --folders "Sent Items" "Inbox/Projects/Alpha"  :: specific folders
```

If Outlook shows a security prompt ("A program is trying to access e-mail
information"), choose **Allow** for 10 minutes.

## What you get (in `out\`)

| File | Use it for |
|---|---|
| `worklog.html` | The main report: stats, a monthly activity chart, praise received, and every thread by category (click a thread to expand it) |
| `worklog.md` | The same content to paste into Word, OneNote or your HR review form |
| `worklog.csv` | One row per thread for Excel, with an empty **Review notes** column for adding impact and metrics |
| `emails.json` | A cache of the scan, used by `--from-json` below |

Each thread shows the dates, how many emails you sent, the key people, the
first lines **you wrote** (the best evidence of what you did), the files you
shared, and any praise.

## Tune it to your job

Edit **`rules.json`**:
- `categories`: rename or add categories and the keywords that point to them.
  Keywords match word starts (`automat` matches "automation"). Add a trailing space
  to match whole words only (`"po "`).
- `recognition_keywords`: phrases that count as praise.
- `ignore_subject_prefixes` / `ignore_senders`: noise to skip, such as meeting
  acceptances, out-of-office replies and no-reply senders.

**Tip:** if you already use Outlook **categories** (the coloured tags), those win over keywords.

Re-run the grouping in seconds without rescanning Outlook:

```bat
python worklog.py --from-json out\emails.json
```

Only threads where you sent at least one email are kept, plus any thread where
someone praised you. Use `--min-mine 2` for a tighter list or `--min-mine 0` to keep everything.

## Optional: AI-drafted review bullets

```bat
pip install anthropic
set ANTHROPIC_API_KEY=your-key
python worklog.py --from-json out\emails.json --ai --role "Business Analyst"
```

This writes `out\ai_summary.md`: an overall summary, accomplishment bullets
(with `[add metric]` placeholders where impact isn't in the email), recognition
quotes, collaborators and development goals. It sends a **digest** of your worklog
to the Claude API: thread titles, names, and short snippets of what you wrote.
**Check your company's policy on sending work data to external AI services before using `--ai`.**
Server-side model fallback is enabled so a refused request can be retried on another model.

## Notes

- This needs **classic** Outlook on Windows. The "new Outlook" and Outlook on the web
  don't expose the COM interface this tool uses.
- Large mailboxes can take a few minutes. Progress is printed as the scan runs.
- To run the tests: `pip install pytest` and then `python -m pytest tests`. They use sample data, so Outlook isn't needed.
