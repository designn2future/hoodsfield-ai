"""Seamless loops for "study / lofi" videos: a quiet scene with gentle motion that repeats for hours with no visible seam.

  POST /api/loop/make        a short clip (upload) -> a clip that loops seamlessly (finds the best loop point, cross-fades the seam)
  POST /api/loop/import      register a clip as-is (for example after upscaling a loop) so it can be exported
  GET  /api/loop/file/{id}   the loop (preview / download)
  POST /api/loop/export      a loop (+ optional music) -> one long video of N minutes (a job; the picture is copied, never re-encoded)
  GET  /api/loop/export_info/{job_id}

How the loop is made. Pick a start frame `a` and a loop length `N`. The loop plays frames a .. a+N-1. Its first `L` frames are a cross-fade
from the frames that would have come AFTER the loop (a+N .. a+N+L-1) into the real frames a .. a+L-1, so when the loop wraps around, the
last frame (a+N-1) is followed by something that looks like frame a+N: the motion simply continues. The (a, N) pair is the one where those
two streams look most alike, so the cross-fade has almost nothing to hide (no ghosting of leaves, rain or steam).
"""
import asyncio
import json
import math
import os
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path

import numpy as np
from fastapi import File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from audio_analysis import ffmpeg_exe

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
AW, AH = 128, 72          # analysis size (RGB)
MAX_ANALYSIS_FRAMES = 900


def _probe(path: Path) -> dict:
    r = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, text=True, creationflags=NOWIN)
    txt = r.stderr
    info = {"fps": 24.0, "width": 0, "height": 0, "duration": 0.0, "audio": "Audio:" in txt}
    mm = re.search(r"(\d+(?:\.\d+)?)\s*fps", txt)
    if mm:
        info["fps"] = float(mm.group(1))
    mm = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", txt)
    if mm:
        info["width"], info["height"] = int(mm.group(1)), int(mm.group(2))
    mm = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", txt)
    if mm:
        info["duration"] = int(mm.group(1)) * 3600 + int(mm.group(2)) * 60 + float(mm.group(3))
    return info


def _fps_arg(fps: float) -> str:
    for n, d in ((24000, 1001), (30000, 1001), (60000, 1001)):
        if abs(fps - n / d) < 0.02:
            return f"{n}/{d}"
    return f"{round(fps)}" if abs(fps - round(fps)) < 0.02 else f"{fps:.3f}"


def _decode_small(path: Path, fps: float) -> np.ndarray:
    raw = subprocess.run([ffmpeg_exe(), "-v", "error", "-i", str(path), "-an", "-vf", f"fps={_fps_arg(fps)},scale={AW}:{AH}:flags=area,format=rgb24",
                          "-f", "rawvideo", "-"], capture_output=True, creationflags=NOWIN).stdout
    n = len(raw) // (AW * AH * 3)
    return np.frombuffer(raw, np.uint8)[: n * AW * AH * 3].reshape(n, AH, AW, 3)


def _dist_matrix(frames: np.ndarray) -> np.ndarray:
    """RMS per-pixel difference (0..1) between every pair of frames."""
    X = frames.reshape(len(frames), -1).astype(np.float32) / 255.0
    sq = (X * X).sum(1)
    d2 = np.maximum(sq[:, None] + sq[None, :] - 2.0 * (X @ X.T), 0.0)
    return np.sqrt(d2 / X.shape[1])


def find_jumps(D: np.ndarray) -> list[int]:
    """Frame indices i where the picture jumps between frame i and i+1 (a cut, or a model glitch): far above this clip's normal step."""
    if len(D) < 8:
        return []
    step = D[np.arange(len(D) - 1), np.arange(len(D) - 1) + 1]
    med = float(np.median(step))
    mad = float(np.median(np.abs(step - med)))
    thr = max(med + 7.0 * mad, 2.5 * med, 0.02)
    return [int(i) for i in np.where(step > thr)[0]]


