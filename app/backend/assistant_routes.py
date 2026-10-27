"""Hoodsfield Assistant: one idea in, a finished video out, with approvals at key points.

A run is a headless Claude Code session (the user's own Claude login, no API key) that drives the studio through
assistant_mcp.py and stops at `ask_user` for the user's OK. The session may only use the assistant_mcp tools and Read;
it cannot run commands or edit files. The app shows the run live on every screen (PC and phone):

  GET  /api/assistant/status                   is Claude Code usable
  GET  /api/assistant/runs                     recent runs (summaries)
  POST /api/assistant/runs                     start {idea, genre, seconds, notes, model}
  GET  /api/assistant/runs/{id}                the whole run (events, pending approval, output)
  POST /api/assistant/runs/{id}/answer         the user's answer to the pending approval {approval_id, choice, note}
  POST /api/assistant/runs/{id}/message        a free-text note to the assistant at any time
  POST /api/assistant/runs/{id}/cancel         stop it
  POST /api/assistant/runs/{id}/resume         continue an interrupted run
  GET  /api/assistant/runs/{id}/media/{name}   a picture/video shown in the run
  (used by assistant_mcp.py)  POST .../event   POST .../ask   GET .../approval/{aid}

Every change is announced on the shared feed as {type: "assistant", run: id}.
"""
import asyncio
import app_settings
import claude_cli
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

from fastapi import Body, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

import httpx

import assistant_refs
import jobs

ROOT = jobs.WORK_DIR / "assistant"
ROOT.mkdir(parents=True, exist_ok=True)
UPLOADS = ROOT / "_uploads"
HERE = Path(__file__).resolve().parent
PLAYBOOK = HERE / "assistant_playbook.md"
OUTPUT = app_settings.output_dir()
RUNS: dict[str, dict] = {}
PROCS: dict[str, asyncio.subprocess.Process] = {}
ALLOWED_MEDIA_ROOTS = [ROOT, OUTPUT, Path(os.getenv("COMFY_ROOT", r"D:\ComfyUI-LTX2")) / "output"]
LITE_MODEL = os.getenv("ASSISTANT_LITE_MODEL", "qwen2.5:14b-instruct")
MEDIA_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm"}
MCP_PREFIX = "mcp__hoodsfield_assistant__"


def _path(rid: str) -> Path:
    if not rid.isalnum():
        raise HTTPException(400, "bad run id")
    return ROOT / rid


def _save(run: dict):
    d = _path(run["id"])
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "run.tmp"
    tmp.write_text(json.dumps(run), encoding="utf-8")
    tmp.replace(d / "run.json")


def _load_all():
    for f in ROOT.glob("*/run.json"):
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if r.get("status") in ("running", "waiting", "starting"):    # the backend restarted underneath it
            r["status"] = "interrupted"
            r["events"].append({"t": time.time(), "kind": "note", "text": "The app was restarted while this was running. Press Resume to continue.", "media": []})
            r["approval"] = None
            _save(r)
        RUNS[r["id"]] = r


def _summary(r: dict) -> dict:
    return {k: r.get(k) for k in ("id", "idea", "genre", "status", "created", "updated", "output")} | {"waiting": bool(r.get("approval"))}


