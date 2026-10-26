@echo off
rem Choose the username/password used when you open Hoodsfield from the internet (not needed at home / on your Wi-Fi).
rem Run again any time to change it - that also signs out every remote device.
cd /d "%~dp0app\backend"
".venv\Scripts\python.exe" remote_auth.py set
echo.
pause
