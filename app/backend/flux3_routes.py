"""
Flux 3 routes: model discovery, prompt upsampling, and image generation /
reference editing. Registered onto the main FastAPI app by `register(app, m)`
where `m` is the main module (late-bound so we reuse its job plumbing:
_submit, _new_job, _mock_run, COMFY_URL, MOCK).
"""

import asyncio
import io
import json
import random
import uuid

import httpx
from fastapi import File, Form, HTTPException, UploadFile
from PIL import Image

import director
import flux3
from workflow import append_faceswap_chain


def register(app, m):
    async def _choices(client: httpx.AsyncClient, node: str, field: str) -> list[str]:
        r = await client.get(f"{m.COMFY_URL}/object_info/{node}")
        r.raise_for_status()
        try:
            opts = r.json()[node]["input"]["required"][field][0]
            return list(opts) if isinstance(opts, list) else []
        except (KeyError, IndexError, TypeError):
            return []

    async def _upload(client: httpx.AsyncClient, data: bytes, name: str, subfolder: str) -> str:
        r = await client.post(
            f"{m.COMFY_URL}/upload/image",
            files={"image": (name, data, "image/png")},
            data={"subfolder": subfolder, "type": "input", "overwrite": "true"},
        )
        if r.status_code != 200:
            raise HTTPException(502, f"ComfyUI upload failed: {r.text[:300]}")
        return f"{subfolder}/{name}"

    async def _run_graph(client: httpx.AsyncClient, graph: dict, timeout: float = 600) -> dict:
        """Submit a graph and block until ComfyUI finishes it; returns the
        history entry's outputs. Used for short helper jobs (prompt upsampling)."""
        r = await client.post(f"{m.COMFY_URL}/prompt", json={"prompt": graph, "client_id": uuid.uuid4().hex})
        if r.status_code != 200:
            raise HTTPException(502, f"ComfyUI rejected the workflow: {r.text[:800]}")
        pid = r.json()["prompt_id"]
        waited = 0.0
        while waited < timeout:
            h = (await client.get(f"{m.COMFY_URL}/history/{pid}")).json()
            if pid in h:
                st = h[pid].get("status", {})
                if st.get("status_str") == "error":
                    msg = next((x[1].get("exception_message", "") for x in st.get("messages", [])
                                if x[0] == "execution_error"), "execution error")
                    raise HTTPException(502, f"ComfyUI error: {msg[:500]}")
                return h[pid].get("outputs", {})
            await asyncio.sleep(0.5)
            waited += 0.5
        raise HTTPException(504, "ComfyUI helper job timed out")

    async def _models(client: httpx.AsyncClient) -> dict:
        unets = await _choices(client, "UNETLoader", "unet_name")
        clips = await _choices(client, "CLIPLoader", "clip_name")
        vaes = await _choices(client, "VAELoader", "vae_name")
        flux_unets = [u for u in unets if flux3.pick([u], flux3.UNET_PREF) and not flux3.UNET_EXCLUDE.search(u)]
        return {
            "unets": flux_unets,
            "clips": [c for c in clips if "flux3" in c.lower() or "flux_3" in c.lower()],
            "vaes": [v for v in vaes if "flux" in v.lower()],
            "upsamplers": [c for c in clips if flux3.UPSAMPLER_PREF.search(c)],
            "defaults": {
                "unet": flux3.pick(flux_unets, flux3.UNET_PREF),
                "clip": flux3.pick(clips, flux3.CLIP_PREF),
                "vae": flux3.pick(vaes, flux3.VAE_PREF),
                "upsampler": flux3.pick(clips, flux3.UPSAMPLER_PREF),
            },
        }

    @app.get("/api/flux3/models")
    async def flux3_models():
        if m.MOCK:
            return {"unets": ["mock-flux3"], "clips": ["mock"], "vaes": ["mock"], "upsamplers": ["mock"],
                    "defaults": {"unet": "mock-flux3", "clip": "mock", "vae": "mock", "upsampler": "mock"},
                    "ready": True}
        async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
            out = await _models(client)
        d = out["defaults"]
        out["ready"] = bool(d["unet"] and d["clip"] and d["vae"])
        return out

    async def _upsample(client, text: str, width: int, height: int, seed: int, upsampler: str = "") -> str:
        mdl = await _models(client)
        clip = upsampler or mdl["defaults"]["upsampler"]
        if not clip:
            raise HTTPException(502, "No Flux 3 prompt-upsampler text encoder installed in ComfyUI")
        graph = flux3.build_upsample_graph(text=text, aspect_w=width, aspect_h=height, clip=clip, seed=seed)
        outs = await _run_graph(client, graph)
        for node_out in outs.values():
            t = node_out.get("text")
            if t:
                return (t[0] if isinstance(t, list) else t).strip()
        raise HTTPException(502, "Prompt upsampler returned no text")

    @app.post("/api/flux3/upsample")
    async def flux3_upsample(
        prompt: str = Form(...),
        width: int = Form(1024),
        height: int = Form(1024),
        seed: int = Form(-1),
        upsampler: str = Form(""),
    ):
        """Expand a short idea into BFL's dense, layout-aware caption (shown to
        the user so they can edit it before generating)."""
        if m.MOCK:
            return {"prompt": f"[mock upsample] {prompt}"}
        if seed < 0:
            seed = random.randrange(2**31)
        async with httpx.AsyncClient(timeout=700, trust_env=False) as client:
            return {"prompt": await _upsample(client, prompt, width, height, seed, upsampler)}

    @app.post("/api/generate_flux3")
    async def generate_flux3(
        prompt: str = Form(...),
        width: int = Form(1024),
        height: int = Form(1024),
        steps: int = Form(8),
        cfg: float = Form(1.0),
        seed: int = Form(-1),
        negative: str = Form(""),
        unet: str = Form(""),
        text_encoder: str = Form(""),
        vae: str = Form(""),
        sampler: str = Form("euler"),
        upsample: bool = Form(False),
        match_ref_size: bool = Form(False),
        ref_megapixels: float = Form(1.0),
        swap_model: str = Form("inswapper_128.onnx"),
        face_restore_model: str = Form("none"),
        mask: UploadFile | None = File(None),
        mask_feather: int = Form(12),
        refs: list[UploadFile] = File([]),
        face_indices: list[int] = Form([]),
        face_images: list[UploadFile] = File([]),
        lora_names: list[str] = Form([]),
        lora_strengths: list[float] = Form([]),
    ):
        """Flux 3 Klein text-to-image. With `refs` it becomes reference-guided
        generation / instruction editing (each ref is chained on via
        ReferenceLatent). `match_ref_size` sizes the canvas from the first ref
        (use for edits). `upsample` rewrites the prompt through BFL's Qwen3.5
        upsampler first; the final prompt is returned."""
        if seed < 0:
            seed = uuid.uuid4().int % (2**48)
        if len(face_indices) != len(face_images):
            raise HTTPException(400, "face_indices and face_images must have the same length")
        if len(lora_names) != len(lora_strengths):
            raise HTTPException(400, "lora_names and lora_strengths must have the same length")
        # same scrub the Krea path applies: plural/"recurring" framing makes
        # these models paint multi-panel contact sheets
        prompt = director._fix_repetition_cues(director._fix_plural_framing(prompt))

        job_id = uuid.uuid4().hex[:12]
        subfolder = f"vsa_{job_id}"

        if m.MOCK:
            echo = await refs[0].read() if refs else b""
            m._new_job(job_id)
            asyncio.get_event_loop().create_task(m._mock_run(job_id, [echo], 1, is_video=False))
            return {"job_id": job_id, "prompt_id": "mock", "seed": seed, "prompt": prompt}

        async with httpx.AsyncClient(timeout=700, trust_env=False) as client:
            mdl = await _models(client)
            d = mdl["defaults"]
            unet = unet or d["unet"]
            text_encoder = text_encoder or d["clip"]
            vae = vae or d["vae"]
            if not (unet and text_encoder and vae):
                raise HTTPException(502, "Flux 3 models not found in ComfyUI (need Klein diffusion model, "
                                         "flux3 Qwen3-VL text encoder and flux3 VAE)")

            ref_files: list[str] = []
            for i, up in enumerate(refs):
                data = await up.read()
                if match_ref_size and i == 0:
                    try:
                        w0, h0 = Image.open(io.BytesIO(data)).size
                        scale = (ref_megapixels * 1_000_000 / (w0 * h0)) ** 0.5
                        width, height = int(w0 * scale), int(h0 * scale)
                    except Exception:
                        pass
                ref_files.append(await _upload(client, data, f"ref_{i}.png", subfolder))

            if upsample:
                prompt = await _upsample(client, prompt, width, height, seed % (2**31))

            loras = [{"name": n, "strength_model": s, "strength_clip": s}
                     for n, s in zip(lora_names, lora_strengths)]
            graph = flux3.build_flux3_graph(
                prompt=prompt, width=width, height=height, steps=steps, cfg=cfg, seed=seed,
                unet=unet, clip=text_encoder, vae=vae, negative=negative, refs=ref_files,
                loras=loras, sampler=sampler, ref_megapixels=ref_megapixels,
            )

            if mask is not None and ref_files:
                mdata = await mask.read()
                if mdata:
                    mfile = await _upload(client, mdata, "mask.png", subfolder)
                    flux3.add_mask_composite(graph, ref_files[0], mfile, width, height, mask_feather)

            if face_indices:
                faces = []
                for i, (idx, up) in enumerate(zip(face_indices, face_images)):
                    fname = await _upload(client, await up.read(), f"face_{i}.png", subfolder)
                    faces.append({"index": idx, "filename": fname})
                append_faceswap_chain(graph, faces, swap_model=swap_model, face_restore_model=face_restore_model)

            prompt_id = await m._submit(client, json.dumps(graph), job_id)

        return {"job_id": job_id, "prompt_id": prompt_id, "seed": seed, "prompt": prompt}
