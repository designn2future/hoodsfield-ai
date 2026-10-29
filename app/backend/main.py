"""
Hoodsfield — backend proxy between the browser editor and ComfyUI.

Flow:
  POST /api/generate  (multipart: depth-frame PNGs + generation params)
    -> upload frames to ComfyUI's input dir (per-job subfolder)
    -> inject params into the workflow template (workflows/*.json)
    -> POST to ComfyUI /prompt
    -> background task listens on ComfyUI's websocket for progress
  GET  /api/events/{job_id}   -> SSE progress stream for the browser
  GET  /api/video/{job_id}    -> proxies the finished video bytes
  GET  /api/health            -> checks ComfyUI reachability
"""

import app_settings  # noqa: F401  loads settings + .env into the environment BEFORE any other module reads it
import genres
import asyncio
import io
import json
import os
import re
import tempfile
import time
import uuid
from pathlib import Path

import httpx
import websockets
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from PIL import Image, ImageFilter

import audio_analysis
import jobs
import director
import h3_coach
import render as final_render
import story
import whisper_stt
from h3 import (
    AUDIO_VAE_PREF,
    DEFAULT_FRAMES,
    FRAME_GRID,
    MODEL_PREF,
    TEXT_ENCODER_PREF,
    VIDEO_VAE_PREF,
    build_h3_graph,
    canvas_for,
    compose_h3_prompt,
    pick,
    snap_frames,
    timeline_to_shots,
)
from workflow import (
    add_depth_control_refine,
    add_two_pass_refine,
    append_faceswap_chain,
    append_lora_chain,
    attach_moodboard_images,
    build_workflow,
    bypass_enhancer_when_zero,
    set_video_lora_chain,
    use_plain_unet_loader,
    use_vision_reference,
)

# ---------------------------------------------------------------- config

BASE_DIR = Path(__file__).parent

# lightweight .env loader (no extra dependency)
_env_file = BASE_DIR / ".env"
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

