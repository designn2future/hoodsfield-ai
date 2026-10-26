"""
Generic placeholder injection for ComfyUI API-format workflow JSON.

Two placeholder styles are supported, so ANY exported workflow can be turned
into a template:

1. Whole-value placeholders (preferred) — the field's entire value is the
   quoted token; it is replaced with a correctly-typed JSON value:

       "width": "__WIDTH__"        ->  "width": 768
       "text":  "__PROMPT__"       ->  "text": "a misty forest..."

2. Inline placeholders — the token appears inside a longer string:

       "text": "cinematic, __PROMPT__, 35mm"

Available tokens: __PROMPT__  __NEGATIVE_PROMPT__  __WIDTH__  __HEIGHT__
__NUM_FRAMES__  __FPS__  __STEPS__  __CFG__  __SEED__  __DENOISE__
__FRAMES_DIR__  __FRAMES_SUBFOLDER__  __FIRST_FRAME__
"""

import json


def build_workflow(template_str: str, values: dict) -> str:
    out = template_str
    for key, val in values.items():
        token = f"__{key}__"
        # pass 1: whole-value replacement with proper JSON type
        out = out.replace(f'"{token}"', json.dumps(val))
        # pass 2: inline replacement inside remaining strings
        if token in out:
            inline = json.dumps(str(val))[1:-1]  # JSON-escaped, unquoted
            out = out.replace(token, inline)
    return out


def _next_node_id(graph: dict) -> str:
    numeric = [int(k) for k in graph if k.isdigit()]
    return str((max(numeric) if numeric else 0) + 1)


def append_faceswap_chain(
    graph: dict,
    faces: list[dict],
    swap_model: str = "inswapper_128.onnx",
    face_restore_model: str = "none",
) -> dict:
    """Splice a chain of ReActorFaceSwap nodes between the graph's final image
    and its SaveImage node, one per face. `faces` is an ordered list of
    {"index": int, "filename": str} — index = which detected face (0 =
    leftmost) to replace, filename = the uploaded source-face image path
    already present in ComfyUI's input dir. No-op if `faces` is empty.

    Uses the `ReActorFaceSwapOpt` node + a `ReActorOptions` node per face
    (not the plain `ReActorFaceSwap` node) to explicitly force
    `input_faces_order`/`source_faces_order` to "left-right". The plain
    node's `input_faces_index` looks positional but is NOT — ReActor's
    default (and the plain node's only available) ordering is "large-small"
    (sorts detected faces by bounding-box area, largest first), which the
    plain node has no input to override (its `faces_order` hidden input has
    no producer node in this pack, so it always falls back to that
    "large-small" default). Confirmed live: in a 3-up wide shot, this
    silently swapped a male cast member's reference face onto a different
    character's position — index 0 didn't mean "leftmost person," it meant
    "whichever detected face rendered largest," which is essentially a coin
    flip when several people are similar distances from camera. This only
    showed up in wide/group shots (faces close in size) and not close-ups
    (one dominant face, no ambiguity)."""
    if not faces:
        return graph

    save_id = next((nid for nid, n in graph.items() if n.get("class_type") == "SaveImage"), None)
    if save_id is None:
        raise ValueError("append_faceswap_chain: no SaveImage node found in graph")

    image_ref = graph[save_id]["inputs"]["images"]
    for face in faces:
        load_id = _next_node_id(graph)
        graph[load_id] = {
            "class_type": "LoadImage",
            "inputs": {"image": face["filename"]},
            "_meta": {"title": f"Source face for person index {face['index']}"},
        }
        opts_id = _next_node_id(graph)
        graph[opts_id] = {
            "class_type": "ReActorOptions",
            "inputs": {
                "input_faces_order": "left-right",
                "input_faces_index": str(face["index"]),
                "detect_gender_input": "no",
                "source_faces_order": "left-right",
                "source_faces_index": "0",
                "detect_gender_source": "no",
                "console_log_level": 1,
                "restore_swapped_only": True,
            },
            "_meta": {"title": f"ReActor options — person index {face['index']} (left-right)"},
        }
        swap_id = _next_node_id(graph)
        graph[swap_id] = {
            "class_type": "ReActorFaceSwapOpt",
            "inputs": {
                "enabled": True,
                "input_image": image_ref,
                "source_image": [load_id, 0],
                "options": [opts_id, 0],
                "swap_model": swap_model,
                "facedetection": "retinaface_resnet50",
                "face_restore_model": face_restore_model,
                "face_restore_visibility": 1,
                "codeformer_weight": 0.5,
            },
            "_meta": {"title": f"ReActor swap — person index {face['index']} (left-right)"},
        }
        image_ref = [swap_id, 0]

    graph[save_id]["inputs"]["images"] = image_ref
    return graph


