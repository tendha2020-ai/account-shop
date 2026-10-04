@echo off
REM Double-click to build your worklog for this calendar year.
REM Outlook (classic) should be open.
cd /d "%~dp0"

python --version >nul 2>&1
if errorlevel 1 (
  echo Python is not installed. Get it from https://www.python.org/downloads/
  echo and tick "Add Python to PATH" during setup, then run this again.
  pause
  exit /b 1
)
python -m pip install --quiet pywin32

echo.
python worklog.py --list-mailboxes
echo.
set /p MAILBOX=Type your WORK mailbox name from the list above (or press Enter for the default): 

if "%MAILBOX%"=="" (
  python worklog.py --folders "Sent Items" "Inbox" --subfolders
) else (
  python worklog.py --mailbox "%MAILBOX%" --folders "Sent Items" "Inbox" --subfolders
)
if not errorlevel 1 start "" "out\worklog.html"
pause