COMFY_URL = os.getenv("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
COMFY_WS = COMFY_URL.replace("http://", "ws://").replace("https://", "wss://")
COMFY_INPUT_DIR = os.getenv("COMFY_INPUT_DIR", "input")
WORKFLOW_FILE = os.getenv("WORKFLOW_FILE", "ltx_depth_workflow.json")
WORKFLOW_IMAGE_FILE = os.getenv("WORKFLOW_IMAGE_FILE", "sketch_image_workflow.json")
WORKFLOW_SKETCH_CN_FILE = os.getenv("WORKFLOW_SKETCH_CN_FILE", "sketch_controlnet_workflow.json")
WORKFLOW_I2V_FILE = os.getenv("WORKFLOW_I2V_FILE", "ltx23_i2v_workflow.json")
WORKFLOW_KREA_FILE = os.getenv("WORKFLOW_KREA_FILE", "krea2_workflow.json")
WORKFLOW_SKETCH_KREA_FILE = os.getenv("WORKFLOW_SKETCH_KREA_FILE", "sketch_krea2_workflow.json")
# Local Ollama (image -> prompt description via a Qwen-VL vision model)
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL", "")  # empty = auto-detect qwen*vl
# MiniMax H3: longest clip this GPU can sample without spilling. 175 frames
# = 7.3 s on the 17k+5 grid (the "7 seconds" ceiling on the RTX 4060 Ti 16GB).
H3_MAX_FRAMES = int(os.getenv("H3_MAX_FRAMES", "175"))
H3_MODEL = os.getenv("H3_MODEL", "")               # empty = first file matching /minimax.*h3/
H3_TEXT_ENCODER = os.getenv("H3_TEXT_ENCODER", "")  # empty = first CLIPLoader file matching /minimax/
H3_VIDEO_VAE = os.getenv("H3_VIDEO_VAE", "")        # empty = minimax video fp16 (int8_convrot decodes black)
H3_AUDIO_VAE = os.getenv("H3_AUDIO_VAE", "")
# Scratch dir for uploaded music tracks / final renders
WORK_DIR = Path(os.getenv("VSA_WORK_DIR", tempfile.gettempdir())) / "vsa_work"
WORK_DIR.mkdir(parents=True, exist_ok=True)

# COMFY_MOCK=1 -> no ComfyUI needed: simulates progress, echoes the sketch back
# as the "image", and returns an animated GIF of the depth frames as the "video".
MOCK = os.getenv("COMFY_MOCK", "0") == "1"

app = FastAPI(title="Hoodsfield backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
from remote_auth import RemoteAuth  # login gate for tunnelled (internet) traffic; LAN/localhost/Tailscale stay open
app.add_middleware(RemoteAuth)
from resource_guard import MemoryGate, STATE as _GUARD  # noqa: E402  (refuses to START a heavy job when the PC is nearly out of RAM)
app.add_middleware(MemoryGate)

# job_id -> {"status", "queue", "video", "error", "prompt_id"}
JOBS: dict[str, dict] = {}


MEDIA_TYPES = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".webp": "image/webp",
    ".gif": "image/gif", ".png": "image/png", ".jpg": "image/jpeg",
}


def _media_for(filename: str) -> str:
    return MEDIA_TYPES.get(Path(filename).suffix.lower(), "application/octet-stream")


# Shared live feed: every connected screen (PC, phone) hears about every job, whoever started it.
FEED_SUBS: set = set()


def _feed(ev: dict):
    for q in list(FEED_SUBS):
        try:
            q.put_nowait(ev)
        except Exception:
            pass


def _new_job(job_id: str, prompt_id: str = "", titles: dict | None = None) -> dict:
    JOBS[job_id] = {
        "status": "running",
        "queue": asyncio.Queue(),
        "video": None,
        "error": None,
        "prompt_id": prompt_id,
        "cancelled": False,
        "mock_bytes": None,
        "mock_media": None,
        "titles": titles or {},  # node id -> human title, for progress text
    }
    return JOBS[job_id]


async def _mock_run(job_id: str, images: list[bytes], fps: int, is_video: bool):
    """Simulate a generation so the full UI flow can be tested without ComfyUI."""
    job = JOBS[job_id]
    await job["queue"].put({"type": "status", "text": "MOCK MODE — no ComfyUI, echoing your input back"})
    total = 20
    for i in range(total):
        await asyncio.sleep(0.08)
        if job["cancelled"]:
            job["status"] = "cancelled"
            await job["queue"].put({"type": "error", "text": "Cancelled"})
            return
        await job["queue"].put({"type": "progress", "value": i + 1, "max": total})
    job["mock_bytes"], job["mock_media"] = images[0], "image/png"
    if is_video and len(images) > 1:
        pil = [Image.open(io.BytesIO(b)).convert("RGB") for b in images]
        buf = io.BytesIO()
        pil[0].save(buf, format="GIF", save_all=True, append_images=pil[1:],
                    duration=max(20, int(1000 / fps)), loop=0)
        job["mock_bytes"], job["mock_media"] = buf.getvalue(), "image/gif"
    job["status"] = "done"
    await job["queue"].put({"type": "done", "url": f"/api/video/{job_id}", "media": job["mock_media"]})


@app.exception_handler(httpx.TransportError)
async def comfy_unreachable(request, exc):
    return JSONResponse(
        status_code=502,
        content={"detail": f"Cannot reach ComfyUI at {COMFY_URL} — is it running? ({exc})"},
    )


def _load_template(name: str) -> str:
    path = BASE_DIR / "workflows" / name
    if not path.exists():
        raise HTTPException(500, f"Workflow template not found: {path}")
    return path.read_text()


async def _keep_source(job_id: str, graph: dict):
    """Keep a copy of the picture an edit started from, so Explore can show a before/after slider."""
    try:
        for nid, n in graph.items():
            if not isinstance(n, dict) or n.get("class_type") != "LoadImage" or str(nid) == "21":   # 21 = Qwen depth control, not the photo
                continue
            name = str(n.get("inputs", {}).get("image", ""))
            if not name:
                continue
            sub, _, fn = name.replace("\\", "/").rpartition("/")
            async with httpx.AsyncClient(timeout=30, trust_env=False) as c:
                r = await c.get(f"{COMFY_URL}/view", params={"filename": fn, "subfolder": sub, "type": "input"})
            if r.status_code == 200 and r.content:
                d = jobs.WORK_DIR / "job_sources"
                d.mkdir(parents=True, exist_ok=True)
                (d / f"{job_id}{Path(fn).suffix or '.png'}").write_bytes(r.content)
            return
    except Exception:
        pass


async def _submit(client: httpx.AsyncClient, graph_str: str, job_id: str) -> str:
    """Parse injected graph, submit to ComfyUI, register the job, start monitor."""
    try:
        graph = json.loads(graph_str)
    except json.JSONDecodeError as e:
        raise HTTPException(500, f"Workflow template produced invalid JSON: {e}")
    r = await client.post(f"{COMFY_URL}/prompt", json={"prompt": graph, "client_id": job_id})
    if r.status_code != 200:
        raise HTTPException(502, f"ComfyUI rejected the workflow: {r.text[:1000]}")
    prompt_id = r.json()["prompt_id"]
    titles = {
        nid: n.get("_meta", {}).get("title", "")
        for nid, n in graph.items() if isinstance(n, dict)
    }
    _new_job(job_id, prompt_id, titles)
    try:
        kind, family, title = jobs.classify(graph)
        jobs.upsert(job_id, kind=kind, family=family, title=title[:300], prompt_id=prompt_id, started=time.time(), status="running")
        _feed({"type": "started", "job_id": job_id, "kind": kind, "title": title[:120]})
    except Exception:
        pass  # history is best-effort; never block a render on it
    if kind in ("image-qwen21-edit", "image-flux3-edit"):
        asyncio.get_event_loop().create_task(_keep_source(job_id, graph))
    asyncio.get_event_loop().create_task(_monitor(job_id, prompt_id))
    return prompt_id


# ---------------------------------------------------------------- routes


@app.post("/api/cancel/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a generation: drop it from ComfyUI's pending queue, or interrupt
    it if it's the one currently executing."""
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    if job["status"] != "running":
        return {"ok": True, "status": job["status"]}
    job["cancelled"] = True
    if MOCK or not job["prompt_id"]:
        return {"ok": True, "status": "cancelling"}  # composite: its runner stops the active sub-job
    prompt_id = job["prompt_id"]
    async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
        # remove from the pending queue (no-op if it already started) …
        await client.post(f"{COMFY_URL}/queue", json={"delete": [prompt_id]})
        # … then interrupt if it's the one executing
        r = await client.get(f"{COMFY_URL}/queue")
        running = [e[1] for e in r.json().get("queue_running", []) if len(e) > 1]
        if prompt_id in running:
            await client.post(f"{COMFY_URL}/interrupt")
        else:
            # it was still pending: ComfyUI will never emit an event for it,
            # so finish the job from here
            job["status"] = "cancelled"
            job["error"] = "Cancelled"
            await job["queue"].put({"type": "error", "text": "Cancelled"})
    return {"ok": True, "status": "cancelling"}


@app.get("/api/health")
async def health():
    out = {"ok": True, "comfy": COMFY_URL, "comfy_reachable": False, "mock": MOCK, "ollama": False, "ollama_models": []}
    try:
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            r = await client.get(f"{COMFY_URL}/system_stats")
            r.raise_for_status()
            out["comfy_reachable"] = True
    except Exception as e:
        out["detail"] = str(e)
    try:
        async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
            out["ollama_models"] = await director.ollama_models(client)
            out["ollama"] = True
            out["ollama_text_model"] = director.pick_text_model(out["ollama_models"])
    except Exception:
        pass
    return out


_H3_FP16_ACCUM_OK: bool | None = None


async def _supports_fp16_accumulation() -> bool:
    """DiffusionModelLoaderKJ's `enable_fp16_accumulation` needs
    `torch.backends.cuda.matmul.allow_fp16_accumulation`, added in pytorch
    2.7.1 — forcing it on an older torch build crashes H3 generation outright
    (`RuntimeError: Failed to set fp16 accumulation...`) rather than just
    skipping the optimization. Query ComfyUI's actual installed torch once
    (via /system_stats, which reports it directly) and cache the answer for
    the process lifetime, instead of assuming a version that may not hold on
    every box this app runs against."""
    global _H3_FP16_ACCUM_OK
    if _H3_FP16_ACCUM_OK is not None:
        return _H3_FP16_ACCUM_OK
    try:
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            r = await client.get(f"{COMFY_URL}/system_stats")
            r.raise_for_status()
            version = r.json().get("system", {}).get("pytorch_version", "")
        m = re.match(r"(\d+)\.(\d+)\.(\d+)", version)
        _H3_FP16_ACCUM_OK = bool(m) and tuple(int(x) for x in m.groups()) >= (2, 7, 1)
    except Exception:
        _H3_FP16_ACCUM_OK = False
    return _H3_FP16_ACCUM_OK


@app.get("/api/llm/status")
async def llm_status():
    """Is a local Ollama up, and which model would the director use?"""
    try:
        async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
            models = await director.ollama_models(client)
        vision = [m for m in models if re.search(r"qwen[\d.]*[-]?vl", m, re.IGNORECASE)]
        return {"ok": True, "url": OLLAMA_URL, "models": models,
                "text_model": director.pick_text_model(models), "vision_model": OLLAMA_VISION_MODEL or (vision[0] if vision else "")}
    except Exception as e:
        return {"ok": False, "url": OLLAMA_URL, "models": [], "text_model": "", "vision_model": "", "detail": str(e)}


@app.get("/api/models")
async def models():
    """List checkpoints installed in ComfyUI (for the sketch-mode picker)."""
    if MOCK:
        return {"checkpoints": ["mock-checkpoint.safetensors"]}
    async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
        r = await client.get(f"{COMFY_URL}/object_info/CheckpointLoaderSimple")
        r.raise_for_status()
        info = r.json()
    try:
        ckpts = info["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0]
    except (KeyError, IndexError):
        ckpts = []
    return {"checkpoints": ckpts}


@app.get("/api/controlnets")
async def controlnets():
    """List ControlNet models installed in ComfyUI (for sketch structure control)."""
    if MOCK:
        return {"controlnets": ["mock-controlnet.safetensors"]}
    async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
        r = await client.get(f"{COMFY_URL}/object_info/ControlNetLoader")
        r.raise_for_status()
        info = r.json()
    try:
        cns = info["ControlNetLoader"]["input"]["required"]["control_net_name"][0]
    except (KeyError, IndexError):
        cns = []
    return {"controlnets": cns}


@app.get("/api/gguf_models")
async def gguf_models():
    """List diffusion-model files installed in ComfyUI: GGUF quants (ComfyUI-GGUF's
    UnetLoaderGGUF) plus plain safetensors transformers (core UNETLoader), so
    finetunes distributed as safetensors are selectable too. The response key
    stays `gguf_models` for frontend compatibility; the generate endpoints swap
    the loader node per file extension."""
    if MOCK:
        return {"gguf_models": ["mock-Krea-2-Turbo-Q4_K_M.gguf"]}
    names = []
    async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
        for loader, key in (("UnetLoaderGGUF", "unet_name"), ("UNETLoader", "unet_name")):
            r = await client.get(f"{COMFY_URL}/object_info/{loader}")
            r.raise_for_status()
            try:
                for n in r.json()[loader]["input"]["required"][key][0]:
                    if n not in names:
                        names.append(n)
            except (KeyError, IndexError):
                pass
    return {"gguf_models": names}


@app.get("/api/text_encoders")
async def text_encoders():
    """List text encoders installed in ComfyUI (Krea2's CLIPLoader picker —
    fp8 files are text-only, bf16/fp16 files also support moodboard images)."""
    if MOCK:
        return {"text_encoders": ["mock-qwen3vl_4b_fp8_scaled.safetensors"]}
    async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
        r = await client.get(f"{COMFY_URL}/object_info/CLIPLoader")
        r.raise_for_status()
        info = r.json()
    try:
        names = info["CLIPLoader"]["input"]["required"]["clip_name"][0]
    except (KeyError, IndexError):
        names = []
    return {"text_encoders": names}


@app.get("/api/vaes")
async def vaes():
    """List VAEs installed in ComfyUI."""
    if MOCK:
        return {"vaes": ["mock-qwen_image_vae.safetensors"]}
    async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
        r = await client.get(f"{COMFY_URL}/object_info/VAELoader")
        r.raise_for_status()
        info = r.json()
    try:
        names = info["VAELoader"]["input"]["required"]["vae_name"][0]
    except (KeyError, IndexError):
        names = []
    # Audio VAEs (LTX AV pipeline) crash image VAEEncode with a 0-element
    # reshape — never valid for the image endpoints this list feeds. Dedupe:
    # ComfyUI lists a file once per model path it's found under.
    names = list(dict.fromkeys(n for n in names if "audio" not in n.lower()))
    return {"vaes": names}


@app.get("/api/face_swap_models")
async def face_swap_models():
    """List ReActor swap models + face-restore models installed in ComfyUI."""
    if MOCK:
        return {"swap_models": ["mock-inswapper_128.onnx"], "face_restore_models": ["none"]}
    async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
        r = await client.get(f"{COMFY_URL}/object_info/ReActorFaceSwap")
        r.raise_for_status()
        info = r.json()
    try:
        req = info["ReActorFaceSwap"]["input"]["required"]
        swap = req["swap_model"][0]
        restore = req["face_restore_model"][0]
    except (KeyError, IndexError):
        swap, restore = [], []
    return {"swap_models": swap, "face_restore_models": restore}


@app.get("/api/loras")
async def loras():
    """List LoRAs installed in ComfyUI (core LoraLoader's picker)."""
    if MOCK:
        return {"loras": ["mock-realism_engine_krea2_v2.safetensors"]}
    async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
        r = await client.get(f"{COMFY_URL}/object_info/LoraLoader")
        r.raise_for_status()
        info = r.json()
    try:
        names = info["LoraLoader"]["input"]["required"]["lora_name"][0]
    except (KeyError, IndexError):
        names = []
    return {"loras": names}


@app.get("/api/loras/info")
async def loras_info():
    """{name: model family} for every installed LoRA (flux3, krea2, qwen, zimage, ltx, wan, minimax_h3, sdxl, unknown),
    read from the file headers, so a panel can show only the LoRAs that fit the model it generates with."""
    import lora_info
    names = (await loras())["loras"]
    roots = [Path(os.getenv("COMFY_ROOT", r"D:\ComfyUI-LTX2")) / "models" / "loras"] + [Path(d) / "loras" for d in os.getenv("EXTRA_MODEL_DIRS", "").split(os.pathsep) if d]
    out: dict[str, str] = {}
    for n in names:
        root = next((r for r in roots if (r / n).exists()), roots[0])
        out.update(await asyncio.to_thread(lora_info.families, root, [n]))
    return {"families": out}


# ---------------------------------------------------------------- image -> prompt

def _png_text_chunks(data: bytes) -> dict:
    """Extract tEXt/iTXt/zTXt key/value pairs from a PNG. ComfyUI embeds the
    executed API graph under 'prompt' (that's what drag-drop-into-ComfyUI
    re-imports); A1111 uses 'parameters'. Zero-dependency chunk walk."""
    import zlib

    out: dict[str, str] = {}
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return out
    i = 8
    while i + 8 <= len(data):
        length = int.from_bytes(data[i:i + 4], "big")
        ctype = data[i + 4:i + 8]
        chunk = data[i + 8:i + 8 + length]
        try:
            if ctype == b"tEXt":
                k, _, v = chunk.partition(b"\x00")
                out[k.decode("latin1")] = v.decode("latin1", "replace")
            elif ctype == b"zTXt":
                k, _, rest = chunk.partition(b"\x00")
                out[k.decode("latin1")] = zlib.decompress(rest[1:]).decode("latin1", "replace")
            elif ctype == b"iTXt":
                k, _, rest = chunk.partition(b"\x00")
                if len(rest) >= 2:
                    compressed = rest[0] == 1
                    parts = rest[2:].split(b"\x00", 2)
                    if len(parts) == 3:
                        txt = zlib.decompress(parts[2]) if compressed else parts[2]
                        out[k.decode("latin1")] = txt.decode("utf-8", "replace")
        except Exception:
            pass  # one malformed chunk shouldn't kill the others
        if ctype == b"IEND":
            break
        i += 8 + length + 4
    return out


def _prompt_from_comfy_graph(graph: dict) -> str | None:
    """Recover the positive prompt from an embedded ComfyUI API graph: find a
    sampler-ish node's 'positive' input and follow it upstream (through
    conditioning combinators) to the first node holding literal prompt text."""

    def literal_text(nid: str, depth: int = 0) -> str | None:
        node = graph.get(nid)
        if not isinstance(node, dict) or depth > 8:
            return None
        ins = node.get("inputs", {})
        for key in ("text", "prompt", "global_prompt", "local_prompts", "positive_prompt"):
            v = ins.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
        for v in ins.values():
            if isinstance(v, list) and len(v) == 2:
                t = literal_text(str(v[0]), depth + 1)
                if t:
                    return t
        return None

    for node in graph.values():
        if not isinstance(node, dict):
            continue
        pos = node.get("inputs", {}).get("positive")
        if isinstance(pos, list) and len(pos) == 2:
            t = literal_text(str(pos[0]))
            if t:
                return t
    return None


def _embedded_prompt(data: bytes) -> str | None:
    chunks = _png_text_chunks(data)
    if "prompt" in chunks:
        try:
            found = _prompt_from_comfy_graph(json.loads(chunks["prompt"]))
            if found:
                return found
        except (json.JSONDecodeError, TypeError):
            pass
    if "parameters" in chunks:  # A1111: positive prompt up to "Negative prompt:"
        text = chunks["parameters"].split("\nNegative prompt:")[0].strip()
        if text:
            return text
    return None


_DESCRIBE_INSTRUCTION = (
    "Describe this image as a single detailed image-generation prompt. Cover the "
    "subject and their appearance, the setting, composition and framing, lighting, "
    "color palette, mood, and artistic style (photo/painting/render, lens or medium). "
    "Write one paragraph of comma-separated descriptors. Output only the prompt, "
    "no preamble and no quotation marks."
)


async def _ollama_vision(images: list[bytes], instruction: str) -> tuple[str, str]:
    """Run the local Ollama Qwen-VL model over one or more images with the
    given instruction. Returns (response_text, model_name)."""
    import base64

    async with httpx.AsyncClient(timeout=600, trust_env=False) as client:
        try:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            r.raise_for_status()
        except Exception:
            raise HTTPException(
                502,
                f"Ollama is not reachable at {OLLAMA_URL} — start Ollama "
                "(and `ollama pull qwen3-vl` if you haven't installed a Qwen vision model).",
            )
        models = [m.get("name", "") for m in r.json().get("models", [])]
        model = OLLAMA_VISION_MODEL
        if not model:
            vl = [m for m in models if re.search(r"qwen[\d.]*[-]?vl", m, re.IGNORECASE)]
            if not vl:
                raise HTTPException(
                    502,
                    "No Qwen-VL vision model found in Ollama. Run e.g. `ollama pull qwen3-vl` "
                    f"(installed models: {', '.join(models) or 'none'}).",
                )
            model = vl[0]
        r = await client.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": model,
                "prompt": instruction,
                "images": [base64.b64encode(d).decode() for d in images],
                "stream": False,
                # each image costs several hundred–1000+ context tokens once
                # tokenized; the model's own default (as low as 4096) can be
                # eaten entirely by a handful of images, leaving no room for
                # the model to write an answer — give it real headroom
                "options": {"temperature": 0.4, "num_ctx": 16384},
            },
        )
        if r.status_code != 200:
            raise HTTPException(502, f"Ollama error: {r.text[:300]}")
        body = r.json()
        text = (body.get("response") or "").strip()
        if not text:
            hint = ""
            if body.get("thinking"):
                hint = (f" — {model} spent its reply budget on internal reasoning and never wrote an answer. "
                        "Try fewer/smaller images, or a non-reasoning vision model.")
            raise HTTPException(502, f"Ollama returned an empty description{hint}")
        return text, model


async def _ollama_describe(data: bytes, mime: str) -> dict:
    text, model = await _ollama_vision([_downscale_for_vision(data)], _DESCRIBE_INSTRUCTION)
    return {"prompt": text, "source": "ollama", "model": model}


@app.post("/api/describe_image")
async def describe_image(
    mode: str = Form("auto"),
    image: UploadFile = File(...),
):
    """Image -> generation prompt. mode='auto' first recovers the original
    prompt from ComfyUI/A1111 metadata embedded in the PNG (same data ComfyUI
    imports on drag-drop); if none, describes the image with a local Ollama
    Qwen-VL vision model. mode='vision' skips the metadata and always uses
    the vision model."""
    data = await image.read()
    if MOCK:
        return {"prompt": "mock description: a cinematic scene, dramatic lighting", "source": "mock"}
    if mode != "vision":
        embedded = _embedded_prompt(data)
        if embedded:
            return {"prompt": embedded, "source": "embedded"}
    return await _ollama_describe(data, image.content_type or "image/png")


_VIDEO_STYLE_INSTRUCTION = (
    "These images are frames sampled evenly from one music video. Analyze the "
    "video's overall visual aesthetic and write a reusable STYLE description to "
    "append to an image-generation prompt. Cover: color grading and palette, "
    "lighting style, film stock or digital look (grain, halation, bloom, "
    "sharpness), camera and lens character (focal-length feel, depth of field), "
    "composition and framing tendencies, era/genre vibe, mood and atmosphere, "
    "recurring visual motifs, wardrobe and set-design aesthetic. Do NOT describe "
    "the specific people, faces, lyrics, or story events — only the transferable "
    "visual style. Write one paragraph of comma-separated descriptors. Output "
    "only the description, no preamble and no quotation marks."
)


def _extract_video_frames(data: bytes, count: int = 6, max_side: int = 768) -> list[bytes]:
    """Decode an uploaded video and sample `count` frames evenly across its
    duration (skipping the first/last 5% — usually black/logo cards), resized
    to max_side and JPEG-encoded for the vision model. Blocking (cv2) — run
    via asyncio.to_thread."""
    import tempfile

    import cv2

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        f.write(data)
        path = f.name
    try:
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            raise HTTPException(400, "Could not decode the uploaded video")
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        frames = []
        if total > count:
            lo, hi = int(total * 0.05), int(total * 0.95)
            targets = [lo + int(i * (hi - lo) / max(1, count - 1)) for i in range(count)]
            for t in targets:
                cap.set(cv2.CAP_PROP_POS_FRAMES, t)
                ok, img = cap.read()
                if ok:
                    frames.append(img)
        if not frames:  # unknown frame count / seek-unfriendly codec: read through
            cap.release()
            cap = cv2.VideoCapture(path)
            step, i = 30, 0
            while len(frames) < count:
                ok, img = cap.read()
                if not ok:
                    break
                if i % step == 0:
                    frames.append(img)
                i += 1
        cap.release()
        if not frames:
            raise HTTPException(400, "No readable frames in the uploaded video")
        out = []
        for img in frames:
            h, w = img.shape[:2]
            scale = max_side / max(h, w)
            if scale < 1:
                img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 87])
            if ok:
                out.append(buf.tobytes())
        return out
    finally:
        os.unlink(path)


