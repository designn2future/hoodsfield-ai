"""Model manager: which model files each Hoodsfield feature needs, what is installed, disk space, and where to get the rest.

  GET /api/models/manager        -> {disk, features:[{id,title,ready,items:[{label,found,size,required,url,gated,note}]}]}
Nothing is downloaded automatically: gated repos need the user to accept the licence on Hugging Face first.
"""
import asyncio
import os
import re
import shutil
import time
from pathlib import Path

HF = "https://huggingface.co/"

# (pattern on lower-cased file name, label, required, url, gated, note)
MANIFEST = [
    ("flux3", "Flux 3 Klein (image, edit, inpaint)", [
        (r"flux3_image_klein.*(int8|convrot)", "Klein diffusion model (INT8)", True, HF + "black-forest-labs/flux-3-image-klein-comfy", False, "diffusion_models/"),
        (r"flux3_klein_ae|flux2[-_]vae", "Klein VAE", True, HF + "black-forest-labs/flux-3-image-klein-comfy/resolve/main/vae/flux2-vae.safetensors", False, "vae/"),
        (r"qwen3.*flux3|flux3.*qwen3|qwen_3_4b", "Klein text encoder", True, HF + "black-forest-labs/flux-3-image-klein-comfy", False, "text_encoders/ or clip/"),
    ]),
    ("wan", "Wan 2.2 video (I2V / T2V / first-last / long shots)", [
        (r"wan2\.?2.*i2v.*high.*\.gguf|high.*noise.*\.gguf", "I2V high-noise expert (GGUF)", True, HF + "QuantStack/Wan2.2-I2V-A14B-GGUF", False, "diffusion_models/"),
        (r"wan2\.?2.*i2v.*low.*\.gguf|low.*noise.*\.gguf", "I2V low-noise expert (GGUF)", True, HF + "QuantStack/Wan2.2-I2V-A14B-GGUF", False, "diffusion_models/"),
        (r"lightx2v.*high|lightning.*high", "Lightning 4-step LoRA (high)", True, HF + "Kijai/WanVideo_comfy", False, "loras/"),
        (r"lightx2v.*low|lightning.*low", "Lightning 4-step LoRA (low)", True, HF + "Kijai/WanVideo_comfy", False, "loras/"),
        (r"umt5", "UMT5 text encoder", True, HF + "Comfy-Org/Wan_2.2_ComfyUI_Repackaged", False, "text_encoders/"),
        (r"wan_?2\.?[12]_vae", "Wan VAE", True, HF + "Comfy-Org/Wan_2.2_ComfyUI_Repackaged", False, "vae/"),
    ]),
    ("ltx", "LTX 2.3: video, motion control, lip-sync", [
        (r"ltx-2\.3-22b-dev.*int8|ltx-2\.3-22b", "LTX 2.3 22B transformer", True, HF + "Lightricks/LTX-2.3", False, "diffusion_models/"),
        (r"ltx-2\.3-22b-ic-lora-union-control", "Union-Control IC-LoRA (motion control)", False, HF + "Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control", False, "loras/"),
        (r"ltx.*dubit|ic-lora-dubit", "DubIt IC-LoRA (better lip-sync)", False, HF + "Lightricks/LTX-2.3-22b-IC-LoRA-DubIt", True, "Accept the licence on Hugging Face first, then place in loras/"),
        (r"ltx2_audio_vae|audio_vae", "LTX audio VAE", True, HF + "Lightricks/LTX-2", False, "checkpoints/"),
    ]),
    ("h3", "MiniMax H3 (music-video / TikTok engine)", [
        (r"minimax_h3.*\.safetensors", "H3 diffusion model", True, "", False, "diffusion_models/ (also looked for on C:\ComfyUI-models)"),
        (r"minimax_h3.*vae|h3.*vae", "H3 video VAE (fp16)", True, "", False, "vae/"),
    ]),
    ("tools", "Upscale, smoothing, background removal", [
        (r"x4plus\.pth|realesrgan_x4plus", "Real-ESRGAN x4+", True, HF + "schwgHao/RealESRGAN_x4plus/resolve/main/RealESRGAN_x4plus.pth", False, "upscale_models/"),
        (r"rife49", "RIFE 4.9 (frame interpolation)", True, "", False, "custom node rife folder"),
        (r"birefnet", "BiRefNet (background removal)", False, HF + "Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors", False, "background_removal/"),
        (r"inswapper", "InSwapper (face swap)", False, "", False, "insightface/ (face-swap node currently broken: numpy ABI)"),
    ]),
]

_cache = {"t": 0.0, "files": []}


def _scan(roots):
    out = []
    for r in roots:
        if not r.exists():
            continue
        for dp, dn, fn in os.walk(r):
            dn[:] = [d for d in dn if d not in (".cache", "__pycache__")]
            for f in fn:
                if f.lower().endswith((".safetensors", ".gguf", ".pth", ".onnx", ".ckpt", ".bin", ".hdd-backup")):
                    p = os.path.join(dp, f)
                    try:
                        out.append((f.lower(), p, os.path.getsize(p)))
                    except OSError:
                        pass
    return out


def _files():
    if time.time() - _cache["t"] > 90:
        root = Path(os.getenv("COMFY_ROOT", r"D:\ComfyUI-LTX2"))
        _cache["files"] = _scan([root / "models", Path(r"C:\ComfyUI-models"),
                         root / "custom_nodes" / "comfyui-frame-interpolation" / "ckpts"])
        _cache["t"] = time.time()
    return _cache["files"]


def build():
    files = _files()
    feats = []
    for fid, title, items in MANIFEST:
        rows, ready = [], True
        for pat, label, req, url, gated, note in items:
            rx = re.compile(pat)
            hit = [(p, s) for n, p, s in files if rx.search(n) and not n.endswith(".hdd-backup")]
            if not hit and fid == "h3":
                hit = [(p, s) for n, p, s in files if rx.search(n.replace(".hdd-backup", ""))]
            if req and not hit:
                ready = False
            rows.append({"label": label, "required": req, "found": [p for p, _ in hit[:3]], "size": sum(s for _, s in hit[:1]),
                         "url": url, "gated": gated, "note": note})
        feats.append({"id": fid, "title": title, "ready": ready, "items": rows})
    disk = {}
    for d in ("C:\\", "D:\\"):
        try:
            u = shutil.disk_usage(d)
            disk[d[0]] = {"free": u.free, "total": u.total}
        except OSError:
            pass
    return {"disk": disk, "features": feats}


def register(app, m):
    @app.get("/api/models/manager")
    async def models_manager(refresh: int = 0):
        if refresh:
            _cache["t"] = 0
        return await asyncio.to_thread(build)
