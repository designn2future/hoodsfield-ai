"""Settings, Claude connection, first-run health check, GPU profile and a few system actions.

  GET  /api/settings                 every setting (secrets masked) + which need a restart
  PUT  /api/settings                 {values:{key:value}}   (sensitive keys: only from the PC itself)
  GET  /api/settings/detect_comfy    look for a ComfyUI folder
  GET  /api/claude/status            installed? signed in? (force=1 re-checks)
  POST /api/claude/test              one tiny real request
  POST /api/claude/login|logout      PC only: opens the sign-in window / signs out
  GET  /api/health/check             the first-run checklist (ComfyUI, folders, nodes, models, GPU, RAM, disk, ffmpeg, Claude, Ollama)
  GET  /api/gpu/profile              detected VRAM, the active profile and its H3 defaults
  GET  /api/settings/skill           POST: install the H3 prompting skill into Claude Code's skills folder (PC only)
  POST /api/settings/remote_password PC only: set the remote-access login
  GET  /api/diagnostics              text for bug reports (no secrets)
  POST /api/system/restart           PC only
"""
import asyncio
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
from fastapi import Body, HTTPException, Request

import claude_cli
from app_settings import BY_KEY, FILE, PROFILES, S, detect_comfy_root, profile_for_vram_gb

HERE = Path(__file__).resolve().parent
SENSITIVE = {"claude_api_key", "claude_bin", "comfy_launch_args", "comfy_root", "extra_model_dirs", "work_dir"}
PROXY = ("cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip")
SKILL_SRC = HERE / "assets" / "skills" / "minimax-h3-prompting" / "SKILL.md"
SKILL_DST = Path.home() / ".claude" / "skills" / "minimax-h3-prompting" / "SKILL.md"
APP_VERSION = "0.2.0"


def _local(req: Request) -> bool:
    """True only for a request made on this PC itself (not LAN, not through a tunnel)."""
    peer = req.client.host if req.client else ""
    return peer in ("127.0.0.1", "::1", "localhost") and not any(h in req.headers for h in PROXY)


def _need_local(req: Request, what: str):
    if not _local(req):
        raise HTTPException(403, f"{what} can only be done on the PC that runs Hoodsfield.")


def _gb(n: float) -> float:
    return round(n / 2**30, 1)