@app.post("/api/describe_video")
async def describe_video(
    video: UploadFile = File(...),
    frames: int = Form(6),
):
    """Reference video -> aesthetic/style descriptors for a generation prompt.
    Samples frames evenly across the video and asks the local Ollama Qwen-VL
    model for the transferable visual style (grading, lighting, lens, mood…),
    deliberately excluding subjects/story so it composes with the user's own
    prompt."""
    data = await video.read()
    if MOCK:
        return {"style": "mock style: moody teal-and-amber grade, 35mm grain, shallow depth of field", "source": "mock", "frames_analyzed": 0}
    if not data:
        raise HTTPException(400, "Empty video upload")
    frames = max(2, min(12, frames))
    images = await asyncio.to_thread(_extract_video_frames, data, frames)
    text, model = await _ollama_vision(images, _VIDEO_STYLE_INSTRUCTION)
    return {"style": text, "source": "ollama", "model": model, "frames_analyzed": len(images)}


_IMAGE_STYLE_INSTRUCTION = (
    "These images are mood-board / environment references the user generated for a video "
    "project. Analyze their shared visual aesthetic and write a reusable STYLE description "
    "to append to an image-generation prompt. Cover: color grading and palette, lighting "
    "style, film stock or digital look (grain, halation, bloom, sharpness), lens character "
    "and depth of field, composition and framing tendencies, environment/set-design and "
    "production-design details, era/genre vibe, mood and atmosphere, recurring visual "
    "motifs. Do NOT describe specific people, faces, or a story — only the transferable "
    "environment/style. Write one paragraph of comma-separated descriptors. Output only "
    "the description, no preamble and no quotation marks."
)


def _downscale_for_vision(data: bytes, max_side: int = 768) -> bytes:
    """Shrink an image to `max_side` before handing it to the local vision
    model. AI-generated reference stills are routinely 1024px+, and the
    video-style-analysis path already learned this lesson (see
    `_extract_video_frames`) — an untouched full-res image tokenizes into far
    more context than a small model's window (sometimes as little as 4096)
    can hold alongside the instruction text, silently leaving zero budget for
    the model to write an answer at all."""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    scale = max_side / max(img.width, img.height)
    if scale < 1:
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=87)
    return buf.getvalue()


@app.post("/api/describe_images_style")
async def describe_images_style(images: list[UploadFile] = File(...)):
    """Environment/mood-board reference images -> a shared style paragraph for the
    music-video director and the still prompts (text side of style guidance; the
    same images are also usable directly as Krea 2 moodboard conditioning for
    pixel-level style transfer)."""
    data = []
    for f in images:
        if f:
            d = await f.read()
            if d:
                data.append(d)
    if MOCK:
        return {"style": "mock style: neon-noir cityscape, wet reflective streets, teal-and-magenta grade", "source": "mock", "images_analyzed": len(data)}
    if not data:
        raise HTTPException(400, "No images uploaded")
    resized = [_downscale_for_vision(d) for d in data]
    text, model = await _ollama_vision(resized, _IMAGE_STYLE_INSTRUCTION)
    return {"style": text, "source": "ollama", "model": model, "images_analyzed": len(data)}


_VIDEO_CONTENT_INSTRUCTION = (
    "These images are frames sampled evenly from a reference video that tells a story. Describe what "
    "actually happens: the subjects/characters present, their actions, the setting, and the apparent "
    "sequence of events across the frames — this will be used to help an AI rewrite the story as a new "
    "short video. Do NOT describe visual style, color grading, or lens/camera aesthetics — only the "
    "content and story. Write a few plain sentences, no preamble, no markdown."
)

_IMAGES_CONTENT_INSTRUCTION = (
    "These images are reference photos/stills for a story someone wants retold as a short video. For "
    "each image, briefly describe the subject(s), their action, and the setting. Do NOT describe visual "
    "style or color grading — only the content. Write a few plain sentences per image, no preamble, no "
    "markdown."
)


@app.post("/api/story/describe_video")
async def story_describe_video(
    video: UploadFile = File(...),
    frames: int = Form(6),
):
    """Reference video -> story content notes (subjects/actions/setting/events),
    the content-side counterpart to /api/describe_video's style-only analysis."""
    data = await video.read()
    if MOCK:
        return {"notes": "mock notes: a person walks into a kitchen, picks up a mug, and reacts in surprise", "source": "mock", "frames_analyzed": 0}
    if not data:
        raise HTTPException(400, "Empty video upload")
    frames = max(2, min(12, frames))
    images = await asyncio.to_thread(_extract_video_frames, data, frames)
    text, model = await _ollama_vision(images, _VIDEO_CONTENT_INSTRUCTION)
    return {"notes": text, "source": "ollama", "model": model, "frames_analyzed": len(images)}


@app.post("/api/story/describe_images")
async def story_describe_images(images: list[UploadFile] = File(...)):
    """Reference jpgs -> story content notes (subjects/actions/setting)."""
    data = []
    for f in images:
        if f:
            d = await f.read()
            if d:
                data.append(d)
    if MOCK:
        return {"notes": "mock notes: a person stands on a rooftop at sunset, looking out over the city", "source": "mock", "images_analyzed": len(data)}
    if not data:
        raise HTTPException(400, "No images uploaded")
    resized = [_downscale_for_vision(d) for d in data]
    text, model = await _ollama_vision(resized, _IMAGES_CONTENT_INSTRUCTION)
    return {"notes": text, "source": "ollama", "model": model, "images_analyzed": len(data)}


@app.post("/api/story/transcribe")
async def story_transcribe(video: UploadFile = File(...)):
    """Reference video -> narration transcript (local faster-whisper), so the
    story director can be given real spoken content instead of vision alone."""
    data = await video.read()
    if MOCK:
        return {"text": "mock transcript: so today I finally tried the new coffee shop downtown...",
                "segments": [], "language": "en", "source": "mock"}
    if not data:
        raise HTTPException(400, "Empty video upload")
    suffix = Path(video.filename or "story.mp4").suffix or ".mp4"
    tmp = WORK_DIR / f"story_{uuid.uuid4().hex[:8]}{suffix}"
    tmp.write_bytes(data)
    try:
        result = await asyncio.to_thread(whisper_stt.transcribe, str(tmp))
    except Exception as e:
        raise HTTPException(502, f"Transcription failed: {str(e)[:300]}")
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    result["source"] = "whisper"
    return result


@app.post("/api/story/script")
async def story_script(body: dict = Body(...)):
    """Reference story material (transcript + vision notes) + cast + concept ->
    a flat, ordered short-form scene list. Uses the local Ollama text model
    when reachable (`use_llm` true), else a deterministic template."""
    source = body.get("source") or {}
    cast = body.get("cast") or []
    concept = str(body.get("concept") or "")
    style = str(body.get("style") or "")
    aspect = str(body.get("aspect") or "9:16")
    n_scenes = max(1, min(40, int(body.get("n_scenes") or 6)))
    max_seconds = float(body.get("max_seconds") or 5.2)
    max_seconds = min(max_seconds, H3_MAX_FRAMES / 24)
    use_llm = bool(body.get("use_llm", True))
    model = str(body.get("model") or "")
    realistic = bool(body.get("realistic", True))
    genre = str(body.get("genre") or "")
    if MOCK or not use_llm:
        out = story.template_script(source, cast, concept, style, n_scenes, max_seconds, body.get("seed"), realistic)
        out["source"] = "template"
        return genres.decorate_script(out, genre, str(body.get("scare") or "creepy"))
    try:
        out = await story.write_script(source, cast, concept, style, n_scenes, max_seconds, aspect, model, realistic, genre, str(body.get("scare") or "creepy"))
        out["source"] = "ollama"
        return genres.decorate_script(out, genre, str(body.get("scare") or "creepy"))
    except Exception as e:  # unreachable Ollama, bad JSON, empty reply…
        out = story.template_script(source, cast, concept, style, n_scenes, max_seconds, body.get("seed"), realistic)
        out["source"] = "template"
        out["warning"] = f"LLM director unavailable ({str(e)[:200]}) — used the template writer instead"
        return genres.decorate_script(out, genre, str(body.get("scare") or "creepy"))


SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"


def _script_name(name: str) -> str:
    n = re.sub(r"[^A-Za-z0-9 _.\-]", "", str(name)).strip(" .")[:80]
    if not n:
        raise HTTPException(400, "Bad script name")
    return n if n.lower().endswith((".md", ".txt")) else n + ".md"