def _search(D: np.ndarray, lo: int, hi: int, fps: float, nmin: int, L: int) -> dict | None:
    """Best loop inside frames lo..hi (inclusive). Returns None when that stretch is too short."""
    sub = D[lo:hi + 1, lo:hi + 1]
    M = sub.shape[0]
    nmax = M - L
    if nmax < nmin:
        return None
    best, costs = None, []
    for N in range(nmin, nmax + 1):
        k = M - N                              # valid pairs (i, i+N)
        if k < L:
            continue
        v = sub[np.arange(k), np.arange(k) + N]
        c = np.concatenate([[0.0], np.cumsum(v)])
        win = (c[L:] - c[:-L]) / L              # mean over the L cross-fade frames, for every start a = 0..k-L
        a = int(np.argmin(win))
        cost = float(win[a]) * (1.0 + 0.12 * (1.0 - N / nmax))      # a little preference for longer loops
        costs.append(float(win[a]))
        if best is None or cost < best["score"]:
            best = {"a": lo + a, "N": N, "L": L, "cost": float(win[a]), "score": cost}
    if best is None:
        return None
    best["typical"] = float(np.median(costs))
    return best


def find_loop(D: np.ndarray, fps: float, min_loop_s: float, blend_s: float) -> dict:
    """Best (start a, length N, blend L): the pair where the two cross-faded streams look most alike, never straddling a jump in the footage."""
    M = D.shape[0]
    L = max(4, min(int(round(blend_s * fps)), M // 3))
    nmin = max(L + 2, int(round(min_loop_s * fps)))
    jumps = find_jumps(D)
    cuts = [-1] + jumps + [M - 1]
    segs = [(cuts[i] + 1, cuts[i + 1]) for i in range(len(cuts) - 1) if cuts[i + 1] - cuts[i] >= L + 6]
    best, used = None, None
    for lo, hi in segs:
        r = _search(D, lo, hi, fps, nmin, L)
        if r is None and (hi - lo + 1) >= 2 * L + 6:           # shorter than the wanted loop: still use the longest loop it allows
            r = _search(D, lo, hi, fps, max(L + 2, (hi - lo + 1 - L) // 2), L)
        if r is not None and (best is None or r["score"] < best["score"]):
            best, used = r, (lo, hi)
    if best is None:      # no calm stretch is long enough: use the whole clip and let the report say the footage itself has sudden changes
        best = _search(D, 0, M - 1, fps, nmin, L) or _search(D, 0, M - 1, fps, max(L + 2, (M - L) // 2), L)
        used = (0, M - 1)
    if best is None:
        raise ValueError("The clip is too short to make a loop from. Use a steady clip of at least 3 seconds.")
    best["jumps"] = jumps
    best["used"] = used
    return best


def _ranges(jumps: list[int], fps: float) -> list[list[float]]:
    """Consecutive jump frames -> [[from_s, to_s], ...] for the report."""
    out = []
    for j in jumps:
        if out and j - out[-1][1] <= 2:
            out[-1][1] = j
        else:
            out.append([j, j])
    return [[round(a / fps, 1), round((b + 2) / fps, 1)] for a, b in out]


def _build_loop(src: Path, out: Path, a: int, N: int, L: int, fps: float, info: dict) -> None:
    f = _fps_arg(fps)
    L1 = L + 1
    w = f"((N+1)/{L1})*((N+1)/{L1})*(3-2*((N+1)/{L1}))"      # smoothstep weight of the real frames during the cross-fade
    fc = (f"[0:v]fps={f},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2,split=3[s1][s2][s3];"
          f"[s1]trim=start_frame={a + N}:end_frame={a + N + L},setpts=PTS-STARTPTS[old];"
          f"[s2]trim=start_frame={a}:end_frame={a + L},setpts=PTS-STARTPTS[new];"
          f"[old][new]blend=all_expr='A*(1-({w}))+B*({w})'[bl];"
          f"[s3]trim=start_frame={a + L}:end_frame={a + N},setpts=PTS-STARTPTS[plain];"
          f"[bl][plain]concat=n=2:v=1:a=0,setsar=1,format=yuv420p[v]")
    cmd = [ffmpeg_exe(), "-y", "-v", "error", "-i", str(src), "-filter_complex", fc, "-map", "[v]", "-an", "-r", f, "-c:v", "libx264", "-crf", "17",
           "-preset", "slow", "-x264-params", "bframes=0:keyint=240:min-keyint=24:scenecut=0", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True, creationflags=NOWIN)
    if r.returncode or not out.exists():
        raise RuntimeError("Could not build the loop: " + (r.stderr or "")[-300:])


def _seam_report(path: Path, fps: float) -> dict:
    fr = _decode_small(path, fps)
    if len(fr) < 4:
        return {"ratio": None, "rating": "unknown", "frames": len(fr)}
    X = fr.reshape(len(fr), -1).astype(np.float32) / 255.0
    step = np.sqrt(((X[1:] - X[:-1]) ** 2).mean(1))
    wrap = float(np.sqrt(((X[0] - X[-1]) ** 2).mean()))
    med = float(np.median(step)) + 1e-6
    top = float(np.percentile(step, 99)) + 1e-6          # the biggest step the loop makes by itself: a seam below this cannot be told apart from normal motion
    ratio = wrap / top
    lum = X.reshape(len(fr), -1).mean(1)
    rating = "seamless" if ratio <= 1.15 else "very good" if ratio <= 1.6 else "check the seam" if ratio <= 2.5 else "visible seam"
    return {"ratio": round(float(ratio), 2), "rating": rating, "frames": int(len(fr)), "wrap_diff": round(wrap, 5), "typical_step": round(med, 5),
            "largest_step": round(top, 5), "brightness_jump": round(float(abs(lum[0] - lum[-1])), 5)}


def register(app, m):
    root = Path(m.WORK_DIR) / "loops"
    root.mkdir(parents=True, exist_ok=True)
    EXPORTS: dict[str, dict] = {}

    def _meta_path(lid: str) -> Path:
        return root / f"{lid}.json"

    def _load(lid: str) -> dict:
        if not re.fullmatch(r"[a-f0-9]{10}", lid or ""):
            raise HTTPException(404, "Unknown loop")
        p = _meta_path(lid)
        if not p.exists():
            raise HTTPException(404, "Unknown loop (it may have been cleaned up). Make it again.")
        return json.loads(p.read_text(encoding="utf-8"))

    @app.post("/api/loop/make")
    async def loop_make(file: UploadFile = File(...), min_seconds: float = Form(4.0), blend_seconds: float = Form(1.2)):
        data = await file.read()
        if not data:
            raise HTTPException(400, "Empty upload")
        lid = uuid.uuid4().hex[:10]
        src = root / f"{lid}_src{Path(file.filename or 'clip.mp4').suffix.lower() or '.mp4'}"
        src.write_bytes(data)
        out = root / f"{lid}.mp4"

        def work():
            info = _probe(src)
            frames = _decode_small(src, info["fps"])
            M = len(frames)
            if M < 40:
                raise ValueError("That clip is too short. Use a clip of at least 3 seconds.")
            if M > MAX_ANALYSIS_FRAMES:
                raise ValueError(f"That clip is too long to analyse ({M} frames). Trim it to under {MAX_ANALYSIS_FRAMES // int(max(1, round(info['fps'])))} seconds first.")
            D = _dist_matrix(frames)
            best = find_loop(D, info["fps"], min(max(1.0, min_seconds), 30.0), min(max(0.3, blend_seconds), 4.0))
            _build_loop(src, out, best["a"], best["N"], best["L"], info["fps"], info)
            seam = _seam_report(out, info["fps"])
            meta = {"id": lid, "fps": info["fps"], "width": info["width"], "height": info["height"], "source_frames": M, "source_seconds": round(M / info["fps"], 2),
                    "start_frame": best["a"], "frames": best["N"], "seconds": round(best["N"] / info["fps"], 2), "blend_frames": best["L"],
                    "blend_seconds": round(best["L"] / info["fps"], 2), "match": {"cost": round(best["cost"], 5), "typical": round(best["typical"], 5)},
                    "seam": seam, "jump_ranges": _ranges(best.get("jumps", []), info["fps"]), "used_s": [round(best["used"][0] / info["fps"], 2), round((best["used"][1] + 1) / info["fps"], 2)], "made": time.time()}
            _meta_path(lid).write_text(json.dumps(meta), encoding="utf-8")
            return meta

        try:
            meta = await asyncio.to_thread(work)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except RuntimeError as e:
            raise HTTPException(500, str(e))
        finally:
            try:
                src.unlink()
            except OSError:
                pass
        meta["url"] = f"/api/loop/file/{lid}"
        return meta

    @app.post("/api/loop/import")
    async def loop_import(file: UploadFile = File(...)):
        """Register an existing loop (for example the upscaled version of one) without changing it."""
        data = await file.read()
        if not data:
            raise HTTPException(400, "Empty upload")
        lid = uuid.uuid4().hex[:10]
        out = root / f"{lid}.mp4"
        out.write_bytes(data)
        info = await asyncio.to_thread(_probe, out)
        seam = await asyncio.to_thread(_seam_report, out, info["fps"])
        meta = {"id": lid, "fps": info["fps"], "width": info["width"], "height": info["height"], "seconds": round(info["duration"], 2),
                "frames": int(round(info["duration"] * info["fps"])), "seam": seam, "imported": True, "made": time.time()}
        _meta_path(lid).write_text(json.dumps(meta), encoding="utf-8")
        meta["url"] = f"/api/loop/file/{lid}"
        return meta

    @app.get("/api/loop/file/{lid}")
    async def loop_file(lid: str):
        _load(lid)
        return FileResponse(root / f"{lid}.mp4", media_type="video/mp4", filename=f"loop_{lid}.mp4")

    @app.post("/api/loop/export")
    async def loop_export(loop_id: str = Form(...), minutes: float = Form(60.0), match_audio: bool = Form(True), fade_out: float = Form(4.0),
                          audio: UploadFile | None = File(None)):
        meta = _load(loop_id)
        loop_path = root / f"{loop_id}.mp4"
        audio_path = None
        if audio is not None:
            data = await audio.read()
            if data:
                audio_path = root / f"{loop_id}_{uuid.uuid4().hex[:6]}_music{Path(audio.filename or 'a.mp3').suffix.lower() or '.mp3'}"
                audio_path.write_bytes(data)
        minutes = min(max(0.2, minutes), 600.0)
        cj = m.CompositeJob("video-loop-export", f"Long loop video · {minutes:g} min", steps=1)

        async def work(cj):
            ff = ffmpeg_exe()
            total = minutes * 60.0
            if audio_path is not None and match_audio:
                info = await asyncio.to_thread(_probe, audio_path)
                if info["duration"] > 1:
                    total = info["duration"]
            dur = max(0.5, float(meta["seconds"]))
            reps = int(math.ceil(total / dur))
            await cj.status(f"Building a {total / 60:.1f} minute video ({reps} repeats of the loop)…")
            name = f"loop_{loop_id}_{int(total // 60)}min_{uuid.uuid4().hex[:4]}.mp4"
            out = root / name
            cmd = [ff, "-y", "-v", "error", "-stream_loop", str(max(0, reps - 1)), "-i", str(loop_path)]
            if audio_path is not None:
                cmd += ["-stream_loop", "-1", "-i", str(audio_path)]
            cmd += ["-map", "0:v:0"]
            if audio_path is not None:
                fo = max(0.0, min(float(fade_out), 30.0))
                af = f"afade=t=out:st={max(0.0, total - fo):.2f}:d={fo:.2f}" if fo > 0 else "anull"
                cmd += ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k", "-af", af]
            cmd += ["-c:v", "copy", "-t", f"{total:.3f}", "-movflags", "+faststart", str(out)]
            r = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, creationflags=NOWIN)
            if r.returncode or not out.exists():
                raise RuntimeError("Could not build the long video: " + (r.stderr or "")[-300:])
            saved = None
            try:
                import app_settings
                dst = app_settings.output_dir() / "Loops"
                dst.mkdir(parents=True, exist_ok=True)
                saved = dst / name
                shutil.copyfile(out, saved)
            except Exception:
                saved = None
            EXPORTS[cj.id] = {"path": str(saved or out), "seconds": round(total, 1), "size": out.stat().st_size, "repeats": reps}
            if audio_path is not None:
                try:
                    audio_path.unlink()
                except OSError:
                    pass
            cj.finish(out)

        cj.start(work)
        return {"job_id": cj.id}

    @app.get("/api/loop/export_info/{job_id}")
    async def loop_export_info(job_id: str):
        if job_id not in EXPORTS:
            raise HTTPException(404, "Not finished yet")
        return EXPORTS[job_id]