def register(app, m):
    @app.get("/api/settings")
    async def get_settings(request: Request):
        return {"fields": S.schema(), "file": str(FILE), "restart_needed": S.restart_needed(), "local": _local(request),
                "profiles": PROFILES, "version": APP_VERSION}

    @app.put("/api/settings")
    async def put_settings(request: Request, body: dict = Body(...)):
        vals = body.get("values") or {}
        if not _local(request) and (set(vals) & SENSITIVE):
            raise HTTPException(403, "These settings can only be changed on the PC that runs Hoodsfield.")
        try:
            res = await asyncio.to_thread(S.save, vals)
        except Exception as e:
            raise HTTPException(400, f"Could not save: {e}")
        claude_cli._cache["t"] = 0
        return {**res, "restart_needed": S.restart_needed(), "fields": S.schema()}

    @app.get("/api/settings/detect_comfy")
    async def detect_comfy():
        return {"path": await asyncio.to_thread(detect_comfy_root)}

    # ------------------------------------------------------------------ Claude
    @app.get("/api/claude/status")
    async def claude_status(force: int = 0):
        return await asyncio.to_thread(claude_cli.status, bool(force))

    @app.post("/api/claude/test")
    async def claude_test(request: Request, body: dict = Body(default={})):
        return await asyncio.to_thread(claude_cli.test, body.get("model"))

    @app.post("/api/claude/login")
    async def claude_login(request: Request):
        _need_local(request, "Signing in")
        return await asyncio.to_thread(claude_cli.open_login)

    @app.post("/api/claude/logout")
    async def claude_logout(request: Request):
        _need_local(request, "Signing out")
        return await asyncio.to_thread(claude_cli.logout)

    # ------------------------------------------------------------------ GPU
    async def _gpu():
        try:
            async with httpx.AsyncClient(timeout=5, trust_env=False) as c:
                j = (await c.get(f"{m.COMFY_URL}/system_stats")).json()
            d = (j.get("devices") or [{}])[0]
            nm = (d.get("name", "") or "").replace("cuda:0 ", "").split(" : ")[0]
            return {"name": nm, "vram_gb": _gb(d.get("vram_total", 0)) if d.get("vram_total") else 0.0,
                    "comfy": (j.get("system") or {}).get("comfyui_version", ""), "torch": (j.get("system") or {}).get("pytorch_version", ""),
                    "reachable": True}
        except Exception:
            return {"name": "", "vram_gb": 0.0, "reachable": False}

    @app.get("/api/gpu/profile")
    async def gpu_profile():
        g = await _gpu()
        detected = profile_for_vram_gb(g["vram_gb"]) if g["vram_gb"] else "16"
        chosen = S.get("gpu_profile")
        active = detected if chosen in ("auto", "", None) else str(chosen)
        p = dict(PROFILES.get(active, PROFILES["16"]))
        mf = int(S.get("h3_max_frames") or 0)
        if mf:
            p["h3_max_frames"] = mf
        return {"gpu": g, "detected": detected, "setting": chosen, "active": active, "profile": p, "profiles": PROFILES}

    # ------------------------------------------------------------------ health check
    async def _node_classes(names):
        found = {}
        async with httpx.AsyncClient(timeout=12, trust_env=False) as c:
            async def one(n):
                try:
                    r = await c.get(f"{m.COMFY_URL}/object_info/{n}")
                    found[n] = n in r.json()
                except Exception:
                    found[n] = None
            await asyncio.gather(*(one(n) for n in names))
        return found

    @app.get("/api/health/check")
    async def health_check():
        checks = []

        def add(id_, title, status, detail, fix="", action=""):
            checks.append({"id": id_, "title": title, "status": status, "detail": detail, "fix": fix, "action": action})

        v = sys.version_info
        add("python", "Python", "ok" if v >= (3, 10) else "fail", f"{v.major}.{v.minor}.{v.micro}", "" if v >= (3, 10) else "Install Python 3.10 or newer.")

        ff = ""
        try:
            import imageio_ffmpeg
            ff = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            ff = shutil.which("ffmpeg") or ""
        add("ffmpeg", "ffmpeg (video engine)", "ok" if ff else "fail", ff or "not found", "" if ff else "Run the installer again, or install ffmpeg and add it to PATH.")

        g = await _gpu()
        if g["reachable"]:
            add("comfy", "ComfyUI is running", "ok", f"{m.COMFY_URL}  ·  ComfyUI {g.get('comfy', '')}  ·  PyTorch {g.get('torch', '')}")
            add("gpu", "Graphics card", "ok" if g["vram_gb"] >= 8 else "warn",
                f"{g['name']}  ·  {g['vram_gb']} GB video memory  ·  recommended profile: {PROFILES[profile_for_vram_gb(g['vram_gb'])]['label']}",
                "" if g["vram_gb"] >= 8 else "Under 8 GB: use the Fast preset and short clips.", "gpu")
        else:
            add("comfy", "ComfyUI is running", "fail", f"No answer from {m.COMFY_URL}", "Start ComfyUI (Start_Hoodsfield.bat does it), or fix the ComfyUI address in Settings.", "comfy")

        root = Path(os.environ.get("COMFY_ROOT", ""))
        ok_root = root.is_dir() and (root / "main.py").exists() and (root / "models").is_dir()
        add("comfy_root", "ComfyUI folder", "ok" if ok_root else "fail", str(root) if str(root) else "not set",
            "" if ok_root else "Set the ComfyUI folder in Settings (the folder that contains main.py).", "comfy")

        if g["reachable"]:
            need = [("VHS_VideoCombine", "Video Helper Suite", "video export, Video Lab"), ("UpscaleModelLoader", "ComfyUI core", "Real-ESRGAN upscaling"),
                    ("ImageUpscaleWithModelBatched", "an upscale node pack", "video upscaling"), ("RIFE VFI", "Frame Interpolation nodes", "slow-motion and smoothing"),
                    ("RTXVideoSuperResolution", "NVIDIA RTX nodes", "fast RTX upscaler (optional)")]
            found = await _node_classes([n for n, _, _ in need])
            missing = [(n, p, f) for n, p, f in need if found.get(n) is False]
            hard = [x for x in missing if x[0] != "RTXVideoSuperResolution"]
            add("nodes", "ComfyUI custom nodes", "ok" if not missing else "warn" if not hard else "fail",
                "all present" if not missing else "missing: " + ", ".join(f"{n} ({p}: {f})" for n, p, f in missing),
                "" if not missing else "Install the missing node packs with ComfyUI-Manager, then restart ComfyUI.")

        try:
            import models_routes
            mm = await asyncio.to_thread(models_routes.build)
            ready = [f for f in mm["features"] if f["ready"]]
            miss = [f for f in mm["features"] if not f["ready"]]
            add("models", "Model files", "ok" if not miss else "warn" if ready else "fail",
                f"{len(ready)} of {len(mm['features'])} feature groups ready" + (": missing for " + ", ".join(f["id"] for f in miss) if miss else ""),
                "" if not miss else "Open the Model manager to see exactly which files are missing and where to get them.", "models")
        except Exception as e:
            add("models", "Model files", "warn", f"could not scan: {e}", "Check the ComfyUI folder setting.")

        try:
            import resource_guard
            free, total = resource_guard.free_ram_gb()
            add("ram", "Memory (RAM)", "ok" if total >= 31 else "warn", f"{free:.0f} GB free of {total:.0f} GB",
                "" if total >= 31 else "32 GB or more is recommended for the largest models. The memory guard keeps the PC responsive.")
        except Exception:
            pass

        wd = Path(os.environ.get("VSA_WORK_DIR") or tempfile.gettempdir())
        try:
            u = shutil.disk_usage(wd if wd.exists() else Path(wd.anchor or "."))
            add("disk", "Disk space (work folder)", "ok" if u.free > 30e9 else "warn", f"{_gb(u.free)} GB free on {wd.anchor or wd}",
                "" if u.free > 30e9 else "Videos and models are big. Move the work folder to a drive with more space in Settings.", "storage")
        except Exception:
            pass

        cs = await asyncio.to_thread(claude_cli.status, False)
        add("claude", "Claude (for the Assistant)", "ok" if cs["ready"] else "warn",
            cs["message"] + (f"  ·  {cs['version']}" if cs.get("version") else ""),
            "" if cs["ready"] else "Optional: the Assistant uses your Claude account. Open Settings → Claude to connect it. Lite mode works without it.", "claude")

        try:
            async with httpx.AsyncClient(timeout=3, trust_env=False) as c:
                tags = (await c.get(f"{os.environ.get('OLLAMA_URL', 'http://127.0.0.1:11434').rstrip('/')}/api/tags")).json().get("models", [])
            add("ollama", "Local language model (Ollama)", "ok" if tags else "warn", f"{len(tags)} model(s) installed" if tags else "running, but no models pulled",
                "" if tags else "Optional: run `ollama pull qwen2.5:14b-instruct` for Lite mode and the AI director.", "llm")
        except Exception:
            add("ollama", "Local language model (Ollama)", "info", "not running (optional)", "Needed only for Lite mode, the AI director and image descriptions.", "llm")

        order = {"fail": 0, "warn": 1, "info": 2, "ok": 3}
        summary = {k: sum(1 for c in checks if c["status"] == k) for k in order}
        return {"checks": checks, "summary": summary, "ok": summary["fail"] == 0, "time": time.time()}

    # ------------------------------------------------------------------ demo project
    @app.get("/api/demo/project")
    async def demo_project():
        from fastapi.responses import FileResponse
        p = HERE / "assets" / "demo" / "Hoodsfield_Demo.vstudio"
        if not p.exists():
            raise HTTPException(404, "The demo project is not part of this install.")
        return FileResponse(p, media_type="application/json")

    # ------------------------------------------------------------------ skill
    @app.get("/api/settings/skill")
    async def skill_status():
        return {"available": SKILL_SRC.exists(), "installed": SKILL_DST.exists(), "path": str(SKILL_DST)}

    @app.post("/api/settings/skill")
    async def skill_install(request: Request):
        _need_local(request, "Installing the skill")
        if not SKILL_SRC.exists():
            raise HTTPException(404, "The skill file is missing from this install.")
        SKILL_DST.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SKILL_SRC, SKILL_DST)
        return {"installed": True, "path": str(SKILL_DST)}

    # ------------------------------------------------------------------ remote access login
    @app.get("/api/settings/remote_password")
    async def remote_status():
        import remote_auth
        cfg = remote_auth._load()
        return {"set": bool(cfg), "user": (cfg or {}).get("user", "")}

    @app.post("/api/settings/remote_password")
    async def remote_set(request: Request, body: dict = Body(...)):
        _need_local(request, "Setting the remote-access login")
        import remote_auth
        user, pw = str(body.get("user", "")).strip(), str(body.get("password", ""))
        if not user or len(pw) < 10:
            raise HTTPException(400, "Username required and the password needs 10 or more characters.")
        remote_auth.set_credentials(user, pw)
        return {"set": True, "user": user}

    # ------------------------------------------------------------------ diagnostics + restart
    @app.get("/api/diagnostics")
    async def diagnostics():
        g = await _gpu()
        hc = await health_check()
        lines = [f"Hoodsfield {APP_VERSION}", f"OS: {platform.platform()}", f"Python: {sys.version.split()[0]}",
                 f"GPU: {g.get('name', '?')} ({g.get('vram_gb', '?')} GB)  ComfyUI {g.get('comfy', '?')}  PyTorch {g.get('torch', '?')}", ""]
        for c in hc["checks"]:
            lines.append(f"[{c['status'].upper():4}] {c['title']}: {c['detail']}")
        lines.append("")
        lines.append("Settings changed from default: " + (", ".join(k for k in S.data if not BY_KEY.get(k, {}).get("secret")) or "none"))
        return {"text": "\n".join(lines)}

    @app.post("/api/system/restart")
    async def restart(request: Request):
        _need_local(request, "Restarting the studio")

        def go():
            time.sleep(0.8)
            if os.environ.get("HF_KEEPALIVE") == "1":
                os._exit(0)      # the keep-alive launcher starts it again
            import comfy_watchdog
            comfy_watchdog._relaunch_studio()

        asyncio.get_event_loop().run_in_executor(None, go)
        return {"restarting": True, "keepalive": os.environ.get("HF_KEEPALIVE") == "1"}