@app.get("/api/scripts")
async def list_scripts():
    """The script inbox: story scripts written outside the app (for example written in another tool) appear here and load into the Script step."""
    SCRIPTS_DIR.mkdir(exist_ok=True)
    out = []
    for f in sorted(SCRIPTS_DIR.glob("*.*"), key=lambda p: p.stat().st_mtime, reverse=True):
        if f.suffix.lower() not in (".md", ".txt"):
            continue
        t = f.read_text(encoding="utf-8", errors="replace")
        h1 = re.search(r"^#\s+(?!#)(.+?)\s*$", t, re.M)
        out.append({"name": f.name, "title": h1.group(1).strip() if h1 else f.stem, "shots": len(re.findall(r"^##\s*SHOT\s+\d+", t, re.M)), "modified": f.stat().st_mtime})
    return {"scripts": out}


@app.get("/api/scripts/{name}")
async def get_script(name: str):
    f = SCRIPTS_DIR / _script_name(name)
    if not f.exists():
        raise HTTPException(404, "No such script")
    return {"name": f.name, "text": f.read_text(encoding="utf-8", errors="replace")}


@app.post("/api/scripts/{name}")
async def save_script(name: str, body: dict = Body(...)):
    SCRIPTS_DIR.mkdir(exist_ok=True)
    (SCRIPTS_DIR / _script_name(name)).write_text(str(body.get("text") or ""), encoding="utf-8")
    return {"ok": True}


@app.post("/api/story/parse_script")
async def story_parse_script(body: dict = Body(...)):
    """An already-written shot-by-shot script -> a flat scene list, parsed
    deterministically (no LLM call) — for a script the user wrote themselves
    rather than one to be generated. See `story.parse_pasted_script` for the
    expected format."""
    text = str(body.get("text") or "")
    if not text.strip():
        raise HTTPException(400, "No script text provided")
    max_seconds = float(body.get("max_seconds") or 5.2)
    max_seconds = min(max_seconds, H3_MAX_FRAMES / 24)
    realistic = bool(body.get("realistic", True))
    try:
        out = story.parse_pasted_script(text, max_seconds, realistic)
    except ValueError as e:
        raise HTTPException(400, str(e))
    out["source"] = "pasted"
    return genres.decorate_script(out, str(body.get("genre") or ""), "off")     # the genre look is added; the author's scares are left exactly as written


@app.post("/api/generate")
async def generate(
    prompt: str = Form(...),
    negative_prompt: str = Form("blurry, distorted, low quality, watermark"),
    width: int = Form(768),
    height: int = Form(448),
    num_frames: int = Form(97),
    fps: int = Form(24),
    steps: int = Form(8),
    cfg: float = Form(3.0),
    seed: int = Form(-1),
    denoise: float = Form(0.75),
    frames: list[UploadFile] = File(...),
):
    if not frames:
        raise HTTPException(400, "No depth frames uploaded")
    if seed < 0:
        seed = uuid.uuid4().int % (2**48)

    job_id = uuid.uuid4().hex[:12]
    subfolder = f"vsa_{job_id}"

    if MOCK:
        images = [await f.read() for f in frames]
        _new_job(job_id)
        asyncio.get_event_loop().create_task(_mock_run(job_id, images, fps, is_video=True))
        return {"job_id": job_id, "prompt_id": "mock", "seed": seed}

    template = _load_template(WORKFLOW_FILE)

    # 1. upload frames to ComfyUI's input dir
    async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
        for i, f in enumerate(frames):
            data = await f.read()
            r = await client.post(
                f"{COMFY_URL}/upload/image",
                files={"image": (f"frame_{i:05d}.png", data, "image/png")},
                data={"subfolder": subfolder, "type": "input", "overwrite": "true"},
            )
            if r.status_code != 200:
                raise HTTPException(502, f"ComfyUI frame upload failed: {r.text[:300]}")

        # 2. build workflow from template
        graph_str = build_workflow(
            template,
            {
                "PROMPT": prompt,
                "NEGATIVE_PROMPT": negative_prompt,
                "WIDTH": width,
                "HEIGHT": height,
                "NUM_FRAMES": num_frames,
                "FPS": fps,
                "STEPS": steps,
                "CFG": cfg,
                "SEED": seed,
                "DENOISE": denoise,
                "FRAMES_DIR": f"{COMFY_INPUT_DIR}/{subfolder}",
                "FRAMES_SUBFOLDER": subfolder,
                "FIRST_FRAME": f"{subfolder}/frame_00000.png",
            },
        )
        # 3. submit to ComfyUI
        prompt_id = await _submit(client, graph_str, job_id)

    return {"job_id": job_id, "prompt_id": prompt_id, "seed": seed}


@app.post("/api/generate_image")
async def generate_image(
    prompt: str = Form(...),
    negative_prompt: str = Form("blurry, distorted, low quality, watermark, text"),
    width: int = Form(768),
    height: int = Form(768),
    steps: int = Form(20),
    cfg: float = Form(7.0),
    seed: int = Form(-1),
    denoise: float = Form(0.7),
    checkpoint: str = Form(""),
    controlnet: str = Form(""),
    cn_strength: float = Form(0.8),
    cn_end: float = Form(0.6),
    backend: str = Form("sd"),
    gguf_model: str = Form(""),
    text_encoder: str = Form(""),
    vae: str = Form(""),
    enhancer_strength: float = Form(0.0),
    swap_model: str = Form("inswapper_128.onnx"),
    face_restore_model: str = Form("none"),
    face_indices: list[int] = Form([]),
    face_images: list[UploadFile] = File([]),
    lora_names: list[str] = Form([]),
    lora_strengths: list[float] = Form([]),
    krea_structure_mode: str = Form("img2img"),
    refine_denoise: float = Form(0.80),
    sketch_blur: float = Form(0.0),
    depth_lora: str = Form(""),
    control_strength: float = Form(1.0),
    sketch: UploadFile = File(...),
):
    """Sketch-to-image. `backend="sd"` (default): CheckpointLoaderSimple — with
    `controlnet` set, sketch = structure control at full denoise (exact
    composition + full realism); without, plain img2img fallback.
    `backend="krea2"`: native Krea 2, with the same optional LoRA chain and
    multi-face ReActor swap as `/api/generate_krea`. `krea_structure_mode`
    picks how the sketch conditions it: `"img2img"` (default) noises the
    sketch and partially denoises it — `denoise` controls the composition/
    realism trade-off, same knob, same tension as the SD path without
    ControlNet. `"reference"` instead feeds the sketch through Krea2's own
    vision-conditioning path (semantic, includes spatial relationships) and
    generates from a fresh empty latent at full denoise — decouples
    composition-following from photorealism, but in practice inherits the
    sketch's rendering style onto the described subject regardless of prompt
    wording, and doesn't lock framing/composition precisely either (semantic
    guidance, not pixel-locked). `"two_pass"` runs img2img at `denoise` (low,
    e.g. 0.4, to lock composition) then a second KSampler pass at
    `refine_denoise` (higher, e.g. 0.55) on the first pass's own output
    latent — refining away sketch-line artifacts using the first pass's
    shading/proportions as a photographic starting point, rather than the
    original bare linework. `"depth_control"` (best adherence — the Krea2
    equivalent of the SD path's ControlNet) runs the same pass 1 compose,
    extracts a depth map from that intermediate, then regenerates at full
    denoise with the Krea2 depth Control LoRA (`depth_lora`, strength
    `control_strength`) locking structure — requires the
    facok/comfyui-krea2-controlnet + comfyui_controlnet_aux node packs and
    the depth Control LoRA installed in ComfyUI. `sketch_blur` (Krea2 only)
    Gaussian-blurs the sketch before it's uploaded/encoded — softens the
    sketch's crisp linework into gradients so the sampler treats it as a
    compositional hint rather than literal content to preserve, which the
    crisp black-on-white lines otherwise are (a high-contrast edge reads as
    "real structure" to a diffusion sampler)."""
    if seed < 0:
        seed = uuid.uuid4().int % (2**48)
    if len(face_indices) != len(face_images):
        raise HTTPException(400, "face_indices and face_images must have the same length")
    if len(lora_names) != len(lora_strengths):
        raise HTTPException(400, "lora_names and lora_strengths must have the same length")

    prompt = director._fix_repetition_cues(director._fix_plural_framing(prompt))

    job_id = uuid.uuid4().hex[:12]
    subfolder = f"vsa_{job_id}"

    if MOCK:
        data = await sketch.read()
        _new_job(job_id)
        asyncio.get_event_loop().create_task(_mock_run(job_id, [data], 1, is_video=False))
        return {"job_id": job_id, "prompt_id": "mock", "seed": seed}

    use_krea = backend == "krea2"
    use_cn = controlnet and controlnet != "none"
    template = _load_template(
        WORKFLOW_SKETCH_KREA_FILE if use_krea else (WORKFLOW_SKETCH_CN_FILE if use_cn else WORKFLOW_IMAGE_FILE)
    )

    async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
        data = await sketch.read()
        if use_krea and sketch_blur > 0:
            img = Image.open(io.BytesIO(data)).convert("RGB")
            img = img.filter(ImageFilter.GaussianBlur(radius=sketch_blur))
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            data = buf.getvalue()
        r = await client.post(
            f"{COMFY_URL}/upload/image",
            files={"image": ("sketch.png", data, "image/png")},
            data={"subfolder": subfolder, "type": "input", "overwrite": "true"},
        )
        if r.status_code != 200:
            raise HTTPException(502, f"ComfyUI sketch upload failed: {r.text[:300]}")

        if use_krea:
            if not gguf_model:
                m = await gguf_models()
                if not m["gguf_models"]:
                    raise HTTPException(502, "No GGUF checkpoints installed in ComfyUI")
                # prefer a Krea file: this is a Krea-2 pipeline and [0] can be a
                # video model that crashes sampling (embedding size mismatch)
                gguf_model = next(
                    (n for n in m["gguf_models"] if "krea" in n.lower()), m["gguf_models"][0]
                )
            if not text_encoder:
                t = await text_encoders()
                if not t["text_encoders"]:
                    raise HTTPException(502, "No text encoders installed in ComfyUI")
                text_encoder = t["text_encoders"][0]
            if not vae:
                v = await vaes()
                if not v["vaes"]:
                    raise HTTPException(502, "No VAEs installed in ComfyUI")
                vae = v["vaes"][0]

            graph_str = build_workflow(
                template,
                {
                    "PROMPT": prompt,
                    "WIDTH": width,
                    "HEIGHT": height,
                    "STEPS": steps,
                    "CFG": cfg,
                    "SEED": seed,
                    "DENOISE": denoise,
                    "SKETCH_IMAGE": f"{subfolder}/sketch.png",
                    "GGUF_MODEL": gguf_model,
                    "TEXT_ENCODER": text_encoder,
                    "VAE_NAME": vae,
                    "ENHANCER_STRENGTH": enhancer_strength,
                },
            )
            graph = json.loads(graph_str)
            use_plain_unet_loader(graph, "1", gguf_model)

            model_ref, clip_ref = ["1", 0], ["2", 0]
            if lora_names:
                loras = [
                    {"name": n, "strength_model": s, "strength_clip": s}
                    for n, s in zip(lora_names, lora_strengths)
                ]
                model_ref, clip_ref = append_lora_chain(graph, model_ref, clip_ref, loras)
            bypass_enhancer_when_zero(graph, "4", model_ref, enhancer_strength)

            if krea_structure_mode == "reference":
                use_vision_reference(graph, "5", "10", clip_ref, prompt, ["7", 0], width, height)
            else:
                graph["5"]["inputs"]["clip"] = clip_ref
                if krea_structure_mode == "two_pass":
                    add_two_pass_refine(graph, "10", "11", steps=steps, cfg=cfg, denoise=refine_denoise)

            if face_indices:
                faces = []
                for i, (idx, upload) in enumerate(zip(face_indices, face_images)):
                    fdata = await upload.read()
                    fname = f"face_{i}.png"
                    r = await client.post(
                        f"{COMFY_URL}/upload/image",
                        files={"image": (fname, fdata, "image/png")},
                        data={"subfolder": subfolder, "type": "input", "overwrite": "true"},
                    )
                    if r.status_code != 200:
                        raise HTTPException(502, f"ComfyUI face upload failed: {r.text[:300]}")
                    faces.append({"index": idx, "filename": f"{subfolder}/{fname}"})
                append_faceswap_chain(graph, faces, swap_model=swap_model, face_restore_model=face_restore_model)

            prompt_id = await _submit(client, json.dumps(graph), job_id)
        else:
            # resolve checkpoint: explicit > env > first installed
            if not checkpoint:
                checkpoint = os.getenv("SKETCH_CHECKPOINT", "")
            if not checkpoint:
                m = await models()
                if not m["checkpoints"]:
                    raise HTTPException(502, "No checkpoints installed in ComfyUI")
                checkpoint = m["checkpoints"][0]

            graph_str = build_workflow(
                template,
                {
                    "PROMPT": prompt,
                    "NEGATIVE_PROMPT": negative_prompt,
                    "WIDTH": width,
                    "HEIGHT": height,
                    "STEPS": steps,
                    "CFG": cfg,
                    "SEED": seed,
                    "DENOISE": denoise,
                    "SKETCH_IMAGE": f"{subfolder}/sketch.png",
                    "FRAMES_DIR": f"{COMFY_INPUT_DIR}/{subfolder}",
                    "CHECKPOINT": checkpoint,
                    "CONTROLNET": controlnet,
                    "CN_STRENGTH": cn_strength,
                    "CN_END": cn_end,
                },
            )
            prompt_id = await _submit(client, graph_str, job_id)

    return {"job_id": job_id, "prompt_id": prompt_id, "seed": seed}


