@echo off
rem Closes the internet tunnel. Hoodsfield keeps working at home.
taskkill /f /im cloudflared.exe
del "%~dp0Remote_URL.txt" 2>nul
pause
