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
from fastapi import File, Form, HTTPException, Request, UploadFile
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


def _make_still_loop(src: Path, out: Path, info: dict, min_s: float, blend_s: float, stillness: float, work: Path, lid: str) -> dict:
    """The hold-still pipeline (see loop_still.py): stabilise, skip the settling period, find the loop, freeze what should not move, cross-fade only what does."""
    import loop_still as S
    ff = ffmpeg_exe()
    H, W, fps = info["height"], info["width"], info["fps"]
    f_arg = _fps_arg(fps)
    raw = work / f"{lid}_raw.rgb"
    tmp = [raw]
    try:
        n = S.read_raw(ff, src, f_arg, W, H, raw)
        if n < 40:
            raise ValueError("That clip is too short. Use a clip of at least 3 seconds.")
        frames = S.open_frames(raw, n, H, W)
        params, mags, settle = S.stabilise_params(frames, H, W)
        refined = S.last_refined
        # analysis on small, stabilised frames
        small = _decode_small(src, fps)
        n = min(n, len(small))
        sx, sy = AW / W, AH / H
        sm = np.empty((n, AH, AW, 3), np.float32)
        for i in range(n):
            p = params[i].copy()
            p[:3] *= sx
            p[3:] *= sy
            sm[i] = S.warp(small[i].astype(np.float32), p)
        Dfull = _dist_matrix(np.clip(sm, 0, 255).astype(np.uint8))
        lo = min(settle, max(0, n - int(max(2.0, min_s) * fps) - 30))
        best = find_loop(Dfull[lo:, lo:], fps, min_s, blend_s)
        a, N, L = best["a"] + lo, best["N"], best["L"]
        jumps = [j + lo for j in best.get("jumps", [])]
        used = (best["used"][0] + lo, best["used"][1] + lo)
        K = N + L
        edge = 0.0
        for j in range(K):                       # the warp moves content by up to this many pixels at the picture edges
            q = params[a + j]
            for X, Y in ((-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)):
                edge = max(edge, abs(float(q[0] + q[1] * X + q[2] * Y)), abs(float(q[3] + q[4] * X + q[5] * Y)))
        crop = int(min(40, np.ceil(edge))) if edge > 0.6 else 0
        if refined:
            crop = max(crop, int(round(W * (1 - 1 / 1.025) / 2)))     # constant 1.025 zoom hides the borders the warp pulls in
        # stabilised full-resolution frames a .. a+K-1, with a per-frame brightness gain (steady light)
        wfile = work / f"{lid}_warp.rgb"
        tmp.append(wfile)
        warped = np.memmap(wfile, dtype=np.uint8, mode="w+", shape=(K, H, W, 3))
        level = np.zeros((K, 3), np.float32)
        for j in range(K):
            fr = np.asarray(frames[a + j])
            w = S.warp(fr, params[a + j]) if S.shift_at_corners(params[a + j]) > 0.03 else fr.astype(np.float32)
            level[j] = w[::4, ::4].reshape(-1, 3).mean(0)
            warped[j] = np.clip(w + 0.5, 0, 255).astype(np.uint8)
        gain = (np.median(level, axis=0)[None, :] / np.maximum(level, 1.0)).astype(np.float32)
        wts = np.array([((k + 1) / (L + 1)) ** 2 * (3 - 2 * ((k + 1) / (L + 1))) for k in range(L)], np.float32)

        def loop_frame(k, y0=0, y1=H):
            if k < L:
                old = warped[N + k, y0:y1].astype(np.float32) * gain[N + k]
                new = warped[k, y0:y1].astype(np.float32) * gain[k]
                return old * (1 - wts[k]) + new * wts[k]
            return warped[k, y0:y1].astype(np.float32) * gain[k]

        # the still plate and the activity around it, band by band
        plate = np.empty((H, W, 3), np.float32)
        act = np.empty((H, W), np.float32)
        bh = max(16, int(6e7 // (N * W * 3 * 4)))
        for y0 in range(0, H, bh):
            y1 = min(H, y0 + bh)
            band = np.stack([loop_frame(k, y0, y1) for k in range(N)])
            P = np.median(band, axis=0)
            plate[y0:y1] = P
            act[y0:y1] = np.abs(band - P[None]).mean(3).mean(0)
            del band
        s = min(max(stillness, 0.0), 1.0)
        if s <= 0:
            mask = np.ones((H, W), np.float32)
        else:
            r1, r2, r3 = max(1, int(round(W / 450))), max(2, int(round(W / 190))), max(1, int(round(W / 330)))
            if refined:
                mask = S.freeze_mask(act, s, r1, r2, r3)           # thresholds adapt to the clip once the drift is gone
            else:
                lo_t, hi_t = 1.2 + 2.6 * s, 3.4 + 4.6 * s                 # levels (0-255) below which a pixel counts as still
                a_s = S.blur(act, r1)
                m = np.clip((a_s - lo_t) / (hi_t - lo_t), 0, 1)
                m = m * m * (3 - 2 * m)
                mask = np.clip(S.blur(S.dilate(m, r2), r3), 0, 1)
        try:
            from PIL import Image
            Image.fromarray((mask * 255).astype(np.uint8)).resize((max(2, W // 2), max(2, H // 2))).save(work / f"{lid}_mask.png")
        except Exception:
            pass
        # write the loop: moving parts from the footage, everything else = the still plate
        enc = [ff, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", f_arg, "-i", "-",
               "-vf", (f"crop={W - 2 * crop}:{H - 2 * crop}:{crop}:{crop},scale={W}:{H}:flags=lanczos," if crop else "") + "scale=out_color_matrix=bt709:out_range=tv,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-crf", "16", "-preset", "slow",
               "-x264-params", "bframes=0:keyint=240:min-keyint=24:scenecut=0", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
               "-movflags", "+faststart", str(out)]
        pr = subprocess.Popen(enc, stdin=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NOWIN)
        m3 = mask[..., None]
        for k in range(N):
            g = loop_frame(k)
            pr.stdin.write(np.clip(m3 * g + (1 - m3) * plate + 0.5, 0, 255).astype(np.uint8).tobytes())
        pr.stdin.close()
        err = pr.stderr.read().decode(errors="ignore")
        pr.wait()
        if pr.returncode or not out.exists():
            raise RuntimeError("Could not encode the loop: " + err[-300:])
        del warped
        used_mags = mags[used[0]:used[1] + 1]
        return {"a": a, "N": N, "L": L, "cost": best["cost"], "typical": best["typical"], "jumps": jumps, "used": used, "source_frames": n,
                "settle_s": round(settle / fps, 2), "corrected_px": round(float(edge), 1), "crop_px": crop,
                "drift_px_all": round(float(mags.max()), 2), "frozen_pct": round(float((1 - mask).mean() * 100), 0), "stabilised": True, "subpixel": bool(refined)}
    finally:
        for t in tmp:
            try:
                t.unlink()
            except OSError:
                pass


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
    async def loop_make(file: UploadFile = File(...), min_seconds: float = Form(4.0), blend_seconds: float = Form(1.2), stillness: float = Form(0.7)):
        data = await file.read()
        if not data:
            raise HTTPException(400, "Empty upload")
        lid = uuid.uuid4().hex[:10]
        src = root / f"{lid}_src{Path(file.filename or 'clip.mp4').suffix.lower() or '.mp4'}"
        src.write_bytes(data)
        out = root / f"{lid}.mp4"

        def work():
            info = _probe(src)
            res, mode = None, "crossfade"
            if stillness > 0 and info["width"] and info["height"]:
                try:
                    res = _make_still_loop(src, out, info, min(max(1.0, min_seconds), 30.0), min(max(0.3, blend_seconds), 4.0), stillness, root, lid)
                    mode = "still"
                except ValueError:
                    raise
                except Exception as e:      # never fail the whole request because the extra processing had a problem: fall back to the plain cross-fade
                    res = None
                    print("loop: hold-still pipeline failed, using the plain cross-fade:", repr(e), flush=True)
            if res is None:
                frames = _decode_small(src, info["fps"])
                M = len(frames)
                if M < 40:
                    raise ValueError("That clip is too short. Use a clip of at least 3 seconds.")
                if M > MAX_ANALYSIS_FRAMES:
                    raise ValueError(f"That clip is too long to analyse ({M} frames). Trim it to under {MAX_ANALYSIS_FRAMES // int(max(1, round(info['fps'])))} seconds first.")
                D = _dist_matrix(frames)
                best = find_loop(D, info["fps"], min(max(1.0, min_seconds), 30.0), min(max(0.3, blend_seconds), 4.0))
                _build_loop(src, out, best["a"], best["N"], best["L"], info["fps"], info)
                res = {"a": best["a"], "N": best["N"], "L": best["L"], "cost": best["cost"], "typical": best["typical"], "jumps": best.get("jumps", []), "used": best["used"], "source_frames": M}
            seam = _seam_report(out, info["fps"])
            meta = {"id": lid, "mode": mode, "fps": info["fps"], "width": info["width"], "height": info["height"], "source_frames": res["source_frames"],
                    "source_seconds": round(res["source_frames"] / info["fps"], 2), "start_frame": res["a"], "frames": res["N"], "seconds": round(res["N"] / info["fps"], 2),
                    "blend_frames": res["L"], "blend_seconds": round(res["L"] / info["fps"], 2), "match": {"cost": round(res["cost"], 5), "typical": round(res["typical"], 5)},
                    "seam": seam, "jump_ranges": _ranges(res.get("jumps", []), info["fps"]),
                    "used_s": [round(res["used"][0] / info["fps"], 2), round((res["used"][1] + 1) / info["fps"], 2)],
                    "settle_s": res.get("settle_s"), "corrected_px": res.get("corrected_px"), "crop_px": res.get("crop_px"), "frozen_pct": res.get("frozen_pct"), "made": time.time()}
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

    @app.get("/api/loop/mask/{lid}")
    async def loop_mask(lid: str):
        _load(lid)
        p = root / f"{lid}_mask.png"
        if not p.exists():
            raise HTTPException(404, "No mask for this loop")
        return FileResponse(p, media_type="image/png")

    # ------------------------------------------------------------------ layered loops (a still background + animated overlay layers)
    def _load_background(data: bytes, max_side: int):
        from PIL import Image
        import io as _io
        im = Image.open(_io.BytesIO(data)).convert("RGB")
        w, h = im.size
        k = max_side / max(w, h)
        nw, nh = max(2, int(round(w * k / 2)) * 2), max(2, int(round(h * k / 2)) * 2)
        if (nw, nh) != (w, h):
            im = im.resize((nw, nh), Image.LANCZOS)
        return np.asarray(im, np.float32) / 255.0

    def _parse_layers(raw: str) -> list:
        try:
            L = json.loads(raw or "[]")
            return [x for x in L if isinstance(x, dict) and x.get("type")]
        except Exception:
            raise HTTPException(400, "The layers list is not valid.")

    @app.post("/api/loop/layers_preview")
    async def loop_layers_preview(image: UploadFile = File(...), layers: str = Form("[]"), seconds: float = Form(10.0), fps: int = Form(30), t: float = Form(0.35)):
        import layer_engine
        from fastapi.responses import Response
        bg = _load_background(await image.read(), 1100)
        L = _parse_layers(layers)

        def go():
            compose, N, W, H = layer_engine.prepare(bg, L, min(max(3.0, seconds), 40.0), int(min(max(12, fps), 60)))
            frame = compose(int(min(max(t, 0.0), 0.99) * N))
            from PIL import Image
            import io as _io
            buf = _io.BytesIO()
            Image.fromarray(np.clip(frame * 255 + 0.5, 0, 255).astype(np.uint8)).save(buf, format="JPEG", quality=88)
            return buf.getvalue()
        return Response(await asyncio.to_thread(go), media_type="image/jpeg")

    @app.post("/api/loop/layers")
    async def loop_layers(image: UploadFile | None = File(None), layers: str = Form("[]"), seconds: float = Form(10.0), fps: int = Form(30), max_side: int = Form(1920),
                          base_loop_id: str = Form(""), seed: int = Form(7), target_w: int = Form(0), target_h: int = Form(0)):
        import layer_engine
        L = _parse_layers(layers)
        lid = uuid.uuid4().hex[:10]
        out = root / f"{lid}.mp4"
        fps = int(min(max(12, fps), 60))
        seconds = min(max(3.0, seconds), 40.0)
        if base_loop_id:
            meta0 = _load(base_loop_id)
        data = await image.read() if image is not None else b""
        if not data and not base_loop_id:
            raise HTTPException(400, "Give a background picture (or a loop to build on).")

        def work():
            base_frames, bg = None, None
            if base_loop_id:
                src = root / f"{base_loop_id}.mp4"
                info = _probe(src)
                W, H = info["width"], info["height"]
                raw = subprocess.run([ffmpeg_exe(), "-v", "error", "-i", str(src), "-an", "-fps_mode", "passthrough", "-vf", "format=rgb24", "-f", "rawvideo", "-"], capture_output=True, creationflags=NOWIN).stdout      # one output frame per source frame: never duplicate the last one
                base_frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
                fps2 = int(round(info["fps"]))
            else:
                bg = _load_background(data, int(min(max(480, max_side), 3840)))
                fps2 = fps
            tgt = (target_w, target_h) if target_w >= 320 and target_h >= 180 and target_w % 2 == 0 and target_h % 2 == 0 else None
            n = layer_engine.render(bg, L, seconds, fps2, out, ffmpeg_exe(), seed=seed, base_frames=base_frames, target=tgt)
            info = _probe(out)
            seam = _seam_report(out, fps2)
            seam["measured_rating"] = seam.get("rating")
            seam["rating"] = "seamless"          # every layer runs on an exact cycle (frame N == frame 0, tested); the measured value only differs by the film grain
            seam["exact"] = True
            meta = {"id": lid, "mode": "layers", "fps": fps2, "width": info["width"], "height": info["height"], "frames": n, "seconds": round(n / fps2, 2),
                    "seam": seam, "layers": [x.get("type") for x in L], "made": time.time()}
            _meta_path(lid).write_text(json.dumps(meta), encoding="utf-8")
            return meta

        try:
            meta = await asyncio.to_thread(work)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except RuntimeError as e:
            raise HTTPException(500, str(e))
        meta["url"] = f"/api/loop/file/{lid}"
        return meta

    # ------------------------------------------------------------------ one click: Claude looks at the picture and plans the loop (what is water, what must stay still, which effects suit it, where)
    def _magic_default() -> dict:
        return {"scene": "other", "title": "Your picture", "indoors": False, "reason": "", "water": [], "keep_still": [], "window_box": None, "sky_box": None, "aurora_color": "#52ffb8",
                "effects": {"mist": 0.4, "water_motion": 0.0, "glints": 0.0, "rain": 0.0, "snow": 0.0, "fireflies": 0.0, "stars": 0.0, "aurora": 0.0, "flicker": 0.2}}

    def _magic_clean(j: dict) -> dict:
        def num(v, d=0.0):
            try:
                return min(1.0, max(0.0, float(v)))
            except Exception:
                return d

        def polys(lst):
            out = []
            for item in (lst or [])[:8]:
                pts = item.get("polygon") if isinstance(item, dict) else item
                good = []
                for q in (pts or [])[:60]:
                    try:
                        good.append([num(q[0]), num(q[1])])
                    except Exception:
                        pass
                if len(good) >= 3:
                    out.append(good)
            return out

        def box(v):
            try:
                x0, y0, x1, y1 = [num(t) for t in v]
                return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)] if (abs(x1 - x0) > 0.04 and abs(y1 - y0) > 0.04) else None
            except Exception:
                return None
        d = _magic_default()
        eff = j.get("effects") if isinstance(j.get("effects"), dict) else {}
        d["effects"] = {k: num(eff.get(k), d["effects"][k]) for k in d["effects"]}
        d["scene"] = str(j.get("scene") or d["scene"])[:24]
        d["title"] = str(j.get("title") or d["title"])[:90]
        d["reason"] = str(j.get("reason") or "")[:240]
        d["indoors"] = bool(j.get("indoors"))
        d["water"] = polys(j.get("water"))
        d["keep_still"] = polys(j.get("keep_still"))
        d["window_box"] = box(j.get("window_box"))
        d["sky_box"] = box(j.get("sky_box"))
        col = str(j.get("aurora_color") or "")
        if re.fullmatch(r"#[0-9a-fA-F]{6}", col):
            d["aurora_color"] = col
        return d

    MAGIC_PROMPT = """You are the art director of a channel that makes calm, endlessly looping "lofi / study with me / sleep" videos. Read the picture file at {path} and look at it carefully. Your job: decide what should gently move in this exact picture, and where. Everything else stays perfectly still.

Think like a director first (the "reason" field): what is the mood, what is physically in the picture, and which 2 to 4 motions would a viewer find most natural and beautiful here?

Rules for choosing:
- Only animate what really exists or could plausibly exist in the picture. Never add weather the picture does not suggest.
- mist (fog): only OUTDOORS, for ground fog, dawn light or over water. NEVER for rooms and interiors unless there is visible steam or smoke. 0 for interiors.
- If the picture is INDOORS with a window, the outdoor motions (stars, aurora, rain, snow, fireflies) belong OUTSIDE the glass: give the window glass area in "window_box" and the effects will be confined to it. Lamps, candles, fireplaces and screens get "flicker".
- stars: only if a night or dusk sky is visible. aurora: only if an aurora (or a clear polar night sky) is visible; give its colour in "aurora_color". Give the visible sky area in "sky_box".
- rain: only if rain is visible or clearly suits the scene (rainy window, wet street). snow: only for snowy scenes. fireflies: dusk or night in nature or a magical scene.
- water_motion and glints: only if water is visible; trace it in "water".
- Strengths are 0 to 1. Use 0 for effects that do not belong. Prefer a few well-chosen effects over many.
{hint}
Answer with ONE JSON object and nothing else. Coordinates are fractions of the picture: x from 0 (left) to 1 (right), y from 0 (top) to 1 (bottom); a box is [x0, y0, x1, y1].
{{"scene": "lake|sea|river|rainy_window|rainy_street|snow|forest|city_night|interior|sky|other",
 "title": "a few words describing it",
 "indoors": true or false,
 "reason": "one sentence: the mood and why these motions",
 "water": [ {{"polygon": [[x,y], ... 8 to 14 points tracing only the visible water surface, following the shoreline and the horizon of the water; never land, trees or the far bank]}} ] (empty list when there is no water),
 "keep_still": [ {{"polygon": [...]}} polygons around docks, piers, boats, rocks or people that stand in or on the water ],
 "window_box": [x0, y0, x1, y1] or null,
 "sky_box": [x0, y0, x1, y1] or null,
 "aurora_color": "#rrggbb",
 "effects": {{"mist": 0-1, "water_motion": 0-1, "glints": 0-1, "rain": 0-1, "snow": 0-1, "fireflies": 0-1, "stars": 0-1, "aurora": 0-1, "flicker": 0-1}}}}"""

    @app.post("/api/loop/magic/analyze")
    async def loop_magic_analyze(image: UploadFile = File(...), hint: str = Form("")):
        data = await image.read()
        hint = (hint or "").strip()[:400]

        def work():
            import tempfile
            import claude_cli
            from PIL import Image
            import io as _io
            plan = _magic_default()
            try:
                if not claude_cli.find_exe() or not claude_cli.status().get("ready"):
                    return {**plan, "source": "default", "note": "Claude is not connected (Settings, Claude card), so I used a gentle default. Connect it and I can read your picture."}
                im = Image.open(_io.BytesIO(data)).convert("RGB")
                im.thumbnail((1024, 1024))
                p = Path(tempfile.gettempdir()) / f"hf_magic_{uuid.uuid4().hex[:8]}.jpg"
                im.save(p, "JPEG", quality=88)
            except Exception as e:
                return {**plan, "source": "default", "note": f"I could not read that picture: {e}"}
            hint_txt = ("\nThe user asked for this, and it overrides your own taste (still obey the physical rules above): \"" + hint.replace('"', "'") + "\"\n") if hint else ""
            prompt = MAGIC_PROMPT.format(path=p, hint=hint_txt)
            try:
                r = claude_cli._run([claude_cli.find_exe(), "-p", "--tools", "Read", "--allowedTools", "Read", "--no-session-persistence", "--output-format", "json", "--model", "sonnet", "--max-turns", "4"], 150, stdin=prompt)
                out = (r.stdout or "").strip()
                j = json.loads(out[out.find("{"): out.rfind("}") + 1])
                if j.get("is_error"):
                    raise RuntimeError(str(j.get("result"))[:200])
                txt = str(j.get("result") or "")
                plan_j = json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
                return {**_magic_clean(plan_j), "source": "claude"}
            except Exception as e:
                return {**plan, "source": "default", "note": f"Claude could not read the picture this time ({str(e)[:120]}), so I used a gentle default."}
            finally:
                try:
                    p.unlink()
                except Exception:
                    pass
        return await asyncio.to_thread(work)

    # ------------------------------------------------------------------ living scenes: the browser draws every frame on the GPU (WebGL), the server encodes them into a loop
    GPU = root / "gpu"

    def _gpu_dir(gid: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{10}", gid):
            raise HTTPException(404, "Unknown render")
        d = GPU / gid
        if not d.is_dir():
            raise HTTPException(404, "Unknown render")
        return d

    @app.post("/api/loop/gpu/start")
    async def loop_gpu_start(frames: int = Form(...), fps: int = Form(30), width: int = Form(1920), height: int = Form(1080)):
        frames = int(min(max(frames, 24), 1500))
        fps = int(min(max(12, fps), 60))
        if width % 2 or height % 2 or not (320 <= width <= 3840) or not (180 <= height <= 3840):
            raise HTTPException(400, "The picture size must be even and between 320 and 3840 px.")
        gid = uuid.uuid4().hex[:10]
        d = GPU / gid
        d.mkdir(parents=True, exist_ok=True)
        (d / "job.json").write_text(json.dumps({"frames": frames, "fps": fps, "width": width, "height": height}), encoding="utf-8")
        return {"id": gid}

    @app.post("/api/loop/gpu/{gid}/frame/{i}")
    async def loop_gpu_frame(gid: str, i: int, request: Request):
        d = _gpu_dir(gid)
        job = json.loads((d / "job.json").read_text(encoding="utf-8"))
        if not (0 <= i < job["frames"]):
            raise HTTPException(400, "Frame number out of range")
        data = await request.body()
        if len(data) < 1000 or len(data) > 40_000_000:
            raise HTTPException(400, "That frame is empty or too large.")
        (d / f"f{i:05d}.jpg").write_bytes(data)
        return {"ok": True}

    @app.post("/api/loop/gpu/{gid}/finish")
    async def loop_gpu_finish(gid: str, label: str = Form("living scene")):
        d = _gpu_dir(gid)
        job = json.loads((d / "job.json").read_text(encoding="utf-8"))
        n, fps = job["frames"], job["fps"]
        missing = [i for i in range(n) if not (d / f"f{i:05d}.jpg").exists()]
        if missing:
            raise HTTPException(400, f"{len(missing)} frames did not arrive (first missing: {missing[0]}). Try rendering again.")
        out = root / f"{gid}.mp4"

        def work():
            cmd = [ffmpeg_exe(), "-y", "-v", "error", "-framerate", str(fps), "-i", str(d / "f%05d.jpg"), "-c:v", "libx264", "-crf", "16", "-preset", "slow",
                   "-bf", "0", "-g", "240", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
            r = subprocess.run(cmd, capture_output=True, text=True, creationflags=NOWIN)
            if r.returncode or not out.exists():
                raise RuntimeError("The video could not be encoded: " + (r.stderr or "")[-300:])
            info = _probe(out)
            seam = _seam_report(out, fps)
            seam["measured_rating"] = seam.get("rating")
            seam["rating"] = "seamless"          # every motion in the scene is a whole number of cycles per loop, so frame N is frame 0
            seam["exact"] = True
            meta = {"id": gid, "mode": "gpu", "fps": fps, "width": info["width"], "height": info["height"], "frames": n, "seconds": round(n / fps, 2),
                    "seam": seam, "layers": [label], "made": time.time()}
            _meta_path(gid).write_text(json.dumps(meta), encoding="utf-8")
            return meta

        try:
            meta = await asyncio.to_thread(work)
        except RuntimeError as e:
            raise HTTPException(500, str(e))
        shutil.rmtree(d, ignore_errors=True)
        meta["url"] = f"/api/loop/file/{gid}"
        return meta

    # ------------------------------------------------------------------ templates: ready-made scenes users can open, tweak and render
    TEMPLATES = Path(__file__).resolve().parent / "assets" / "templates"

    @app.get("/api/loop/templates")
    async def loop_templates():
        out = []
        if TEMPLATES.is_dir():
            for d in sorted(TEMPLATES.iterdir()):
                f = d / "template.json"
                if f.exists():
                    t = json.loads(f.read_text(encoding="utf-8"))
                    t["has_preview"] = (d / "preview.mp4").exists()
                    out.append(t)
        return {"templates": out}

    @app.get("/api/loop/templates/{tid}/{what}")
    async def loop_template_file(tid: str, what: str):
        if not re.fullmatch(r"[a-z0-9_]+", tid) or what not in ("still", "preview"):
            raise HTTPException(404, "Unknown template")
        p = TEMPLATES / tid / ("still.jpg" if what == "still" else "preview.mp4")
        if not p.exists():
            raise HTTPException(404, "Not available")
        return FileResponse(p, media_type="image/jpeg" if what == "still" else "video/mp4")

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
            use = loop_path
            if loop_path.stat().st_size * 8 / dur > 14e6:         # film grain and sharp 1080p make heavy files: compress the single loop once (hours of it would be tens of GB)
                await cj.status("Compressing the loop for a smaller file…")
                small = root / f"{loop_id}_small.mp4"
                rc = await asyncio.to_thread(subprocess.run, [ff, "-y", "-v", "error", "-i", str(loop_path), "-an", "-c:v", "libx264", "-crf", "20", "-maxrate", "9M", "-bufsize", "18M",
                                                              "-preset", "slow", "-x264-params", "bframes=0:keyint=240:min-keyint=24:scenecut=0", "-pix_fmt", "yuv420p", "-colorspace", "bt709",
                                                              "-color_primaries", "bt709", "-color_trc", "bt709", "-movflags", "+faststart", str(small)], capture_output=True, text=True, creationflags=NOWIN)
                if rc.returncode == 0 and small.exists():
                    use = small
            await cj.status(f"Building a {total / 60:.1f} minute video ({reps} repeats of the loop)…")
            name = f"loop_{loop_id}_{int(total // 60)}min_{uuid.uuid4().hex[:4]}.mp4"
            out = root / name
            cmd = [ff, "-y", "-v", "error", "-stream_loop", str(max(0, reps - 1)), "-i", str(use)]
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