@app.post("/api/generate_krea")
async def generate_krea(
    prompt: str = Form(...),
    width: int = Form(1024),
    height: int = Form(1024),
    steps: int = Form(8),
    cfg: float = Form(1.0),
    seed: int = Form(-1),
    gguf_model: str = Form(""),
    text_encoder: str = Form(""),
    vae: str = Form(""),
    enhancer_strength: float = Form(0.0),
    swap_model: str = Form("inswapper_128.onnx"),
    face_restore_model: str = Form("none"),
    moodboard: list[UploadFile] = File([]),
    face_indices: list[int] = Form([]),
    face_images: list[UploadFile] = File([]),
    lora_names: list[str] = Form([]),
    lora_strengths: list[float] = Form([]),
):
    """Krea 2 (native) text-to-image. Positive prompt uses a plain CLIPTextEncode
    (no chat-template wrapping — TextEncodeKrea2's instruct framing measurably
    softens explicit prompts) unless `moodboard` images are attached, which
    requires TextEncodeKrea2 for its vision-conditioning image slots. Negative
    conditioning is a zeroed-out copy of the positive (turbo/distilled
    convention; irrelevant at cfg=1.0 anyway). `face_indices`/`face_images`
    (parallel arrays) each add a ReActorFaceSwap node, indexed left-to-right by
    position in the output. `lora_names`/`lora_strengths` (parallel arrays)
    chain LoraLoader nodes onto the model+clip before sampling/encoding."""
    if seed < 0:
        seed = uuid.uuid4().int % (2**48)
    if len(face_indices) != len(face_images):
        raise HTTPException(400, "face_indices and face_images must have the same length")
    if len(lora_names) != len(lora_strengths):
        raise HTTPException(400, "lora_names and lora_strengths must have the same length")

    # A still_prompt reaching this endpoint may have been hand-typed/edited in
    # the UI and never passed through director.normalize_script — "recurring"/
    # "repeated"/plural-shot language is a literal multi-panel instruction to
    # this model regardless of where the prompt came from, so scrub it here too.
    prompt = director._fix_repetition_cues(director._fix_plural_framing(prompt))

    job_id = uuid.uuid4().hex[:12]
    subfolder = f"vsa_{job_id}"

    if MOCK:
        echo = b""
        if moodboard:
            echo = await moodboard[0].read()
        elif face_images:
            echo = await face_images[0].read()
        _new_job(job_id)
        asyncio.get_event_loop().create_task(_mock_run(job_id, [echo], 1, is_video=False))
        return {"job_id": job_id, "prompt_id": "mock", "seed": seed}

    template = _load_template(WORKFLOW_KREA_FILE)

    async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
        if not gguf_model:
            m = await gguf_models()
            if not m["gguf_models"]:
                raise HTTPException(502, "No GGUF checkpoints installed in ComfyUI")
            # prefer a Krea file: this is a Krea-2 pipeline and [0] can be a
            # video model that crashes sampling (embedding size mismatch)
            gguf_model = next(
                (n for n in m["gguf_models"] if "krea" in n.lower()), m["gguf_models"][0]
            )
        if not text_encoder:
            t = await text_encoders()
            if not t["text_encoders"]:
                raise HTTPException(502, "No text encoders installed in ComfyUI")
            text_encoder = t["text_encoders"][0]
        if not vae:
            v = await vaes()
            if not v["vaes"]:
                raise HTTPException(502, "No VAEs installed in ComfyUI")
            vae = v["vaes"][0]

        graph_str = build_workflow(
            template,
            {
                "PROMPT": prompt,
                "WIDTH": width,
                "HEIGHT": height,
                "STEPS": steps,
                "CFG": cfg,
                "SEED": seed,
                "GGUF_MODEL": gguf_model,
                "TEXT_ENCODER": text_encoder,
                "VAE_NAME": vae,
                "ENHANCER_STRENGTH": enhancer_strength,
            },
        )
        graph = json.loads(graph_str)
        use_plain_unet_loader(graph, "1", gguf_model)

        model_ref, clip_ref = ["1", 0], ["2", 0]
        if lora_names:
            loras = [
                {"name": n, "strength_model": s, "strength_clip": s}
                for n, s in zip(lora_names, lora_strengths)
            ]
            model_ref, clip_ref = append_lora_chain(graph, model_ref, clip_ref, loras)
        bypass_enhancer_when_zero(graph, "4", model_ref, enhancer_strength)

        if moodboard:
            mood_filenames = []
            for i, upload in enumerate(moodboard, start=1):
                data = await upload.read()
                fname = f"mood_{i}.png"
                r = await client.post(
                    f"{COMFY_URL}/upload/image",
                    files={"image": (fname, data, "image/png")},
                    data={"subfolder": subfolder, "type": "input", "overwrite": "true"},
                )
                if r.status_code != 200:
                    raise HTTPException(502, f"ComfyUI moodboard upload failed: {r.text[:300]}")
                mood_filenames.append(f"{subfolder}/{fname}")
            graph["5"] = {
                "class_type": "TextEncodeKrea2",
                "inputs": {"clip": clip_ref, "prompt": prompt},
                "_meta": {"title": "Positive prompt — Krea2 vision-conditioned (moodboard references attached)"},
            }
            attach_moodboard_images(graph, "5", mood_filenames)
            # Moodboard forces the bf16 text encoder (fp8 can't run the vision
            # path), which is ~2x the size of the usual fp8 file — on a 16GB
            # card that plus the diffusion model + sampling activations can
            # OOM. Running the encode on CPU frees that VRAM for the sampler;
            # it's only a 4B model, so CPU encoding is still fast (unlike the
            # 32B MiniMax H3 text encoder, where this trade-off isn't worth it).
            if "2" in graph and graph["2"].get("class_type") == "CLIPLoader":
                graph["2"]["inputs"]["device"] = "cpu"
        else:
            graph["5"]["inputs"]["clip"] = clip_ref

        if face_indices:
            faces = []
            for i, (idx, upload) in enumerate(zip(face_indices, face_images)):
                data = await upload.read()
                fname = f"face_{i}.png"
                r = await client.post(
                    f"{COMFY_URL}/upload/image",
                    files={"image": (fname, data, "image/png")},
                    data={"subfolder": subfolder, "type": "input", "overwrite": "true"},
                )
                if r.status_code != 200:
                    raise HTTPException(502, f"ComfyUI face upload failed: {r.text[:300]}")
                faces.append({"index": idx, "filename": f"{subfolder}/{fname}"})
            append_faceswap_chain(graph, faces, swap_model=swap_model, face_restore_model=face_restore_model)

        prompt_id = await _submit(client, json.dumps(graph), job_id)

    return {"job_id": job_id, "prompt_id": prompt_id, "seed": seed}


_SEG_TAG = re.compile(r"^\[(\d+(?:\.\d+)?)\s*(s|f)\]\s*", re.IGNORECASE)


