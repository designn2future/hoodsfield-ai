# Starts Hoodsfield (if needed) and opens a Cloudflare tunnel to it. The public link is saved to Remote_URL.txt.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$be   = Join-Path $root 'app\backend'
$log  = Join-Path $env:TEMP 'hf_tunnel.log'
$urlF = Join-Path $root 'Remote_URL.txt'

function Fail($m) { Write-Host "`n$m`n" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

if (-not (Test-Path (Join-Path $be 'hf_auth.json'))) {
    Fail "No remote password set yet. Run Set_Remote_Password.bat first, then run this again."
}

function Up { try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/ping -TimeoutSec 5 | Out-Null; $true } catch { try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/health -TimeoutSec 8 | Out-Null; $true } catch { $false } } }
if (-not (Up)) {
    Write-Host 'Starting Hoodsfield...'
    Start-Process -FilePath (Join-Path $be '.venv\Scripts\python.exe') -ArgumentList 'main.py' -WorkingDirectory $be -WindowStyle Minimized
    1..40 | ForEach-Object { if (-not (Up)) { Start-Sleep 2 } }
    if (-not (Up)) { Fail 'Hoodsfield did not start.' }
}

# Safety check: a request that looks like it came through a tunnel must be refused without a login.
$code = 0
try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/health -Headers @{ 'CF-Connecting-IP' = '203.0.113.1' } -TimeoutSec 5 | Out-Null; $code = 200 }
catch { if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } }
if ($code -ne 401) {
    Fail "The running Hoodsfield is an older copy without the login gate (got HTTP $code), so I will NOT open the tunnel.`nClose the Hoodsfield window (and make sure no video is generating), then run this again."
}

$cf = Join-Path $root 'tools\cloudflared.exe'
if (-not (Test-Path $cf)) {
    Fail "Remote access uses Cloudflare's free quick tunnel, which needs one extra program.`nDownload cloudflared-windows-amd64.exe from https://github.com/cloudflare/cloudflared/releases/latest , save it as tools\cloudflared.exe in this folder, then run this again."
}

Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item $log, $urlF -ErrorAction SilentlyContinue
Start-Process -FilePath (Join-Path $root 'tools\cloudflared.exe') `
    -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:8000', '--no-autoupdate' `
    -RedirectStandardError $log -WindowStyle Hidden

$url = $null
1..30 | ForEach-Object {
    if (-not $url -and (Test-Path $log)) {
        $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) { $url = $m.Matches[0].Value }
    }
    if (-not $url) { Start-Sleep 1 }
}
if (-not $url) { Fail "The tunnel did not give a link. See $log" }

Set-Content -Path $urlF -Value $url
Write-Host "`nHoodsfield is reachable from anywhere at:`n`n    $url`n" -ForegroundColor Green
Write-Host 'Sign in with the username/password you chose. (Link also saved in Remote_URL.txt.)'
Write-Host 'The link changes if the tunnel is restarted. Leave this PC on; closing the tunnel = Stop_Remote_Access.bat'
Read-Host "`nPress Enter to close this window (the tunnel keeps running)"
