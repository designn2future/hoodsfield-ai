"""3D scene layout -> image, and image -> 3D scene layout.

  POST /api/scene/generate  depth-map render of the user's 3D layout (+ prompt, optional identity refs) -> Qwen Image 2.1 with the
                            Fun-Controlnet-Union depth patch. Same job/SSE contract as every other image job.
  POST /api/scene/analyze   photo -> {depth map, camera field of view, objects with boxes + relative depth} (Depth Anything 3 +
                            MoGe FOV + Florence-2 region captions, all through ComfyUI). The frontend turns that into 3D.
  GET  /api/scene/status    which of the models are installed.
"""
import asyncio
import base64
import json
import re
import uuid
from pathlib import Path

import httpx
from fastapi import File, Form, HTTPException, UploadFile

import qwen21

DA3 = re.compile(r"depth_anything_3_mono_large", re.I)
MOGE = re.compile(r"moge_2_vitl", re.I)
PATCH = re.compile(r"qwen.*2[._]1.*(fun|control)", re.I)


def register(app, m):
    async def _choices(client, node, field):
        r = await client.get(f"{m.COMFY_URL}/object_info/{node}")
        r.raise_for_status()
        try:
            spec = r.json()[node]["input"]["required"][field]
            opts = spec[0]
            if opts == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict):     # newer node schema: ["COMBO", {"options": [...]}]
                opts = spec[1].get("options", [])
            return list(opts) if isinstance(opts, list) else []
        except (KeyError, IndexError, TypeError):
            return []

    async def _status(client):
        patches = await _choices(client, "ModelPatchLoader", "name")
        geo = await _choices(client, "LoadDA3Model", "model_name")
        out = {
            "patch": next((n for n in patches if PATCH.search(n)), ""),
            "da3": next((n for n in geo if DA3.search(n)), ""),
            "moge": next((n for n in await _choices(client, "LoadMoGeModel", "model_name") if MOGE.search(n)), ""),
        }
        out["can_generate"] = bool(out["patch"])
        out["can_analyze"] = bool(out["da3"])
        return out

    @app.get("/api/scene/status")
    async def scene_status():
        async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
            try:
                return await _status(client)
            except Exception as e:
                return {"patch": "", "da3": "", "moge": "", "can_generate": False, "can_analyze": False, "error": str(e)}

    async def _upload(client, data: bytes, name: str, sub: str) -> str:
        r = await client.post(f"{m.COMFY_URL}/upload/image", files={"image": (name, data, "image/png")},
                              data={"subfolder": sub, "type": "input", "overwrite": "true"})
        if r.status_code != 200:
            raise HTTPException(502, f"ComfyUI upload failed: {r.text[:200]}")
        return f"{sub}/{name}"

    @app.post("/api/scene/generate")
    async def scene_generate(
        prompt: str = Form(...),
        control: UploadFile = File(...),
        negative: str = Form(""),
        width: int = Form(1344),
        height: int = Form(768),
        steps: int = Form(25),
        cfg: float = Form(1.0),
        seed: int = Form(-1),
        strength: float = Form(0.85),
        end: float = Form(0.7),
        refs: list[UploadFile] = File([]),
    ):
        if seed < 0:
            seed = uuid.uuid4().int % (2**48)
        job_id = uuid.uuid4().hex[:12]
        if m.MOCK:
            echo = await control.read()
            m._new_job(job_id)
            asyncio.get_event_loop().create_task(m._mock_run(job_id, [echo], 1, is_video=False))
            return {"job_id": job_id, "prompt_id": "mock", "seed": seed}
        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            st = await _status(client)
            if not st["patch"]:
                raise HTTPException(501, "The Qwen Image 2.1 Fun-Controlnet-Union model is not installed (models/model_patches).")
            unets = [u for u in await _choices(client, "UNETLoader", "unet_name") if "qwen_image_2.1" in u.lower() and not qwen21.TURBO_PREF.search(u)]
            clips = [c for c in await _choices(client, "CLIPLoader", "clip_name") if "qwen3vl_8b" in c.lower()]
            vaes = [v for v in await _choices(client, "VAELoader", "vae_name") if "qwen_image_2.1" in v.lower() or "qwen_image_vae" in v.lower()]
            d = {"unet": qwen21.pick(unets, qwen21.UNET_PREF), "clip": qwen21.pick(clips, *qwen21.CLIP_PREF), "vae": qwen21.pick(vaes, qwen21.VAE_PREF)}
            if not all(d.values()):
                raise HTTPException(502, "Qwen Image 2.1 models not found in ComfyUI")
            sub = f"vsa_{job_id}"
            ctl = await _upload(client, await control.read(), "control.png", sub)
            files = [await _upload(client, await up.read(), f"ref_{i}.png", sub) for i, up in enumerate(refs)]
            graph = qwen21.build_graph(
                prompt=prompt, negative=negative, width=width, height=height, steps=steps, cfg=cfg, seed=seed,
                unet=d["unet"], clip=d["clip"], vae=d["vae"], refs=files, prefix="vsa/scene",
                control={"patch": st["patch"], "image": ctl, "strength": strength, "end": min(1.0, max(0.2, end))})
            pid = await m._submit(client, json.dumps(graph), job_id)
        return {"job_id": job_id, "prompt_id": pid, "seed": seed, "prompt": prompt}

    # ------------------------------------------------------------------ image -> scene
    async def _run_and_wait(client, graph, timeout=240):
        r = await client.post(f"{m.COMFY_URL}/prompt", json={"prompt": graph, "client_id": "scene-analyze"})
        if r.status_code != 200:
            raise HTTPException(502, f"ComfyUI rejected the analysis graph: {r.text[:600]}")
        pid = r.json()["prompt_id"]
        for _ in range(timeout * 2):
            await asyncio.sleep(0.5)
            h = (await client.get(f"{m.COMFY_URL}/history/{pid}")).json().get(pid)
            if h and h.get("status", {}).get("completed") is not None or (h and h.get("outputs")):
                if h.get("status", {}).get("status_str") == "error":
                    msgs = [x for x in h["status"].get("messages", []) if x[0] == "execution_error"]
                    raise HTTPException(502, "analysis failed: " + (str(msgs[-1][1].get("exception_message"))[:400] if msgs else "unknown"))
                return h["outputs"]
        raise HTTPException(504, "scene analysis timed out")

    @app.post("/api/scene/analyze")
    async def scene_analyze(image: UploadFile = File(...)):
        async with httpx.AsyncClient(timeout=300, trust_env=False) as client:
            st = await _status(client)
            if not st["da3"]:
                raise HTTPException(501, "Depth Anything 3 is not installed (models/geometry_estimation).")
            sub = f"vsa_scene_{uuid.uuid4().hex[:8]}"
            img = await _upload(client, await image.read(), "src.png", sub)
            g = {
                "1": {"class_type": "LoadImage", "inputs": {"image": img}},
                "2": {"class_type": "LoadDA3Model", "inputs": {"model_name": st["da3"], "weight_dtype": "default"}},
                "3": {"class_type": "DA3Inference", "inputs": {"da3_model": ["2", 0], "image": ["1", 0], "resolution": 756,
                                                              "resize_method": "upper_bound_resize", "mode": "mono"}},
                "4": {"class_type": "DA3Render", "inputs": {"da3_geometry": ["3", 0], "output": "depth", "output.normalization": "min_max",
                                                           "output.apply_sky_clip": True}},
                "5": {"class_type": "SaveImage", "inputs": {"images": ["4", 0], "filename_prefix": "vsa/scene_depth"}},
            }
            if st["moge"]:
                g["10"] = {"class_type": "LoadMoGeModel", "inputs": {"model_name": st["moge"]}}
                g["11"] = {"class_type": "MoGeInference", "inputs": {"moge_model": ["10", 0], "image": ["1", 0], "resolution_level": 6,
                                                                    "fov_x_degrees": 0.0, "batch_size": 1,
                                                                    "force_projection": True, "apply_mask": True, "refine_steps": 3}}
                g["12"] = {"class_type": "MoGeGeometryToFOV", "inputs": {"moge_geometry": ["11", 0], "axis": "horizontal", "unit": "degrees"}}
                g["13"] = {"class_type": "PreviewAny", "inputs": {"source": ["12", 0]}}
            if (await _choices(client, "Florence2ModelLoader", "model")):
                g["20"] = {"class_type": "Florence2ModelLoader", "inputs": {"model": "Florence-2-base", "precision": "fp16"}}
                g["21"] = {"class_type": "Florence2Run", "inputs": {"image": ["1", 0], "florence2_model": ["20", 0], "text_input": "",
                                                                   "task": "region_caption", "fill_mask": False, "keep_model_loaded": False,
                                                                   "max_new_tokens": 1024, "num_beams": 3, "do_sample": False, "seed": 1}}
                g["22"] = {"class_type": "PreviewAny", "inputs": {"source": ["21", 2]}}
            outs = await _run_and_wait(client, g)
            depth_png = None
            texts = {}
            for nid, o in outs.items():
                for im in o.get("images", []):
                    if nid == "5":
                        v = await client.get(f"{m.COMFY_URL}/view", params={"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                        depth_png = base64.b64encode(v.content).decode()
                if o.get("text"):
                    texts[nid] = o["text"][0] if isinstance(o["text"], list) else o["text"]
            fov = None
            try:
                fov = float(str(texts.get("13", "")).strip())
            except ValueError:
                pass
            objects = []
            raw = str(texts.get("22") or "")
            for lab, locs in re.findall(r"([^<>]+?)((?:<loc_\d+>){4})", raw):
                x0, y0, x1, y1 = [(int(v) + 0.5) / 1000 for v in re.findall(r"<loc_(\d+)>", locs)]
                objects.append({"label": lab.strip(" ,.").lower(), "box": [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]})
            if depth_png and objects:
                try:
                    import io
                    import numpy as np
                    from PIL import Image
                    d = np.asarray(Image.open(io.BytesIO(base64.b64decode(depth_png))).convert("L"), dtype=np.float32) / 255.0
                    H, W = d.shape
                    for o in objects:
                        x0, y0, x1, y1 = o["box"]
                        reg = d[int(y0 * H):max(int(y1 * H), int(y0 * H) + 1), int(x0 * W):max(int(x1 * W), int(x0 * W) + 1)]
                        o["near"] = float(np.median(reg)) if reg.size else None
                except Exception:
                    pass
            return {"fov_x": fov, "depth_png": depth_png, "objects": objects, "raw": {k: str(v)[:1500] for k, v in texts.items()}}


# ---------------------------------------------------------------------- stage directions -> pose plan
_PRESETS = {
    "stand": "standing, arms at sides", "relaxed": "standing loosely, weight easy", "sit": "seated (a chair is added)", "walk": "mid-stride",
    "run": "running", "hips": "hands on hips", "crossed": "arms folded across the chest", "point": "one arm pointing (set points_at)",
    "handsup": "both hands raised (surrender / celebration)", "reach": "one arm reaching forward", "guard": "fighting / boxing stance",
    "crouch": "crouching low", "kneel": "kneeling on both knees", "phone": "holding a phone to the ear",
}
_HANDS = ["open", "relaxed", "fist", "point", "grip", "peace", "thumbs"]
_ARMS = {"down": "at the side", "out": "stretched out to the side", "forward": "reaching forward", "up": "raised", "hip": "hand on hip",
         "lap": "hand in lap", "head": "hand behind head", "back": "stretched along the top of a couch/seat back", "rest": "resting on an armrest"}
_LEGS = {"down": "foot on floor", "extended": "stretched out in front", "up": "foot up on the seat, knee raised",
         "side": "stretched out sideways along the seat (reclined)", "cross": "ankle over the other knee"}

_DIRECT_SYSTEM = (
    "You are a film director's blocking assistant. Turn stage directions into a JSON plan that positions mannequins in a 3D set. "
    "Reply with ONE JSON object and nothing else.\n"
    "Coordinates are metres. The camera sits at the +z end looking toward -z, so x>0 is screen-right, x<0 screen-left, "
    "z>0 is closer to the camera and z<0 is further away. Keep people between x=-4..4 and z=-6..3 and at least 0.6 m apart.\n"
    "Schema: {\"people\":[{\"label\":str (how the prompt names them, e.g. \"the detective\"),\"gender\":\"male\"|\"female\","
    "\"preset\":one of PRESETS,\"hands\":[left,right] each one of HANDS,\"x\":number,\"z\":number,"
    "\"faces\":\"camera\"|\"away\"|\"left\"|\"right\"|<another person's label>,"
    "\"looks_at\":<another person's label>|\"camera\"|null,\"points_at\":<another person's label>|\"camera\"|null,"
    "\"sits_on\":null|couch|armchair|chair|bench|stool|bed (set it whenever the person sits; people sharing one couch/bench/bed get the same value),"
    "\"limbs\":{optional, anatomical sides of THAT person: armL/armR one of ARMS, legL/legR one of LEGS},"
    "\"height\":optional metres,\"hair\":optional none|short|bob|long|ponytail|bun,\"note\":optional short phrase about clothes or props}],"
    "\"camera\":{\"lens\":optional mm 18-85,\"height\":optional metres,\"pitch\":optional degrees}}\n"
    "Use the preset that best fits the action; use \"points_at\" only with preset \"point\". People who talk to each other face each other. "
    "Prefer a natural, cinematic composition (rule of thirds, depth between people). "
    "Example: \"a woman sits on a couch, her right leg reclined on the couch and her arm outstretched over the top of the couch\" -> "
    "{\"people\":[{\"label\":\"woman\",\"gender\":\"female\",\"preset\":\"sit\",\"hands\":[\"relaxed\",\"relaxed\"],\"x\":0,\"z\":-1,\"faces\":\"camera\","
    "\"looks_at\":\"camera\",\"points_at\":null,\"sits_on\":\"couch\",\"limbs\":{\"legR\":\"side\",\"armL\":\"back\"}}],\"camera\":{}}"
)


def _direct_user(text: str, cast: list[dict]) -> str:
    return (f"PRESETS: {json.dumps(_PRESETS)}\nHANDS: {json.dumps(_HANDS)}\nARMS: {json.dumps(_ARMS)}\nLEGS: {json.dumps(_LEGS)}\n"
            f"People already in the scene (reuse their labels when the directions mention them): {json.dumps(cast)}\n"
            f"Stage directions: {text}\nJSON:")


def register_direct(app, m):
    import director

    @app.post("/api/scene/direct")
    async def scene_direct(body: dict):
        text = str(body.get("text", "")).strip()
        if not text:
            raise HTTPException(400, "Describe where the people should be and what they are doing.")
        cast = body.get("cast") or []
        try:
            async with httpx.AsyncClient(timeout=180, trust_env=False) as client:
                models = await director.ollama_models(client)
                model = director.pick_text_model(models)
                if not model:
                    return {"plan": None, "reason": "Ollama has no models pulled"}
                req = {"model": model, "stream": False, "format": "json", "think": False,
                       "messages": [{"role": "system", "content": _DIRECT_SYSTEM}, {"role": "user", "content": _direct_user(text, cast)}],
                       "options": {"temperature": 0.4, "num_ctx": 4096, "num_predict": 1400}}
                r = await client.post(f"{director.OLLAMA_URL}/api/chat", json=req)
                if r.status_code != 200:
                    req.pop("think", None)
                    r = await client.post(f"{director.OLLAMA_URL}/api/chat", json=req)
                if r.status_code != 200:
                    return {"plan": None, "reason": f"Ollama error {r.status_code}"}
                plan = director._clean_json(r.json().get("message", {}).get("content", ""))
                if not isinstance(plan.get("people"), list) or not plan["people"]:
                    return {"plan": None, "reason": "the model returned no people"}
                return {"plan": plan, "model": model}
        except Exception as e:  # Ollama not running etc: the browser falls back to its built-in parser
            return {"plan": None, "reason": f"local AI unavailable ({type(e).__name__})"}


# ---------------------------------------------------------------------- saved scenes (survive reloads, rebuilds and restarts)
SCENES_DIR = Path(__file__).resolve().parent.parent / "scenes"


def _safe(name: str) -> str:
    n = re.sub(r"[^A-Za-z0-9 _.\-]", "", str(name)).strip(" .")[:60]
    if not n:
        raise HTTPException(400, "Give the scene a name (letters, numbers, spaces).")
    return n


def register_saves(app, m):
    SCENES_DIR.mkdir(exist_ok=True)

    @app.get("/api/scene/saves")
    async def scene_saves():
        out = []
        for f in sorted(SCENES_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            jpg = f.with_suffix(".jpg")
            out.append({"name": f.stem, "saved": f.stat().st_mtime, "size": f.stat().st_size,
                        "thumb": ("data:image/jpeg;base64," + base64.b64encode(jpg.read_bytes()).decode()) if jpg.exists() else None})
        return {"scenes": out}

    @app.post("/api/scene/saves/{name}")
    async def scene_save(name: str, body: dict):
        n = _safe(name)
        (SCENES_DIR / f"{n}.json").write_text(json.dumps(body.get("state", {})), encoding="utf-8")
        th = body.get("thumb") or ""
        if th.startswith("data:image/jpeg;base64,"):
            (SCENES_DIR / f"{n}.jpg").write_bytes(base64.b64decode(th.split(",", 1)[1]))
        return {"ok": True, "name": n}

    @app.get("/api/scene/saves/{name}")
    async def scene_open(name: str):
        f = SCENES_DIR / f"{_safe(name)}.json"
        if not f.exists():
            raise HTTPException(404, "No scene with that name.")
        return json.loads(f.read_text(encoding="utf-8"))

    @app.delete("/api/scene/saves/{name}")
    async def scene_delete(name: str):
        n = _safe(name)
        for ext in (".json", ".jpg"):
            (SCENES_DIR / f"{n}{ext}").unlink(missing_ok=True)
        return {"ok": True}
