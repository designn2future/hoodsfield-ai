@echo off
rem Hoodsfield installer: creates the Python environment, installs the dependencies, builds the web UI and checks Claude.
rem Safe to run again at any time (it only fills in what is missing).
setlocal
cd /d "%~dp0"
set "HF=%~dp0app"
set "VENV=%HF%\backend\.venv"
title Hoodsfield installer
echo.
echo ===== Hoodsfield installer =====
echo.

set "PYEXE="
for %%P in (python py python3) do (
  if not defined PYEXE (
    %%P -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1 && set "PYEXE=%%P"
  )
)
if not defined PYEXE (
  echo [x] Python 3.10 or newer was not found.
  echo     Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH", then run this again.
  pause
  exit /b 1
)
echo [ok] Python found: %PYEXE%

if not exist "%VENV%\Scripts\python.exe" (
  echo Creating the Python environment...
  %PYEXE% -m venv "%VENV%"
  if errorlevel 1 ( echo [x] Could not create the environment. & pause & exit /b 1 )
)
echo Installing Python packages (this can take a few minutes the first time)...
"%VENV%\Scripts\python.exe" -m pip install --upgrade pip >nul 2>&1
"%VENV%\Scripts\python.exe" -m pip install -r "%HF%\backend\requirements.txt"
if errorlevel 1 ( echo [x] Package install failed. Check your internet connection and run this again. & pause & exit /b 1 )
echo [ok] Python packages installed

if not exist "%HF%\backend\.env" (
  if exist "%HF%\backend\.env.example" copy /y "%HF%\backend\.env.example" "%HF%\backend\.env" >nul
)

set "NODE_OK=0"
where npm >nul 2>&1 && set "NODE_OK=1"
if "%NODE_OK%"=="1" (
  echo Building the web UI...
  pushd "%HF%\frontend"
  if not exist node_modules call npm install --no-audit --no-fund
  call npm run build
  popd
  echo [ok] Web UI built
) else (
  if exist "%HF%\frontend\dist\index.html" (
    echo [ok] Web UI already built; Node.js is not needed to run it.
  ) else (
    echo [x] Node.js 18 or newer is needed once to build the web UI.
    echo     Install it from https://nodejs.org/ then run this again.
    pause
    exit /b 1
  )
)

echo.
"%VENV%\Scripts\python.exe" "%HF%\backend\launch_info.py" claude
"%VENV%\Scripts\python.exe" "%HF%\backend\launch_info.py" check
if errorlevel 1 (
  echo ComfyUI folder: not found yet. You will set it in Settings when Hoodsfield opens.
) else (
  echo ComfyUI folder: found.
)
echo.
echo ===== Done =====
echo Start Hoodsfield with Start_Hoodsfield.bat. A short setup check opens the first time.
echo (ComfyUI, its models and custom nodes are installed separately: see the README.)
echo.
pause
