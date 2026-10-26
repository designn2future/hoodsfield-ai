"""Auto-QA: cheap heuristic checks (black / frozen / blurry / flicker / jump cuts) on a rendered clip, plus an optional
local vision-model verdict (Ollama Qwen-VL). Also ranks several takes of the same shot so best-of-N is one call.

  POST /api/qa/analyze   file=<video>  vlm=0|1                -> {score, verdict, issues[], metrics{}, vlm?}
  POST /api/qa/rank      files=<video>*  vlm=0|1               -> {ranked:[{index,name,score,...}]}
"""
import asyncio
import json
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from fastapi import File, Form, HTTPException, UploadFile

from audio_analysis import ffmpeg_exe

W, H, SAMPLE_FPS = 256, 144, 6


def _frames(path: str) -> np.ndarray:
    cmd = [ffmpeg_exe(), "-v", "error", "-i", path, "-vf", f"fps={SAMPLE_FPS},scale={W}:{H},format=gray",
           "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    n = len(raw) // (W * H)
    if n < 2:
        raise HTTPException(422, "Could not decode enough frames from this clip")
    return np.frombuffer(raw[:n * W * H], dtype=np.uint8).reshape(n, H, W).astype(np.float32)


def _laplacian_var(f: np.ndarray) -> float:
    lap = (-4 * f[1:-1, 1:-1] + f[:-2, 1:-1] + f[2:, 1:-1] + f[1:-1, :-2] + f[1:-1, 2:])
    return float(lap.var())


def analyze_frames(fr: np.ndarray) -> tuple[int, list[dict], dict]:
    n = len(fr)
    luma = fr.mean(axis=(1, 2))
    diff = np.abs(np.diff(fr, axis=0)).mean(axis=(1, 2))
    sharp = np.array([_laplacian_var(f) for f in fr])
    metrics = {
        "frames_sampled": n,
        "mean_luma": round(float(luma.mean()), 1),
        "black_fraction": round(float((luma < 12).mean()), 3),
        "frozen_fraction": round(float((diff < 0.25).mean()), 3),
        "sharpness_median": round(float(np.median(sharp)), 1),
        "flicker_events": int((np.abs(np.diff(luma)) > 18).sum()),
        "jump_cuts": int((diff > 45).sum()),
        "motion_mean": round(float(diff.mean()), 2),
        "drift": round(float(np.abs(fr[:max(1, n // 6)].mean(axis=0) - fr[-max(1, n // 6):].mean(axis=0)).mean()), 1),
    }
    issues, score = [], 100
    def add(sev, code, msg, pen):
        nonlocal score
        issues.append({"severity": sev, "code": code, "message": msg}); score -= pen
    if metrics["black_fraction"] > 0.2:
        add("error", "black", f"{metrics['black_fraction']:.0%} of the clip is near-black", 45)
    if metrics["frozen_fraction"] > 0.6:
        add("error", "frozen", f"{metrics['frozen_fraction']:.0%} of frames barely change (frozen / no motion)", 60)
    elif metrics["frozen_fraction"] > 0.35:
        add("warn", "static", "Large parts of the clip are nearly static", 12)
    if metrics["sharpness_median"] < 25:
        add("warn", "blurry", f"Very soft image (sharpness {metrics['sharpness_median']})", 30)
    if metrics["flicker_events"] >= max(2, n // 12):
        add("warn", "flicker", f"{metrics['flicker_events']} sudden brightness jumps (flicker)", 15)
    if metrics["jump_cuts"]:
        add("warn", "jump", f"{metrics['jump_cuts']} abrupt frame jump(s): a cut, glitch or scene reset", 10 * min(3, metrics["jump_cuts"]))
    if metrics["motion_mean"] > 14:
        add("warn", "chaotic", "Extremely high frame-to-frame change (likely warping / chaos)", 15)
    return max(0, min(100, score)), issues, metrics


def _vlm_frames(path: str, count: int = 2) -> list[bytes]:
    out = []
    with tempfile.TemporaryDirectory() as td:
        # evenly spaced frames: select via thumbnail-free approach (fps filter from duration)
        txt = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", path], capture_output=True, text=True).stderr
        mm = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", txt)
        dur = int(mm.group(1)) * 3600 + int(mm.group(2)) * 60 + float(mm.group(3)) if mm else 3.0
        for i in range(count):
            t = dur * (i + 0.5) / count
            p = Path(td) / f"f{i}.jpg"
            subprocess.run([ffmpeg_exe(), "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", path, "-frames:v", "1",
                            "-vf", "scale='min(448,iw)':-2", "-q:v", "4", str(p)], capture_output=True)
            if p.exists():
                out.append(p.read_bytes())
    return out


VLM_PROMPT = (
    "You are a strict QA reviewer for AI-generated video. These are {n} frames from one clip, in order. "
    "Judge visual quality only: anatomy errors (extra/missing limbs or fingers, melted faces), identity changing "
    "between frames, warped or garbled objects, text garbage, heavy artifacts. Reply with ONLY compact JSON: "
    '{{"score": <1-10 integer>, "problems": ["short phrase", ...]}}. Use an empty list if clean.'
)


async def _vlm(m, path: str) -> dict:
    frames = await asyncio.to_thread(_vlm_frames, path)
    if not frames:
        return {"error": "no frames"}
    try:
        text, model = await m._ollama_vision(frames, VLM_PROMPT.format(n=len(frames)))
    except HTTPException as e:
        return {"error": str(e.detail)}
    mm = re.search(r"\{.*\}", text, re.S)
    try:
        j = json.loads(mm.group(0)) if mm else {}
    except Exception:
        j = {}
    score = j.get("score")
    return {"model": model, "score": score if isinstance(score, (int, float)) else None,
            "problems": [str(p) for p in j.get("problems", [])][:6], "raw": None if j else text[:300]}


def _verdict(score: int) -> str:
    return "good" if score >= 80 else "usable" if score >= 55 else "reject"


def register(app, m):
    async def _run(up: UploadFile, vlm: bool) -> dict:
        data = await up.read()
        if not data:
            raise HTTPException(400, "Empty upload")
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / ("clip" + (Path(up.filename or "").suffix or ".mp4"))
            p.write_bytes(data)
            fr = await asyncio.to_thread(_frames, str(p))
            score, issues, metrics = analyze_frames(fr)
            res = {"name": up.filename, "score": score, "issues": issues, "metrics": metrics}
            if vlm:
                v = await _vlm(m, str(p))
                res["vlm"] = v
                if v.get("score") is not None:
                    # blend: the vision verdict is allowed to pull the score either way
                    res["score"] = int(round(0.5 * score + 0.5 * v["score"] * 10))
                    for pr in v.get("problems", []):
                        res["issues"].append({"severity": "warn", "code": "vlm", "message": pr})
            res["verdict"] = _verdict(res["score"])
            return res

    @app.post("/api/qa/analyze")
    async def qa_analyze(file: UploadFile = File(...), vlm: int = Form(0)):
        return await _run(file, bool(vlm))

    @app.post("/api/qa/rank")
    async def qa_rank(files: list[UploadFile] = File(...), vlm: int = Form(0)):
        out = []
        for i, f in enumerate(files):
            r = await _run(f, bool(vlm))
            r["index"] = i
            out.append(r)
        out.sort(key=lambda r: -r["score"])
        return {"ranked": out, "best": out[0]["index"] if out else None}
