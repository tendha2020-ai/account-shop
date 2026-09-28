@echo off
REM Double-click to build your worklog for this calendar year.
REM Outlook (classic) should be open. Edit the line below to change dates/folders.
cd /d "%~dp0"
python -m pip install --quiet pywin32
python worklog.py --folders "Sent Items" "Inbox" --subfolders
start "" "out\worklog.html"
pause
