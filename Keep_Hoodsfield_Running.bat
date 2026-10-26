@echo off
rem Optional supervisor: runs the studio and starts it again whenever it exits for any reason (crash, Ctrl+C, a dead network listener).
rem Start ComfyUI as usual (Start_Hoodsfield.bat starts both once; use THIS file instead when you want the studio kept alive).
setlocal
set "HF=%~dp0app"
title Hoodsfield studio (keep-alive) - close this window to stop it
:loop
echo [%date% %time%] starting the studio...
cd /d "%HF%\backend"
if not exist vsa_work mkdir vsa_work
"%HF%\backend\.venv\Scripts\python.exe" main.py >> vsa_work\studio_console.log 2>&1
echo [%date% %time%] the studio exited; restarting in 3 s (close this window to stop)
timeout /t 3 >nul
goto loop
