"""
LTX 2.3 control endpoints built on the app's proven LTX 2.3 distilled template (stage 1 only, like Genjutsu):

  POST /api/motion_control   structure-locked motion transfer with the LTX-2.3 *Union-Control* IC-LoRA.
                             A control video (canny edges of any source clip) is attached as a guide
                             (LTXVAddGuide + IC-LoRA reference downscale factor) so the NEW video follows the
                             source's motion/layout exactly while identity, look and setting come from the
                             prompt and an optional first-frame image. Stronger than Genjutsu's SDEdit
                             (which inherits the source's colours); needs the LoRA file in models/loras.
  POST /api/lipsync          audio-driven talking video: a face still + a speech clip. The audio is encoded
                             into LTX's audio latent and FROZEN (audio mask = no generation), so the joint
                             audio-video model generates video that matches the supplied speech.

Pose/depth control need SD-Pose / depth models that are not installed; canny works out of the box.
"""

import asyncio
import json
import os
import re
import subprocess
import uuid
from pathlib import Path

import httpx
from fastapi import File, Form, HTTPException, UploadFile

import lipalign
from audio_analysis import ffmpeg_exe
from workflow import build_workflow, use_plain_unet_loader

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)

UNION_LORA = re.compile(r"ltx-?2\.?3.*ic-?lora.*union", re.I)