def use_plain_unet_loader(graph: dict, node_id: str, unet_name: str) -> None:
    """Templates ship UnetLoaderGGUF, which only accepts .gguf files. When the
    picked model is a plain diffusion safetensors (e.g. an fp8 or finetuned
    transformer), swap the node to core UNETLoader in place — same unet_name
    input, same output slot, so downstream refs keep working."""
    if unet_name.lower().endswith(".gguf"):
        return
    node = graph[node_id]
    node["class_type"] = "UNETLoader"
    node["inputs"]["unet_name"] = unet_name
    node["inputs"]["weight_dtype"] = "default"


def bypass_enhancer_when_zero(graph: dict, enhancer_id: str, model_ref, enhancer_strength: float):
    """ComfyUI-Krea2T-Enhancer is documented as a safe no-op at strength 0, so
    the templates always wire it in. On this ComfyUI build the node pack
    currently errors (`krea2t_enhancer_wrapper() takes from 4 to 6 positional
    arguments but 7 were given` — a third-party node/ComfyUI version
    mismatch, not something to patch here). Skip it entirely at strength 0:
    delete the node and rewire whatever pointed at its output straight to
    `model_ref`. Returns the effective model ref (only meaningful when the
    caller still needs it — most don't, since this already rewires the
    downstream consumer in place)."""
    node = graph.get(enhancer_id)
    if not node:
        return model_ref
    if float(enhancer_strength or 0) > 0:
        node["inputs"]["model"] = model_ref
        return [enhancer_id, 0]
    old_ref = [enhancer_id, 0]
    del graph[enhancer_id]
    for n in graph.values():
        if not isinstance(n, dict):
            continue
        for k, v in n.get("inputs", {}).items():
            if v == old_ref:
                n["inputs"][k] = model_ref
    return model_ref


def append_lora_chain(graph: dict, model_ref, clip_ref, loras: list[dict]):
    """Chain core LoraLoader nodes onto a model/clip ref pair, one per entry in
    `loras` ({"name": str, "strength_model": float, "strength_clip": float}).
    Returns the final (model_ref, clip_ref) — unchanged if `loras` is empty."""
    for lora in loras:
        node_id = _next_node_id(graph)
        graph[node_id] = {
            "class_type": "LoraLoader",
            "inputs": {
                "model": model_ref,
                "clip": clip_ref,
                "lora_name": lora["name"],
                "strength_model": lora.get("strength_model", 1.0),
                "strength_clip": lora.get("strength_clip", 1.0),
            },
            "_meta": {"title": f"LoRA: {lora['name']}"},
        }
        model_ref, clip_ref = [node_id, 0], [node_id, 1]
    return model_ref, clip_ref


def set_video_lora_chain(graph: dict, loras: list[dict]) -> None:
    """Replace the LTX 2.3 i2v template's built-in model-only LoRA with the
    requested chain. The template ships one hardcoded LoraLoaderModelOnly
    (node 844:856, spliced between PromptRelayEncodeTimeline's model output
    and the stage-1 sampler's VRAM-clean wrapper 844:857 — stage 2 refines on
    the base model, per the proven source workflow). `loras` is
    [{"name": str, "strength": float}]; an empty list removes the LoRA
    entirely. Don't call at all to keep the template's built-in default."""
    lora_node = graph.pop("844:856")
    model_ref = lora_node["inputs"]["model"]  # PromptRelay model out
    for lora in loras:
        node_id = _next_node_id(graph)
        graph[node_id] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": model_ref,
                "lora_name": lora["name"],
                "strength_model": lora.get("strength", 1.0),
            },
            "_meta": {"title": f"Video LoRA: {lora['name']}"},
        }
        model_ref = [node_id, 0]
    graph["844:857"]["inputs"]["anything"] = model_ref


