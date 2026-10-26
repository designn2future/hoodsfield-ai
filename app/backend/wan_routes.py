"""
Wan 2.2 (A14B) video engine — the third engine next to MiniMax H3 and LTX 2.3.

Wan 2.2 is a two-expert model: a HIGH-noise expert denoises the first part of
the schedule, a LOW-noise expert finishes it. With the Lightning 4-step LoRAs
that is 4 steps total (2 + 2) at cfg 1. Verified recipe (ComfyUI 0.41, RTX 4060 Ti):

  UnetLoaderGGUF (HighNoise Q6_K) -> LoraLoaderModelOnly (Lightning HIGH) -> [user LoRAs] -> ModelSamplingSD3 shift 5
  UnetLoaderGGUF (LowNoise  Q6_K) -> LoraLoaderModelOnly (Lightning LOW)  -> [user LoRAs] -> ModelSamplingSD3 shift 5
  CLIPLoader umt5_xxl (type wan) · VAELoader wan_2.1_vae
  WanImageToVideo / WanFirstLastFrameToVideo / EmptyHunyuanLatentVideo (text-to-video)
  KSamplerAdvanced HIGH  (add_noise on,  steps 0..2, leftover noise on)
  KSamplerAdvanced LOW   (add_noise off, steps 2..end)
  VAEDecode -> [RIFE x2] -> CreateVideo -> SaveVideo

Wan is silent and natively 16 fps; `smooth` interpolates to 32 fps with RIFE.

POST /api/generate_wan   multipart: prompt, image? (start frame), last_image? (end frame), ...
GET  /api/wan/models     which files were found + whether the engine is ready
"""

import asyncio
import json
import re
import uuid

import httpx
from fastapi import File, Form, HTTPException, UploadFile

import director

NEG = ("色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，"
       "多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走")


def _pick(names, *patterns):
    for p in patterns:
        for n in names:
            if re.search(p, n, re.I):
                return n
    return ""


_WAN_SYSTEM = (
    "You write prompts for the Wan 2.2 image-to-video model. Wan follows the formula: SUBJECT + SCENE + MOTION + CAMERA + LIGHT/STYLE. "
    "Rules: one flowing paragraph of 70-110 words, present tense, concrete physical motion verbs (what moves, how fast, which direction), "
    "describe the camera move explicitly, mention lighting and atmosphere, keep the subject's appearance consistent with the still. "
    "No dialogue, no quotation marks, no scene cuts, no text overlays, no lists. Output only the prompt."
)


def _register_enhance(app):
    @app.post("/api/wan/enhance_prompt")
    async def enhance(still: str = Form(""), motion: str = Form(""), camera: str = Form(""), seconds: float = Form(5.0)):
        """Rewrite a rough idea into Wan's preferred prompt shape with the local LLM (Ollama)."""
        idea = " ".join(x for x in (f"Still frame: {still}." if still else "", f"Wanted action: {motion}." if motion else "",
                                    f"Camera: {camera}." if camera else "", f"Clip length about {seconds:g} seconds.") if x)
        async with httpx.AsyncClient(timeout=300, trust_env=False) as client:
            try:
                models = await director.ollama_models(client)
            except Exception:
                raise HTTPException(502, "Ollama is not reachable — start it to use prompt enhancement")
            model = director.pick_text_model(models)
            if not model:
                raise HTTPException(502, "Ollama has no text model pulled")
            body = {"model": model, "stream": False, "think": False,
                    "messages": [{"role": "system", "content": _WAN_SYSTEM}, {"role": "user", "content": idea}],
                    "options": {"temperature": 0.7, "num_ctx": 4096, "num_predict": 400}}
            r = await client.post(f"{director.OLLAMA_URL}/api/chat", json=body)
            if r.status_code != 200:
                body.pop("think", None)
                r = await client.post(f"{director.OLLAMA_URL}/api/chat", json=body)
            if r.status_code != 200:
                raise HTTPException(502, f"Ollama error {r.status_code}: {r.text[:200]}")
            text = (r.json().get("message", {}).get("content") or "").strip().strip('"')
            if not text:
                raise HTTPException(502, "Ollama returned an empty prompt")
            return {"prompt": text, "model": model}


