@echo off
rem One-time setup: lets phones on your home Wi-Fi reach Hoodsfield (port 8000). Right-click -> Run as administrator.
netsh advfirewall firewall add rule name="Hoodsfield phone" dir=in action=allow protocol=TCP localport=8000 profile=private
echo.
echo Open this on your phone (same Wi-Fi):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo    http://%%a:8000
pause