def register(app, m):
    _load_all()

    def announce(run: dict):
        run["updated"] = time.time()
        _save(run)
        m._feed({"type": "assistant", "run": run["id"], "status": run["status"], "waiting": bool(run.get("approval"))})

    def event(run: dict, kind: str, text: str = "", media=None):
        run["events"].append({"t": time.time(), "kind": kind, "text": text, "media": media or []})
        announce(run)

    def stage_media(run: dict, paths) -> list[str]:
        """Copy files an event mentions into the run's own media folder so any screen can show them."""
        out = []
        md = _path(run["id"]) / "media"
        md.mkdir(parents=True, exist_ok=True)
        for p in paths or []:
            try:
                src = Path(p).resolve()
                if src.suffix.lower() not in MEDIA_EXT or not src.is_file():
                    continue
                if not any(str(src).lower().startswith(str(r.resolve()).lower()) for r in ALLOWED_MEDIA_ROOTS):
                    continue
                dst = md / f"{uuid.uuid4().hex[:6]}_{src.name}"
                shutil.copyfile(src, dst)
                out.append(dst.name)
            except Exception:
                continue
        return out

    def note_output(run: dict, paths):
        for p in paths or []:
            if str(p).lower().endswith(".mp4") and str(OUTPUT).lower() in str(p).lower():
                run["output"] = str(p)

    async def _spawn(run: dict, prompt: str, resume: bool = False):
        exe = claude_cli.find_exe()
        if not exe:
            raise HTTPException(503, "Claude Code isn't installed on this computer. Open Settings > Claude to set it up, or use Lite mode.")
        if not (await asyncio.to_thread(claude_cli.status)).get("ready"):
            raise HTTPException(503, "Claude isn't connected yet. Open Settings > Claude to sign in, or use Lite mode.")
        d = _path(run["id"])
        (d / "work").mkdir(parents=True, exist_ok=True)
        cfg = d / "mcp.json"
        cfg.write_text(json.dumps({"mcpServers": {"hoodsfield_assistant": {
            "command": sys.executable, "args": [str(HERE / "assistant_mcp.py")],
            "env": {"VSA_URL": f"http://127.0.0.1:{os.getenv('PORT', '8000')}", "ASSISTANT_RUN": run["id"], "ASSISTANT_DIR": str(d / "work"), "ASSISTANT_REFS": str(d / "refs.json"), "ASSISTANT_CHAR_MODE": run.get("char_engine", "combo")}}}}), encoding="utf-8")
        args = [exe, "-p", "--output-format", "stream-json", "--verbose", "--model", run.get("model", "opus"),
                "--strict-mcp-config", "--mcp-config", str(cfg),
                "--tools", "Read", "--allowedTools", f"{MCP_PREFIX}*", "Read",
                "--append-system-prompt", PLAYBOOK.read_text(encoding="utf-8")]
        if resume and run.get("session"):
            args += ["--resume", run["session"]]
        env = claude_cli.run_env()      # the user's own login (or the saved API key when Settings says so), never a stray key
        proc = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=str(d / "work"), env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), limit=2**24)
        PROCS[run["id"]] = proc
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()
        run["status"] = "running"
        announce(run)
        asyncio.get_event_loop().create_task(_pump(run, proc))

    async def _spawn_lite(run: dict):
        """Lite mode: a fixed pipeline (assistant_lite.py) with a local Ollama model, no Claude account."""
        d = _path(run["id"])
        (d / "work").mkdir(parents=True, exist_ok=True)
        (d / "lite_brief.json").write_text(json.dumps({k: run.get(k) for k in ("idea", "genre", "seconds", "notes", "variations", "refs")}), encoding="utf-8")
        env = dict(os.environ, VSA_URL=f"http://127.0.0.1:{os.getenv('PORT', '8000')}", ASSISTANT_RUN=run["id"], ASSISTANT_DIR=str(d / "work"), ASSISTANT_REFS=str(d / "refs.json"),
                   LITE_BRIEF=str(d / "lite_brief.json"), LITE_MODEL=LITE_MODEL, PYTHONIOENCODING="utf-8")
        proc = await asyncio.create_subprocess_exec(sys.executable, str(HERE / "assistant_lite.py"), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                    cwd=str(HERE), env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        PROCS[run["id"]] = proc
        run["status"] = "running"
        announce(run)

        async def watch():
            try:
                _, err = await proc.communicate()
            finally:
                PROCS.pop(run["id"], None)
            if run["status"] == "cancelled":
                return
            if proc.returncode == 0:
                run["status"] = "done"
                run.setdefault("board", {"stage": "", "shots": [], "now": None}).update(stage="final", now=None)
            else:
                run["status"] = "error"
                event(run, "error", (err.decode("utf-8", "replace").strip().splitlines() or ["The lite assistant stopped unexpectedly."])[-1][:400])
            run["approval"] = None
            announce(run)
        asyncio.get_event_loop().create_task(watch())

    async def _pump(run: dict, proc):
        """Read the session's stream-json: keep what the user should see (what Claude says, what it is doing), note the result."""
        final = None
        try:
            async for raw in proc.stdout:
                try:
                    ev = json.loads(raw.decode("utf-8", "replace"))
                except Exception:
                    continue
                t = ev.get("type")
                if t == "system" and ev.get("session_id"):
                    run["session"] = ev["session_id"]
                elif t == "assistant":
                    for b in (ev.get("message") or {}).get("content", []):
                        if b.get("type") == "text" and b.get("text", "").strip():
                            event(run, "think", b["text"].strip())
                        elif b.get("type") == "tool_use":
                            name = b.get("name", "").replace(MCP_PREFIX, "")
                            if name not in ("report", "ask_user"):
                                event(run, "tool", name)
                elif t == "result":
                    final = ev
            await proc.wait()
        finally:
            PROCS.pop(run["id"], None)
        err = (await proc.stderr.read()).decode("utf-8", "replace")[:400] if proc.stderr else ""
        if run["status"] == "cancelled":
            return
        if final and not final.get("is_error"):
            run["status"] = "done"
            run.setdefault("board", {"stage": "", "shots": [], "now": None}).update(stage="final", now=None)
            run["result"] = str(final.get("result", ""))[:2000]
            if not run["events"] or run["events"][-1].get("text") != run["result"]:      # do not repeat what was just said
                event(run, "say", run["result"] or "Finished.")
        else:
            run["status"] = "error"
            event(run, "error", str((final or {}).get("result") or err or "The assistant stopped unexpectedly."))
        run["approval"] = None
        announce(run)

    @app.get("/api/assistant/status")
    async def status():
        lite = {"model": LITE_MODEL, "ollama": False, "installed": False}
        try:
            async with httpx.AsyncClient(timeout=3, trust_env=False) as c:
                tags = (await c.get("http://127.0.0.1:11434/api/tags")).json().get("models", [])
            lite.update(ollama=True, installed=any(t.get("name", "").split(":")[0] == LITE_MODEL.split(":")[0] and t.get("name") == LITE_MODEL for t in tags))
        except Exception:
            pass
        cs = await asyncio.to_thread(claude_cli.status)
        return {"claude_code": bool(cs.get("ready")), "claude": {k: cs.get(k) for k in ("installed", "logged_in", "ready", "account", "mode", "message", "version")},
                "default_model": app_settings.S.get("claude_model"), "playbook": PLAYBOOK.exists(), "lite": lite}

    @app.get("/api/assistant/runs")
    async def list_runs():
        return {"runs": sorted((_summary(r) for r in RUNS.values()), key=lambda r: -(r.get("created") or 0))[:40]}

    @app.post("/api/assistant/upload")
    async def upload_ref(file: UploadFile = File(...)):
        """A reference the user attaches before starting (image / video / audio). Returns an id to list in the start request."""
        name = Path(file.filename or "ref").name
        if not assistant_refs.kind_of(name):
            raise HTTPException(400, "Use an image (png/jpg/webp), a video (mp4/mov/webm) or audio (mp3/wav/m4a).")
        UPLOADS.mkdir(parents=True, exist_ok=True)
        uid = uuid.uuid4().hex[:10]
        dst = UPLOADS / f"{uid}{Path(name).suffix.lower()}"
        size = 0
        with open(dst, "wb") as f:
            while chunk := await file.read(1 << 20):
                size += len(chunk)
                if size > 400 * 1024 * 1024:
                    f.close()
                    dst.unlink(missing_ok=True)
                    raise HTTPException(413, "That file is over 400 MB.")
                f.write(chunk)
        return {"id": uid, "file": dst.name, "name": name, "kind": assistant_refs.kind_of(name), "size": size}

    @app.post("/api/assistant/runs")
    async def start(body: dict = Body(...)):
        idea = (body.get("idea") or "").strip()
        if len(idea) < 4:
            raise HTTPException(400, "Tell the assistant your idea first.")
        rid = uuid.uuid4().hex[:10]
        seconds = max(5, min(180, int(float(body.get("seconds") or 22))))
        variations = body.get("variations", True) is not False
        engine = "lite" if body.get("engine") == "lite" else "claude"
        char_engine = body.get("char_engine") if body.get("char_engine") in ("combo", "qwen", "flux") else "combo"
        run = {"variations": variations, "engine": engine, "char_engine": char_engine, "id": rid, "idea": idea, "genre": body.get("genre", ""), "seconds": seconds, "notes": body.get("notes", ""),
               "model": body.get("model") or app_settings.S.get("claude_model") or "opus", "status": "starting", "created": time.time(), "updated": time.time(), "events": [], "approval": None,
               "inbox": [], "output": None, "session": "", "refs": []}
        RUNS[rid] = run
        event(run, "note", "Project started.")
        if body.get("refs"):
            event(run, "note", f"Looking at your {len(body['refs'])} reference file(s)…")
            run["refs"] = await asyncio.to_thread(assistant_refs.prepare, UPLOADS, body["refs"], _path(rid) / "refs")
            (_path(rid) / "refs.json").write_text(json.dumps(run["refs"]), encoding="utf-8")
        shots = max(3, round(seconds / 3.5))
        brief = (f"NEW PROJECT.\nIdea: {idea}\nGenre/look the user picked: {run['genre'] or 'your choice, whatever fits best'}\n"
                 f"Target length: {seconds} seconds (the finished video must land within about 10% of this; roughly {shots} shots of ~3-4 s).\n"
                 f"Extra notes: {run['notes'] or 'none'}\n"
                 + {"combo": "Pictures with a named character: the app uses Qwen Image for close/medium shots (best face) and Flux 3 for wide shots on its own; set `framing` honestly on each make_still.\n",
                    "qwen": "Pictures with a named character: the app uses Qwen Image for every one (slower, best face).\n",
                    "flux": "Pictures with a named character: the app uses Flux 3 for every one (fastest).\n"}[char_engine]
                 + ("Variations: ON. At the stills approval offer 2 alternates per shot (different distance/angle of the same moment) as `picks`, and add 2-4 `suggestions`.\n" if variations
                    else "Variations: OFF. Do not make alternates; still add 2-4 `suggestions` to each approval.\n") + "\n"
                 + (assistant_refs.describe(run["refs"]) + "\n\n" if run["refs"] else "")
                 + "Follow your playbook. Start by telling the user your plan with `report`, then write the shot list and ask for approval 1.")
        if engine == "lite":
            await _spawn_lite(run)
        else:
            await _spawn(run, brief)
        return _summary(run)

    @app.get("/api/assistant/runs/{rid}")
    async def get_run(rid: str):
        r = RUNS.get(rid)
        if not r:
            raise HTTPException(404, "unknown run")
        return {k: v for k, v in r.items() if k != "inbox"}

    @app.post("/api/assistant/runs/{rid}/event")
    async def post_event(rid: str, body: dict = Body(...)):
        r = RUNS.get(rid)
        if not r:
            raise HTTPException(404, "unknown run")
        note_output(r, body.get("media"))
        event(r, body.get("kind", "say"), body.get("text", ""), stage_media(r, body.get("media")))
        inbox, r["inbox"] = r["inbox"], []
        return {"ok": True, "inbox": "\n".join(inbox)}

    def _board(r: dict) -> dict:
        return r.setdefault("board", {"stage": "", "shots": [], "now": None})

    def _shot(r: dict, n: int) -> dict:
        b = _board(r)
        s = next((x for x in b["shots"] if x["n"] == n), None)
        if not s:
            s = {"n": n, "title": f"Shot {n}", "still": "", "motion": "", "caption": "", "stills": [], "clips": []}
            b["shots"].append(s)
            b["shots"].sort(key=lambda x: x["n"])
        return s

    @app.post("/api/assistant/runs/{rid}/board")
    async def board(rid: str, body: dict = Body(...)):
        """The live shot board the app draws. ops: shots (the plan), stage, now (what is happening + progress), add (a still/clip result), mark (chosen/rejected)."""
        r = RUNS.get(rid)
        if not r:
            raise HTTPException(404, "unknown run")
        b = _board(r)
        op = body.get("op")
        if op == "shots":
            old = {s["n"]: s for s in b["shots"]}
            b["shots"] = []
            for i, s in enumerate(body.get("shots") or [], 1):
                n = int(s.get("n") or i)
                keep = old.get(n, {})
                b["shots"].append({"n": n, "title": s.get("title") or f"Shot {n}", "still": s.get("still", ""), "motion": s.get("motion", ""), "caption": s.get("caption", ""),
                                   "stills": keep.get("stills", []), "clips": keep.get("clips", [])})
        elif op == "stage":
            b["stage"] = body.get("stage", "")
        elif op == "now":
            b["now"] = {"text": body.get("text", ""), "since": b["now"]["since"] if b.get("now") and b["now"].get("text") == body.get("text") else time.time(),
                        "progress": body.get("progress"), "shot": body.get("shot")} if body.get("text") else None
        elif op == "add":
            kind = "clips" if body.get("kind") == "clip" else "stills"
            names = stage_media(r, body.get("media"))
            if names:
                _shot(r, int(body.get("shot") or 0))[kind].append({"name": names[0], "seed": body.get("seed"), "label": body.get("label", ""), "prompt": body.get("prompt", ""),
                                                                   "status": "new", "reason": "", "t": time.time()})
        elif op == "mark":
            s = _shot(r, int(body.get("shot") or 0))
            base = Path(body.get("path") or "x").name
            for it in s["stills"] + s["clips"]:
                if it["name"].endswith(base):
                    it["status"], it["reason"] = body.get("status", "chosen"), body.get("reason", "")
        announce(r)
        return {"ok": True}

    @app.post("/api/assistant/runs/{rid}/ask")
    async def ask(rid: str, body: dict = Body(...)):
        r = RUNS.get(rid)
        if not r:
            raise HTTPException(404, "unknown run")
        aid = uuid.uuid4().hex[:6]
        note_output(r, body.get("media"))
        picks = []
        for g in body.get("picks") or []:      # variations: one group per shot, the user taps the one they want
            opts = [{"name": (stage_media(r, [o.get("path")]) or [""])[0], "label": o.get("label", "")} for o in g.get("options", [])]
            opts = [o for o in opts if o["name"]]
            if len(opts) > 1:
                picks.append({"shot": g.get("shot"), "label": g.get("label", ""), "options": opts})
        r["approval"] = {"id": aid, "title": body.get("title", "Approval"), "message": body.get("message", ""), "options": body.get("options") or ["Approve", "Change something"],
                         "media": stage_media(r, body.get("media")), "picks": picks, "suggestions": [str(x)[:120] for x in (body.get("suggestions") or [])][:6],
                         "answered": False, "choice": "", "note": ""}
        r["status"] = "waiting"
        event(r, "ask", r["approval"]["title"])
        return {"id": aid}

    @app.get("/api/assistant/runs/{rid}/approval/{aid}")
    async def approval(rid: str, aid: str):
        r = RUNS.get(rid)
        if not r:
            raise HTTPException(404, "unknown run")
        if r["status"] == "cancelled":
            return {"cancelled": True}
        a = r.get("approval")
        if a and a["id"] == aid and a["answered"]:
            return {"answered": True, "choice": a["choice"], "note": a["note"]}
        last = next((e for e in reversed(r["events"]) if e["kind"] == "answer" and e.get("aid") == aid), None)
        if last:
            return {"answered": True, "choice": last.get("choice", ""), "note": last.get("note", "")}
        return {"answered": False}

    @app.post("/api/assistant/runs/{rid}/answer")
    async def answer(rid: str, body: dict = Body(...)):
        r = RUNS.get(rid)
        a = r and r.get("approval")
        if not a or a["id"] != body.get("approval_id"):
            raise HTTPException(409, "That question was already answered.")
        choice, note = str(body.get("choice", "")), str(body.get("note", ""))[:2000]
        chosen = []      # which variation the user tapped for each shot
        for p in a.get("picks") or []:
            i = (body.get("picks") or {}).get(str(p["shot"]), 0)
            i = i if isinstance(i, int) and 0 <= i < len(p["options"]) else 0
            chosen.append(f"shot {p['shot']}: option {i + 1} ({p['options'][i]['label'] or 'main'})")
            try:      # reflect the pick on the board (options are re-staged copies: match by the original file name)
                offered = {o["name"][7:]: k for k, o in enumerate(p["options"])}
                for it in _shot(r, int(p["shot"]))["stills"]:
                    k = offered.get(it["name"][7:])
                    if k is not None:
                        it["status"], it["reason"] = ("chosen", "") if k == i else ("rejected", "not picked")
            except Exception:
                pass
        if chosen:
            note = (note + "\n" if note else "") + "USER PICKED: " + "; ".join(chosen)
        r["status"] = "running"
        r["events"].append({"t": time.time(), "kind": "answer", "text": choice + (f" — {note}" if note else ""), "media": [], "aid": a["id"], "choice": choice, "note": note})
        r["approval"] = None
        announce(r)
        return {"ok": True}

    @app.post("/api/assistant/runs/{rid}/message")
    async def message(rid: str, body: dict = Body(...)):
        r = RUNS.get(rid)
        if not r:
            raise HTTPException(404, "unknown run")
        txt = str(body.get("text", "")).strip()[:2000]
        if txt:
            r["inbox"].append(txt)
            event(r, "user", txt)
        return {"ok": True}

    @app.post("/api/assistant/runs/{rid}/pause")
    async def pause(rid: str):
        """Soft pause: whatever is generating right now finishes, then the assistant waits before starting the next picture/clip/cut."""
        r = RUNS.get(rid)
        if not r or r["status"] not in ("running", "starting", "waiting"):
            raise HTTPException(409, "Nothing is running.")
        r["paused"] = True
        event(r, "note", "Paused. The current step will finish, then it waits for you.")
        return {"ok": True}

    @app.post("/api/assistant/runs/{rid}/unpause")
    async def unpause(rid: str):
        r = RUNS.get(rid)
        if not r:
            raise HTTPException(404, "unknown run")
        r["paused"] = False
        event(r, "note", "Continuing.")
        return {"ok": True}

    @app.get("/api/assistant/runs/{rid}/state")
    async def state(rid: str):
        r = RUNS.get(rid) or {}
        return {"paused": bool(r.get("paused")), "cancelled": r.get("status") == "cancelled"}

    @app.post("/api/assistant/runs/{rid}/cancel")
    async def cancel(rid: str):
        r = RUNS.get(rid)
        if not r:
            raise HTTPException(404, "unknown run")
        r["status"] = "cancelled"
        r["paused"] = False
        r["approval"] = None
        p = PROCS.get(rid)
        if p:
            try:
                p.kill()
            except Exception:
                pass
        event(r, "note", "Stopped by you.")
        return {"ok": True}

    @app.post("/api/assistant/runs/{rid}/resume")
    async def resume(rid: str):
        r = RUNS.get(rid)
        if not r or r["status"] in ("running", "waiting", "starting") or (r["status"] == "done" and r.get("output")):
            raise HTTPException(409, "Nothing to resume.")
        if r.get("engine") == "lite":
            raise HTTPException(409, "Lite projects can't be resumed. Use 'Start again from this'.")
        event(r, "note", "Resuming…")
        r["paused"] = False
        await _spawn(r, "The project stopped before it was finished (the app restarted, a tool was unavailable, or you were stopped). Continue from where you left off: look at what already exists on the board, retry whatever failed, do not redo finished work, and carry on to the end.", resume=bool(r.get("session")))
        return _summary(r)

    @app.post("/api/assistant/runs/{rid}/refs")
    async def attach_refs(rid: str, body: dict = Body(...)):
        """Add reference pictures/characters to a project that already exists (even while it runs). The assistant is told and uses them from its next picture on."""
        r = RUNS.get(rid)
        if not r:
            raise HTTPException(404, "unknown run")
        items = body.get("refs") or []
        if not items:
            raise HTTPException(400, "Nothing to attach.")
        start = max([x["n"] for x in r.get("refs") or []] + [0]) + 1
        new = await asyncio.to_thread(assistant_refs.prepare, UPLOADS, items, _path(rid) / "refs", start)
        if not new:
            raise HTTPException(400, "Those files could not be read.")
        r.setdefault("refs", []).extend(new)
        (_path(rid) / "refs.json").write_text(json.dumps(r["refs"]), encoding="utf-8")
        names = ", ".join(f"@{x['char']}" if x.get("char") else x["name"] for x in new)
        event(r, "note", f"Attached: {names}")
        r["inbox"].append("NEW REFERENCE ATTACHED by the user: " + assistant_refs.describe(new)
                          + "\nFrom now on write @Name in make_still prompts for any named character (the tool links the picture). Any earlier picture that shows such a character WITHOUT their reference is unreliable: redo those stills with the reference before moving on.")
        return {"refs": [{k: x.get(k) for k in ("n", "kind", "name", "role", "char", "label")} for x in r["refs"]]}

    @app.get("/api/assistant/runs/{rid}/form")
    async def form(rid: str):
        """Everything needed to start the same project again: idea, notes, length, style, and its reference files re-uploaded server-side."""
        r = RUNS.get(rid)
        if not r:
            raise HTTPException(404, "unknown run")
        UPLOADS.mkdir(parents=True, exist_ok=True)
        refs = []
        for x in r.get("refs") or []:
            src = Path(x["path"])
            if not src.is_file():
                continue
            dst = UPLOADS / f"{uuid.uuid4().hex[:10]}{src.suffix.lower()}"
            shutil.copyfile(src, dst)
            refs.append({"file": dst.name, "name": x["name"], "kind": x["kind"], "role": x["role"], "label": x.get("label", ""), "char": x.get("char", ""), "n": x["n"]})
        return {"engine": r.get("engine", "claude"), "idea": r["idea"], "genre": r.get("genre", ""), "seconds": r.get("seconds", 22), "notes": r.get("notes", ""), "variations": r.get("variations", True), "char_engine": r.get("char_engine", "combo"), "refs": refs}

    @app.get("/api/assistant/runs/{rid}/ref/{n}")
    async def ref_file(rid: str, n: int):
        r = RUNS.get(rid)
        x = next((x for x in (r or {}).get("refs") or [] if x["n"] == n), None)
        if not x or not Path(x["path"]).is_file():
            raise HTTPException(404, "not found")
        return FileResponse(x["path"])

    @app.post("/api/assistant/runs/{rid}/revise")
    async def revise(rid: str, body: dict = Body(...)):
        """Reopen a finished/stopped project: the assistant keeps everything already made and redoes only what the note asks for."""
        r = RUNS.get(rid)
        if not r:
            raise HTTPException(404, "unknown run")
        if r["status"] in ("running", "waiting", "starting"):
            raise HTTPException(409, "It is still working. Use 'Tell the assistant something' instead.")
        if r.get("engine") == "lite":
            raise HTTPException(409, "Lite projects can't be revised. Use 'Start again from this'.")
        note = str(body.get("note", "")).strip()[:3000]
        if not note:
            raise HTTPException(400, "Say what to change.")
        work = _path(rid) / "work"

        def orig(name: str) -> str:      # the board stores copies as <hex>_<original name>
            f = work / name[7:]
            return str(f) if f.is_file() else ""
        lines = []
        for s in (r.get("board") or {}).get("shots", []):
            def best(items):
                it = next((x for x in items if x["status"] == "chosen"), None) or next((x for x in reversed(items) if x["status"] != "rejected"), None)
                return orig(it["name"]) if it else ""
            lines.append(f"  shot {s['n']} '{s['title']}': still {best(s['stills']) or '-'} | clip {best(s['clips']) or '-'} | still idea: {s.get('still', '')[:160]} | motion: {s.get('motion', '')[:160]}")
        refs = assistant_refs.describe(r.get("refs") or [])
        r["approval"] = None
        r["status"] = "running"
        event(r, "user", f"Revise: {note}")
        prompt = ("REVISION REQUEST on a project you already made. Keep everything that is not mentioned; reuse the existing stills/clips below, redo ONLY what the note needs "
                  "(new stills/clips for the affected shots, same character references), mark replaced results rejected on the board, rebuild the cut as the NEXT version number "
                  "(never overwrite), check it, and ask for the final approval again.\n\n"
                  f"Original idea: {r['idea']}\nNotes: {r.get('notes') or 'none'}\nTarget length: {r.get('seconds')} s. Previous output: {r.get('output') or 'none yet'}\n"
                  f"Current shots:\n" + ("\n".join(lines) or "  (none recorded)") + "\n" + (refs + "\n" if refs else "") + f"\nTHE USER'S CHANGE: {note}")
        await _spawn(r, prompt, resume=bool(r.get("session")))
        return _summary(r)

    @app.get("/api/assistant/runs/{rid}/media/{name}")
    async def media(rid: str, name: str):
        f = _path(rid) / "media" / Path(name).name
        if not f.is_file():
            raise HTTPException(404, "not found")
        return FileResponse(f)
