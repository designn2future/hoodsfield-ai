@echo off
rem Hoodsfield one-click launcher: starts ComfyUI (if not already running) and the studio, then opens the browser.
setlocal
set "HF=%~dp0app"
set "COMFY=D:\ComfyUI-LTX2"
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8188/system_stats -TimeoutSec 2)|Out-Null;exit 0}catch{exit 1}"
if errorlevel 1 (
  echo Starting ComfyUI...
  rem /belownormal: renders never starve the desktop or Remote Desktop.  --cache-ram 10 18: ComfyUI gives RAM back when less than 10-18 GB is free.
  start "ComfyUI" /min /belownormal /d "%COMFY%" "%COMFY%\venv\Scripts\python.exe" main.py --listen 127.0.0.1 --port 8188 --use-sage-attention --enable-triton-backend --reserve-vram 2.5 --cache-ram 10 18
)
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/health -TimeoutSec 2)|Out-Null;exit 0}catch{exit 1}"
if errorlevel 1 (
  echo Starting Hoodsfield...
  start "Hoodsfield" /min /d "%HF%\backend" "%HF%\backend\.venv\Scripts\python.exe" main.py
)
echo Waiting for the studio...
:wait
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/health -TimeoutSec 2)|Out-Null;exit 0}catch{exit 1}"
if errorlevel 1 ( timeout /t 2 >nul & goto wait )
start "" http://localhost:8000
