"""Keeps the PC usable while Hoodsfield works.

A generation can pull tens of GB of models into RAM; when Windows starts paging, everything freezes, including Remote Desktop.
This module (all thresholds are free RAM on the whole machine, in GB; override with env vars):

  * every 5 s it measures free RAM;
  * below SOFT_GB (6): asks ComfyUI to unload cached models / free memory (at most once a minute);
  * below HARD_GB (2) for 10 s: interrupts the running job so the PC stays alive, and says why in /api/resources;
  * keeps the ComfyUI process at BELOW-NORMAL priority and the Remote Desktop host at ABOVE-NORMAL, so the desktop and the remote
    session always win over a render;
  * MemoryGate (ASGI middleware) refuses to START a new generation while free RAM is under GATE_GB (4) with a clear message.

Set HOODSFIELD_GUARD=0 to turn it all off.
"""
import asyncio
import ctypes
import json
import os
import re
import subprocess
import time
import urllib.request

SOFT_GB = float(os.getenv("HF_GUARD_SOFT_GB", "6"))
HARD_GB = float(os.getenv("HF_GUARD_HARD_GB", "2"))
GATE_GB = float(os.getenv("HF_GUARD_GATE_GB", "4"))
COMFY = os.getenv("COMFY_URL", "http://127.0.0.1:8188")
ENABLED = os.getenv("HOODSFIELD_GUARD", "1") != "0"
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)

STATE = {"free_gb": None, "total_gb": None, "level": "ok", "last_action": "", "last_action_at": 0.0, "interrupted_at": 0.0}


class _MEM(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong), ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]


def free_ram_gb() -> tuple[float, float]:
    m = _MEM(); m.dwLength = ctypes.sizeof(_MEM)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.ullAvailPhys / 2**30, m.ullTotalPhys / 2**30


def _post(path: str, body: dict | None = None, timeout: float = 5) -> bool:
    try:
        req = urllib.request.Request(COMFY + path, data=json.dumps(body or {}).encode(), headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=timeout).read()
        return True
    except Exception:
        return False


def _set_priority(pid: int, cls: int) -> bool:
    PROCESS_SET_INFORMATION = 0x0200
    h = ctypes.windll.kernel32.OpenProcess(PROCESS_SET_INFORMATION, False, pid)
    if not h:
        return False
    try:
        return bool(ctypes.windll.kernel32.SetPriorityClass(h, cls))
    finally:
        ctypes.windll.kernel32.CloseHandle(h)


BELOW_NORMAL, ABOVE_NORMAL = 0x4000, 0x8000


def _pids(pattern: str) -> list[int]:
    ps = f"Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -match '{pattern}' -or $_.Name -match '{pattern}' }} | ForEach-Object {{ $_.ProcessId }}"
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=30, creationflags=NOWIN).stdout
    except Exception:
        return []
    return [int(x) for x in out.split() if x.isdigit()]


def _prioritise():
    for pid in _pids(r"main\.py.*--port 8188"):
        _set_priority(pid, BELOW_NORMAL)
    for pid in _pids(r"^remoting_host"):
        _set_priority(pid, ABOVE_NORMAL)


TRACE = os.path.join(os.getenv("VSA_WORK_DIR") or os.environ.get("TEMP", "."), "vsa_work", "guard_trace.log")


def _trace_line(free: float) -> str | None:
    """One line of evidence while ComfyUI is rendering (RAM, GPU load / clocks / PCIe link), so a slow job can be explained afterwards."""
    try:
        q = json.loads(urllib.request.urlopen(f"{COMFY}/queue", timeout=3).read())
        if not q.get("queue_running"):
            return None
        g = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,clocks.sm,pcie.link.gen.current,pcie.link.width.current,power.draw",
                            "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5).stdout.strip()
        return f"{time.strftime('%H:%M:%S')} free_ram={free:.1f}GB gpu[util%,vram_mb,sm_mhz,pcie_gen,pcie_w,watts]={g}"
    except Exception as e:
        STATE["trace_err"] = repr(e)[:160]
        return None


async def run(feed=None):
    """Background loop; `feed(event_dict)` (optional) announces actions on the shared feed."""
    if not ENABLED:
        return
    low_since = None
    last_soft = 0.0
    last_prio = 0.0
    last_trace = 0.0
    while True:
        try:
            free, total = await asyncio.to_thread(free_ram_gb)
            STATE.update(free_gb=round(free, 1), total_gb=round(total, 1))
            now = time.time()
            if now - last_trace >= 10:
                last_trace = now
                ln = await asyncio.to_thread(_trace_line, free)
                if ln:
                    try:
                        os.makedirs(os.path.dirname(TRACE), exist_ok=True)
                        if os.path.exists(TRACE) and os.path.getsize(TRACE) > 2_000_000:
                            os.replace(TRACE, TRACE + ".old")
                        with open(TRACE, "a", encoding="utf-8") as fh:
                            fh.write(ln + "\n")
                    except OSError as e:
                        STATE["trace_err"] = repr(e)[:160]
            if now - last_prio > 90:
                last_prio = now
                await asyncio.to_thread(_prioritise)
            if free < SOFT_GB:
                STATE["level"] = "low"
                if now - last_soft > 60:
                    last_soft = now
                    ok = await asyncio.to_thread(_post, "/free", {"unload_models": True, "free_memory": True})
                    STATE.update(last_action=f"Memory was low ({free:.1f} GB free): asked ComfyUI to unload cached models" + ("" if ok else " (it did not answer)"), last_action_at=now)
            else:
                STATE["level"] = "ok"
            if free < HARD_GB:
                low_since = low_since or now
                if now - low_since >= 10 and now - STATE["interrupted_at"] > 120:
                    STATE["level"] = "critical"
                    await asyncio.to_thread(_post, "/interrupt")
                    await asyncio.to_thread(_post, "/free", {"unload_models": True, "free_memory": True})
                    STATE.update(interrupted_at=now, last_action=f"Stopped the running job: only {free:.1f} GB RAM was left and the PC was about to freeze", last_action_at=now)
                    if feed:
                        try:
                            feed({"type": "guard", "text": STATE["last_action"]})
                        except Exception:
                            pass
            else:
                low_since = None
        except Exception:
            pass
        await asyncio.sleep(5)


# POSTs that start heavy work. Reading, saving and editing the project are never blocked.
_HEAVY = re.compile(r"^/api/(generate|scene/generate|scene/analyze|tts/speak|timeline/render|tiktok|mv/|video|ltx|wan|h3|genjutsu|tools/rtx|qa/)")


class MemoryGate:
    """ASGI middleware: refuse to START a heavy job while the machine is nearly out of RAM."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if ENABLED and scope["type"] == "http" and scope["method"] == "POST" and _HEAVY.match(scope["path"]):
            free = STATE.get("free_gb")
            if free is not None and free < GATE_GB:
                body = json.dumps({"detail": f"The PC is low on memory ({free:.1f} GB free), so a new job was not started. "
                                             "Wait for the current job to finish (or close other programs), then try again."}).encode()
                await send({"type": "http.response.start", "status": 503, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
