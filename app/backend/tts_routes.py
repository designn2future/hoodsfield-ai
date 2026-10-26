"""Voiceover: local Chatterbox TTS with voice cloning.

Chatterbox runs in its own environment (it needs torch 2.6 / transformers 5, which would break ComfyUI), as a small HTTP
server (app/voice/voice_server.py) that this module starts on demand and talks to on 127.0.0.1:8189.

  GET  /api/tts/status                 -> voice server state (running, loaded, device, free VRAM)
  GET  /api/tts/voices                 -> reference voices: your uploads + the legacy C:\\shorts_data\\voice_samples library
  POST /api/tts/voices                 -> upload / record a new reference voice (name + audio file)
  GET  /api/tts/voices/{id}/audio      -> preview a reference voice
  POST /api/tts/speak                  -> {job_id}: text + voice -> wav (a composite job; SSE like every other job)
  GET  /api/tts/audio/{job_id}         -> the finished wav
  POST /api/tts/unload                 -> free the model's VRAM now
"""
import asyncio
import os
import re
import subprocess
import time
import uuid
from pathlib import Path

import httpx
from fastapi import File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from audio_analysis import ffmpeg_exe

VOICE_HOME = Path(os.getenv("VSA_VOICE_HOME", r"D:\vsa_voice"))
VOICE_PY = VOICE_HOME / "cb" / "Scripts" / "python.exe"
SERVER = Path(__file__).resolve().parent.parent / "voice" / "voice_server.py"
URL = "http://127.0.0.1:8189"
LEGACY = Path(os.getenv("VSA_LEGACY_VOICES", r"C:\shorts_data\voice_samples"))
UPLOADS = VOICE_HOME / "voices"

_dur_cache: dict[str, float] = {}


def _duration(p: Path) -> float:
    k = str(p)
    if k not in _dur_cache:
        r = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", k], capture_output=True, text=True).stderr
        mm = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", r)
        _dur_cache[k] = int(mm.group(1)) * 3600 + int(mm.group(2)) * 60 + float(mm.group(3)) if mm else 0.0
    return _dur_cache[k]


def _voices() -> list[dict]:
    out = []
    if UPLOADS.is_dir():
        for p in sorted(UPLOADS.glob("*.wav"), key=lambda x: -x.stat().st_mtime):
            out.append({"id": f"u:{p.name}", "name": p.stem.replace("_", " "), "source": "yours", "seconds": round(_duration(p), 1)})
    if LEGACY.is_dir():
        for i, p in enumerate(sorted(LEGACY.glob("*.*"))):
            if p.suffix.lower() in (".mp3", ".wav", ".m4a", ".flac", ".ogg"):
                out.append({"id": f"s:{p.name}", "name": f"Library voice {i + 1:02d}", "source": "library", "seconds": round(_duration(p), 1)})
    return out


def _resolve(vid: str) -> Path:
    kind, _, name = vid.partition(":")
    base = UPLOADS if kind == "u" else LEGACY if kind == "s" else None
    p = (base / Path(name).name) if base else None
    if not p or not p.is_file():
        raise HTTPException(404, "Voice not found")
    return p


