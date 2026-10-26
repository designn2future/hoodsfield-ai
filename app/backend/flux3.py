"""
Flux 3 (Klein) graph builder — text-to-image, multi-reference image editing,
and the Qwen3.5 prompt upsampler, built as ComfyUI API-format graphs in Python.

Verified on the RTX 4060 Ti 16GB box (ComfyUI 0.41, 2026-10):
  * UNETLoader  flux3_image_klein_sd_int8_convrot   (8 steps, cfg 1 — the "sd"
    build is step-distilled: ~5 s for 1024x1024 warm, ~28 s cold)
  * CLIPLoader  type "flux3"  (Qwen3-VL-4B bf16)
  * VAELoader   flux3_klein_ae
  * Flux2Scheduler + SamplerCustomAdvanced + CFGGuider  (cfg 1 -> the negative
    is a zeroed-out copy of the positive, irrelevant to the result)
  * Reference images (edit / "References" / character consistency): each is
    scaled to ~1 MP, VAE-encoded, and chained onto the positive AND negative
    conditioning with ReferenceLatent — the model then edits/re-poses/re-styles
    from the reference per the prompt.

Prompt upsampler: BFL ships a Qwen3.5-9B int8 text model that rewrites a short
request into a dense, layout-aware caption. Run through core `TextGenerate`
with the system prompt in workflows/flux3_upsampler_system.txt.
"""

import re
from pathlib import Path

BASE_DIR = Path(__file__).parent

UNET_PREF = [
    re.compile(r"flux3.*klein.*(sd|distill).*int8", re.I),
    re.compile(r"flux3.*klein.*int8", re.I),
    re.compile(r"flux.?3.*klein", re.I),
]
CLIP_PREF = re.compile(r"flux3.*klein.*qwen3vl.*(bf16|fp16)", re.I)
VAE_PREF = [re.compile(r"flux3.*(ae|vae)", re.I), re.compile(r"flux2.*vae", re.I)]
UPSAMPLER_PREF = re.compile(r"flux3.*upsampler|prompt_upsampler", re.I)

# NOTE: flux-3-klein-base-fp8r.safetensors is NOT usable on this ComfyUI build —
# it ships `*.weight_scale` tensors the loader reports as "unexpected", and
# every render comes out solid black (verified 2026-10-17). The step-distilled
# "sd" int8 build is the model; quality is bought with steps/resolution.
UNET_EXCLUDE = re.compile(r"base", re.I)


def pick(names: list[str], prefs) -> str:
    """First name matching the first matching preference (regex or list of)."""
    prefs = prefs if isinstance(prefs, list) else [prefs]
    for p in prefs:
        for n in names:
            if p.search(n):
                return n
    return ""


def snap16(n: int, lo: int = 256, hi: int = 4096) -> int:
    return max(lo, min(hi, int(round(int(n) / 16) * 16)))


def upsampler_system_prompt() -> str:
    return (BASE_DIR / "workflows" / "flux3_upsampler_system.txt").read_text(encoding="utf-8")


def _nid(graph: dict) -> str:
    """Next free id for a dynamically-added node. Starts at 100 so it can never
    collide with the fixed ids (1-13) the builders assign by hand."""
    return str(max(max((int(k) for k in graph if k.isdigit()), default=0), 99) + 1)