def attach_moodboard_images(graph: dict, node_id: str, filenames: list[str]) -> dict:
    """Wire uploaded reference images onto a TextEncodeKrea2 node's unbounded
    image1/image2/... slots (see comfyui-krea2-text-encoder's nodes.py —
    it collects any kwarg matching `image<N>` via a regex, no fixed cap)."""
    for i, filename in enumerate(filenames, start=1):
        load_id = _next_node_id(graph)
        graph[load_id] = {
            "class_type": "LoadImage",
            "inputs": {"image": filename},
            "_meta": {"title": f"Moodboard reference {i}"},
        }
        graph[node_id]["inputs"][f"image{i}"] = [load_id, 0]
    return graph


def use_vision_reference(
    graph: dict, positive_node_id: str, ksampler_node_id: str,
    clip_ref, prompt: str, reference_ref, width: int, height: int,
) -> dict:
    """Swap plain img2img (noised-pixel conditioning, shares one knob between
    'looks photorealistic' and 'follows my composition') for Krea2's own
    vision-conditioning path: the reference image is fed through the Qwen3-VL
    text encoder as a semantic description (including spatial relationships,
    per its own trained descriptor prompt) rather than as pixels the sampler
    partially denoises. Generation then runs at full denoise from a fresh
    empty latent — nothing sketch-like survives into the output pixels, so
    photorealism and composition-following stop competing on the same knob.
    `reference_ref` is a [node_id, output_index] pointing at an already-loaded
    IMAGE (reuse the existing sketch LoadImage node — no new upload needed).
    """
    graph[positive_node_id] = {
        "class_type": "TextEncodeKrea2",
        "inputs": {"clip": clip_ref, "prompt": prompt, "image1": reference_ref},
        "_meta": {"title": "Positive prompt — Krea2 vision-conditioned on the sketch (full denoise, no pixel-level img2img)"},
    }
    latent_id = _next_node_id(graph)
    graph[latent_id] = {
        "class_type": "EmptySD3LatentImage",
        "inputs": {"width": width, "height": height, "batch_size": 1},
        "_meta": {"title": "Fresh latent — composition comes from the vision reference, not img2img noise"},
    }
    graph[ksampler_node_id]["inputs"]["latent_image"] = [latent_id, 0]
    graph[ksampler_node_id]["inputs"]["denoise"] = 1.0
    return graph


def add_two_pass_refine(
    graph: dict, base_ksampler_id: str, vaedecode_id: str,
    steps: int, cfg: float, denoise: float,
) -> dict:
    """Chain a second KSampler onto an existing img2img pass's output latent —
    'compose at low denoise, then refine away sketch-line artifacts at a
    second, higher denoise', the standard two-pass/hires-fix technique. Fixes
    the case where no single denoise value both follows a rough sketch's
    composition AND looks photorealistic: pass 1 (low denoise) locks in
    composition but looks sketch-like; this second pass starts from that
    already-shaded, already-proportioned result instead of bare linework, so
    a higher denoise has real photographic material to preserve while erasing
    the sketchy look. Reuses pass 1's model/positive/negative/sampler/
    scheduler/seed — only steps/cfg/denoise are independently set. Rewires
    the given VAEDecode node to decode the refined pass instead of the base.
    """
    base = graph[base_ksampler_id]["inputs"]
    refine_id = _next_node_id(graph)
    graph[refine_id] = {
        "class_type": "KSampler",
        "inputs": {
            "model": base["model"],
            "positive": base["positive"],
            "negative": base["negative"],
            "latent_image": [base_ksampler_id, 0],
            "seed": base["seed"],
            "steps": steps,
            "cfg": cfg,
            "sampler_name": base["sampler_name"],
            "scheduler": base["scheduler"],
            "denoise": denoise,
        },
        "_meta": {"title": "Refine pass — removes sketch-line artifacts from the composed first pass"},
    }
    graph[vaedecode_id]["inputs"]["samples"] = [refine_id, 0]
    return graph


