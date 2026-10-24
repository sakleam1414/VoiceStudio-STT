@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
set "STT_DIR=%~dp0"
set "STT_MODE=--dashboard"
if defined BD_AUTO_LAUNCH set "STT_MODE=--background"
if /i "%~1"=="--background" set "STT_MODE=--background"
if /i "%~1"=="--web" set "STT_MODE=--web"

REM Prefer an existing Python setup to preserve optional speech engines.
if not exist "%STT_DIR%stt_server.py" goto portable
if exist "%STT_DIR%.stt-venv\Scripts\python.exe" (
    set "STT_PYTHON=%STT_DIR%.stt-venv\Scripts\python.exe"
    call :check_python
    if not errorlevel 1 goto python_ready
)
for %%V in (3.12 3.11 3.10 3) do (
    for /f "delims=" %%P in ('py -%%V -c "import sys; print(sys.executable)" 2^>nul') do (
        set "STT_PYTHON=%%P"
        call :check_python
        if not errorlevel 1 goto python_ready
    )
)
for /f "delims=" %%P in ('python -c "import sys; print(sys.executable)" 2^>nul') do (
    set "STT_PYTHON=%%P"
    call :check_python
    if not errorlevel 1 goto python_ready
)

:portable
if not exist "%STT_DIR%stt_server.exe" goto unavailable
if /i "%~1"=="--check" (
    start "" /wait "%STT_DIR%stt_server.exe" --check
    exit /b
)
start "" /b "%STT_DIR%stt_server.exe" %STT_MODE% %*
exit /b 0

:python_ready
if not exist "%STT_DIR%vosk_models.json" goto missing_catalog
if /i "%~1"=="--check" (
    "%STT_PYTHON%" "%STT_DIR%stt_server.py" --check
    exit /b
)
for %%P in ("%STT_PYTHON%") do set "STT_PYTHONW=%%~dpPpythonw.exe"
if not exist "%STT_PYTHONW%" set "STT_PYTHONW=%STT_PYTHON%"
start "" /b "%STT_PYTHONW%" "%STT_DIR%stt_server.py" %STT_MODE% %*
exit /b 0

:check_python
"%STT_PYTHON%" -c "import sys; assert sys.version_info >= (3,9); import vosk, websockets" >nul 2>nul
exit /b

:missing_catalog
echo [STT] Missing vosk_models.json. Extract ALL files from the ZIP into one folder.
goto failed

:unavailable
echo [STT] No working Python dependencies or stt_server.exe found.
echo Extract the complete portable ZIP, then run this file again.
echo For the Python version: install Python 3.12 x64 and run stt_install.bat.

:failed
echo.
echo Folder: %STT_DIR%
if not defined BD_AUTO_LAUNCH if /i not "%STT_MODE%"=="--background" pause
exit /b 1