def register(app, m):
    root = Path(os.getenv("COMFY_ROOT", r"D:\ComfyUI-LTX2"))

    def _probe(path: Path) -> dict:
        r = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, text=True)
        t = r.stderr
        info = {"fps": 24.0, "width": 0, "height": 0, "duration": 0.0}
        mm = re.search(r"(\d+(?:\.\d+)?)\s*fps", t)
        if mm:
            info["fps"] = float(mm.group(1))
        mm = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", t)
        if mm:
            info["width"], info["height"] = int(mm.group(1)), int(mm.group(2))
        mm = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", t)
        if mm:
            info["duration"] = int(mm.group(1)) * 3600 + int(mm.group(2)) * 60 + float(mm.group(3))
        return info

    def _stage(data: bytes, suffix: str) -> Path:
        d = root / "input" / "vsa_tools"
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"ltx_{uuid.uuid4().hex[:10]}{suffix}"
        p.write_bytes(data)
        return p

    async def _lora_names(client) -> list[str]:
        r = await client.get(f"{m.COMFY_URL}/object_info/LoraLoaderModelOnly")
        try:
            return list(r.json()["LoraLoaderModelOnly"]["input"]["required"]["lora_name"][0])
        except Exception:
            return []

    def _canvas(aspect: float, megapixels: float, multiple: int = 64) -> tuple[int, int]:
        h = (megapixels * 1e6 / aspect) ** 0.5
        return max(multiple * 4, round(h * aspect / multiple) * multiple), max(multiple * 4, round(h / multiple) * multiple)

    async def _base(client, prompt, width, height, frames, seed, steps, subfolder, guide_bytes, negative="", fps=24):
        """Template -> graph dict with W/H/frames/seed/prompt filled and the first-frame guide uploaded."""
        guide_name = "first_frame.png"
        if guide_bytes:
            data = guide_bytes
        else:
            import io
            from PIL import Image
            buf = io.BytesIO()
            Image.new("RGB", (256, 256), (0, 0, 0)).save(buf, "PNG")
            data = buf.getvalue()
        r = await client.post(f"{m.COMFY_URL}/upload/image", files={"image": (guide_name, data, "image/png")},
                              data={"subfolder": subfolder, "type": "input", "overwrite": "true"})
        if r.status_code != 200:
            raise HTTPException(502, f"ComfyUI image upload failed: {r.text[:300]}")
        graph_str = build_workflow(m._load_template(m.WORKFLOW_I2V_FILE), {
            "PROMPT": prompt, "GLOBAL_PROMPT": prompt, "LOCAL_PROMPTS": prompt, "SEGMENT_LENGTHS": "",
            "NEGATIVE_PROMPT": negative, "WIDTH": width, "HEIGHT": height, "NUM_FRAMES": frames, "FPS": fps,
            "STEPS": steps, "CFG": 1.0, "SEED": seed, "FIRST_FRAME": f"{subfolder}/{guide_name}", "FRAMES_DIR": f"input/{subfolder}"})
        g = json.loads(graph_str)
        # the template's half-res latent size maths is bypassed: stage 1 runs at exactly width x height
        g["844:268"]["inputs"]["width"], g["844:268"]["inputs"]["height"] = width, height
        g["844:290"]["inputs"]["bypass"] = not bool(guide_bytes)
        # stop after stage 1 and decode it (VAEDecodeTiled replaced the removed spatio-temporal tiled node)
        g["844:279"]["inputs"]["samples"] = ["844:273", 0]
        g["844:282"]["inputs"]["samples"] = ["844:273", 1]
        return g

    def _drop_template_lora(g, new_model_node=None):
        """Remove the template's I2V motion LoRA; optionally splice `new_model_node` into its place."""
        lora = g.pop("844:856")
        src = lora["inputs"]["model"]
        g["844:857"]["inputs"]["anything"] = new_model_node if new_model_node else src
        return src

    # ------------------------------------------------------------ motion control

    async def _has_depth() -> bool:
        """Depth Anything 3 nodes + model present in ComfyUI (the union IC-LoRA also understands depth maps)."""
        try:
            async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
                r = await client.get(f"{m.COMFY_URL}/object_info/LoadDA3Model")
                opts = r.json()["LoadDA3Model"]["input"]["required"]["model_name"][1]["options"]
            return any("depth_anything" in o for o in opts)
        except Exception:
            return False

    @app.get("/api/motion_control/status")
    async def mc_status():
        if m.MOCK:
            return {"ready": True, "lora": "mock", "modes": ["canny"]}
        async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
            names = await _lora_names(client)
        lora = next((n for n in names if UNION_LORA.search(n)), "")
        return {"ready": bool(lora), "lora": lora, "modes": ["canny", "depth", "both"] if await _has_depth() else ["canny"],
                "hint": "" if lora else "Download ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors into models/loras"}

    @app.post("/api/motion_control")
    async def motion_control(
        video: UploadFile = File(...),
        guide: UploadFile | None = File(None),
        prompt: str = Form(...),
        mode: str = Form("canny"),
        megapixels: float = Form(0.3),
        seconds: float = Form(4.0),
        steps: int = Form(8),
        seed: int = Form(-1),
        control_strength: float = Form(1.0),    # control-video (IC-LoRA guide) strength
        guide_strength: float = Form(1.0),      # how firmly the first-frame picture is pinned (lower = the control video decides the pose sooner)
        audio_sync: bool = Form(False),         # drive the mouth from the source clip's own speech/rap (audio latent frozen, like Lip-sync)
        lora_strength: float = Form(1.0),
        canny_low: float = Form(0.15),
        canny_high: float = Form(0.35),
    ):
        if mode not in ("canny", "depth", "both"):
            raise HTTPException(400, "mode must be canny, depth or both")
        if mode != "canny" and not m.MOCK and not await _has_depth():
            mode = "canny"      # no depth model installed: fall back to edges
        if seed < 0:
            seed = uuid.uuid4().int % (2**48)
        job_id = uuid.uuid4().hex[:12]
        subfolder = f"vsa_{job_id}"
        vdata = await video.read()
        if not vdata:
            raise HTTPException(400, "Empty video upload")
        vpath = _stage(vdata, Path(video.filename or ".mp4").suffix or ".mp4")
        info = _probe(vpath)
        aspect = (info["width"] / info["height"]) if info["width"] and info["height"] else 1.0
        width, height = _canvas(aspect, megapixels)
        has_audio = False
        if audio_sync:
            probe = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", str(vpath)], capture_output=True, text=True).stderr
            has_audio = "Audio:" in probe
        # the template hard-codes frame_rate=25 in its LTXVConditioning, so with speech the clip is rendered at 25 fps: audio and video then agree
        fps = 25 if has_audio else 24
        avail = max(9, int(min(seconds, info["duration"] or seconds) * fps))
        frames = 8 * ((avail - 1) // 8) + 1
        gdata = await guide.read() if guide is not None else b""
        if m.MOCK:
            m._new_job(job_id)
            asyncio.get_event_loop().create_task(m._mock_run(job_id, [b""], 24, is_video=False))
            return {"job_id": job_id, "prompt_id": "mock", "seed": seed}
        apath = None
        if has_audio:
            apath = vpath.with_name(vpath.stem + "_speech.wav")
            subprocess.run([ffmpeg_exe(), "-y", "-v", "error", "-i", str(vpath), "-vn", "-t", f"{frames / fps:.3f}", "-ac", "1", "-ar", "44100", str(apath)], check=True)

        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            names = await _lora_names(client)
            lora = next((n for n in names if UNION_LORA.search(n)), "")
            if not lora:
                raise HTTPException(502, "LTX-2.3 Union-Control IC-LoRA not found in models/loras "
                                         "(ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors)")
            g = await _base(client, prompt, width, height, frames, seed, steps, subfolder, gdata, fps=fps)
            if gdata:
                g["844:290"]["inputs"]["strength"] = max(0.0, min(1.0, float(guide_strength)))
            # --- control video: source frames -> half-res (the LoRA was trained with reference_downscale_factor 2) -> canny
            g["900"] = {"class_type": "VHS_LoadVideoPath",
                        "inputs": {"video": str(vpath), "force_rate": fps, "custom_width": 0, "custom_height": 0,
                                   "frame_load_cap": frames, "skip_first_frames": 0, "select_every_nth": 1}}
            g["901"] = {"class_type": "ImageScale", "inputs": {"image": ["900", 0], "upscale_method": "lanczos",
                                                                 "width": width // 2, "height": height // 2, "crop": "center"}}
            g["902"] = {"class_type": "Canny", "inputs": {"image": ["901", 0], "low_threshold": canny_low, "high_threshold": canny_high}}
            if mode in ("depth", "both"):
                # Depth Anything 3 depth maps: unlike edges they keep the body's volume and where each arm is in front of or behind
                # the torso, and they survive motion blur, so fast movement is followed far better than with canny alone
                g["910"] = {"class_type": "LoadDA3Model", "inputs": {"model_name": "depth_anything_3_mono_large.safetensors", "weight_dtype": "fp16"}}
                g["911"] = {"class_type": "DA3Inference", "inputs": {"da3_model": ["910", 0], "image": ["901", 0], "resolution": 504,
                                                                      "resize_method": "upper_bound_resize", "mode": "mono"}}
                g["912"] = {"class_type": "DA3Render", "inputs": {"da3_geometry": ["911", 0], "output": "depth",
                                                                   "output.normalization": "v2_style", "output.apply_sky_clip": False}}
            # --- IC-LoRA on the model path (replaces the template's I2V motion LoRA)
            lora_src = g["844:856"]["inputs"]["model"]
            g["903"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": lora_src, "lora_name": lora, "strength_model": lora_strength}}
            _drop_template_lora(g, ["903", 0])
            g["904"] = {"class_type": "GetICLoRAParameters", "inputs": {"iclora_model": ["903", 0]}}
            # --- attach the control video as a guide on the (optionally first-frame-guided) latent
            g["905"] = {"class_type": "LTXVAddGuide",
                        "inputs": {"positive": ["844:272", 0], "negative": ["844:272", 1], "vae": ["844:332", 0],
                                   "latent": ["844:290", 0], "image": ["912", 0] if mode in ("depth", "both") else ["902", 0], "frame_idx": 0,
                                   "strength": control_strength, "iclora_parameters": ["904", 0]}}
            last = "905"
            if mode == "both":      # edges on top of the depth map (outlines + volume)
                g["907"] = {"class_type": "LTXVAddGuide",
                            "inputs": {"positive": ["905", 0], "negative": ["905", 1], "vae": ["844:332", 0],
                                       "latent": ["905", 2], "image": ["902", 0], "frame_idx": 0,
                                       "strength": control_strength * 0.6, "iclora_parameters": ["904", 0]}}
                last = "907"
            g["844:269"]["inputs"]["video_latent"] = [last, 2]
            if apath is not None:
                # the source's speech becomes a frozen audio latent, so the new person's mouth is generated to match it
                dur = frames / fps
                g["920"] = {"class_type": "VHS_LoadAudio", "inputs": {"audio_file": str(apath), "seek_seconds": 0, "duration": dur}}
                g["921"] = {"class_type": "LTXVAudioVAEEncode", "inputs": {"audio": ["920", 0], "audio_vae": ["844:331", 0]}}
                g["922"] = {"class_type": "LTXVAudioVideoMask",
                            "inputs": {"video_fps": float(fps), "video_start_time": 0.0, "video_end_time": float(dur),
                                       "audio_start_time": float(dur + 5), "audio_end_time": float(dur + 5), "max_length": "partial",
                                       "audio_latent": ["921", 0]}}
                g["844:269"]["inputs"]["audio_latent"] = ["922", 1]
            g["844:284"]["inputs"]["positive"] = [last, 0]
            g["844:284"]["inputs"]["negative"] = [last, 1]
            g["906"] = {"class_type": "LTXVCropGuides", "inputs": {"positive": [last, 0], "negative": [last, 1], "latent": ["844:273", 0]}}
            g["844:279"]["inputs"]["samples"] = ["906", 2]
            pid = await m._submit(client, json.dumps(g), job_id)
        return {"job_id": job_id, "prompt_id": pid, "seed": seed, "frames": frames, "width": width, "height": height, "lora": lora}

    # ------------------------------------------------------------ lip-sync (audio-to-video)

    async def _lipsync_h3(idata: bytes, apath: Path, speech: float, direction: str, megapixels: float, seed: int, job_id: str, quality: bool = False):
        """MiniMax H3 lip-sync: the recorded voice is anchored into H3's audio track (MiniMaxH3AddGuide), so the face is generated
        together with that exact sound. Measured: mouth/voice match as tight as H3 speaking the line itself, in the user's own voice.
        Returns the job response, or None when this ComfyUI cannot do it (the caller then falls back to LTX)."""
        import h3 as h3mod
        ff = ffmpeg_exe()
        speech = min(speech, 7.0)
        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            try:
                cat = await m._h3_catalog(client)
                ok = cat["nodes_ok"] and await m._node_exists(client, "MiniMaxH3AddGuide")
            except Exception:
                ok = False
            d = cat["defaults"] if ok else {}
            if not (ok and all(d.get(k) for k in ("model", "text_encoder", "video_vae", "audio_vae"))):
                return None
        clean = apath.with_name(apath.stem + "_h3.wav")
        subprocess.run([ff, "-y", "-v", "error", "-i", str(apath), "-t", f"{speech:.3f}", "-ac", "1", "-ar", "44100", str(clean)], check=True)
        frames = next((f for f in h3mod.FRAME_GRID if f / 24 >= speech + 0.15), h3mod.FRAME_GRID[-1])      # smallest H3 length that holds the whole line
        frames = min(frames, cat.get("max_frames", 175))
        import io
        from PIL import Image
        im = Image.open(io.BytesIO(idata))
        width, height = h3mod.canvas_for(im.width / im.height, max(0.35, min(1.0, megapixels + 0.1)))      # H3 runs on a 0.4 MP canvas by default; wide shots with small faces want 0.8 to 0.9
        try:                                                  # the words help H3 shape the mouth for them
            said = (await asyncio.to_thread(m.whisper_stt.transcribe, str(clean))).get("text", "").strip()
        except Exception:
            said = ""
        head = m.director.LOCK_STILL + "\n\n" + direction.strip()
        if said:
            head += f'\n\nThe person says clearly and naturally: "{said}"'
        prompt = h3mod.compose_h3_prompt(head, "The person's own voice, clean and close, quiet room tone.", "No music.")
        sub = f"vsa_{job_id}"
        cj = m.CompositeJob("video-lipsync", f"Lip-sync · {direction[:60]}", steps=1,
                            params={"seconds": round(speech, 2), "megapixels": megapixels, "engine": "h3"}, family="h3")

        async def work(cj):
            from jobs import OUT_DIR
            fp16 = await m._supports_fp16_accumulation()

            async def render(sd, label):
                async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
                    first = await m._upload_to_comfy(client, sub, f"face_{sd % 1000}.png", idata)
                g = h3mod.build_h3_graph(model=d["model"], text_encoder=d["text_encoder"], video_vae=d["video_vae"], audio_vae=d["audio_vae"],
                                         prompt=prompt, width=width, height=height, frames=frames, seed=sd, preset="quality" if quality else "fast", steps=8, first_frame=first,
                                         use_kj_loader=cat["kj_loader"], enable_fp16_accumulation=fp16, filename_prefix=f"vsa/h3/{cj.id}")
                g["60"] = {"class_type": "VHS_LoadAudio", "inputs": {"audio_file": str(clean), "seek_seconds": 0, "duration": speech + 0.15}}
                g["61"] = {"class_type": "MiniMaxH3AddGuide", "inputs": {"positive": ["6", 0], "latent": ["6", 1], "frame_idx": 0,
                                                                           "audio_vae": ["5", 0], "audio": ["60", 0]}}
                g["9"]["inputs"]["conditioning"] = ["61", 0]
                data = await cj.run_graph(g, label)
                rw = OUT_DIR / f"{cj.id}_raw{'' if sd == seed else '_2'}.mp4"
                rw.write_bytes(data)
                try:
                    return rw, await asyncio.to_thread(lipalign.measure, rw, clean, ff, NOWIN)
                except Exception as e:
                    print("lip-sync: mouth check skipped:", repr(e), flush=True)
                    return rw, None

            raw, al = await render(seed, "Rendering the talking clip with H3…")
            if al is not None and al.get("open", 1.0) < 0.25:          # the mouth hardly moved (seed luck): one more take, keep the livelier one
                await cj.status("The mouth hardly moved: making a second take…")
                raw2, al2 = await render(seed + 7919, "Rendering a second take…")
                if al2 is not None and al2.get("open", 0.0) > al["open"]:
                    raw, al = raw2, al2
            cj.job["lip_check"] = al
            out = OUT_DIR / f"{cj.id}.mp4"
            await cj.status("Attaching the original voice…")
            r = subprocess.run([ff, "-y", "-v", "error", "-i", str(raw), "-i", str(clean), "-map", "0:v", "-map", "1:a", "-c:v", "copy",
                                "-c:a", "aac", "-b:a", "192k", "-t", f"{speech:.3f}", str(out)], capture_output=True, text=True)
            if r.returncode or not out.exists():
                raise RuntimeError("ffmpeg: " + r.stderr[-300:])
            await cj.step_done()
            cj.finish(out)

        cj.start(work)
        return {"job_id": cj.id, "seed": seed, "frames": frames, "seconds": round(speech, 2), "width": width, "height": height, "engine": "h3"}

    @app.post("/api/lipsync")
    async def lipsync(
        image: UploadFile = File(...),
        audio: UploadFile = File(...),
        prompt: str = Form("A person speaks naturally to the camera, clear lip movements in sync with the speech, subtle head motion and expressions."),
        megapixels: float = Form(0.3),
        max_seconds: float = Form(6.0),
        steps: int = Form(8),
        seed: int = Form(-1),
        lead_seconds: float = Form(0.6),
        engine: str = Form("h3"),
        quality: bool = Form(False),      # H3 only: the 8-step sampler instead of the fast 4-step one (cleaner eyes and fine detail, about twice the time)
    ):
        if seed < 0:
            seed = uuid.uuid4().int % (2**48)
        job_id = uuid.uuid4().hex[:12]
        subfolder = f"vsa_{job_id}"
        idata, adata = await image.read(), await audio.read()
        if not idata or not adata:
            raise HTTPException(400, "Both an image and an audio clip are required")
        apath = _stage(adata, Path(audio.filename or ".wav").suffix or ".wav")
        ainfo = _probe(apath)
        speech = min(max_seconds, ainfo["duration"] or max_seconds)
        if engine != "ltx" and not m.MOCK:
            res = await _lipsync_h3(idata, apath, speech, prompt, megapixels, seed, job_id, quality)
            if res is not None:
                return res
        # Lead-in: the first frame is the still (closed mouth) and the model needs a moment to start talking, so the opening
        # words used to be missed. Pad the audio with silence, render, then cut the lead-in off the video again.
        lead = max(0.0, min(1.5, lead_seconds))
        # the lips can start up to a second after the voice; the clip is cut later to line them up, so render a spare second at the end
        tail = 1.0 if lipalign.available() else 0.0
        ff = ffmpeg_exe()
        padded = apath.with_name(apath.stem + "_pad.wav")
        clean = apath.with_name(apath.stem + "_clean.wav")
        subprocess.run([ff, "-y", "-v", "error", "-i", str(apath), "-t", f"{speech:.3f}", "-ac", "1", "-ar", "44100",
                        "-af", (f"adelay={int(lead * 1000)}:all=1," if lead > 0 else "") + f"apad=whole_dur={speech + lead + tail:.3f}", str(padded)], check=True)
        subprocess.run([ff, "-y", "-v", "error", "-i", str(apath), "-t", f"{speech:.3f}", "-ac", "1", "-ar", "44100", str(clean)], check=True)
        # the template hard-codes frame_rate=25 in its LTXVConditioning, so render at 25 fps: audio/video timing then agree
        fps = 25
        total = speech + lead + tail
        frames = 8 * ((max(9, int(total * fps)) - 1) // 8) + 1
        dur = frames / fps
        import io
        from PIL import Image
        aspect = Image.open(io.BytesIO(idata)).size
        width, height = _canvas(aspect[0] / aspect[1], megapixels)
        if m.MOCK:
            m._new_job(job_id)
            asyncio.get_event_loop().create_task(m._mock_run(job_id, [idata], 24, is_video=False))
            return {"job_id": job_id, "prompt_id": "mock", "seed": seed}

        cj = m.CompositeJob("video-lipsync", f"Lip-sync · {prompt[:60]}", steps=2,
                            params={"seconds": round(speech, 2), "megapixels": megapixels, "lead": lead}, family="ltx")

        async def work(cj):
            from jobs import OUT_DIR

            async def render(sd, label):
                async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
                    g = await _base(client, prompt, width, height, frames, sd, steps, subfolder, idata, fps=fps)
                g["844:290"]["inputs"]["bypass"] = False
                # no I2V motion LoRA for A2V
                _drop_template_lora(g)
                g["910"] = {"class_type": "VHS_LoadAudio", "inputs": {"audio_file": str(padded), "seek_seconds": 0, "duration": dur}}
                g["911"] = {"class_type": "LTXVAudioVAEEncode", "inputs": {"audio": ["910", 0], "audio_vae": ["844:331", 0]}}
                # KJNodes mask semantics: a fresh mask is all 0 (= keep) and only the given range is set to 1 (= generate).
                # So: pass ONLY the audio latent, 'partial' (no truncation), and a range past the end of the clip -> empty -> the
                # encoded speech stays frozen while the sampler generates the video to match it.
                g["912"] = {"class_type": "LTXVAudioVideoMask",
                            "inputs": {"video_fps": float(fps), "video_start_time": 0.0, "video_end_time": float(dur),
                                       "audio_start_time": float(dur + 5), "audio_end_time": float(dur + 5), "max_length": "partial",
                                       "audio_latent": ["911", 0]}}
                g["844:269"]["inputs"]["audio_latent"] = ["912", 1]   # video latent stays the template's (first-frame guided) one
                data = await cj.run_graph(g, label)
                rw = OUT_DIR / f"{cj.id}_raw{'' if sd == seed else '_2'}.mp4"
                rw.write_bytes(data)
                try:
                    return rw, await asyncio.to_thread(lipalign.measure, rw, padded, ff, NOWIN)
                except Exception as e:
                    print("lip-sync: alignment skipped:", repr(e), flush=True)
                    return rw, None

            raw, al = await render(seed, "Rendering the talking clip…")
            # the model sometimes barely moves the mouth (seed luck): measured by how far the jaw opens. One more take, keep the livelier one.
            if al is not None and al.get("open", 1.0) < 0.3:
                await cj.status("The mouth hardly moved: making a second take…")
                raw2, al2 = await render(seed + 7919, "Rendering a second take…")
                if al2 is not None and al2.get("open", 0.0) > al["open"]:
                    raw, al = raw2, al2
            await cj.step_done()
            await cj.status("Lining the lips up with the voice…")
            out = OUT_DIR / f"{cj.id}.mp4"
            # when do the lips really start? cut the video so that moment lands on the moment the voice starts
            cut = lead + (al["lag"] if al else 0.0)
            vs, adel = (cut, 0.0) if cut >= 0 else (0.0, -cut)              # lips earlier than the voice (rare): hold the voice back instead
            cj.job["lip_align"] = al
            await cj.status("Attaching the original voice…")
            af = ["-af", f"adelay={int(adel * 1000)}:all=1"] if adel > 0 else []
            r = subprocess.run([ff, "-y", "-v", "error", "-ss", f"{vs:.3f}", "-i", str(raw), "-i", str(clean), "-map", "0:v", "-map", "1:a",
                                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-c:a", "aac", "-b:a", "192k", *af, "-t", f"{speech + adel:.3f}", str(out)],
                               capture_output=True, text=True)
            if r.returncode or not out.exists():
                raise RuntimeError("ffmpeg: " + r.stderr[-300:])
            await cj.step_done()
            cj.finish(out)

        cj.start(work)
        return {"job_id": cj.id, "seed": seed, "frames": frames, "seconds": round(speech, 2), "lead": lead, "width": width, "height": height}

    # ------------------------------------------------------------ lip-sync (audio-to-video)

    @app.post("/api/lipsync")
    async def lipsync(
        image: UploadFile = File(...),
        audio: UploadFile = File(...),
        prompt: str = Form("A person speaks naturally to the camera, clear lip movements in sync with the speech, subtle head motion and expressions."),
        megapixels: float = Form(0.3),
        max_seconds: float = Form(6.0),
        steps: int = Form(8),
        seed: int = Form(-1),
    ):
        if seed < 0:
            seed = uuid.uuid4().int % (2**48)
        job_id = uuid.uuid4().hex[:12]
        subfolder = f"vsa_{job_id}"
        idata, adata = await image.read(), await audio.read()
        if not idata or not adata:
            raise HTTPException(400, "Both an image and an audio clip are required")
        apath = _stage(adata, Path(audio.filename or ".wav").suffix or ".wav")
        ainfo = _probe(apath)
        dur = min(max_seconds, ainfo["duration"] or max_seconds)
        # the template hard-codes frame_rate=25 in its LTXVConditioning, so render at 25 fps: audio/video timing then agree
        fps = 25
        frames = 8 * ((max(9, int(dur * fps)) - 1) // 8) + 1
        dur = frames / fps
        import io
        from PIL import Image
        aspect = Image.open(io.BytesIO(idata)).size
        width, height = _canvas(aspect[0] / aspect[1], megapixels)
        if m.MOCK:
            m._new_job(job_id)
            asyncio.get_event_loop().create_task(m._mock_run(job_id, [idata], 24, is_video=False))
            return {"job_id": job_id, "prompt_id": "mock", "seed": seed}

        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            g = await _base(client, prompt, width, height, frames, seed, steps, subfolder, idata, fps=fps)
            g["844:290"]["inputs"]["bypass"] = False
            # no I2V motion LoRA for A2V
            _drop_template_lora(g)
            g["910"] = {"class_type": "VHS_LoadAudio", "inputs": {"audio_file": str(apath), "seek_seconds": 0, "duration": dur}}
            g["911"] = {"class_type": "LTXVAudioVAEEncode", "inputs": {"audio": ["910", 0], "audio_vae": ["844:331", 0]}}
            # KJNodes mask semantics: a fresh mask is all 0 (= keep) and only the given range is set to 1 (= generate).
            # So: pass ONLY the audio latent, 'partial' (no truncation), and a range past the end of the clip -> empty -> the
            # encoded speech stays frozen while the sampler generates the video to match it.
            g["912"] = {"class_type": "LTXVAudioVideoMask",
                        "inputs": {"video_fps": float(fps), "video_start_time": 0.0, "video_end_time": float(dur),
                                   "audio_start_time": float(dur + 5), "audio_end_time": float(dur + 5), "max_length": "partial",
                                   "audio_latent": ["911", 0]}}
            g["844:269"]["inputs"]["audio_latent"] = ["912", 1]   # video latent stays the template's (first-frame guided) one
            pid = await m._submit(client, json.dumps(g), job_id)
        return {"job_id": job_id, "prompt_id": pid, "seed": seed, "frames": frames, "seconds": round(dur, 2), "width": width, "height": height}
