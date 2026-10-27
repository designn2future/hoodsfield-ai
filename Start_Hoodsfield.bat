@echo off
rem Hoodsfield one-click launcher: starts ComfyUI (if it is not already running) and the studio, then opens the browser.
rem The ComfyUI folder and its start-up options come from Settings (app\backend\hoodsfield_settings.json), so there is nothing to edit here.
setlocal
set "HF=%~dp0app"
set "PY=%HF%\backend\.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo Hoodsfield is not installed yet. Run Install_Hoodsfield.bat first.
  pause
  exit /b 1
)
set "COMFY="
set "CARGS="
set "CPORT=8188"
set "CPY=python"
for /f "usebackq delims=" %%a in (`"%PY%" "%HF%\backend\launch_info.py" root`) do set "COMFY=%%a"
for /f "usebackq delims=" %%a in (`"%PY%" "%HF%\backend\launch_info.py" args`) do set "CARGS=%%a"
for /f "usebackq delims=" %%a in (`"%PY%" "%HF%\backend\launch_info.py" port`) do set "CPORT=%%a"
for /f "usebackq delims=" %%a in (`"%PY%" "%HF%\backend\launch_info.py" python`) do set "CPY=%%a"
set "OPENURL=http://localhost:8000"
"%PY%" "%HF%\backend\launch_info.py" check
if errorlevel 1 (
  echo.
  echo ComfyUI was not found at "%COMFY%".
  echo The studio will open on its Settings page: set the ComfyUI folder there, then start this file again.
  set "OPENURL=http://localhost:8000/#settings"
  goto studio
)
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%CPORT%/system_stats -TimeoutSec 2)|Out-Null;exit 0}catch{exit 1}"
if errorlevel 1 (
  echo Starting ComfyUI...
  rem /belownormal: renders never starve the desktop or Remote Desktop.
  start "ComfyUI" /min /belownormal /d "%COMFY%" "%CPY%" main.py --listen 127.0.0.1 --port %CPORT% %CARGS%
)
:studio
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/health -TimeoutSec 2)|Out-Null;exit 0}catch{exit 1}"
if errorlevel 1 (
  echo Starting Hoodsfield...
  start "Hoodsfield" /min /d "%HF%\backend" "%PY%" main.py
)
echo Waiting for the studio...
:wait
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/health -TimeoutSec 2)|Out-Null;exit 0}catch{exit 1}"
if errorlevel 1 ( timeout /t 2 >nul & goto wait )
start "" %OPENURL%