def add_depth_control_refine(
    graph: dict, base_ksampler_id: str, vaedecode_id: str, save_id: str,
    model_ref, vae_ref, depth_lora_name: str, control_strength: float,
    width: int, height: int,
) -> dict:
    """The Krea2 equivalent of the SD path's ControlNet: pass 1 (the existing
    img2img compose at low denoise) yields a photo-ish intermediate with real
    perspective; a depth map is extracted from THAT (a depth estimator on the
    raw line-art sketch produces near-uniform garbage — the depth Control
    LoRA's own model card warns against flat 2D input), then pass 2
    regenerates from a fresh latent at FULL denoise with the Krea2 depth
    Control LoRA locking structure. Composition comes from control
    conditioning, realism from full denoise — decoupled, no shared knob.

    `model_ref` must be the pass-1 model WITHOUT the Control LoRA (loading
    the Control LoRA with no attached control latent fails sampling, per the
    node pack's docs) — the control chain branches off it for pass 2 only.
    Requires facok/comfyui-krea2-controlnet + comfyui_controlnet_aux
    installed in ComfyUI. Rewires SaveImage to the new final decode.
    """
    base = graph[base_ksampler_id]["inputs"]

    depth_id = _next_node_id(graph)
    graph[depth_id] = {
        "class_type": "DepthAnythingV2Preprocessor",
        "inputs": {
            "image": [vaedecode_id, 0],
            "ckpt_name": "depth_anything_v2_vitl.safetensors",
            "resolution": 512,
        },
        "_meta": {"title": "Depth from the composed pass-1 image (not the flat sketch)"},
    }
    latent_id = _next_node_id(graph)
    graph[latent_id] = {
        "class_type": "EmptySD3LatentImage",
        "inputs": {"width": width, "height": height, "batch_size": 1},
        "_meta": {"title": "Fresh latent for the controlled full-denoise pass"},
    }
    encode_id = _next_node_id(graph)
    graph[encode_id] = {
        "class_type": "Krea2ControlImageEncode",
        "inputs": {
            "control_image": [depth_id, 0],
            "vae": vae_ref,
            "latent": [latent_id, 0],
            "resize": "match_latent_size",
            "upscale_method": "lanczos",
            "crop": "center",
            "channel_mode": "grayscale",
            "normalize": "per_image_minmax",
            "invert": False,
            "batch_mode": "independent_images",
        },
        "_meta": {"title": "Depth map -> Krea2 control latent (settings per the node pack's depth recipe)"},
    }
    loader_id = _next_node_id(graph)
    graph[loader_id] = {
        "class_type": "Krea2ControlLoRALoader",
        "inputs": {"model": model_ref, "lora_name": depth_lora_name, "strength": control_strength},
        "_meta": {"title": "Krea2 depth Control LoRA"},
    }
    apply_id = _next_node_id(graph)
    graph[apply_id] = {
        "class_type": "Krea2ControlApply",
        "inputs": {"model": [loader_id, 0], "control_latent": [encode_id, 0]},
        "_meta": {"title": "Attach control latent — required after the loader or sampling fails"},
    }
    sampler_id = _next_node_id(graph)
    graph[sampler_id] = {
        "class_type": "KSampler",
        "inputs": {
            "model": [apply_id, 0],
            "positive": base["positive"],
            "negative": base["negative"],
            "latent_image": [latent_id, 0],
            "seed": base["seed"],
            "steps": base["steps"],
            "cfg": base["cfg"],
            "sampler_name": base["sampler_name"],
            "scheduler": base["scheduler"],
            "denoise": 1.0,
        },
        "_meta": {"title": "Controlled full-denoise pass — structure from depth, realism from full denoise"},
    }
    decode_id = _next_node_id(graph)
    graph[decode_id] = {
        "class_type": "VAEDecode",
        "inputs": {"samples": [sampler_id, 0], "vae": vae_ref},
        "_meta": {"title": "Decode final"},
    }
    graph[save_id]["inputs"]["images"] = [decode_id, 0]
    return graph