def register(app, m):
    state = {"proc": None}

    async def _health(client):
        try:
            r = await client.get(f"{URL}/health", timeout=2)
            return r.json()
        except Exception:
            return None

    async def _ensure_server(cj=None):
        async with httpx.AsyncClient(trust_env=False) as client:
            h = await _health(client)
            if h:
                return h
            if not VOICE_PY.is_file():
                raise RuntimeError(f"Voice environment not found at {VOICE_PY}. Install Chatterbox into {VOICE_HOME}\\cb first.")
            if cj:
                await cj.status("Starting the voice engine…")
            log = open(VOICE_HOME / "voice_server.log", "ab")
            state["proc"] = subprocess.Popen([str(VOICE_PY), str(SERVER)], stdout=log, stderr=log, cwd=str(SERVER.parent),
                                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            for _ in range(90):
                await asyncio.sleep(1)
                h = await _health(client)
                if h:
                    return h
            raise RuntimeError("The voice engine did not start (see D:\\vsa_voice\\voice_server.log)")

    @app.get("/api/tts/status")
    async def tts_status():
        async with httpx.AsyncClient(trust_env=False) as client:
            h = await _health(client)
        return {"installed": VOICE_PY.is_file(), "running": bool(h), **(h or {})}

    @app.get("/api/tts/voices")
    async def tts_voices():
        return {"voices": await asyncio.to_thread(_voices)}

    @app.post("/api/tts/voices")
    async def tts_add_voice(name: str = Form(...), file: UploadFile = File(...)):
        data = await file.read()
        if not data:
            raise HTTPException(400, "Empty audio")
        UPLOADS.mkdir(parents=True, exist_ok=True)
        slug = re.sub(r"[^A-Za-z0-9_-]+", "_", name.strip())[:40] or "voice"
        tmp = UPLOADS / f"_tmp_{uuid.uuid4().hex[:6]}{Path(file.filename or '.wav').suffix or '.wav'}"
        tmp.write_bytes(data)
        dst = UPLOADS / f"{slug}.wav"
        # 24 kHz mono, at most 20 s: a clean 6-15 s sample clones best
        r = await asyncio.to_thread(subprocess.run, [ffmpeg_exe(), "-y", "-v", "error", "-i", str(tmp), "-t", "20", "-ac", "1", "-ar", "24000", str(dst)],
                                    capture_output=True, text=True)
        tmp.unlink(missing_ok=True)
        if r.returncode or not dst.exists():
            raise HTTPException(400, "Could not read that audio: " + r.stderr[-200:])
        _dur_cache.pop(str(dst), None)
        return {"id": f"u:{dst.name}", "seconds": round(_duration(dst), 1)}

    @app.get("/api/tts/voices/{vid:path}/audio")
    async def tts_voice_audio(vid: str):
        return FileResponse(_resolve(vid))

    @app.post("/api/tts/speak")
    async def tts_speak(
        text: str = Form(...),
        voice: str = Form(...),
        exaggeration: float = Form(0.5),
        cfg_weight: float = Form(0.5),
        seed: int = Form(0),
        device: str = Form("auto"),
    ):
        if not text.strip():
            raise HTTPException(400, "Write something for the voice to say")
        ref = _resolve(voice)
        if m.MOCK:
            raise HTTPException(400, "Voiceover needs the real backend (not mock mode)")
        cj = m.CompositeJob("audio-voice", f"Voiceover · {text.strip()[:70]}", steps=2,
                            params={"prompt": text.strip(), "voice": voice, "exaggeration": exaggeration, "cfg_weight": cfg_weight}, family="voice")

        async def work(cj):
            from jobs import OUT_DIR
            await _ensure_server(cj)
            await cj.step_done()
            await cj.status("Speaking…")
            async with httpx.AsyncClient(timeout=1800, trust_env=False) as client:
                r = await client.post(f"{URL}/speak", json={"text": text, "ref": str(ref), "exaggeration": exaggeration,
                                                              "cfg_weight": cfg_weight, "seed": seed, "device": device})
            if r.status_code != 200:
                try:
                    msg = r.json().get("error", r.text[:200])
                except Exception:
                    msg = r.text[:200]
                raise RuntimeError(msg)
            out = OUT_DIR / f"{cj.id}.wav"
            out.write_bytes(r.content)
            cj.job["device"] = r.headers.get("x-device", "")
            await cj.step_done()
            cj.finish(out)

        cj.start(work)
        return {"job_id": cj.id}

    @app.get("/api/tts/audio/{job_id}")
    async def tts_audio(job_id: str):
        from jobs import OUT_DIR
        p = OUT_DIR / f"{Path(job_id).name}.wav"
        if not p.is_file():
            raise HTTPException(404, "No audio for that job")
        return FileResponse(p, media_type="audio/wav")

    @app.post("/api/tts/unload")
    async def tts_unload():
        async with httpx.AsyncClient(trust_env=False) as client:
            try:
                await client.post(f"{URL}/unload", timeout=10)
            except Exception:
                pass
        return {"ok": True}
