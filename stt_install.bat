@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
set "STT_SETUP_PYTHON="
for %%V in (3.12 3.11 3.10) do (
    for /f "delims=" %%P in ('py -%%V -c "import sys; print(sys.executable)" 2^>nul') do (
        set "STT_SETUP_PYTHON=%%P"
        goto setup
    )
)
for /f "delims=" %%P in ('python -c "import sys; assert (3,9) <= sys.version_info < (3,13); print(sys.executable)" 2^>nul') do set "STT_SETUP_PYTHON=%%P"
if not defined STT_SETUP_PYTHON (
    echo Install Python 3.12 x64 from https://www.python.org/downloads/windows/
    echo Or use stt_server.exe from the portable ZIP. It does not need Python.
    goto failed
)

:setup
if not exist stt_requirements.txt (
    echo Missing stt_requirements.txt. Extract the complete ZIP.
    goto failed
)
"%STT_SETUP_PYTHON%" -m venv .stt-venv
if errorlevel 1 goto failed
"%~dp0.stt-venv\Scripts\python.exe" -m pip install -r "%~dp0stt_requirements.txt"
if errorlevel 1 goto failed
"%~dp0.stt-venv\Scripts\python.exe" "%~dp0stt_server.py" --check
if errorlevel 1 goto failed
echo.
echo Ready. Run stt_server.bat. Autostart can be enabled in its window.
pause
exit /b 0

:failed
echo.
echo Setup failed. The error is shown above; this window stays open.
pause
exit /b 1