def _parse_timeline_prompt(prompt: str, num_frames: int, fps: int) -> tuple[str, str, str]:
    """Split a scene prompt into PromptRelayEncodeTimeline's three inputs:
    (global_prompt, local_prompts, segment_lengths).

    `|` separates time segments, played in order. Segments share the runtime
    evenly unless one opens with a duration tag `[3s]` / `[72f]` — tagged
    segments keep their duration and the rest split what remains. A segment
    starting with `*` is the global anchor (persistent character/scene
    context) rather than a time segment. Plain prompts with none of this
    syntax become a single full-length segment.
    """
    global_parts: list[str] = []
    segs: list[tuple[str, int | None]] = []
    for raw in prompt.split("|"):
        text = raw.strip()
        if not text:
            continue
        if text.startswith("*"):
            global_parts.append(text.lstrip("*").strip())
            continue
        frames = None
        m = _SEG_TAG.match(text)
        if m:
            n = float(m.group(1))
            frames = round(n * fps) if m.group(2).lower() == "s" else round(n)
            text = text[m.end():].strip()
        if text:
            segs.append((text, frames))
    if not segs:
        # prompt was empty or all-global: the relay node needs >=1 segment
        segs = [(" ".join(global_parts) or prompt.strip(), None)]
    lengths = ""
    if any(f for _, f in segs):
        tagged = sum(f or 0 for _, f in segs)
        untagged = [i for i, (_, f) in enumerate(segs) if not f]
        share = max((num_frames - tagged) // len(untagged), 1) if untagged else 0
        lengths = ", ".join(str(f if f else share) for _, f in segs)
    return " ".join(global_parts), " | ".join(t for t, _ in segs), lengths


@app.post("/api/generate_i2v")
async def generate_i2v(
    prompt: str = Form(...),
    negative_prompt: str = Form("blurry, distorted, low quality, watermark"),
    width: int = Form(768),
    height: int = Form(448),
    num_frames: int = Form(97),
    fps: int = Form(24),
    steps: int = Form(8),
    cfg: float = Form(3.0),
    seed: int = Form(-1),
    lora_names: list[str] = Form([]),
    lora_strengths: list[float] = Form([]),
    gguf_model: str = Form(""),
    image: UploadFile = File(...),
):
    """Storyboard scene image + prompt -> LTX 2.3 video with audio (image-to-video).

    Two-stage pipeline (half-res compose -> x1.5 latent upscale -> 3-step
    refine) on the distilled GGUF model; cfg/negative_prompt are ignored (the
    distilled model runs cfg=1 with zeroed negative). `prompt` supports the
    PromptRelay timeline syntax parsed by `_parse_timeline_prompt`: segments
    separated by `|` each direct a slice of the video, optional `[3s]`/`[72f]`
    duration tags, and a `*`-prefixed segment as the global anchor.
    `lora_names`/`lora_strengths` (parallel arrays) replace the workflow's
    built-in model-only video LoRA with a chain of the requested ones; when
    omitted the template's built-in default LoRA stays in place. `gguf_model`
    swaps the video transformer (must be LTX 2.3-compatible; .gguf loads via
    UnetLoaderGGUF, plain safetensors via UNETLoader); empty keeps the
    template default.
    """
    if len(lora_names) != len(lora_strengths):
        raise HTTPException(400, "lora_names and lora_strengths must have the same length")
    if seed < 0:
        seed = uuid.uuid4().int % (2**48)

    job_id = uuid.uuid4().hex[:12]
    subfolder = f"vsa_{job_id}"

    if MOCK:
        data = await image.read()
        _new_job(job_id)
        asyncio.get_event_loop().create_task(_mock_run(job_id, [data], fps, is_video=False))
        return {"job_id": job_id, "prompt_id": "mock", "seed": seed}

    template = _load_template(WORKFLOW_I2V_FILE)
    async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
        data = await image.read()
        r = await client.post(
            f"{COMFY_URL}/upload/image",
            files={"image": ("first_frame.png", data, "image/png")},
            data={"subfolder": subfolder, "type": "input", "overwrite": "true"},
        )
        if r.status_code != 200:
            raise HTTPException(502, f"ComfyUI image upload failed: {r.text[:300]}")

        global_prompt, local_prompts, segment_lengths = _parse_timeline_prompt(
            prompt, num_frames, fps
        )
        graph_str = build_workflow(
            template,
            {
                "PROMPT": prompt,
                "GLOBAL_PROMPT": global_prompt,
                "LOCAL_PROMPTS": local_prompts,
                "SEGMENT_LENGTHS": segment_lengths,
                "NEGATIVE_PROMPT": negative_prompt,
                "WIDTH": width,
                "HEIGHT": height,
                "NUM_FRAMES": num_frames,
                "FPS": fps,
                "STEPS": steps,
                "CFG": cfg,
                "SEED": seed,
                "FIRST_FRAME": f"{subfolder}/first_frame.png",
                "FRAMES_DIR": f"{COMFY_INPUT_DIR}/{subfolder}",
            },
        )
        if lora_names or gguf_model:
            graph = json.loads(graph_str)
            if gguf_model:
                graph["844:286"]["inputs"]["unet_name"] = gguf_model
                use_plain_unet_loader(graph, "844:286", gguf_model)
            if lora_names:
                set_video_lora_chain(
                    graph,
                    [{"name": n, "strength": s} for n, s in zip(lora_names, lora_strengths)],
                )
            graph_str = json.dumps(graph)
        prompt_id = await _submit(client, graph_str, job_id)

    return {"job_id": job_id, "prompt_id": prompt_id, "seed": seed}


# ---------------------------------------------------------------- MiniMax H3 video

async def _object_info_names(client: httpx.AsyncClient, node: str, key: str) -> list[str]:
    r = await client.get(f"{COMFY_URL}/object_info/{node}")
    if r.status_code != 200:
        return []
    try:
        return list(r.json()[node]["input"]["required"][key][0])
    except (KeyError, IndexError, TypeError):
        return []


async def _node_exists(client: httpx.AsyncClient, node: str) -> bool:
    r = await client.get(f"{COMFY_URL}/object_info/{node}")
    return r.status_code == 200 and bool(r.json())


async def _h3_catalog(client: httpx.AsyncClient) -> dict:
    """Model files + resolved defaults for the H3 pipeline."""
    models = await _object_info_names(client, "UNETLoader", "unet_name")
    encoders = await _object_info_names(client, "CLIPLoader", "clip_name")
    vaes = await _object_info_names(client, "VAELoader", "vae_name")
    h3_models = [m for m in models if MODEL_PREF.search(m)] or models
    h3_encoders = [e for e in encoders if TEXT_ENCODER_PREF.search(e)] or encoders
    video_vaes = [v for v in vaes if re.search(r"minimax.*video|video.*minimax", v, re.I)] or [v for v in vaes if "audio" not in v.lower()]
    audio_vaes = [v for v in vaes if AUDIO_VAE_PREF.search(v)] or [v for v in vaes if "audio" in v.lower()]
    return {
        "models": h3_models,
        "text_encoders": h3_encoders,
        "video_vaes": video_vaes,
        "audio_vaes": audio_vaes,
        "defaults": {
            "model": H3_MODEL or pick(h3_models, MODEL_PREF),
            "text_encoder": H3_TEXT_ENCODER or pick(h3_encoders, TEXT_ENCODER_PREF),
            "video_vae": H3_VIDEO_VAE or pick(video_vaes, VIDEO_VAE_PREF),
            "audio_vae": H3_AUDIO_VAE or pick(audio_vaes, AUDIO_VAE_PREF),
        },
        "kj_loader": await _node_exists(client, "DiffusionModelLoaderKJ"),
        "nodes_ok": await _node_exists(client, "MiniMaxH3ImageToVideo"),
        "reference_node": await _node_exists(client, "MiniMaxH3ReferenceToVideo"),
        "max_frames": H3_MAX_FRAMES,
        "frame_grid": [f for f in FRAME_GRID if f <= H3_MAX_FRAMES],
        "default_frames": min(DEFAULT_FRAMES, H3_MAX_FRAMES),
    }


@app.get("/api/h3/models")
async def h3_models():
    if MOCK:
        return {
            "models": ["mock-minimax_h3.safetensors"], "text_encoders": ["mock-qwen3vl_32b_minimax.safetensors"],
            "video_vaes": ["mock-minimax_h3_video_vae_fp16.safetensors"], "audio_vaes": ["mock-minimax_h3_audio_vae_fp32.safetensors"],
            "defaults": {"model": "mock-minimax_h3.safetensors", "text_encoder": "mock-qwen3vl_32b_minimax.safetensors",
                         "video_vae": "mock-minimax_h3_video_vae_fp16.safetensors", "audio_vae": "mock-minimax_h3_audio_vae_fp32.safetensors"},
            "kj_loader": True, "nodes_ok": True, "reference_node": True,
            "max_frames": H3_MAX_FRAMES, "frame_grid": [f for f in FRAME_GRID if f <= H3_MAX_FRAMES],
            "default_frames": min(DEFAULT_FRAMES, H3_MAX_FRAMES),
        }
    async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
        return await _h3_catalog(client)


def _aspect_from_string(aspect: str) -> float:
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$", aspect or "")
    if not m:
        return 16 / 9
    return float(m.group(1)) / float(m.group(2))


async def _upload_to_comfy(client: httpx.AsyncClient, subfolder: str, name: str, data: bytes) -> str:
    r = await client.post(
        f"{COMFY_URL}/upload/image",
        files={"image": (name, data, "image/png")},
        data={"subfolder": subfolder, "type": "input", "overwrite": "true"},
    )
    if r.status_code != 200:
        raise HTTPException(502, f"ComfyUI upload failed: {r.text[:300]}")
    return f"{subfolder}/{name}"


@app.post("/api/generate_h3")
async def generate_h3(
    prompt: str = Form(""),
    description: str = Form(""),
    soundscape: str = Form(""),
    music: str = Form("No music."),
    seconds: float = Form(0.0),
    frames: int = Form(0),
    width: int = Form(0),
    height: int = Form(0),
    aspect: str = Form("16:9"),
    megapixels: float = Form(0.4),
    seed: int = Form(-1),
    preset: str = Form("fast"),
    steps: int = Form(8),
    sampler: str = Form(""),
    shift_video: float = Form(12.0),
    shift_audio: float = Form(3.0),
    model: str = Form(""),
    text_encoder: str = Form(""),
    video_vae: str = Form(""),
    audio_vae: str = Form(""),
    ref_image_size: str = Form("match"),
    lock_still: bool = Form(False),
    coach: bool = Form(True),          # apply the minimax-h3-prompting rules (h3_coach.py) to the prompt
    h3_loras: list[str] = Form([]),   # "name|strength" each
    image: UploadFile | None = File(None),
    last_image: UploadFile | None = File(None),
    ref_images: list[UploadFile] = File([]),
):
    """MiniMax H3 video with native audio.

    Three ways to condition it, by what's attached:
      * `image` (+ optional `last_image`)  -> image-to-video: the still is the
        exact first frame (stretched to the canvas, so the canvas is derived
        from the still's own aspect unless width/height are given).
      * `ref_images`                        -> reference-to-video: characters
        / objects the prompt refers to as <Picture 1>, <Picture 2>… (identity
        guidance, not a keyframe).
      * nothing                             -> text-to-video.

    `prompt` is the full H3 text if you already composed it; otherwise
    `description` / `soundscape` / `music` are laid out in H3's three-section
    format, and a storyboard timeline prompt (`|` segments, `[3s]` tags, `*`
    anchor) in `description` becomes numbered [Shot i | mm:ss-mm:ss] blocks.
    Duration comes from `frames` (grid) or `seconds` (snapped DOWN to the
    17k+5 grid, never above H3_MAX_FRAMES). `preset="fast"` = the 4-step
    manual-sigma turbo schedule; anything else = `steps` on the simple
    scheduler (8 is the distill's native count).
    """
    if seed < 0:
        seed = uuid.uuid4().int % (2**48)
    if frames <= 0:
        frames = snap_frames(round((seconds or DEFAULT_FRAMES / 24) * 24), H3_MAX_FRAMES)
    else:
        frames = snap_frames(frames, H3_MAX_FRAMES)
    clip_seconds = frames / 24

    job_id = uuid.uuid4().hex[:12]
    subfolder = f"vsa_{job_id}"

    image_bytes = await image.read() if image is not None else b""
    if image is not None and not image_bytes:
        image_bytes = b""

    if MOCK:
        _new_job(job_id)
        echo = image_bytes or (await ref_images[0].read() if ref_images else b"")
        asyncio.get_event_loop().create_task(_mock_run(job_id, [echo], 24, is_video=False))
        return {"job_id": job_id, "prompt_id": "mock", "seed": seed, "frames": frames, "seconds": clip_seconds}

    # canvas
    if width <= 0 or height <= 0:
        ratio = _aspect_from_string(aspect)
        if image_bytes:
            try:
                im = Image.open(io.BytesIO(image_bytes))
                ratio = im.width / im.height
            except Exception:
                pass
        width, height = canvas_for(ratio, megapixels)
    width, height = max(32, width // 32 * 32), max(32, height // 32 * 32)

    # prompt text
    coached = None
    if not prompt.strip():
        preamble, shots = timeline_to_shots(description, clip_seconds)
        head = preamble if shots else description
        if coach and not shots:
            coached = await h3_coach.coach(head, soundscape, music, seconds=clip_seconds, has_image=bool(image_bytes), lock_still=lock_still)
            head, soundscape = coached["description"], coached["soundscape"]
        if lock_still and image_bytes:
            # keeps H3 from re-designing the character/set the still already fixed
            head = (director.LOCK_STILL + ("\n\n" + head if head.strip() else "")).strip()
        prompt = compose_h3_prompt(head, soundscape, music, shots or None)
    elif coach and not h3_coach.is_structured(prompt):
        coached = await h3_coach.coach(prompt, soundscape, music, seconds=clip_seconds, has_image=bool(image_bytes), lock_still=lock_still)
        head = coached["description"]
        if lock_still and image_bytes:
            head = (director.LOCK_STILL + "\n\n" + head).strip()
        prompt = compose_h3_prompt(head, coached["soundscape"], music)

    async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
        cat = await _h3_catalog(client)
        if not cat["nodes_ok"]:
            raise HTTPException(502, "ComfyUI has no MiniMaxH3ImageToVideo node — update ComfyUI to a build with MiniMax H3 support")
        d = cat["defaults"]
        model = model or d["model"]
        text_encoder = text_encoder or d["text_encoder"]
        video_vae = video_vae or d["video_vae"]
        audio_vae = audio_vae or d["audio_vae"]
        for label, val in (("MiniMax H3 model", model), ("text encoder", text_encoder), ("video VAE", video_vae), ("audio VAE", audio_vae)):
            if not val:
                raise HTTPException(502, f"No {label} installed in ComfyUI for MiniMax H3")

        first_frame = last_frame = None
        refs: list[str] = []
        if image_bytes:
            first_frame = await _upload_to_comfy(client, subfolder, "first_frame.png", image_bytes)
        if last_image is not None:
            data = await last_image.read()
            if data:
                last_frame = await _upload_to_comfy(client, subfolder, "last_frame.png", data)
        for i, up in enumerate(ref_images[:9]):
            data = await up.read()
            if data:
                refs.append(await _upload_to_comfy(client, subfolder, f"ref_{i}.png", data))
        if refs and not cat["reference_node"]:
            raise HTTPException(502, "ComfyUI has no MiniMaxH3ReferenceToVideo node — update ComfyUI")
        if refs and first_frame:
            # the two conditioning nodes are exclusive: a still wins, refs are dropped
            refs = []

        lora_list = []
        for entry in h3_loras:
            nm, _, st = entry.rpartition("|")
            if nm:
                try:
                    lora_list.append({"name": nm, "strength": float(st)})
                except ValueError:
                    lora_list.append({"name": nm, "strength": 1.0})
        graph = build_h3_graph(
            loras=lora_list,
            model=model, text_encoder=text_encoder, video_vae=video_vae, audio_vae=audio_vae,
            prompt=prompt, width=width, height=height, frames=frames, seed=seed,
            preset=preset, steps=max(1, min(50, steps)), sampler=sampler,
            shift_video=shift_video, shift_audio=shift_audio,
            first_frame=first_frame, last_frame=last_frame, ref_images=refs,
            ref_image_size=ref_image_size if ref_image_size in ("match", "max") else "match",
            use_kj_loader=cat["kj_loader"],
            enable_fp16_accumulation=await _supports_fp16_accumulation(),
            filename_prefix=f"vsa/h3/{job_id}",
        )
        prompt_id = await _submit(client, json.dumps(graph), job_id)

    return {"job_id": job_id, "prompt_id": prompt_id, "seed": seed, "frames": frames,
            "seconds": clip_seconds, "width": width, "height": height,
            "prompt_used": prompt, "coach_notes": (coached or {}).get("notes", [])}


@app.post("/api/h3/coach")
async def h3_coach_preview(prompt: str = Form(""), soundscape: str = Form(""), music: str = Form("No music."),
                           seconds: float = Form(5.0), has_image: bool = Form(False), lock_still: bool = Form(False),
                           use_llm: bool = Form(True)):
    """Preview what the H3 prompt coach will send to the model (the minimax-h3-prompting rules)."""
    res = await h3_coach.coach(prompt, soundscape, music, seconds=seconds, has_image=has_image, lock_still=lock_still, use_llm=use_llm)
    head = res["description"]
    if lock_still and has_image:
        head = (director.LOCK_STILL + "\n\n" + head).strip()
    return {"prompt": compose_h3_prompt(head, res["soundscape"], res["music"]) if res["description"] else "", "notes": res["notes"], "changed": res["changed"]}


# ---------------------------------------------------------------- music video director

@app.post("/api/mv/analyze")
async def mv_analyze(track: UploadFile = File(...)):
    """Music track -> tempo, beat grid, downbeats, energy curve, sections."""
    data = await track.read()
    if not data:
        raise HTTPException(400, "Empty upload")
    suffix = Path(track.filename or "track.mp3").suffix or ".mp3"
    tmp = WORK_DIR / f"track_{uuid.uuid4().hex[:8]}{suffix}"
    tmp.write_bytes(data)
    try:
        result = await asyncio.to_thread(audio_analysis.analyze, str(tmp))
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    result["name"] = track.filename or "track"
    return result


@app.post("/api/mv/script")
async def mv_script(body: dict = Body(...)):
    """Song analysis + cast + concept -> shot list. Uses the local Ollama
    text model when reachable (`use_llm` true), else a deterministic
    template so the rest of the pipeline can still be exercised."""
    analysis = body.get("analysis") or {}
    cast = body.get("cast") or []
    concept = str(body.get("concept") or "")
    style = str(body.get("style") or "")
    lyrics = str(body.get("lyrics") or "")
    aspect = str(body.get("aspect") or "9:16")
    n_scenes = max(1, min(40, int(body.get("n_scenes") or 8)))
    max_seconds = float(body.get("max_seconds") or 5.2)
    max_seconds = min(max_seconds, H3_MAX_FRAMES / 24)
    use_llm = bool(body.get("use_llm", True))
    model = str(body.get("model") or "")
    genre = str(body.get("genre") or "")
    if not analysis.get("duration"):
        raise HTTPException(400, "Analyze a track first")
    if MOCK or not use_llm:
        out = director.template_script(analysis, cast, concept, style, n_scenes, max_seconds, body.get("seed"))
        out["source"] = "template"
        return genres.decorate_script(out, genre, str(body.get("scare") or "creepy"))
    try:
        out = await director.write_script(analysis, cast, concept, style, n_scenes, max_seconds, aspect, lyrics, model, genre)
        out["source"] = "ollama"
        return genres.decorate_script(out, genre, str(body.get("scare") or "creepy"))
    except Exception as e:  # unreachable Ollama, bad JSON, empty reply…
        out = director.template_script(analysis, cast, concept, style, n_scenes, max_seconds, body.get("seed"))
        out["source"] = "template"
        out["warning"] = f"LLM director unavailable ({str(e)[:200]}) — used the template writer instead"
        return genres.decorate_script(out, genre, str(body.get("scare") or "creepy"))


@app.post("/api/story/scarify")
async def story_scarify(body: dict = Body(...)):
    """Rewrite ONE shot's prompts so it contains a specific, visible, unsettling detail (and, for terrifying, a sudden event)."""
    import random
    gid = str(body.get("genre") or "found_footage")
    level = str(body.get("level") or "creepy")
    still = str(body.get("still_prompt") or "").strip()
    motion = str(body.get("motion_prompt") or "").strip()
    bank = random.choice(genres.SCARE_BANK)
    fallback = {"still_prompt": f"{still.rstrip('. ')}. {bank[0].upper() + bank[1:]}.", "motion_prompt": (motion.rstrip('. ') + ". The unsettling shape in the background does not move, but the operator slowly notices it and the camera drifts toward it, then jerks away.") if motion else "", "source": "bank"}
    if MOCK:
        return fallback
    try:
        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            models = await director.ollama_models(client)
            model = director.pick_text_model(models)
            if not model:
                return fallback
            sys_msg = ("You are a horror director fixing ONE shot of a short found-footage video. Rewrite the two prompts so the shot contains ONE specific, visible, unsettling detail "
                       "placed in the background, at the edge of frame or half hidden (a figure, a face in the window, an open door, a handprint). Describe it concretely, small in frame, never fully lit, never gory. "
                       + ("Also put one sudden event in the motion prompt (it steps into the light, a face at the lens, the camera whips round and it is already there). " if level == "terrifying" else "")
                       + "Keep the same people, place and action. Keep each prompt one paragraph, present tense, no camera vocabulary like cinematic or bokeh. Reply with ONE JSON object: {\"still_prompt\":str,\"motion_prompt\":str}.")
            user = f"Genre: {genres.get(gid)['label']}\nShot title: {body.get('title', '')}\nPrevious shot: {body.get('previous', '')}\nNext shot: {body.get('next', '')}\nStill prompt: {still}\nMotion prompt: {motion}"
            req = {"model": model, "stream": False, "format": "json", "think": False, "messages": [{"role": "system", "content": sys_msg}, {"role": "user", "content": user}],
                   "options": {"temperature": 0.8, "num_ctx": 4096, "num_predict": 900}}
            r = await client.post(f"{director.OLLAMA_URL}/api/chat", json=req)
            if r.status_code != 200:
                req.pop("think", None)
                r = await client.post(f"{director.OLLAMA_URL}/api/chat", json=req)
            d = director._clean_json(r.json().get("message", {}).get("content", ""))
            if d.get("still_prompt"):
                return {"still_prompt": genres.scrub(str(d["still_prompt"]), gid), "motion_prompt": genres.scrub(str(d.get("motion_prompt") or motion), gid), "source": "ollama"}
    except Exception:
        pass
    return fallback


@app.post("/api/story/ideas")
async def story_ideas(body: dict = Body(...)):
    """Short, filmable video ideas for a genre: curated ones always, fresh ones from the local LLM when it is running."""
    gid = str(body.get("genre") or "cinematic")
    hint = str(body.get("hint") or "").strip()
    n = max(3, min(8, int(body.get("n") or 6)))
    curated = genres.ideas_for(gid)
    out = {"ideas": [{"title": "", "concept": c} for c in curated], "source": "curated"}
    if MOCK:
        return out
    try:
        import random
        g = genres.get(gid)
        async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
            models = await director.ollama_models(client)
            model = director.pick_text_model(models)
            if not model:
                return out
            sys_msg = ("You invent short-form video ideas. Reply with ONE JSON object: {\"ideas\":[{\"title\":str (3-6 words),\"concept\":str (1-2 sentences: who, where, what goes wrong or what the hook is)}]}. "
                       "Ideas must be concrete, filmable by one person with a camera in 30-60 seconds, with a strong first-second hook and one clear payoff. Original, not clichés.")
            examples = "; ".join(random.sample(curated, min(2, len(curated)))) if curated else ""
            user = (f"Genre: {g['label']} - {g['blurb']}\n{('Direction from the user: ' + hint + chr(10)) if hint else ''}"
                    f"Style examples (do NOT copy): {examples}\nGive {n} new ideas.")
            req = {"model": model, "stream": False, "format": "json", "think": False,
                   "messages": [{"role": "system", "content": sys_msg}, {"role": "user", "content": user}],
                   "options": {"temperature": 0.95, "num_ctx": 4096, "num_predict": 1200}}
            r = await client.post(f"{director.OLLAMA_URL}/api/chat", json=req)
            if r.status_code != 200:
                req.pop("think", None)
                r = await client.post(f"{director.OLLAMA_URL}/api/chat", json=req)
            data = director._clean_json(r.json().get("message", {}).get("content", ""))
            fresh = [{"title": str(i.get("title", ""))[:60], "concept": str(i.get("concept", ""))[:300]} for i in data.get("ideas", []) if i.get("concept")]
            if fresh:
                return {"ideas": fresh[:n], "source": "ollama", "model": model}
    except Exception:
        pass
    return out


@app.get("/api/genres")
async def list_genres():
    """The genre / niche catalogue (labels, prompt styles, director rules, finishing look) shared by every tool."""
    return {"genres": [{**g, "score_prompt": genres.SCORE_PROMPTS.get(g["id"], "")} for g in genres.GENRES]}


@app.get("/api/looks")
async def looks():
    """Post-process color-grade presets available to /api/mv/render's `look` param."""
    return {"looks": [{"id": k, "label": v[0]} for k, v in final_render.LOOKS.items()]}


@app.post("/api/mv/h3_prompt")
async def mv_h3_prompt(body: dict = Body(...)):
    """Preview the exact H3 prompt a music-video scene will be sent with."""
    return {"prompt": director.scene_h3_prompt(body.get("scene") or {}, body.get("cast_names") or [])}


@app.post("/api/mv/render")
async def mv_render(
    edl: str = Form(...),
    width: int = Form(1080),
    height: int = Form(1920),
    music_gain: float = Form(1.0),
    clip_gain: float = Form(0.0),
    music_offset: float = Form(0.0),
    fade_out: float = Form(0.0),
    look: str = Form(""),
    music: UploadFile | None = File(None),
    clips: list[UploadFile] = File([]),
):
    """Cut list + clip files (+ music) -> final mp4. Each clip upload's
    filename stem is its id in the EDL."""
    try:
        pieces = final_render.edl_from_json(edl)
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(400, f"Bad EDL: {e}")
    if not clips:
        raise HTTPException(400, "No clips uploaded")
    work = WORK_DIR / f"render_{uuid.uuid4().hex[:8]}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        paths: dict[str, str] = {}
        for up in clips:
            data = await up.read()
            if not data:
                continue
            stem = Path(up.filename or uuid.uuid4().hex).stem
            p = work / f"{stem}{Path(up.filename or '.mp4').suffix or '.mp4'}"
            p.write_bytes(data)
            paths[stem] = str(p)
        music_path = None
        if music is not None:
            mdata = await music.read()
            if mdata:
                music_path = str(work / f"music{Path(music.filename or '.mp3').suffix or '.mp3'}")
                Path(music_path).write_bytes(mdata)
        out = work / "final.mp4"
        info = await asyncio.to_thread(
            final_render.render_edl, pieces, paths, music_path, str(out),
            max(64, width // 2 * 2), max(64, height // 2 * 2), 24, music_gain, clip_gain, music_offset, 18, fade_out, look,
        )
        return Response(content=out.read_bytes(), media_type="video/mp4",
                        headers={"X-Render-Duration": str(info["duration"]), "X-Render-Pieces": str(info["pieces"])})
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        for p in work.glob("*"):
            try:
                p.unlink()
            except OSError:
                pass
        try:
            work.rmdir()
        except OSError:
            pass


async def _monitor(job_id: str, prompt_id: str):
    job = JOBS[job_id]

    async def push(ev: dict):
        if ev.get("type") == "progress":
            job["progress"] = ev.get("value", 0) / max(1, ev.get("max", 1))
        elif ev.get("type") == "status":
            job["status_text"] = ev.get("text", "")
        await job["queue"].put(ev)
        if ev.get("type") in ("progress", "done", "error"):
            extra = {}
            if ev["type"] == "done":
                rec = jobs.get(job_id) or {}
                extra = {"kind": rec.get("kind", ""), "title": rec.get("title", "")}
            _feed({**ev, **extra, "job_id": job_id})

    try:
        async with websockets.connect(
            f"{COMFY_WS}/ws?clientId={job_id}", max_size=2**24, ping_interval=None   # ComfyUI blocks its event loop while streaming weights; the default 20 s keepalive then kills a healthy job (error 1011)
        ) as ws:
            await push({"type": "status", "text": "Queued on ComfyUI…"})
            # whole-workflow progress: nodes finished (+ the running sampler's fraction) over all nodes, so the bar keeps moving
            # through the loading / decoding stages instead of sitting at 100% when the last sampler ends
            done_nodes: set = set(); cur_node = None; cur_frac = 0.0; best = 0.0
            n_total = max(1, len(job.get("titles", {})))

            def overall() -> float:
                nonlocal best
                best = max(best, min(0.99, (len(done_nodes) + cur_frac) / n_total))
                return round(best, 4)
            while True:
                # H3 cold starts stream ~40 GB of weights off disk before the
                # first progress tick; a queued job behind one sees nothing
                # for the whole run — be patient
                msg = await asyncio.wait_for(ws.recv(), timeout=2400)
                if isinstance(msg, bytes):
                    continue  # binary previews — ignore
                data = json.loads(msg)
                t, d = data.get("type"), data.get("data", {})
                if t == "progress":
                    cur_frac = d.get("value", 0) / max(1, d.get("max", 1))
                    await push({"type": "progress", "value": d.get("value", 0), "max": d.get("max", 1), "overall": overall()})
                elif t == "execution_cached" and d.get("prompt_id") == prompt_id:
                    done_nodes.update(str(n) for n in d.get("nodes", []))
                elif t == "executing":
                    if d.get("prompt_id") != prompt_id:
                        continue
                    if d.get("node") is None:  # finished
                        break
                    node = str(d.get("node"))
                    if cur_node is not None:
                        done_nodes.add(cur_node)
                    cur_node, cur_frac = node, 0.0
                    title = job.get("titles", {}).get(node)
                    await push({"type": "status", "text": f"{title}…" if title else f"Running node {node}…"})
                    _feed({"type": "overall", "job_id": job_id, "overall": overall(), "stage": title or ""})
                elif t == "execution_interrupted" and d.get("prompt_id") == prompt_id:
                    raise RuntimeError("Cancelled")
                elif t == "execution_error" and d.get("prompt_id") == prompt_id:
                    raise RuntimeError(d.get("exception_message", "ComfyUI execution error"))

        video = await _find_output(prompt_id)
        if not video:
            raise RuntimeError("Workflow finished but no video/image output was found in history")
        job["video"] = video
        job["status"] = "done"
        jobs.upsert(job_id, status="done", finished=time.time(), output=video)
        await push({"type": "done", "url": f"/api/video/{job_id}", "media": _media_for(video["filename"])})
    except Exception as e:
        # a cancelled run can also surface as "no output found" — present it
        # as the cancellation it is, not a workflow failure
        msg = "Cancelled" if job.get("cancelled") else str(e)
        job["status"] = "cancelled" if job.get("cancelled") else "error"
        job["error"] = msg
        jobs.upsert(job_id, status=job["status"], error=msg[:500], finished=time.time())
        await push({"type": "error", "text": msg})


async def _find_output(prompt_id: str):
    """Search ComfyUI history for the job's video (or image batch) output."""
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        r = await client.get(f"{COMFY_URL}/history/{prompt_id}")
        r.raise_for_status()
        hist = r.json().get(prompt_id, {})
    outputs = hist.get("outputs", {})
    for node_out in outputs.values():
        for key in ("gifs", "videos", "images"):
            items = node_out.get(key)
            if items:
                it = items[0]
                return {
                    "filename": it["filename"],
                    "subfolder": it.get("subfolder", ""),
                    "type": it.get("type", "output"),
                }
    return None


@app.get("/api/events/{job_id}")
async def events(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")

    async def stream():
        # if already finished before the client connected
        if job["status"] == "done" and job["queue"].empty():
            yield f"data: {json.dumps({'type': 'done', 'url': f'/api/video/{job_id}'})}\n\n"
            return
        if job["status"] == "error" and job["queue"].empty():
            yield f"data: {json.dumps({'type': 'error', 'text': job['error']})}\n\n"
            return
        while True:
            try:
                ev = await asyncio.wait_for(job["queue"].get(), timeout=2400)
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'type': 'error', 'text': 'Timed out waiting for ComfyUI'})}\n\n"
                return
            yield f"data: {json.dumps(ev)}\n\n"
            if ev["type"] in ("done", "error"):
                return

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/api/feed")
async def feed_stream():
    """Server-sent events: started / progress / done / error for every job on this PC, from any device."""
    q: asyncio.Queue = asyncio.Queue(maxsize=500)
    FEED_SUBS.add(q)
    _feed({"type": "presence", "devices": len(FEED_SUBS)})      # every screen shows how many devices are connected

    async def stream():
        try:
            yield "retry: 2000\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            FEED_SUBS.discard(q)
            _feed({"type": "presence", "devices": len(FEED_SUBS)})

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/feed/recent")
async def feed_recent(since: float = 0):
    """Finished image jobs after `since` (epoch seconds): lets a screen that was asleep or closed catch up."""
    rows = jobs.list_jobs(limit=60, status="done")
    out = [{"job_id": r["id"], "kind": r.get("kind", ""), "title": r.get("title", ""), "finished": r.get("finished") or 0}
           for r in rows if (r.get("finished") or 0) > since and str(r.get("kind", "")).startswith("image")]
    return {"now": time.time(), "jobs": sorted(out, key=lambda r: r["finished"])}


@app.get("/api/video/{job_id}")
async def video(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        if jobs.get(job_id):
            from fastapi.responses import RedirectResponse
            return RedirectResponse(f"/api/jobs/{job_id}/media")
        raise HTTPException(404, "Unknown job")
    if job.get("file"):
        from fastapi.responses import FileResponse
        return FileResponse(job["file"], media_type=job.get("media") or _media_for(job["file"]))
    if job.get("mock_bytes"):
        return Response(content=job["mock_bytes"], media_type=job["mock_media"])
    if not job.get("video"):
        raise HTTPException(404, "Video not ready")
    v = job["video"]
    params = {"filename": v["filename"], "subfolder": v["subfolder"], "type": v["type"]}
    media = _media_for(v["filename"])

    async def stream():
        async with httpx.AsyncClient(timeout=None, trust_env=False) as client:
            async with client.stream("GET", f"{COMFY_URL}/view", params=params) as r:
                async for chunk in r.aiter_bytes():
                    yield chunk

    return StreamingResponse(stream(), media_type=media)


@app.get("/api/job/{job_id}")
async def job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    return JSONResponse({"status": job["status"], "error": job["error"]})


# ---------------------------------------------------------------- feature modules
import sys as _sys

import flux3_routes

import tools_routes

flux3_routes.register(app, _sys.modules[__name__])
tools_routes.register(app, _sys.modules[__name__])
import chaos_cut
chaos_cut.register(app, _sys.modules[__name__])
import genjutsu_routes

genjutsu_routes.register(app, _sys.modules[__name__])
import ads_routes

ads_routes.register(app, _sys.modules[__name__])
import wan_routes

wan_routes.register(app, _sys.modules[__name__])
import jobs_routes

jobs_routes.register(app, _sys.modules[__name__])
import ltx_routes

ltx_routes.register(app, _sys.modules[__name__])
import timeline_routes
import pose_routes
pose_routes.register(app, _sys.modules[__name__])

timeline_routes.register(app, _sys.modules[__name__])
import qa_routes
qa_routes.register(app, _sys.modules[__name__])
import models_routes
models_routes.register(app, _sys.modules[__name__])
import tts_routes
tts_routes.register(app, _sys.modules[__name__])
import face_routes
face_routes.register(app, _sys.modules[__name__])
import qwen_routes
qwen_routes.register(app, _sys.modules[__name__])
import session_routes
session_routes.register(app, _sys.modules[__name__])
import assistant_routes
assistant_routes.register(app, _sys.modules[__name__])
import settings_routes
settings_routes.register(app, _sys.modules[__name__])
import loop_routes
loop_routes.register(app, _sys.modules[__name__])
import scene_routes
scene_routes.register(app, _sys.modules[__name__])
scene_routes.register_direct(app, _sys.modules[__name__])
scene_routes.register_saves(app, _sys.modules[__name__])
import story_room
story_room.register(app, _sys.modules[__name__])

# Packaged mode: if the frontend has been built (npm run build), serve it from this same port so
# the whole studio is just http://localhost:8000 (no Vite dev server needed). Mounted last so /api wins.
@app.get("/api/resources")
async def resources():
    """Free RAM and what the guard last did (memory protection for the whole PC)."""
    return dict(_GUARD)


_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _dist.is_dir() and (_dist / "index.html").exists():
    from fastapi.staticfiles import StaticFiles

    class _UI(StaticFiles):
        """The front page must never be served from a browser's cache: it names the current script file, so a cached copy
        keeps loading an OLD version of the app after every rebuild (and on phones, even after a normal refresh).
        The script/style files have hashed names and can be cached forever."""
        async def get_response(self, path, scope):
            resp = await super().get_response(path, scope)
            resp.headers["Cache-Control"] = ("public, max-age=31536000, immutable" if path.replace("\\", "/").startswith("assets/")
                                             else "no-cache, must-revalidate")
            return resp

    app.mount("/", _UI(directory=str(_dist), html=True), name="ui")


@app.on_event("startup")
async def _start_resource_guard():
    import resource_guard
    asyncio.get_event_loop().create_task(resource_guard.run(_feed))


@app.on_event("startup")
async def _start_comfy_watchdog():
    import comfy_watchdog
    asyncio.get_event_loop().create_task(comfy_watchdog.run(_feed))


class _QuietResets(__import__("logging").Filter):
    """A phone that sleeps or leaves the page drops its connection mid-stream; Windows' asyncio then prints a harmless
    'WinError 10054 / 10053 connection forcibly closed' traceback. Hide just those."""
    def filter(self, record):
        e = record.exc_info[1] if record.exc_info else None
        return not (isinstance(e, ConnectionError) and getattr(e, "winerror", None) in (10053, 10054))


if __name__ == "__main__":
    import logging

    import uvicorn

    logging.getLogger("asyncio").addFilter(_QuietResets())

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
