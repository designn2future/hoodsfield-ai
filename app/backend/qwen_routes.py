"""Qwen Image 2.1 routes: model discovery + text-to-image / reference editing (see qwen21.py for the graph).

  GET  /api/qwen21/models        -> installed unet / text encoder / vae / LoRAs and the defaults
  POST /api/generate_qwen21      -> {job_id, seed}  (progress over /api/events/{job_id}, like every other image job)
"""
import json
import uuid

import httpx
from fastapi import File, Form, HTTPException, UploadFile

import qwen21


def register(app, m):
    async def _choices(client, node, field):
        r = await client.get(f"{m.COMFY_URL}/object_info/{node}")
        r.raise_for_status()
        try:
            opts = r.json()[node]["input"]["required"][field][0]
            return list(opts) if isinstance(opts, list) else []
        except (KeyError, IndexError, TypeError):
            return []

    async def _models(client):
        unets = [u for u in await _choices(client, "UNETLoader", "unet_name") if "qwen_image_2.1" in u.lower()]
        clips = [c for c in await _choices(client, "CLIPLoader", "clip_name") if "qwen3vl_8b" in c.lower()]
        vaes = [v for v in await _choices(client, "VAELoader", "vae_name") if "qwen_image_2.1" in v.lower() or "qwen_image_vae" in v.lower()]
        loras = [x for x in await _choices(client, "LoraLoaderModelOnly", "lora_name") if "qwen" in x.lower()]
        full = [u for u in unets if not qwen21.TURBO_PREF.search(u)]
        d = {"unet": qwen21.pick(full, qwen21.UNET_PREF), "clip": qwen21.pick(clips, *qwen21.CLIP_PREF), "vae": qwen21.pick(vaes, qwen21.VAE_PREF)}
        return {"unets": unets, "clips": clips, "vaes": vaes, "loras": loras, "defaults": d, "ready": bool(d["unet"] and d["clip"] and d["vae"])}

    @app.get("/api/qwen21/models")
    async def qwen_models():
        if m.MOCK:
            return {"unets": ["mock"], "clips": ["mock"], "vaes": ["mock"], "loras": [], "defaults": {"unet": "mock", "clip": "mock", "vae": "mock"}, "ready": True}
        async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
            try:
                return await _models(client)
            except Exception as e:
                return {"ready": False, "error": str(e), "unets": [], "clips": [], "vaes": [], "loras": [], "defaults": {}}

    @app.post("/api/generate_qwen21")
    async def generate_qwen21(
        prompt: str = Form(...),
        negative: str = Form(""),
        width: int = Form(1024),
        height: int = Form(1024),
        steps: int = Form(25),
        cfg: float = Form(1.0),
        seed: int = Form(-1),
        match_ref_size: bool = Form(True),
        refs: list[UploadFile] = File([]),
        lora_names: list[str] = Form([]),
        lora_strengths: list[float] = Form([]),
    ):
        if seed < 0:
            seed = uuid.uuid4().int % (2**48)
        job_id = uuid.uuid4().hex[:12]
        if m.MOCK:
            echo = await refs[0].read() if refs else b""
            m._new_job(job_id)
            import asyncio
            asyncio.get_event_loop().create_task(m._mock_run(job_id, [echo], 1, is_video=False))
            return {"job_id": job_id, "prompt_id": "mock", "seed": seed}
        if len(lora_names) != len(lora_strengths):
            raise HTTPException(400, "lora_names and lora_strengths must have the same length")
        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            mdl = await _models(client)
            if not mdl["ready"]:
                raise HTTPException(502, "Qwen Image 2.1 models not found in ComfyUI (need qwen_image_2.1 diffusion model, a qwen3vl_8b text encoder and the qwen_image_2.1 VAE)")
            d = mdl["defaults"]
            sub = f"vsa_{job_id}"
            files = []
            for i, up in enumerate(refs):
                data = await up.read()
                r = await client.post(f"{m.COMFY_URL}/upload/image", files={"image": (f"ref_{i}.png", data, "image/png")},
                                      data={"subfolder": sub, "type": "input", "overwrite": "true"})
                if r.status_code != 200:
                    raise HTTPException(502, f"ComfyUI upload failed: {r.text[:200]}")
                files.append(f"{sub}/ref_{i}.png")
            graph = qwen21.build_graph(
                prompt=prompt, negative=negative, width=width, height=height, steps=steps, cfg=cfg, seed=seed,
                unet=d["unet"], clip=d["clip"], vae=d["vae"], refs=files, match_ref_size=match_ref_size,
                loras=[{"name": n, "strength": s} for n, s in zip(lora_names, lora_strengths)])
            pid = await m._submit(client, json.dumps(graph), job_id)
        return {"job_id": job_id, "prompt_id": pid, "seed": seed, "prompt": prompt}
