"""Qwen Image 2.1 graph builder (ComfyUI core nodes: TextEncodeQwenImage21 + QwenImage21Cache).

Text-to-image, and image editing / multi-reference generation: reference images go into TextEncodeQwenImage21 (up to 16), which
feeds them to the Qwen3-VL text encoder and splices them in as VAE latents. Recipe from ComfyUI's own templates:
euler / simple, 25 steps, CFG 1, shift handled by the model, 64-channel /16 latent via EmptyLatentImage.
"""
import re

UNET_PREF = re.compile(r"qwen_image_2\.1(?!.*turbo).*", re.I)
TURBO_PREF = re.compile(r"qwen_image_2\.1.*turbo", re.I)
CLIP_PREF = [re.compile(r"qwen3vl_8b.*int8", re.I), re.compile(r"qwen3vl_8b", re.I)]
VAE_PREF = re.compile(r"qwen_image_2\.1_vae", re.I)


def pick(names, *patterns):
    for p in patterns:
        for n in names:
            if p.search(n):
                return n
    return ""


def build_graph(*, prompt, negative="", width=1024, height=1024, steps=25, cfg=1.0, seed=0, unet, clip, vae,
                refs=(), loras=(), ref_resolution=1024, sampler="euler", scheduler="simple", prefix="vsa/qwen21", cache="auto", control=None, match_ref_size=True):
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": clip, "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": vae}},
    }
    model = ["1", 0]
    nid = 10
    for lo in loras:
        g[str(nid)] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": model, "lora_name": lo["name"], "strength_model": float(lo.get("strength", 1.0))}}
        model = [str(nid), 0]
        nid += 1
    if control:
        # Fun-Controlnet-Union: a depth / canny / pose map steers the layout of the generation (strength ~0.6-1.0)
        g["20"] = {"class_type": "ModelPatchLoader", "inputs": {"name": control["patch"]}}
        g["21"] = {"class_type": "LoadImage", "inputs": {"image": control["image"]}}
        g["22"] = {"class_type": "QwenImageDiffsynthControlnet", "inputs": {
            "model": model, "model_patch": ["20", 0], "vae": ["3", 0], "image": ["21", 0], "strength": float(control.get("strength", 0.8)),
            "start_percent": 0.0, "end_percent": float(control.get("end", 1.0))}}
        model = ["22", 0]
    g["4"] = {"class_type": "QwenImage21Cache", "inputs": {"model": model, "device": cache, "dtype": "default"}}
    enc = {"clip": ["2", 0], "prompt": prompt, "negative_prompt": negative or "", "resolution": int(ref_resolution), "vae": ["3", 0]}
    for i, r in enumerate(refs):
        g[str(100 + i)] = {"class_type": "LoadImage", "inputs": {"image": r}}
        enc[f"images.image_{i + 1}"] = [str(100 + i), 0]
    g["5"] = {"class_type": "TextEncodeQwenImage21", "inputs": enc}
    if refs and not control and match_ref_size:
        # edit / reference mode: the canvas follows the first reference (the encoder returns an empty latent of that size)
        latent = ["5", 2]
    else:
        g["6"] = {"class_type": "EmptyLatentImage", "inputs": {"width": int(width), "height": int(height), "batch_size": 1}}
        latent = ["6", 0]
    g["7"] = {"class_type": "KSampler", "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["5", 1], "latent_image": latent,
                                                  "seed": int(seed), "steps": int(steps), "cfg": float(cfg), "sampler_name": sampler, "scheduler": scheduler, "denoise": 1.0}}
    g["8"] = {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}}
    g["9"] = {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": prefix}}
    return g
