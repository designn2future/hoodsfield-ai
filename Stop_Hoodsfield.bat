@echo off
rem Stops Hoodsfield on purpose: the studio will NOT restart. Also stops ComfyUI unless you run:  Stop_Hoodsfield.bat studio
rem (a crash still restarts the studio, because that is not a deliberate stop).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop_Hoodsfield.ps1" %*
if "%~1"=="" timeout /t 4 >nul