def build_wan_graph(cat, *, i2v, prompt, negative="", width, height, length, seed, steps=4, cfg=1.0, shift=5.0,
                    lightning=True, smooth=True, loras_high=(), loras_low=(), start_file=None, end_file=None,
                    ref_file=None, prefix="vsa/wan", single_expert=False):
    """Build the Wan 2.2 two-expert graph. `*_file` are names already uploaded to ComfyUI's input dir.
    `ref_file` = identity anchor (WanImageToVideo.ref_pad_image: fills the padding frames with the anchor
    instead of grey so long chained shots don't drift away from the original subject).
    `single_expert` = draft speed mode: ONLY the low-noise expert runs all steps. Half the weights to stream over this
    machine's x1 PCIe link (resolution barely matters there; weight traffic does), at some cost in motion quality.
    Returns (graph, output_fps)."""
    high = cat["i2v_high"] if i2v else cat["t2v_high"]
    low = cat["i2v_low"] if i2v else cat["t2v_low"]
    l_high = cat["lightning_i2v_high"] if i2v else cat["lightning_t2v_high"]
    l_low = cat["lightning_i2v_low"] if i2v else cat["lightning_t2v_low"]
    if lightning and not (l_high and l_low):
        lightning = False
    if not lightning:
        steps, cfg = max(steps, 20), (cfg if cfg > 1 else 3.5)

    g: dict = {}
    counter = [100]

    def nid() -> str:
        counter[0] += 1
        return str(counter[0])

    def expert(unet, lightning_lora, user_loras, title):
        ref = nid()
        g[ref] = {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": unet}, "_meta": {"title": title}}
        chain = [ref, 0]
        for name, strength in ([(lightning_lora, 1.0)] if lightning else []) + list(user_loras):
            n = nid()
            g[n] = {"class_type": "LoraLoaderModelOnly",
                    "inputs": {"model": chain, "lora_name": name, "strength_model": strength},
                    "_meta": {"title": f"LoRA: {name}"}}
            chain = [n, 0]
        sm = nid()
        g[sm] = {"class_type": "ModelSamplingSD3", "inputs": {"model": chain, "shift": shift}}
        return [sm, 0]

    which = str(single_expert).lower() if single_expert else ""
    which = "low" if which in ("true", "1") else which         # backwards-compatible: True == low
    m_high = expert(high, l_high, loras_high, "Wan 2.2 high-noise expert") if which in ("", "high") else None
    m_low = expert(low, l_low, loras_low, "Wan 2.2 low-noise expert") if which in ("", "low") else None
    clip, vae, pos, neg = nid(), nid(), nid(), nid()
    g[clip] = {"class_type": "CLIPLoader", "inputs": {"clip_name": cat["clip"], "type": "wan", "device": "default"}}
    g[vae] = {"class_type": "VAELoader", "inputs": {"vae_name": cat["vae"]}}
    g[pos] = {"class_type": "CLIPTextEncode", "inputs": {"clip": [clip, 0], "text": prompt}, "_meta": {"title": "Prompt"}}
    g[neg] = {"class_type": "CLIPTextEncode", "inputs": {"clip": [clip, 0], "text": negative or NEG}}

    cond = nid()
    if i2v and end_file:
        start, end = nid(), nid()
        g[start] = {"class_type": "LoadImage", "inputs": {"image": start_file}}
        g[end] = {"class_type": "LoadImage", "inputs": {"image": end_file}}
        g[cond] = {"class_type": "WanFirstLastFrameToVideo",
                   "inputs": {"positive": [pos, 0], "negative": [neg, 0], "vae": [vae, 0], "width": width, "height": height,
                              "length": length, "batch_size": 1, "start_image": [start, 0], "end_image": [end, 0]}}
        positive, negative_ref, latent = [cond, 0], [cond, 1], [cond, 2]
    elif i2v:
        start = nid()
        g[start] = {"class_type": "LoadImage", "inputs": {"image": start_file}}
        g[cond] = {"class_type": "WanImageToVideo",
                   "inputs": {"positive": [pos, 0], "negative": [neg, 0], "vae": [vae, 0], "width": width, "height": height,
                              "length": length, "batch_size": 1, "start_image": [start, 0]}}
        if ref_file:
            ref = nid()
            g[ref] = {"class_type": "LoadImage", "inputs": {"image": ref_file}, "_meta": {"title": "Identity anchor"}}
            g[cond]["inputs"]["ref_pad_image"] = [ref, 0]
        positive, negative_ref, latent = [cond, 0], [cond, 1], [cond, 2]
    else:
        g[cond] = {"class_type": "EmptyHunyuanLatentVideo", "inputs": {"width": width, "height": height, "length": length, "batch_size": 1}}
        positive, negative_ref, latent = [pos, 0], [neg, 0], [cond, 0]

    if which:
        k2 = nid()
        g[k2] = {"class_type": "KSamplerAdvanced",
                 "inputs": {"model": m_low if which == "low" else m_high, "add_noise": "enable", "noise_seed": seed, "steps": steps, "cfg": cfg,
                            "sampler_name": "euler", "scheduler": "simple", "positive": positive, "negative": negative_ref,
                            "latent_image": latent, "start_at_step": 0, "end_at_step": 10000, "return_with_leftover_noise": "disable"},
                 "_meta": {"title": "Sampling — single expert (draft)"}}
    else:
        half = max(1, steps // 2)
        k1, k2 = nid(), nid()
        g[k1] = {"class_type": "KSamplerAdvanced",
                 "inputs": {"model": m_high, "add_noise": "enable", "noise_seed": seed, "steps": steps, "cfg": cfg,
                            "sampler_name": "euler", "scheduler": "simple", "positive": positive, "negative": negative_ref,
                            "latent_image": latent, "start_at_step": 0, "end_at_step": half, "return_with_leftover_noise": "enable"},
                 "_meta": {"title": "Sampling — high-noise expert"}}
        g[k2] = {"class_type": "KSamplerAdvanced",
                 "inputs": {"model": m_low, "add_noise": "disable", "noise_seed": seed, "steps": steps, "cfg": cfg,
                            "sampler_name": "euler", "scheduler": "simple", "positive": positive, "negative": negative_ref,
                            "latent_image": [k1, 0], "start_at_step": half, "end_at_step": 10000, "return_with_leftover_noise": "disable"},
                 "_meta": {"title": "Sampling — low-noise expert"}}
    dec = nid()
    g[dec] = {"class_type": "VAEDecode", "inputs": {"samples": [k2, 0], "vae": [vae, 0]}}
    frames, fps = [dec, 0], 16.0
    if smooth:
        rife = nid()
        g[rife] = {"class_type": "RIFE VFI",
                   "inputs": {"ckpt_name": "rife49.pth", "frames": frames, "clear_cache_after_n_frames": 10,
                              "multiplier": 2, "fast_mode": True, "ensemble": True, "scale_factor": 1.0}}
        frames, fps = [rife, 0], 32.0
    cv, sv = nid(), nid()
    g[cv] = {"class_type": "CreateVideo", "inputs": {"images": frames, "fps": fps}}
    g[sv] = {"class_type": "SaveVideo", "inputs": {"video": [cv, 0], "filename_prefix": prefix, "format": "mp4", "codec": "h264"}}
    return g, fps


async def plan_beats(prompt: str, n: int, seg_seconds: float) -> list[str]:
    """Split one idea into n consecutive beats with the local LLM; falls back to repeating the prompt."""
    fallback = [prompt] + [f"{prompt} The action continues smoothly from the previous moment." for _ in range(n - 1)]
    if n <= 1:
        return [prompt]
    try:
        async with httpx.AsyncClient(timeout=300, trust_env=False) as client:
            models = await director.ollama_models(client)
            model = director.pick_text_model(models)
            if not model:
                return fallback
            sys_msg = ("You split one video idea into consecutive shots for an image-to-video model. Return ONLY a JSON array of "
                       f"{n} strings. Each string is one {seg_seconds:g}-second beat, 40-70 words, present tense, concrete motion and camera "
                       "movement, same subject, location and lighting throughout, each beat starting where the previous one ended. "
                       "No dialogue, no scene cuts, no quotation marks inside the strings.")
            body = {"model": model, "stream": False, "think": False, "format": "json",
                    "messages": [{"role": "system", "content": sys_msg}, {"role": "user", "content": prompt}],
                    "options": {"temperature": 0.7, "num_ctx": 4096, "num_predict": 1200}}
            r = await client.post(f"{director.OLLAMA_URL}/api/chat", json=body)
            if r.status_code != 200:
                body.pop("think", None)
                r = await client.post(f"{director.OLLAMA_URL}/api/chat", json=body)
            txt = r.json().get("message", {}).get("content", "")
            data = json.loads(txt)
            if isinstance(data, dict):
                data = next((v for v in data.values() if isinstance(v, list)), [])
            beats = [str(x).strip() for x in data if str(x).strip()]
            return (beats + fallback[len(beats):])[:n] if beats else fallback
    except Exception:
        return fallback



def _clip_rgb(path, ff):
    """Decode a clip to (frames[N,H,W,3] uint8, fps)."""
    import re as _re, subprocess as _sp
    import numpy as np
    info = _sp.run([ff, "-hide_banner", "-i", str(path)], capture_output=True, text=True).stderr
    mm = _re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", info)
    w, h = int(mm.group(1)), int(mm.group(2))
    fps = float(_re.search(r"(\d+(?:\.\d+)?)\s*fps", info).group(1))
    raw = _sp.run([ff, "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    n = len(raw) // (w * h * 3)
    return np.frombuffer(raw[: n * w * h * 3], dtype=np.uint8).reshape(n, h, w, 3), fps


def match_colour(src, ref_stats, out, ff):
    """Pull a segment's per-channel mean/contrast back to the reference stats (stops the slow saturation / contrast
    creep that builds up when each segment starts from the previous one's last frame). Returns this clip's own stats."""
    import subprocess as _sp
    import numpy as np
    fr, fps = _clip_rgb(src, ff)
    f = fr.astype(np.float32)
    mu, sd = f.mean(axis=(0, 1, 2)), f.std(axis=(0, 1, 2)) + 1e-3
    sat = float((f.max(axis=3) - f.min(axis=3)).mean()) + 1e-3
    if ref_stats is not None:
        rmu, rsd, rsat = ref_stats
        gain = np.clip(rsd / sd, 0.75, 1.3)
        f = (f - mu) * gain + rmu
        # chroma creep: scale colourfulness back toward the reference (after the luma/contrast match)
        gray = f.mean(axis=3, keepdims=True)
        ks = float(np.clip(rsat / sat, 0.6, 1.15))
        f = np.clip(gray + (f - gray) * ks, 0, 255)
    h, w = fr.shape[1:3]
    p = _sp.Popen([ff, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-",
                   "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", str(out)], stdin=_sp.PIPE)
    p.stdin.write(f.astype(np.uint8).tobytes()); p.stdin.close(); p.wait()
    return mu, sd, sat


def register(app, m):
    _register_enhance(app)
    async def _choices(client, node, field):
        r = await client.get(f"{m.COMFY_URL}/object_info/{node}")
        try:
            return list(r.json()[node]["input"]["required"][field][0])
        except Exception:
            return []

    async def _catalog(client):
        unets = await _choices(client, "UnetLoaderGGUF", "unet_name")
        clips = await _choices(client, "CLIPLoader", "clip_name")
        vaes = await _choices(client, "VAELoader", "vae_name")
        loras = await _choices(client, "LoraLoaderModelOnly", "lora_name")
        c = {
            "i2v_high": _pick(unets, r"wan2\.?2.*i2v.*high"), "i2v_low": _pick(unets, r"wan2\.?2.*i2v.*low"),
            "t2v_high": _pick(unets, r"wan2\.?2.*t2v.*high"), "t2v_low": _pick(unets, r"wan2\.?2.*t2v.*low"),
            "clip": _pick(clips, r"umt5_xxl.*fp8", r"umt5"), "vae": _pick(vaes, r"wan_?2\.?1_vae", r"wan.*vae"),
            "lightning_i2v_high": _pick(loras, r"lightning.*i2v.*high"), "lightning_i2v_low": _pick(loras, r"lightning.*i2v.*low"),
            "lightning_t2v_high": _pick(loras, r"lightning.*t2v.*high"), "lightning_t2v_low": _pick(loras, r"lightning.*t2v.*low"),
        }
        c["i2v_ready"] = bool(c["i2v_high"] and c["i2v_low"] and c["clip"] and c["vae"])
        c["t2v_ready"] = bool(c["t2v_high"] and c["t2v_low"] and c["clip"] and c["vae"])
        c["lightning_ready"] = bool(c["lightning_i2v_high"] and c["lightning_i2v_low"])
        c["loras"] = [l for l in loras if re.search(r"wan", l, re.I) and not re.search(r"lightning", l, re.I)]
        return c

    @app.get("/api/wan/models")
    async def wan_models():
        if m.MOCK:
            return {"i2v_ready": True, "t2v_ready": True, "lightning_ready": True, "loras": []}
        async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
            return await _catalog(client)

    @app.post("/api/generate_wan")
    async def generate_wan(
        prompt: str = Form(...),
        negative: str = Form(""),
        seconds: float = Form(5.0),
        width: int = Form(0),
        height: int = Form(0),
        aspect: str = Form("16:9"),
        megapixels: float = Form(0.4),
        seed: int = Form(-1),
        steps: int = Form(4),                 # Lightning: 4 (2 high + 2 low). Without Lightning use 20+ and cfg 3.5
        cfg: float = Form(1.0),
        shift: float = Form(5.0),
        lightning: bool = Form(True),
        smooth: bool = Form(True),            # RIFE x2: 16 -> 32 fps
        single_expert: str = Form(""),        # draft speed mode: "low" | "high" (one expert only) | "" (both)
        lora_names_high: list[str] = Form([]),
        lora_names_low: list[str] = Form([]),
        lora_strengths: list[float] = Form([]),
        image: UploadFile | None = File(None),
        last_image: UploadFile | None = File(None),
    ):
        if seed < 0:
            seed = uuid.uuid4().int % (2**48)
        job_id = uuid.uuid4().hex[:12]
        subfolder = f"vsa_{job_id}"
        if len(lora_names_high) != len(lora_strengths) or len(lora_names_low) != len(lora_strengths):
            raise HTTPException(400, "lora_names_high, lora_names_low and lora_strengths must have the same length")

        # 4k+1 frames at 16 fps; ~6 s is the ceiling that fits this GPU comfortably
        length = max(5, min(97, 4 * round(seconds * 16 / 4) + 1))
        if not (width and height):
            mm = re.match(r"^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$", aspect or "")
            ar = float(mm.group(1)) / float(mm.group(2)) if mm else 16 / 9
            h = (megapixels * 1e6 / ar) ** 0.5
            width, height = max(256, round(h * ar / 16) * 16), max(256, round(h / 16) * 16)

        if m.MOCK:
            m._new_job(job_id)
            data = await image.read() if image else b""
            asyncio.get_event_loop().create_task(m._mock_run(job_id, [data], 16, is_video=False))
            return {"job_id": job_id, "prompt_id": "mock", "seed": seed}

        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            cat = await _catalog(client)
            i2v = image is not None
            if not (cat["i2v_ready"] if i2v else cat["t2v_ready"]):
                raise HTTPException(502, f"Wan 2.2 {'I2V' if i2v else 'T2V'} models not found in ComfyUI")
            async def up(f: UploadFile, name: str) -> str:
                r = await client.post(f"{m.COMFY_URL}/upload/image", files={"image": (name, await f.read(), "image/png")},
                                      data={"subfolder": subfolder, "type": "input", "overwrite": "true"})
                if r.status_code != 200:
                    raise HTTPException(502, f"ComfyUI upload failed: {r.text[:300]}")
                return f"{subfolder}/{name}"

            start_file = await up(image, "start.png") if i2v else None
            end_file = await up(last_image, "end.png") if (i2v and last_image is not None) else None
            g, fps = build_wan_graph(
                cat, i2v=i2v, prompt=prompt, negative=negative, width=width, height=height, length=length, seed=seed,
                steps=steps, cfg=cfg, shift=shift, lightning=lightning, smooth=smooth,
                loras_high=list(zip(lora_names_high, lora_strengths)), loras_low=list(zip(lora_names_low, lora_strengths)),
                start_file=start_file, end_file=end_file, single_expert=single_expert)

            pid = await m._submit(client, json.dumps(g), job_id)
        return {"job_id": job_id, "prompt_id": pid, "seed": seed, "width": width, "height": height,
                "length": length, "fps": fps, "seconds": round(length / 16, 2)}

    # ------------------------------------------------------------ long shots

    @app.post("/api/wan/long")
    async def wan_long(
        prompt: str = Form(...),
        beats: str = Form(""),                  # optional JSON list: one prompt per segment
        total_seconds: float = Form(12.0),
        segment_seconds: float = Form(4.0),
        aspect: str = Form("16:9"),
        megapixels: float = Form(0.3),
        seed: int = Form(-1),
        lightning: bool = Form(True),
        smooth: bool = Form(True),
        anchor: bool = Form(True),              # feed the original still to every later segment as an identity anchor
        plan: bool = Form(True),                # let the local LLM split the idea into per-segment beats
        image: UploadFile = File(...),
    ):
        """Chain Wan segments into one long shot. Segment k starts from segment k-1's LAST frame; the original still
        is passed as an identity anchor; clips are joined without the duplicated hand-off frame. One composite job."""
        import math
        import subprocess
        import time as _t
        from audio_analysis import ffmpeg_exe
        seg_s = max(2.0, min(6.0, segment_seconds))
        n = max(1, min(8, math.ceil(total_seconds / seg_s)))
        if seed < 0:
            seed = uuid.uuid4().int % (2**48)
        mm = re.match(r"^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$", aspect or "")
        ar = float(mm.group(1)) / float(mm.group(2)) if mm else 16 / 9
        h = (megapixels * 1e6 / ar) ** 0.5
        width, height = max(256, round(h * ar / 16) * 16), max(256, round(h / 16) * 16)
        length = max(5, min(97, 4 * round(seg_s * 16 / 4) + 1))
        img0 = await image.read()
        if m.MOCK:
            raise HTTPException(400, "Long shots need a real ComfyUI")
        user_beats = []
        if beats.strip():
            try:
                user_beats = [str(x) for x in json.loads(beats)]
            except Exception:
                raise HTTPException(400, "beats must be a JSON array of strings")

        cj = m.CompositeJob("video-long", f"Long shot ({n} x {seg_s:g}s) · {prompt[:80]}", steps=n + 1,
                            params={"prompt": prompt, "segments": n, "segment_seconds": seg_s, "megapixels": megapixels}, family="wan")

        async def work(cj):
            from jobs import OUT_DIR
            wdir = OUT_DIR / f"{cj.id}_parts"
            wdir.mkdir(exist_ok=True)
            ff = ffmpeg_exe()

            def run_ff(*args):
                r = subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error", *map(str, args)], capture_output=True, text=True)
                if r.returncode:
                    raise RuntimeError(f"ffmpeg: {r.stderr[-300:]}")

            await cj.status("Planning the shot…")
            plan_list = user_beats if user_beats else (await plan_beats(prompt, n, seg_s) if plan else [prompt] * n)
            plan_list = (plan_list + [prompt] * n)[:n]
            cj.job["beats"] = plan_list
            async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
                cat = await _catalog(client)
                if not cat["i2v_ready"]:
                    raise RuntimeError("Wan 2.2 I2V models not found in ComfyUI")
                sub = f"vsa_{cj.id}"

                async def upload(data: bytes, name: str) -> str:
                    r = await client.post(f"{m.COMFY_URL}/upload/image", files={"image": (name, data, "image/png")},
                                          data={"subfolder": sub, "type": "input", "overwrite": "true"})
                    if r.status_code != 200:
                        raise RuntimeError(f"upload failed: {r.text[:200]}")
                    return f"{sub}/{name}"

                anchor_file = await upload(img0, "anchor.png")
                start_bytes = img0
                parts = []
                ref_stats = None
                for i in range(n):
                    start_file = await upload(start_bytes, f"start_{i}.png")
                    g, _fps = build_wan_graph(
                        cat, i2v=True, prompt=plan_list[i], width=width, height=height, length=length, seed=seed + i,
                        lightning=lightning, smooth=smooth, start_file=start_file,
                        ref_file=anchor_file if (anchor and i > 0) else None, prefix=f"vsa/wanlong_{cj.id}")
                    data = await cj.run_graph(g, f"Segment {i + 1}/{n}: {plan_list[i][:60]}")
                    seg = wdir / f"seg_{i}.mp4"
                    seg.write_bytes(data)
                    # keep colour/contrast anchored to segment 0 so the shot doesn't drift segment by segment
                    cm = wdir / f"seg_{i}_cm.mp4"
                    try:
                        stats = await asyncio.to_thread(match_colour, seg, ref_stats, cm, ff)
                        if ref_stats is None:
                            ref_stats = stats
                        if cm.exists() and cm.stat().st_size > 1000:
                            seg = cm
                    except Exception as e:  # colour matching is a polish step: never fail the shot over it
                        print("[wan_long] colour match skipped:", e)
                    await cj.step_done()
                    # hand-off frame for the next segment
                    lf = wdir / f"last_{i}.png"
                    run_ff("-sseof", -0.1, "-i", seg, "-update", 1, "-frames:v", 1, lf)
                    start_bytes = lf.read_bytes()
                    # drop the duplicated first frame of every segment after the first
                    part = wdir / f"part_{i}.mp4"
                    vf = "scale=trunc(iw/2)*2:trunc(ih/2)*2" if i == 0 else "trim=start_frame=1,setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2"
                    run_ff("-i", seg, "-vf", vf, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", 18, part)
                    parts.append(part)
            await cj.status("Joining segments…")
            lst = wdir / "list.txt"
            lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts))
            out = OUT_DIR / f"{cj.id}.mp4"
            run_ff("-f", "concat", "-safe", 0, "-i", lst, "-c", "copy", out)
            await cj.step_done()
            cj.finish(out)

        cj.start(work)
        return {"job_id": cj.id, "segments": n, "seed": seed, "width": width, "height": height}

