"""
Studio utility routes — the "finishing" half of a Higgsfield-style toolbox,
all local:

  ComfyUI-graph jobs (progress over /api/events/{job_id}, result via /api/video):
    POST /api/tools/upscale      Real-ESRGAN image / video upscale (2x or 4x)
    POST /api/tools/interpolate  RIFE 4.9 frame interpolation: smooth fps or slow-motion
    POST /api/tools/remove_bg    BiRefNet background removal: alpha PNG, or video on a solid colour

  Direct ffmpeg ops (bytes returned immediately):
    POST /api/tools/ffmpeg       reverse / speed / boomerang / loop / trim / reframe /
                                 first_frame / last_frame / mute / gif
    GET  /api/tools/models       which tool models are installed

Videos are handed to ComfyUI by absolute path (VHS_LoadVideoPath), so the
backend and ComfyUI must share a filesystem (they do — same machine) and
COMFY_ROOT must point at the ComfyUI folder (default D:\\ComfyUI-LTX2).
"""

import asyncio
import json
import math
import os
import re
import subprocess
import time
import uuid
from pathlib import Path

import httpx
from fastapi import File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from audio_analysis import ffmpeg_exe


def register(app, m):
    root = Path(os.getenv("COMFY_ROOT", r"D:\ComfyUI-LTX2"))

    def _stage_dir() -> Path:
        d = root / "input" / "vsa_tools"
        d.mkdir(parents=True, exist_ok=True)
        # staged uploads are throw-away: prune anything older than a day
        cutoff = time.time() - 86400
        for f in d.iterdir():
            try:
                if f.is_file() and f.stat().st_mtime < cutoff:
                    f.unlink()
            except OSError:
                pass
        return d

    async def _stage(up: UploadFile, default_ext: str) -> Path:
        data = await up.read()
        if not data:
            raise HTTPException(400, "Empty upload")
        ext = Path(up.filename or "").suffix.lower() or default_ext
        p = _stage_dir() / f"{uuid.uuid4().hex[:10]}{ext}"
        p.write_bytes(data)
        return p

    def _probe(path: Path) -> dict:
        """fps / size / duration / has_audio via `ffmpeg -i` (no ffprobe bundled)."""
        r = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, text=True)
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

    def _is_video(up: UploadFile) -> bool:
        ct = (up.content_type or "").lower()
        ext = Path(up.filename or "").suffix.lower()
        return ct.startswith("video") or ext in {".mp4", ".webm", ".mov", ".mkv", ".gif", ".avi"}

    async def _choices(node: str, field: str) -> list[str]:
        async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
            r = await client.get(f"{m.COMFY_URL}/object_info/{node}")
            try:
                v = r.json()[node]["input"]["required"][field]
                opts = v[1].get("options") if len(v) > 1 and isinstance(v[1], dict) and "options" in v[1] else v[0]
                return list(opts) if isinstance(opts, list) else []
            except Exception:
                return []

    async def _submit(graph: dict) -> dict:
        job_id = uuid.uuid4().hex[:12]
        if m.MOCK:
            m._new_job(job_id)
            asyncio.get_event_loop().create_task(m._mock_run(job_id, [b""], 1, is_video=False))
            return {"job_id": job_id, "prompt_id": "mock", "seed": 0}
        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            pid = await m._submit(client, json.dumps(graph), job_id)
        return {"job_id": job_id, "prompt_id": pid, "seed": 0}

    def _combine(images_ref, fps: float, prefix: str, audio_ref=None) -> dict:
        n = {
            "class_type": "VHS_VideoCombine",
            "inputs": {"images": images_ref, "frame_rate": fps, "loop_count": 0, "filename_prefix": prefix,
                       "format": "video/h264-mp4", "pix_fmt": "yuv420p", "crf": 18, "save_metadata": True,
                       "pingpong": False, "save_output": True},
        }
        if audio_ref:
            n["inputs"]["audio"] = audio_ref
        return n

    def _load_video(path: Path) -> dict:
        return {"class_type": "VHS_LoadVideoPath",
                "inputs": {"video": str(path), "force_rate": 0, "custom_width": 0, "custom_height": 0,
                           "frame_load_cap": 0, "skip_first_frames": 0, "select_every_nth": 1}}


    UPSCALE_CHUNK = int(os.getenv("UPSCALE_CHUNK_FRAMES", "48"))      # frames per ComfyUI run; longer clips are split, upscaled in turn and joined

    def _chunked_upscale(path: Path, info: dict, nframes: int, model: str, scale: float) -> dict:
        """A long clip upscaled in short parts behind ONE job: each part's frames fit in memory, so the whole thing can no longer be
        stopped by the memory guard (a 7 s clip held ~9 GB of float frames at once). Parts are cut frame-exactly and joined losslessly."""
        n = math.ceil(nframes / UPSCALE_CHUNK)
        per = math.ceil(nframes / n)
        cj = m.CompositeJob("video-upscale", f"Upscale {scale:g}x · {n} parts", steps=n + 1)

        async def work(cj):
            ff = ffmpeg_exe()
            d = _stage_dir()
            parts = []
            for i in range(n):
                a, b = i * per, min(nframes, (i + 1) * per) - 1
                piece = d / f"{cj.id}_src{i}.mp4"
                r = await asyncio.to_thread(subprocess.run, [ff, "-y", "-v", "error", "-i", str(path), "-vf", f"select='between(n,{a},{b})',setpts=N/FRAME_RATE/TB,tpad=stop_mode=clone:stop=2",
                                                              "-an", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", str(piece)], capture_output=True, text=True)
                if r.returncode or not piece.exists():
                    raise RuntimeError("Could not cut the clip into parts: " + (r.stderr or "")[-200:])
                g = {"1": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": model}}, "2": _load_video(piece)}
                g["3"] = {"class_type": "ImageUpscaleWithModelBatched",
                          "inputs": {"upscale_model": ["1", 0], "images": ["2", 0], "per_batch": 1, "downscale_ratio": max(0.05, min(1.0, scale / 4.0)),
                                     "downscale_method": "lanczos", "precision": "float16"}}
                g["5"] = _combine(["3", 0], info["fps"], "vsa/tools/upscaled_part", None)
                data = await cj.run_graph(g, f"Upscaling part {i + 1} of {n}")
                out = d / f"{cj.id}_up{i}.mp4"
                out.write_bytes(data)
                trim = d / f"{cj.id}_t{i}.mp4"      # keep exactly this part's frames (no spare ones), without re-encoding
                rr = await asyncio.to_thread(subprocess.run, [ff, "-y", "-v", "error", "-i", str(out), "-frames:v", str(b - a + 1), "-c", "copy", "-an", str(trim)], capture_output=True, text=True)
                if rr.returncode or not trim.exists():
                    raise RuntimeError("Could not trim an upscaled part: " + (rr.stderr or "")[-200:])
                try:
                    out.unlink()
                except OSError:
                    pass
                parts.append(trim)
                try:
                    piece.unlink()
                except OSError:
                    pass
                await cj.step_done()
            await cj.status("Joining the parts…")
            lst = d / f"{cj.id}_list.txt"
            lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
            joined = m.WORK_DIR / f"upscaled_{cj.id}.mp4"
            cmd = [ff, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst)]
            if info["audio"]:
                cmd += ["-i", str(path), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-t", f"{nframes / info['fps']:.3f}"]
            else:
                cmd += ["-c", "copy"]
            r = await asyncio.to_thread(subprocess.run, cmd + [str(joined)], capture_output=True, text=True)
            for p in parts + [lst]:
                try:
                    p.unlink()
                except OSError:
                    pass
            if r.returncode or not joined.exists():
                raise RuntimeError("Could not join the upscaled parts: " + (r.stderr or "")[-200:])
            cj.finish(joined)

        cj.start(work)
        return {"job_id": cj.id, "prompt_id": "composite", "seed": 0}

    # ------------------------------------------------------------ models

    @app.get("/api/tools/models")
    async def tool_models():
        if m.MOCK:
            return {"upscalers": ["mock"], "bg_models": ["mock"], "rife": True}
        return {
            "upscalers": await _choices("UpscaleModelLoader", "model_name"),
            "bg_models": await _choices("LoadBackgroundRemovalModel", "bg_removal_name"),
            "rife": bool(await _choices("RIFE VFI", "ckpt_name")),
            "rtx": await _has_node("RTXVideoSuperResolution"),
        }

    async def _has_node(node: str) -> bool:
        try:
            async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
                r = await client.get(f"{m.COMFY_URL}/object_info/{node}")
                return node in r.json()
        except Exception:
            return False

    @app.get("/api/mcp/info")
    async def mcp_info():
        """Exact command that registers this studio's MCP server with Claude Code / any MCP client."""
        import sys
        script = str(Path(__file__).with_name("mcp_server.py"))
        tools = []
        try:
            import importlib
            ms = importlib.import_module("mcp_server")
            tools = [{"name": n, "description": d} for n, (_, d, _p, _r) in ms.TOOLS.items()]
        except Exception:
            pass
        return {"python": sys.executable, "script": script,
                "claude_code": f'claude mcp add hoodsfield -- "{sys.executable}" "{script}"',
                "json": {"mcpServers": {"hoodsfield": {"command": sys.executable, "args": [script]}}}, "tools": tools}

    # ------------------------------------------------------------ upscale

    @app.post("/api/tools/upscale")
    async def tool_upscale(
        file: UploadFile = File(...),
        model: str = Form(""),
        scale: float = Form(2.0),
    ):
        """Real-ESRGAN (x4 native) then Lanczos to the requested 1.5x–4x factor."""
        models = await _choices("UpscaleModelLoader", "model_name")
        if not models:
            raise HTTPException(502, "No upscale models installed (models/upscale_models)")
        model = model if model in models else next((x for x in models if "x4plus.pth" in x), models[0])
        video = _is_video(file)
        path = await _stage(file, ".mp4" if video else ".png")
        g: dict = {"1": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": model}}}
        if video:
            info = _probe(path)
            nframes = int(round(info["duration"] * info["fps"]))
            if nframes > UPSCALE_CHUNK * 1.25:
                return _chunked_upscale(path, info, nframes, model, scale)
            g["2"] = _load_video(path)
            # fp16 + the node's own per-batch downscale (x4 model -> requested factor) keeps
            # peak memory to one frame instead of a full 4x clip
            g["3"] = {"class_type": "ImageUpscaleWithModelBatched",
                      "inputs": {"upscale_model": ["1", 0], "images": ["2", 0], "per_batch": 1,
                                 "downscale_ratio": max(0.05, min(1.0, scale / 4.0)),
                                 "downscale_method": "lanczos", "precision": "float16"}}
            src = ["3", 0]
            g["5"] = _combine(src, info["fps"], "vsa/tools/upscaled", ["2", 2] if info["audio"] else None)
        else:
            g["2"] = {"class_type": "LoadImage", "inputs": {"image": f"vsa_tools/{path.name}"}}
            g["3"] = {"class_type": "ImageUpscaleWithModel", "inputs": {"upscale_model": ["1", 0], "image": ["2", 0]}}
            src = ["3", 0]
            if abs(scale - 4.0) > 0.01:
                g["4"] = {"class_type": "ImageScaleBy",
                          "inputs": {"image": src, "upscale_method": "lanczos", "scale_by": scale / 4.0}}
                src = ["4", 0]
            g["5"] = {"class_type": "SaveImage", "inputs": {"images": src, "filename_prefix": "vsa/tools/upscaled"}}
        return await _submit(g)

    # ------------------------------------------------------------ RTX Video Super Resolution

    @app.post("/api/tools/rtx_upscale")
    async def tool_rtx_upscale(
        file: UploadFile = File(...),
        scale: float = Form(2.0),
        quality: str = Form("ULTRA"),
    ):
        """NVIDIA RTX Video Super Resolution (Comfy-Org Nvidia VFX nodes): fast 1x-4x enlarge + sharpen for images and video.
        It sharpens and cleans what is there; it does not invent new detail like a re-render would."""
        if not m.MOCK and not await _has_node("RTXVideoSuperResolution"):
            raise HTTPException(502, "RTX Video Super Resolution nodes are not installed in ComfyUI (custom_nodes/comfyui_nvidia_rtx_nodes)")
        quality = quality.upper() if quality.upper() in ("LOW", "MEDIUM", "HIGH", "ULTRA") else "ULTRA"
        scale = max(1.0, min(4.0, scale))
        video = _is_video(file)
        path = await _stage(file, ".mp4" if video else ".png")
        rtx = lambda images: {"class_type": "RTXVideoSuperResolution",
                              "inputs": {"images": images, "resize_type": "scale by multiplier", "resize_type.scale": scale, "quality": quality}}
        if video:
            info = _probe(path)
            g = {"2": _load_video(path), "3": rtx(["2", 0])}
            g["5"] = _combine(["3", 0], info["fps"], "vsa/tools/rtx", ["2", 2] if info["audio"] else None)
        else:
            g = {"2": {"class_type": "LoadImage", "inputs": {"image": f"vsa_tools/{path.name}"}}, "3": rtx(["2", 0]),
                 "5": {"class_type": "SaveImage", "inputs": {"images": ["3", 0], "filename_prefix": "vsa/tools/rtx"}}}
        return await _submit(g)

    # ------------------------------------------------------------ finalize (draft -> final)

    @app.post("/api/tools/finalize")
    async def tool_finalize(
        file: UploadFile = File(...),
        scale: float = Form(2.0),
        smooth: int = Form(1),            # RIFE multiplier after the upscale (1 = off)
        model: str = Form(""),
    ):
        """Turn an approved draft into a deliverable in ONE ComfyUI job: Real-ESRGAN upscale, then
        optional RIFE frame interpolation, original audio kept. One graph = no extra model swaps."""
        models = await _choices("UpscaleModelLoader", "model_name")
        if not models:
            raise HTTPException(502, "No upscale models installed (models/upscale_models)")
        model = model if model in models else next((x for x in models if "x4plus.pth" in x), models[0])
        path = await _stage(file, ".mp4")
        info = _probe(path)
        g = {
            "1": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": model}},
            "2": _load_video(path),
            "3": {"class_type": "ImageUpscaleWithModelBatched",
                  "inputs": {"upscale_model": ["1", 0], "images": ["2", 0], "per_batch": 1,
                             "downscale_ratio": max(0.05, min(1.0, scale / 4.0)), "downscale_method": "lanczos", "precision": "float16"}},
        }
        frames, fps = ["3", 0], info["fps"]
        if smooth and smooth > 1:
            g["4"] = {"class_type": "RIFE VFI",
                      "inputs": {"ckpt_name": "rife49.pth", "frames": frames, "clear_cache_after_n_frames": 10,
                                 "multiplier": int(smooth), "fast_mode": True, "ensemble": True, "scale_factor": 1.0}}
            frames, fps = ["4", 0], info["fps"] * int(smooth)
        g["5"] = _combine(frames, fps, "vsa/tools/final", ["2", 2] if info["audio"] else None)
        return await _submit(g)

    # ------------------------------------------------------------ interpolate

    @app.post("/api/tools/interpolate")
    async def tool_interpolate(
        file: UploadFile = File(...),
        multiplier: int = Form(2),
        mode: str = Form("smooth"),   # smooth = higher fps, same length | slowmo = same fps, longer
    ):
        if not await _choices("RIFE VFI", "ckpt_name"):
            raise HTTPException(502, "RIFE VFI node not available in ComfyUI")
        multiplier = max(2, min(8, multiplier))
        path = await _stage(file, ".mp4")
        info = _probe(path)
        slow = mode == "slowmo"
        g = {
            "1": _load_video(path),
            "2": {"class_type": "RIFE VFI",
                  "inputs": {"ckpt_name": "rife49.pth", "frames": ["1", 0], "clear_cache_after_n_frames": 10,
                             "multiplier": multiplier, "fast_mode": True, "ensemble": True, "scale_factor": 1.0}},
            "3": _combine(["2", 0], info["fps"] if slow else info["fps"] * multiplier, "vsa/tools/interp",
                          ["1", 2] if (info["audio"] and not slow) else None),
        }
        return await _submit(g)

    # ------------------------------------------------------------ remove background

    _BG_COLORS = {"green": 0x00B140, "blue": 0x0047BB, "white": 0xFFFFFF, "black": 0x000000, "grey": 0x808080}

    @app.post("/api/tools/remove_bg")
    async def tool_remove_bg(
        file: UploadFile = File(...),
        model: str = Form(""),
        background: str = Form("alpha"),   # alpha (images only) | green | blue | white | black | grey
    ):
        models = await _choices("LoadBackgroundRemovalModel", "bg_removal_name")
        if not models:
            raise HTTPException(502, "No background-removal model installed (models/background_removal)")
        model = model if model in models else models[0]
        video = _is_video(file)
        path = await _stage(file, ".mp4" if video else ".png")
        g: dict = {"1": {"class_type": "LoadBackgroundRemovalModel", "inputs": {"bg_removal_name": model}}}
        if video:
            info = _probe(path)
            g["2"] = _load_video(path)
            g["3"] = {"class_type": "RemoveBackground", "inputs": {"bg_removal_model": ["1", 0], "image": ["2", 0]}}
            color = _BG_COLORS.get(background, _BG_COLORS["green"])
            g["4"] = {"class_type": "EmptyImage",
                      "inputs": {"width": info["width"] or 768, "height": info["height"] or 768,
                                 "batch_size": 1, "color": color}}
            # destination = the video frames (keeps the batch length); paint the solid
            # colour onto them through the *inverted* subject mask
            g["5"] = {"class_type": "InvertMask", "inputs": {"mask": ["3", 0]}}
            g["6"] = {"class_type": "ImageCompositeMasked",
                      "inputs": {"destination": ["2", 0], "source": ["4", 0], "x": 0, "y": 0,
                                 "resize_source": False, "mask": ["5", 0]}}
            g["7"] = _combine(["6", 0], info["fps"], "vsa/tools/nobg", ["2", 2] if info["audio"] else None)
        else:
            g["2"] = {"class_type": "LoadImage", "inputs": {"image": f"vsa_tools/{path.name}"}}
            g["3"] = {"class_type": "RemoveBackground", "inputs": {"bg_removal_model": ["1", 0], "image": ["2", 0]}}
            if background == "alpha":
                # RemoveBackground yields foreground=1; JoinImageWithAlpha expects a
                # "transparent where 1" mask, so invert first
                g["4"] = {"class_type": "InvertMask", "inputs": {"mask": ["3", 0]}}
                g["5"] = {"class_type": "JoinImageWithAlpha", "inputs": {"image": ["2", 0], "alpha": ["4", 0]}}
                g["6"] = {"class_type": "SaveImage", "inputs": {"images": ["5", 0], "filename_prefix": "vsa/tools/cutout"}}
            else:
                # sizes unknown up-front for stills: composite on a flat colour via a solid-image resize of the source
                color = _BG_COLORS.get(background, _BG_COLORS["green"])
                g["4"] = {"class_type": "EmptyImage",
                          "inputs": {"width": 64, "height": 64, "batch_size": 1, "color": color}}
                g["5"] = {"class_type": "ImageScale",
                          "inputs": {"image": ["4", 0], "upscale_method": "nearest-exact",
                                     "width": 0, "height": 0, "crop": "disabled"}}
                g["6"] = {"class_type": "GetImageSize", "inputs": {"image": ["2", 0]}}
                g["5"]["inputs"]["width"] = ["6", 0]
                g["5"]["inputs"]["height"] = ["6", 1]
                g["7"] = {"class_type": "ImageCompositeMasked",
                          "inputs": {"destination": ["5", 0], "source": ["2", 0], "x": 0, "y": 0,
                                     "resize_source": False, "mask": ["3", 0]}}
                g["8"] = {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": "vsa/tools/nobg"}}
        return await _submit(g)

    # ------------------------------------------------------------ face swap (video or image)

    @app.post("/api/tools/face_swap")
    async def tool_face_swap(
        file: UploadFile = File(...),          # target video or image
        face: UploadFile = File(...),          # source face photo
        face_index: int = Form(0),             # which face in the target (left→right)
        swap_model: str = Form("inswapper_128.onnx"),
        face_restore_model: str = Form("none"),
    ):
        """ReActor swap of one source face onto every frame of a video (or a still).
        `face_index` counts faces left→right (ReActor's default size ordering is
        unstable between frames, so the order is pinned to left-right)."""
        if not await _choices("ReActorFaceSwapOpt", "swap_model"):
            raise HTTPException(502, "ReActor is not available in ComfyUI")
        video = _is_video(file)
        path = await _stage(file, ".mp4" if video else ".png")
        fpath = await _stage(face, ".png")
        g: dict = {
            "10": {"class_type": "LoadImage", "inputs": {"image": f"vsa_tools/{fpath.name}"}},
            "11": {"class_type": "ReActorOptions",
                   "inputs": {"input_faces_order": "left-right", "input_faces_index": str(face_index),
                              "detect_gender_input": "no", "source_faces_order": "left-right",
                              "source_faces_index": "0", "detect_gender_source": "no",
                              "console_log_level": 1, "restore_swapped_only": True}},
        }
        if video:
            info = _probe(path)
            g["1"] = _load_video(path)
            src_ref = ["1", 0]
        else:
            g["1"] = {"class_type": "LoadImage", "inputs": {"image": f"vsa_tools/{path.name}"}}
            src_ref = ["1", 0]
        g["2"] = {"class_type": "ReActorFaceSwapOpt",
                  "inputs": {"enabled": True, "input_image": src_ref, "source_image": ["10", 0], "options": ["11", 0],
                             "swap_model": swap_model, "facedetection": "retinaface_resnet50",
                             "face_restore_model": face_restore_model, "face_restore_visibility": 1,
                             "codeformer_weight": 0.5}}
        if video:
            g["3"] = _combine(["2", 0], info["fps"], "vsa/tools/faceswap", ["1", 2] if info["audio"] else None)
        else:
            g["3"] = {"class_type": "SaveImage", "inputs": {"images": ["2", 0], "filename_prefix": "vsa/tools/faceswap"}}
        return await _submit(g)

    # ------------------------------------------------------------ ffmpeg ops

    def _atempo(f: float) -> str:
        parts = []
        while f > 2.0:
            parts.append("atempo=2.0"); f /= 2.0
        while f < 0.5:
            parts.append("atempo=0.5"); f /= 0.5
        parts.append(f"atempo={f:.4f}")
        return ",".join(parts)

    @app.post("/api/tools/score")
    async def tool_score(prompt: str = Form(...), seconds: float = Form(30.0), seed: int = Form(7)):
        """Generate a soundtrack bed locally (Stable Audio Open), looped with crossfades to `seconds`. Returns a WAV."""
        import numpy as np
        import sounddesign as sd
        out_len = max(5.0, min(300.0, seconds))
        try:
            a = await sd.ai_ambience(m.COMFY_URL, prompt, min(46.0, out_len), seed, negative="vocals, speech, singing, bright cheerful music, drums, distortion")
        except Exception as e:
            raise HTTPException(502, f"Soundtrack generation failed (is ComfyUI running and the Stable Audio model installed?): {str(e)[:160]}")
        a = sd.loop_xfade(a.astype(np.float32), int(out_len * sd.SR), 2.0)
        a = a / (np.abs(a).max() + 1e-9) * 0.9
        out = _stage_dir() / f"score_{uuid.uuid4().hex[:8]}.wav"
        sd.write_wav(str(out), np.stack([a, np.roll(a, 700)], axis=1))
        try:
            return Response(content=out.read_bytes(), media_type="audio/wav")
        finally:
            out.unlink(missing_ok=True)

    @app.post("/api/tools/sound")
    async def tool_sound(
        file: UploadFile = File(...),
        ambience: str = Form("forest night (AI)"),   # none | wind | room tone | house at night | hospital hum | forest night (AI) | city night (AI) | lake night (AI) | basement (AI)
        unease: str = Form("medium"),                # none | low | medium | high | rising
        bumps: str = Form("on"),                     # mic bumps + rustle on the camera's real jolts
        footsteps: str = Form("none"),               # none | leaves | floorboards | gravel
        pace: str = Form("walk"),                    # walk | run
        breathing: str = Form("none"),               # none | calm | scared | panicked
        scare: float = Form(-1.0),                   # jump scare at this many seconds (-1 = none)
        keep_original: str = Form("on"),
        cheap_mic: str = Form("on"),
        seed: int = Form(7),
        flaws: str = Form("off"),                    # mic mishaps: off | some | a lot (covered mic, scrapes, wind buffeting, overload)
        crowd_files: list[UploadFile] = File([]),    # extra voice recordings to layer in (other people talking / shouting)
        crowd_starts: str = Form(""),                # comma-separated start seconds, one per crowd file
        crowd_gains: str = Form(""),                 # comma-separated gain in dB, one per crowd file
        ambience_fade: str = Form(""),               # "t0:t1" the ambience bed fades away between these seconds and stays gone (the engine dies)
    ):
        import numpy as np
        import sounddesign as sd
        src = await _stage(file, ".mp4")
        ff = ffmpeg_exe()
        wav = src.with_name(src.stem + "_mix.wav")
        out = src.with_name(src.stem + "_sound.mp4")
        try:
            info = sd.probe(ff, str(src))
            dur = max(0.5, info["duration"])
            events = await asyncio.to_thread(sd.motion_events, ff, str(src), dur) if bumps != "off" else []
            orig = await asyncio.to_thread(sd.decode_audio, ff, str(src), dur)
            amb = ambience.replace(" (AI)", "")
            ai_bed = None
            note = ""
            if ambience.endswith("(AI)") and amb in sd.AI_AMBIENCE:
                try:
                    ai_bed = await sd.ai_ambience(m.COMFY_URL, sd.AI_AMBIENCE[amb], dur + 1.5, seed)
                except Exception as e:      # ComfyUI busy / down: fall back to a synthesised wind bed
                    note = f"AI ambience unavailable ({str(e)[:80]}); used wind instead"
                    amb = "wind"
            crowd = []
            starts = [float(x) for x in crowd_starts.split(",") if x.strip()]
            gains = [float(x) for x in crowd_gains.split(",") if x.strip()]
            for i, cf in enumerate(crowd_files):
                cp = await _stage(cf, ".mp4")
                try:
                    cdur = max(0.3, sd.probe(ff, str(cp))["duration"])
                    crowd.append((await asyncio.to_thread(sd.decode_audio, ff, str(cp), cdur), starts[i] if i < len(starts) else 0.0, gains[i] if i < len(gains) else -6.0))
                finally:
                    cp.unlink(missing_ok=True)
            mix = await asyncio.to_thread(
                sd.design, dur, events, orig, ambience=("none" if ai_bed is not None else amb), ai_bed=ai_bed, unease=unease, bumps=bumps != "off",
                footsteps=footsteps, pace=pace, breathing=breathing, scare=scare, keep_original=keep_original != "off", seed=seed,
                flaws={"some": 0.45, "a lot": 0.9}.get(flaws, 0.0), crowd=crowd,
                bed_fade=tuple(float(v) for v in ambience_fade.split(":")) if ambience_fade.count(":") == 1 else None)
            await asyncio.to_thread(sd.write_wav, str(wav), mix)
            cmd = [ff, "-y", "-i", str(src), "-i", str(wav), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
                   *(["-af", sd.CHEAP_MIC] if cheap_mic != "off" else []), "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", str(out)]
            r = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True)
            if r.returncode != 0 or not out.exists():
                raise HTTPException(500, f"ffmpeg failed: {r.stderr[-400:]}")
            return Response(content=out.read_bytes(), media_type="video/mp4", headers={"X-Sound-Events": str(len(events)), "X-Sound-Note": note})
        finally:
            for p_ in (src, wav, out):
                try:
                    p_.unlink()
                except OSError:
                    pass

    @app.post("/api/tools/ffmpeg")
    async def tool_ffmpeg(
        file: UploadFile = File(...),
        aux: UploadFile | None = File(None),   # second input (mux_audio: the file whose audio to keep)
        op: str = Form(...),
        factor: float = Form(2.0),       # speed
        start: float = Form(0.0),        # trim
        end: float = Form(0.0),          # trim (0 = to end)
        loops: int = Form(2),            # loop
        aspect: str = Form("9:16"),      # reframe
        fit: str = Form("blur"),         # reframe: blur | crop | black
        preset: str = Form("camcorder"),  # footage: camcorder | vhs | cctv | nightvision | bodycam | doorbell | phone
        shake: str = Form("medium"),      # footage: none | light | medium | heavy | blair witch
        focus: str = Form("some"),        # footage: off | some | a lot
        grain: str = Form("medium"),      # footage: low | medium | high
        wear: str = Form("medium"),       # footage: light | medium | heavy (resolution + compression)
        glitches: str = Form("few"),      # footage: none | few | many
        overlay: str = Form("on"),        # footage: camera overlay (REC, timecode, date) on | off
        audio: str = Form("degrade"),     # footage: degrade | ambience | keep | none
        seed: int = Form(7),
        cam_name: str = Form("CAM 03"),
        shake_env: str = Form(""),       # footage: chaos envelope "t:level,t:level,..." (level 0..1 of the shake setting)
    ):
        src = await _stage(file, ".mp4")
        info = _probe(src)
        out = src.with_name(src.stem + "_out.mp4")
        ff = ffmpeg_exe()
        has_a = info["audio"]
        enc = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", "-movflags", "+faststart"]
        media = "video/mp4"
        if op == "reverse":
            cmd = [ff, "-y", "-i", str(src), "-vf", "reverse", *(["-af", "areverse"] if has_a else ["-an"]), *enc, str(out)]
        elif op == "speed":
            f = max(0.1, min(16.0, factor))
            cmd = [ff, "-y", "-i", str(src), "-vf", f"setpts=PTS/{f}",
                   *(["-af", _atempo(f)] if has_a else ["-an"]), *enc, str(out)]
        elif op == "boomerang":
            fc = "[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[v]"
            cmd = [ff, "-y", "-i", str(src), "-filter_complex", fc, "-map", "[v]", "-an", *enc, str(out)]
        elif op == "loop":
            n = max(2, min(20, loops))
            cmd = [ff, "-y", "-stream_loop", str(n - 1), "-i", str(src), *enc, str(out)]
        elif op == "trim":
            cmd = [ff, "-y", "-i", str(src), "-ss", str(max(0, start)), *(["-to", str(end)] if end > start else []),
                   *enc, *(["-c:a", "aac"] if has_a else ["-an"]), str(out)]
        elif op == "footage":
            import footage as ft
            lv = lambda table, key, default: table.get(key, table.get(default))
            g = ft.build(
                preset, info["width"] or 1280, info["height"] or 720, info["fps"], max(0.5, info["duration"]),
                shake=lv(ft.SHAKE_LEVELS, shake, "medium"), focus=lv({"off": 0.0, "some": 0.3, "a lot": 0.75}, focus, "some"),
                grain=lv({"low": 0.2, "medium": 0.5, "high": 0.9}, grain, "medium"), wear=lv({"light": 0.2, "medium": 0.5, "heavy": 0.9}, wear, "medium"),
                glitch=lv({"none": 0.0, "few": 0.35, "many": 0.9}, glitches, "few"), stamp=(overlay != "off"), seed=seed, has_audio=has_a,
                audio=audio, cam_name=cam_name,
                shake_env=[(float(a), float(b)) for a, b in (p.split(":") for p in shake_env.split(",") if ":" in p)] or None)
            crf = 20 + int(10 * lv({"light": 0.2, "medium": 0.5, "heavy": 0.9}, wear, "medium"))
            rate = []
            if preset == "tiktok":      # a re-uploaded phone video: starved bitrate, visible macroblocking
                crf = max(crf, 31)
                rate = ["-maxrate", "380k", "-bufsize", "760k"]
            elif preset == "ugc":       # an ordinary reposted phone video: mildly compressed
                crf = max(crf, 27)
                rate = ["-maxrate", "900k", "-bufsize", "1800k"]
            keep_orig = audio == "passthrough" and has_a        # the clip's own audio untouched (no per-clip wind/hiss that restarts at every cut)
            cmd = [ff, "-y", "-i", str(src), "-filter_complex", g["fc"], "-map", g["v"],
                   *(["-map", g["a"], "-c:a", "aac", "-b:a", "96k"] if g["a"] else (["-map", "0:a:0", "-c:a", "aac", "-b:a", "128k"] if keep_orig else ["-an"])),
                   "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(crf), *rate, "-preset", "veryfast", "-movflags", "+faststart", str(out)]
        elif op == "mux_audio":
            if aux is None:
                raise HTTPException(400, "mux_audio needs the `aux` file (source of the audio)")
            auxp = await _stage(aux, ".mp4")
            cmd = [ff, "-y", "-i", str(src), "-i", str(auxp), "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy",
                   "-c:a", "aac", "-shortest", str(out)]
        elif op == "voiceover":
            # lay a spoken line (aux) over the clip: the picture is kept whole, the line starts 0.3 s in and silence fills the rest
            if aux is None:
                raise HTTPException(400, "voiceover needs the `aux` file (the spoken line)")
            auxp = await _stage(aux, ".wav")
            dur = _probe(src)["duration"]
            # an explicit -t: -shortest never ends when the padded (endless) audio is paired with a stream-copied video
            cmd = [ff, "-y", "-i", str(src), "-i", str(auxp), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
                   "-af", "adelay=300:all=1,apad", "-c:a", "aac"] + (["-t", f"{dur:.3f}"] if dur > 0 else ["-shortest"]) + [str(out)]
        elif op == "join":
            # seamless continuation: `aux` starts on the frame `file` ended on, so its first frame is dropped; both are video-only
            if aux is None:
                raise HTTPException(400, "join needs the `aux` clip to append")
            auxp = await _stage(aux, ".mp4")
            w, h = (info["width"] or 0) // 2 * 2, (info["height"] or 0) // 2 * 2
            fc = (f"[0:v]fps=24,setsar=1,scale={w}:{h}[a];"
                  f"[1:v]fps=24,setsar=1,scale={w}:{h},trim=start_frame=1,setpts=PTS-STARTPTS[b];"
                  f"[a][b]concat=n=2:v=1:a=0[v]")
            cmd = [ff, "-y", "-i", str(src), "-i", str(auxp), "-filter_complex", fc, "-map", "[v]", "-an", *enc, str(out)]
        elif op == "mute":
            cmd = [ff, "-y", "-i", str(src), "-an", "-c:v", "copy", str(out)]
        elif op == "reframe":
            aw, ah = (int(x) for x in aspect.split(":"))
            h = 1080 if ah >= aw else int(round(1080 * ah / aw / 2) * 2)
            w = int(round(h * aw / ah / 2) * 2)
            if fit == "crop":
                vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"
                cmd = [ff, "-y", "-i", str(src), "-vf", vf, *(["-c:a", "copy"] if has_a else ["-an"]), *enc, str(out)]
            elif fit == "black":
                vf = f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black"
                cmd = [ff, "-y", "-i", str(src), "-vf", vf, *(["-c:a", "copy"] if has_a else ["-an"]), *enc, str(out)]
            else:  # blurred-background fill, the classic social reframe
                fc = (f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur=28:6[bg];"
                      f"[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease[fg];"
                      f"[bg][fg]overlay=(W-w)/2:(H-h)/2[v]")
                cmd = [ff, "-y", "-i", str(src), "-filter_complex", fc, "-map", "[v]",
                       *(["-map", "0:a", "-c:a", "copy"] if has_a else ["-an"]), *enc, str(out)]
        elif op in ("first_frame", "last_frame"):
            out = src.with_name(src.stem + "_frame.png")
            media = "image/png"
            if op == "first_frame":
                cmd = [ff, "-y", "-i", str(src), "-frames:v", "1", str(out)]
            else:
                cmd = [ff, "-y", "-sseof", "-0.2", "-i", str(src), "-update", "1", "-q:v", "1", str(out)]
        elif op == "greenkey":
            # the green-screen result of Remove background -> a transparent VP9/WebM the Timeline can lay over other shots
            out = src.with_name(src.stem + "_key.webm")
            media = "video/webm"
            vf = "colorkey=0x00B140:0.10:0.04,despill=type=green:mix=0.5:expand=0,format=yuva420p"
            cmd = [ff, "-y", "-i", str(src), "-vf", vf, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24",
                   "-auto-alt-ref", "0", "-row-mt", "1", *(["-c:a", "libopus"] if has_a else ["-an"]), str(out)]
        elif op == "gif":
            out = src.with_name(src.stem + "_out.gif")
            media = "image/gif"
            vf = "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"
            cmd = [ff, "-y", "-i", str(src), "-vf", vf, "-loop", "0", str(out)]
        else:
            raise HTTPException(400, f"Unknown op {op!r}")
        r = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True)
        try:
            if r.returncode != 0 or not out.exists():
                raise HTTPException(500, f"ffmpeg failed: {r.stderr[-500:]}")
            return Response(content=out.read_bytes(), media_type=media)
        finally:
            for p in (src, out):
                try:
                    p.unlink()
                except OSError:
                    pass
