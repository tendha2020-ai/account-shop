@echo off
rem Starts LagBuster from the source code.
rem Needs Python 3.10 or newer from https://www.python.org/downloads/
rem (tick "Add python.exe to PATH" while installing).
cd /d "%~dp0"

set "PYEXE="
where py >nul 2>nul && set "PYEXE=py -3" && set "PYWEXE=pyw -3"
if not defined PYEXE (
    where python >nul 2>nul && set "PYEXE=python" && set "PYWEXE=pythonw"
)
if not defined PYEXE (
    echo Python was not found.
    echo Install Python 3 from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
    pause
    exit /b 1
)

echo Getting LagBuster ready (installs psutil and nvidia-ml-py the first time)...
%PYEXE% -m pip install --user --quiet --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
    echo Installing the requirements failed - see the message above.
    pause
    exit /b 1
)

start "" %PYWEXE% LagBuster.pyw
