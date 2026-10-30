@echo off
rem Hoodsfield supervisor (Start_Hoodsfield.bat runs the studio through this): it starts the studio again after a crash,
rem but NOT after you stop it on purpose. Stop it with Stop_Hoodsfield.bat, or by closing this window.
setlocal
set "HF_KEEPALIVE=1"
set "HF=%~dp0app"
set "FLAG=%HF%\backend\vsa_work\stop.flag"
title Hoodsfield studio (auto-restarts after a crash; use Stop_Hoodsfield.bat to exit)
if not exist "%HF%\backend\vsa_work" mkdir "%HF%\backend\vsa_work"
if exist "%FLAG%" del "%FLAG%"
set "FAST=0"
:loop
for /f %%t in ('powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()"') do set "T0=%%t"
echo [%date% %time%] starting the studio...
cd /d "%HF%\backend"
"%HF%\backend\.venv\Scripts\python.exe" main.py >> vsa_work\studio_console.log 2>&1
for /f %%t in ('powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()"') do set "T1=%%t"
if exist "%FLAG%" (
  del "%FLAG%"
  echo [%date% %time%] stopped on purpose. Goodbye.
  exit /b 0
)
set /a RAN=T1-T0
if %RAN% LSS 15 ( set /a FAST+=1 ) else ( set "FAST=0" )
if %FAST% GEQ 5 (
  echo [%date% %time%] the studio keeps failing right after it starts, so I am not restarting it again.
  echo See app\backend\vsa_work\studio_console.log for the reason.
  pause
  exit /b 1
)
echo [%date% %time%] the studio exited unexpectedly; restarting in 3 s (Stop_Hoodsfield.bat exits for good)
ping -n 4 127.0.0.1 >nul
goto loop
