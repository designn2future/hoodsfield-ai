# Stops the Hoodsfield studio (and ComfyUI) for good. A "stop" flag tells the keep-alive supervisor this is deliberate, so it does not restart.
# Safety: it only ever stops a python process that is listening on the studio / ComfyUI port, plus the python launcher above it. Nothing else.
param([string]$What = 'all')
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$flag = Join-Path $root 'app\backend\vsa_work\stop.flag'
New-Item -ItemType Directory -Force (Split-Path $flag) | Out-Null
Set-Content -Path $flag -Value (Get-Date).ToString('s')

function Get-ListenerPids([int]$port) {
    # a listening socket has no remote end; this PC's netstat and the -State filter are unreliable, so match on that instead
    Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
        Where-Object { $_.RemoteAddress -in '0.0.0.0', '::' -and $_.RemotePort -eq 0 } |
        ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique
}

function Stop-PortTree([int]$port, [string]$name) {
    $target = $null
    foreach ($id in (Get-ListenerPids $port)) {
        if ($id -le 4) { continue }                       # never the System process
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        if ($p -and $p.Name -match '^pythonw?\.exe$') { $target = $p; break }
    }
    if (-not $target) { Write-Host "$name is not running."; return }
    $id = $target.ProcessId
    # climb through python launchers only (the venv launcher and the real server are two python processes)
    while ($true) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        if (-not $p) { break }
        $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
        if ($par -and $par.ProcessId -gt 4 -and $par.Name -match '^pythonw?\.exe$') { $id = $par.ProcessId } else { break }
    }
    $top = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if (-not $top -or $top.Name -notmatch '^pythonw?\.exe$') { Write-Host "${name}: refusing to stop an unexpected process."; return }
    & taskkill /PID $id /T /F | Out-Null
    Write-Host "$name stopped."
}

Stop-PortTree 8000 'Hoodsfield studio'
if ($What -ne 'studio') { Stop-PortTree 8188 'ComfyUI' }
Start-Sleep -Seconds 6          # give the supervisor time to see the flag and exit
Remove-Item $flag -ErrorAction SilentlyContinue
Write-Host 'Done. Run Start_Hoodsfield.bat to start again.'
