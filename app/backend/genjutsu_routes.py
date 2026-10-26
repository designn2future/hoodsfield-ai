"""
Genjutsu — local video-to-video (the open rebuild of Higgsfield's Genjutsu).

Higgsfield's Genjutsu has two modes: *Motion Transfer* (keep a clip's movement
and camera, rebuild cast + setting from references) and *Object Swap* (change
one element, keep the rest). Both reduce to the same local recipe:

  1. (client) edit the clip's first frame with Flux 3 — swap the character,
     outfit, product, location... using reference images. This is the identity
     anchor.
  2. (here)  encode the whole source clip into LTX 2.3's video latent, add noise
     for only the tail of the schedule (`denoise` = how far the model may depart
     from the source: low keeps structure, high allows bigger swaps), pin latent
     frame 0 to the edited first frame, and let LTX re-render the clip. Motion
     and camera come from the source latent; appearance from the guide frame and
     the prompt.

It reuses the app's proven LTX 2.3 distilled two-stage template but stops after
stage 1 (full resolution, no latent upscale — stage 2 would re-noise away the
structure we are trying to keep).
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

from audio_analysis import ffmpeg_exe
from workflow import build_workflow, set_video_lora_chain, use_plain_unet_loader


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

    @app.post("/api/genjutsu")
    async def genjutsu(
        video: UploadFile = File(...),
        guide: UploadFile | None = File(None),
        prompt: str = Form(...),
        denoise: float = Form(0.75),
        guide_strength: float = Form(1.0),
        guide_hold: int = Form(8),          # frames of the source replaced by the guide before encoding (0 = off)
        megapixels: float = Form(0.3),
        seconds: float = Form(5.0),
        steps: int = Form(8),
        seed: int = Form(-1),
        negative_prompt: str = Form(""),
        gguf_model: str = Form(""),
        lora_names: list[str] = Form([]),
        lora_strengths: list[float] = Form([]),
    ):
        if seed < 0:
            seed = uuid.uuid4().int % (2**48)
        job_id = uuid.uuid4().hex[:12]
        subfolder = f"vsa_{job_id}"
        denoise = max(0.2, min(1.0, denoise))

        data = await video.read()
        if not data:
            raise HTTPException(400, "Empty video upload")
        stage = root / "input" / "vsa_tools"
        stage.mkdir(parents=True, exist_ok=True)
        vpath = stage / f"gj_{job_id}{Path(video.filename or '.mp4').suffix or '.mp4'}"
        vpath.write_bytes(data)
        info = _probe(vpath)

        # Canvas: source aspect at the requested pixel budget, multiples of 32.
        aspect = (info["width"] / info["height"]) if info["width"] and info["height"] else 1.0
        h = (megapixels * 1e6 / aspect) ** 0.5
        width, height = max(256, round(h * aspect / 32) * 32), max(256, round(h / 32) * 32)
        # LTX frame grid: 8k+1 frames at 24 fps, never more than the clip has
        avail = max(9, int(min(seconds, info["duration"] or seconds) * 24))
        frames = 8 * ((avail - 1) // 8) + 1

        if m.MOCK:
            m._new_job(job_id)
            asyncio.get_event_loop().create_task(m._mock_run(job_id, [b""], 24, is_video=False))
            return {"job_id": job_id, "prompt_id": "mock", "seed": seed}

        template = m._load_template(m.WORKFLOW_I2V_FILE)
        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            guide_name = "first_frame.png"
            gdata = await guide.read() if guide is not None else b""
            if gdata:
                r = await client.post(
                    f"{m.COMFY_URL}/upload/image", files={"image": (guide_name, gdata, "image/png")},
                    data={"subfolder": subfolder, "type": "input", "overwrite": "true"})
                if r.status_code != 200:
                    raise HTTPException(502, f"ComfyUI image upload failed: {r.text[:300]}")
            else:
                # the template's LoadImage still needs a valid file; bypassed below
                blank = await _blank_png(width, height)
                await client.post(f"{m.COMFY_URL}/upload/image", files={"image": (guide_name, blank, "image/png")},
                                  data={"subfolder": subfolder, "type": "input", "overwrite": "true"})

            graph_str = build_workflow(template, {
                "PROMPT": prompt, "GLOBAL_PROMPT": prompt, "LOCAL_PROMPTS": prompt, "SEGMENT_LENGTHS": "",
                "NEGATIVE_PROMPT": negative_prompt, "WIDTH": width, "HEIGHT": height,
                "NUM_FRAMES": frames, "FPS": 24, "STEPS": steps, "CFG": 1.0, "SEED": seed,
                "FIRST_FRAME": f"{subfolder}/{guide_name}", "FRAMES_DIR": f"input/{subfolder}",
            })
            g = json.loads(graph_str)

            # --- source clip -> latent (replaces the empty latent) ---
            g["900"] = {"class_type": "VHS_LoadVideoPath",
                        "inputs": {"video": str(vpath), "force_rate": 24, "custom_width": 0, "custom_height": 0,
                                   "frame_load_cap": frames, "skip_first_frames": 0, "select_every_nth": 1}}
            g["901"] = {"class_type": "ImageScale",
                        "inputs": {"image": ["900", 0], "upscale_method": "lanczos", "width": width,
                                   "height": height, "crop": "center"}}
            pixels = ["901", 0]
            hold = max(0, min(int(guide_hold), frames // 2)) if gdata else 0
            if hold:
                # The guide only pins ONE latent frame, so the clip would snap back to the source
                # layout almost at once. Replacing the first `hold` source frames with the guide
                # makes the early latent frames carry the new look; the rest keeps the source motion.
                g["906"] = {"class_type": "ImageScale",
                            "inputs": {"image": ["845", 0], "upscale_method": "lanczos", "width": width,
                                       "height": height, "crop": "center"}}
                g["907"] = {"class_type": "RepeatImageBatch", "inputs": {"image": ["906", 0], "amount": hold}}
                g["908"] = {"class_type": "ImageFromBatch",
                            "inputs": {"image": ["901", 0], "batch_index": hold, "length": frames - hold}}
                g["909"] = {"class_type": "ImageBatch", "inputs": {"image1": ["907", 0], "image2": ["908", 0]}}
                pixels = ["909", 0]
            g["902"] = {"class_type": "VAEEncode", "inputs": {"pixels": pixels, "vae": ["844:332", 0]}}
            g["844:290"]["inputs"]["latent"] = ["902", 0]
            g["844:290"]["inputs"]["strength"] = float(guide_strength)
            g["844:290"]["inputs"]["bypass"] = not bool(gdata)

            # --- partial denoise: only the tail of the sigma schedule ---
            g["903"] = {"class_type": "SplitSigmasDenoise",
                        "inputs": {"sigmas": ["844:275", 0], "denoise": denoise}}
            g["844:284"]["inputs"]["sigmas"] = ["903", 1]

            # --- stop after stage 1: decode it directly (stage 2 would re-noise the structure) ---
            g["844:279"]["inputs"]["samples"] = ["844:273", 0]
            g["844:282"]["inputs"]["samples"] = ["844:273", 1]

            if gguf_model:
                g["844:286"]["inputs"]["unet_name"] = gguf_model
                use_plain_unet_loader(g, "844:286", gguf_model)
            # the template's built-in I2V motion LoRA is wrong for V2V; use only what the caller asks for
            set_video_lora_chain(g, [{"name": n, "strength": s} for n, s in zip(lora_names, lora_strengths)])

            pid = await m._submit(client, json.dumps(g), job_id)

        return {"job_id": job_id, "prompt_id": pid, "seed": seed, "frames": frames, "width": width, "height": height}


async def _blank_png(w: int, h: int) -> bytes:
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (min(w, 512), min(h, 512)), (0, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()