def build_flux3_graph(
    *,
    prompt: str,
    width: int,
    height: int,
    steps: int,
    cfg: float,
    seed: int,
    unet: str,
    clip: str,
    vae: str,
    negative: str = "",
    refs: list[str] | None = None,
    loras: list[dict] | None = None,
    sampler: str = "euler",
    prefix: str = "vsa/flux3",
    ref_megapixels: float = 1.0,
) -> dict:
    """`refs` = filenames already uploaded to ComfyUI's input dir. `loras` =
    [{"name", "strength_model", "strength_clip"}]. Returns an API graph whose
    only SaveImage is the last node (the face-swap splicer finds it by class)."""
    width, height = snap16(width), snap16(height)
    g: dict = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"},
              "_meta": {"title": "Flux 3 Klein"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": clip, "type": "flux3", "device": "default"},
              "_meta": {"title": "Qwen3-VL text encoder"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": vae}, "_meta": {"title": "Flux 3 VAE"}},
    }
    model_ref, clip_ref = ["1", 0], ["2", 0]
    for lora in loras or []:
        nid = _nid(g)
        g[nid] = {
            "class_type": "LoraLoader",
            "inputs": {
                "model": model_ref, "clip": clip_ref, "lora_name": lora["name"],
                "strength_model": lora.get("strength_model", 1.0),
                "strength_clip": lora.get("strength_clip", 1.0),
            },
            "_meta": {"title": f"LoRA: {lora['name']}"},
        }
        model_ref, clip_ref = [nid, 0], [nid, 1]

    g["4"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": clip_ref, "text": prompt},
              "_meta": {"title": "Prompt"}}
    if cfg > 1.0 and negative.strip():
        g["5"] = {"class_type": "CLIPTextEncode", "inputs": {"clip": clip_ref, "text": negative},
                  "_meta": {"title": "Negative prompt"}}
    else:
        g["5"] = {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]},
                  "_meta": {"title": "Negative (zeroed)"}}
    pos_ref, neg_ref = ["4", 0], ["5", 0]

    for i, fname in enumerate(refs or [], start=1):
        load, scale, enc = _nid(g), None, None
        g[load] = {"class_type": "LoadImage", "inputs": {"image": fname},
                   "_meta": {"title": f"Reference {i}"}}
        scale = _nid(g)
        g[scale] = {"class_type": "ImageScaleToTotalPixels",
                    "inputs": {"image": [load, 0], "upscale_method": "lanczos",
                               "megapixels": ref_megapixels, "resolution_steps": 16},
                    "_meta": {"title": f"Reference {i} → ~{ref_megapixels:g} MP"}}
        enc = _nid(g)
        g[enc] = {"class_type": "VAEEncode", "inputs": {"pixels": [scale, 0], "vae": ["3", 0]},
                  "_meta": {"title": f"Encode reference {i}"}}
        for label, ref in (("pos", pos_ref), ("neg", neg_ref)):
            rid = _nid(g)
            g[rid] = {"class_type": "ReferenceLatent",
                      "inputs": {"conditioning": ref, "latent": [enc, 0]},
                      "_meta": {"title": f"Reference {i} → {label}"}}
            if label == "pos":
                pos_ref = [rid, 0]
            else:
                neg_ref = [rid, 0]

    g["6"] = {"class_type": "EmptyFlux2LatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}}
    g["7"] = {"class_type": "Flux2Scheduler", "inputs": {"steps": steps, "width": width, "height": height}}
    g["8"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": sampler}}
    g["9"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}}
    g["10"] = {"class_type": "CFGGuider",
               "inputs": {"model": model_ref, "positive": pos_ref, "negative": neg_ref, "cfg": cfg}}
    g["11"] = {"class_type": "SamplerCustomAdvanced",
               "inputs": {"noise": ["9", 0], "guider": ["10", 0], "sampler": ["8", 0],
                          "sigmas": ["7", 0], "latent_image": ["6", 0]},
               "_meta": {"title": "Sampling"}}
    g["12"] = {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]},
               "_meta": {"title": "Decoding"}}
    g["13"] = {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": prefix}}
    return g


def build_upsample_graph(*, text: str, aspect_w: int, aspect_h: int, clip: str, seed: int,
                         max_length: int = 1024, image_file: str | None = None) -> dict:
    """Prompt-upsampler graph. The result is read off the PreviewAny node's
    `text` output in ComfyUI history. `image_file` (optional) lets the
    upsampler see an input image (edit-mode captions)."""
    from math import gcd
    d = gcd(aspect_w, aspect_h) or 1
    user = f"TARGET CANVAS: {aspect_w // d}:{aspect_h // d}\n{text.strip()}"
    g = {
        "1": {"class_type": "CLIPLoader", "inputs": {"clip_name": clip, "type": "flux3", "device": "default"},
              "_meta": {"title": "Prompt upsampler (Qwen3.5-9B)"}},
        "2": {"class_type": "TextGenerate",
              "inputs": {
                  "clip": ["1", 0], "prompt": user, "max_length": max_length,
                  "sampling_mode": "on", "sampling_mode.temperature": 0.8, "sampling_mode.top_k": 40,
                  "sampling_mode.top_p": 0.95, "sampling_mode.min_p": 0.0,
                  "sampling_mode.repetition_penalty": 1.05, "sampling_mode.seed": seed,
                  "sampling_mode.presence_penalty": 1.5,
                  "thinking": False, "use_default_template": True, "mtp": "auto",
                  "system_prompt": upsampler_system_prompt(),
              },
              "_meta": {"title": "Upsampling prompt"}},
        "3": {"class_type": "PreviewAny", "inputs": {"source": ["2", 0]}},
    }
    if image_file:
        g["4"] = {"class_type": "LoadImage", "inputs": {"image": image_file}}
        g["2"]["inputs"]["image"] = ["4", 0]
    return g


def add_mask_composite(graph: dict, original_file: str, mask_file: str, width: int, height: int,
                       feather: int = 12) -> dict:
    """True brush inpainting on top of Flux 3's instruction edit: the model
    re-renders the whole frame, then the result is composited back onto the
    ORIGINAL only inside the user's painted mask (feathered edge), so every
    pixel outside the brush is bit-identical to the source. Splices between the
    VAEDecode (node "12") and the SaveImage ("13") of build_flux3_graph."""
    width, height = snap16(width), snap16(height)
    orig, orig_s = _nid(graph), None
    graph[orig] = {"class_type": "LoadImage", "inputs": {"image": original_file},
                   "_meta": {"title": "Original (outside the mask stays untouched)"}}
    orig_s = _nid(graph)
    graph[orig_s] = {"class_type": "ImageScale",
                     "inputs": {"image": [orig, 0], "upscale_method": "lanczos", "width": width,
                                "height": height, "crop": "disabled"}}
    m_img = _nid(graph)
    graph[m_img] = {"class_type": "LoadImage", "inputs": {"image": mask_file},
                    "_meta": {"title": "Brush mask"}}
    m_s = _nid(graph)
    graph[m_s] = {"class_type": "ImageScale",
                  "inputs": {"image": [m_img, 0], "upscale_method": "bilinear", "width": width,
                             "height": height, "crop": "disabled"}}
    src = [m_s, 0]
    if feather > 0:
        blur = _nid(graph)
        graph[blur] = {"class_type": "ImageBlur",
                       "inputs": {"image": src, "blur_radius": min(feather, 31), "sigma": max(feather / 3, 0.5)},
                       "_meta": {"title": "Feather the mask edge"}}
        src = [blur, 0]
    m = _nid(graph)
    graph[m] = {"class_type": "ImageToMask", "inputs": {"image": src, "channel": "red"}}
    comp = _nid(graph)
    graph[comp] = {"class_type": "ImageCompositeMasked",
                   "inputs": {"destination": [orig_s, 0], "source": ["12", 0], "x": 0, "y": 0,
                              "resize_source": False, "mask": [m, 0]},
                   "_meta": {"title": "Composite edit into the masked region only"}}
    graph["13"]["inputs"]["images"] = [comp, 0]
    return graph
