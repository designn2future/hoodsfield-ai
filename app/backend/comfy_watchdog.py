"""Keeps ComfyUI usable: if its process is alive but has stopped accepting connections (a Windows asyncio listener crash, seen after a
phone dropped a connection), restart it. It never starts ComfyUI when none is running (you may have closed it on purpose) and
never touches ComfyUI's files. Set HOODSFIELD_COMFY_WATCHDOG=0 to turn it off.

Rule: port 8188 refuses connections 3 checks in a row (90 s) AND a ComfyUI process older than 3 minutes exists -> kill it, start it again
with the same arguments as Start_Hoodsfield.bat, detached.
"""
import asyncio
import json
import os
import socket
import subprocess
import time
from pathlib import Path

COMFY_DIR = Path(os.getenv("COMFY_DIR", r"D:\ComfyUI-LTX2"))
PORT = int(os.getenv("COMFY_PORT", "8188"))
ARGS = ["--listen", "127.0.0.1", "--port", str(PORT), "--use-sage-attention", "--enable-triton-backend", "--reserve-vram", "2.5", "--cache-ram", "10", "18"]
LOG = Path(__file__).resolve().parent / "vsa_work" / "comfy_watchdog.log"


def _log(msg: str):
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except Exception:
        pass


def _listening() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=3):
            return True
    except socket.timeout:
        return True      # busy, not dead: leave it alone
    except OSError:
        return False


def _comfy_procs() -> list[tuple[int, float]]:
    """(pid, age in seconds) of ComfyUI processes (the venv launcher and its child)."""
    ps = ("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'main\\.py' -and $_.CommandLine -match '--port %d' } | "
          "ForEach-Object { '{0} {1}' -f $_.ProcessId, [int]((Get-Date) - $_.CreationDate).TotalSeconds }" % PORT)
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=30,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except Exception:
        return []
    procs = []
    for line in out.splitlines():
        p = line.split()
        if len(p) == 2 and p[0].isdigit():
            procs.append((int(p[0]), float(p[1])))
    return procs


def _restart(procs):
    for pid, _ in procs:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    time.sleep(3)
    py = COMFY_DIR / "venv" / "Scripts" / "python.exe"
    log = open(COMFY_DIR / "user" / "comfyui_watchdog_start.log", "ab") if (COMFY_DIR / "user").is_dir() else subprocess.DEVNULL
    subprocess.Popen([str(py), "main.py", *ARGS], cwd=str(COMFY_DIR), stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                     creationflags=0x00000008 | 0x00000200 | 0x08000000 | 0x00004000)      # DETACHED_PROCESS | NEW_PROCESS_GROUP | NO_WINDOW | BELOW_NORMAL_PRIORITY


STUDIO_PORT = int(os.getenv("PORT", "8000"))
_started = time.time()


def _studio_listening() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", STUDIO_PORT), timeout=3):
            return True
    except socket.timeout:
        return True
    except OSError:
        return False


def _relaunch_studio():
    """The studio's own listener died (process alive, port refusing): start a fresh studio and exit this one."""
    here = Path(__file__).resolve().parent
    py = here / ".venv" / "Scripts" / "python.exe"
    log = here / "vsa_work" / "studio_console.log"
    cmd = f'cmd /c ping -n 4 127.0.0.1 >nul & cd /d "{here}" && "{py}" main.py >> "{log}" 2>&1'
    subprocess.Popen(cmd, shell=False, cwd=str(here), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=0x00000008 | 0x00000200 | 0x08000000)      # DETACHED_PROCESS | NEW_PROCESS_GROUP | NO_WINDOW
    _log("studio listener was dead: started a replacement studio and exiting this one")
    time.sleep(1)
    os._exit(0)


async def run(feed=None):
    if os.getenv("HOODSFIELD_COMFY_WATCHDOG", "1") == "0":
        return
    bad = 0
    deaf = 0
    await asyncio.sleep(120)      # give ComfyUI time to start with the studio
    while True:
        try:
            if await asyncio.to_thread(_studio_listening):
                deaf = 0
            else:
                deaf += 1
                if deaf >= 2 and time.time() - _started > 150:      # 60 s of refusing connections
                    _relaunch_studio()
            if await asyncio.to_thread(_listening):
                bad = 0
            else:
                bad += 1
                if bad >= 3:
                    procs = await asyncio.to_thread(_comfy_procs)
                    if procs and max(a for _, a in procs) > 180:
                        _log(f"ComfyUI process alive ({procs}) but port {PORT} refuses connections: restarting it")
                        await asyncio.to_thread(_restart, procs)
                        if feed:
                            feed({"type": "comfy", "text": "ComfyUI had stopped answering and was restarted."})
                        _log("restart issued")
                        await asyncio.sleep(120)
                    bad = 0
        except Exception as e:      # the watchdog must never take the studio down
            _log(f"watchdog error: {type(e).__name__}: {e}")
        await asyncio.sleep(30)
