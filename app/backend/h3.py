"""
MiniMax H3 graph builder — image-to-video / reference-to-video with native
audio, built as a ComfyUI API-format graph in Python (no exported template).

Recipe (verified on the RTX 4060 Ti 16GB box, 2026-09):
  * DiffusionModelLoaderKJ  -> the int8 fused Turbo-8 checkpoint
  * MiniMaxH3SigmaShift 12/3 (the model's own defaults; exposed as knobs)
  * FAST preset  = 4-step manual sigmas (0.9999166, 0.9728326, 0.9230769,
                   0.8, 0) + euler   (~2.5 min warm, audio clean with the
                   local time_shift_secant patch in comfy/ldm/minimax)
  * QUALITY      = BasicScheduler simple / 8 steps + res_multistep (the
                   model card's sampler; cleaner audio noise floor)
  * fp16 video VAE + fp32 audio VAE  (the int8_convrot video VAE decodes
    every frame to black)
  * CreateVideo 24 fps -> SaveVideo mp4

Frame counts live on H3's 17k+5 grid at 24 fps; anything else is snapped UP
by the node, so the UI only ever offers grid lengths. Canvas: H3 is trained
on a 768 short edge, but 0.4 MP is what fits comfortably here.
"""

import math
import re

FPS = 24
FRAME_GRID = [5 + 17 * k for k in range(1, 40)]  # 22, 39, 56, ... (5 itself is a single latent step)
DEFAULT_FRAMES = 124                             # ~5.2 s
FAST_SIGMAS = "0.9999166, 0.9728326, 0.9230769, 0.8, 0.0"

# Names we prefer when the UI doesn't pin a file (regex, first match wins).
MODEL_PREF = re.compile(r"minimax.*h3|h3.*minimax", re.I)
TEXT_ENCODER_PREF = re.compile(r"minimax", re.I)
VIDEO_VAE_PREF = [re.compile(r"minimax.*video.*fp16", re.I), re.compile(r"minimax.*video(?!.*int8)", re.I)]
AUDIO_VAE_PREF = re.compile(r"minimax.*audio", re.I)


def snap_frames(frames: int, max_frames: int | None = None) -> int:
    """Nearest grid length at or below `frames` (never longer than asked —
    the user's clip budget is a hard VRAM ceiling), clamped to `max_frames`."""
    frames = max(FRAME_GRID[0], int(frames))
    fitted = FRAME_GRID[0]
    for f in FRAME_GRID:
        if f <= frames:
            fitted = f
        else:
            break
    if max_frames:
        fitted = min(fitted, snap_frames(max_frames))
    return fitted


def seconds_to_frames(seconds: float, max_frames: int | None = None) -> int:
    return snap_frames(round(seconds * FPS + 1e-6), max_frames)


def frames_to_seconds(frames: int) -> float:
    return frames / FPS


def canvas_for(aspect: float, megapixels: float = 0.4, multiple: int = 32) -> tuple[int, int]:
    """Width/height for a target pixel budget at the given aspect (w/h),
    both multiples of 32 (H3's latent is /16, its canvas rule is /32). Width
    is rounded first and height derived from it, matching the
    ResolutionSelector behaviour the proven workflows used (0.4 MP 9:16 =
    480x864)."""
    aspect = max(0.2, min(5.0, float(aspect) or 1.0))
    area = max(0.05, float(megapixels)) * 1_000_000
    w = math.sqrt(area * aspect)
    w = max(multiple, round(w / multiple) * multiple)
    h = max(multiple, round((w / aspect) / multiple) * multiple)
    return int(w), int(h)


def pick(names: list[str], prefs) -> str:
    """First name matching any of the preference regexes, else the first name."""
    if isinstance(prefs, re.Pattern):
        prefs = [prefs]
    for p in prefs:
        for n in names:
            if p.search(n):
                return n
    return names[0] if names else ""


def build_h3_graph(
    *,
    model: str,
    text_encoder: str,
    video_vae: str,
    audio_vae: str,
    prompt: str,
    width: int,
    height: int,
    frames: int,
    seed: int,
    preset: str = "fast",
    steps: int = 8,
    sampler: str = "",
    shift_video: float = 12.0,
    shift_audio: float = 3.0,
    first_frame: str | None = None,
    last_frame: str | None = None,
    ref_images: list[str] | None = None,
    ref_image_size: str = "match",
    use_kj_loader: bool = True,
    enable_fp16_accumulation: bool = False,
    filename_prefix: str = "vsa/h3/clip",
    loras: list[dict] | None = None,
) -> dict:
    """Return an API-format graph. `first_frame`/`last_frame`/`ref_images`
    are ComfyUI input-dir paths (already uploaded). With `ref_images` the
    graph uses MiniMaxH3ReferenceToVideo (prompt refers to them as
    <Picture 1>, <Picture 2>…); otherwise MiniMaxH3ImageToVideo, which is
    plain text-to-video when no keyframe is given."""
    ref_images = [r for r in (ref_images or []) if r]
    fast = preset == "fast"
    if not sampler:
        sampler = "euler" if fast else "res_multistep"

    g: dict[str, dict] = {}

    def node(nid, class_type, inputs, title):
        g[nid] = {"class_type": class_type, "inputs": inputs, "_meta": {"title": title}}

    if use_kj_loader:
        node("1", "DiffusionModelLoaderKJ", {
            "model_name": model,
            "weight_dtype": "default",
            "compute_dtype": "default",
            "patch_cublaslinear": False,
            "sage_attention": "auto",
            "enable_fp16_accumulation": enable_fp16_accumulation,
        }, "Loading MiniMax H3 transformer")
    else:
        node("1", "UNETLoader", {"unet_name": model, "weight_dtype": "default"}, "Loading MiniMax H3 transformer")
    model_ref = ["1", 0]
    for i, lo in enumerate(loras or []):   # model-only LoRAs (the text encoder is not touched)
        lid = f"3{i}0"
        node(lid, "LoraLoaderModelOnly", {"model": model_ref, "lora_name": lo["name"], "strength_model": lo["strength"]},
             f"LoRA: {lo['name']}")
        model_ref = [lid, 0]
    node("2", "MiniMaxH3SigmaShift", {"model": model_ref, "shift_video": shift_video, "shift_audio": shift_audio},
         "Sigma shift")
    node("3", "CLIPLoader", {"clip_name": text_encoder, "type": "minimax", "device": "default"},
         "Loading Qwen3-VL-32B text encoder")
    node("4", "VAELoader", {"vae_name": video_vae}, "Loading video VAE")
    node("5", "VAELoader", {"vae_name": audio_vae}, "Loading audio VAE")

    # keyframes / references
    next_id = 20
    if ref_images:
        inputs = {
            "clip": ["3", 0], "vae": ["4", 0], "audio_vae": ["5", 0],
            "prompt": prompt, "width": width, "height": height, "length": frames,
            "ref_image_size": ref_image_size,
        }
        for i, path in enumerate(ref_images[:9]):
            lid = str(next_id)
            next_id += 1
            node(lid, "LoadImage", {"image": path}, f"Reference image <Picture {i + 1}>")
            inputs[f"ref_image_{i}"] = [lid, 0]
        node("6", "MiniMaxH3ReferenceToVideo", inputs, "Encoding prompt + references (Qwen3-VL 32B)")
    else:
        inputs = {
            "clip": ["3", 0], "vae": ["4", 0],
            "prompt": prompt, "width": width, "height": height, "length": frames,
        }
        if first_frame:
            node("7", "LoadImage", {"image": first_frame}, "Scene still (first frame)")
            inputs["first_frame"] = ["7", 0]
        if last_frame:
            node("8", "LoadImage", {"image": last_frame}, "Last frame")
            inputs["last_frame"] = ["8", 0]
        node("6", "MiniMaxH3ImageToVideo", inputs, "Encoding prompt + keyframe (Qwen3-VL 32B)")

    node("9", "BasicGuider", {"model": ["2", 0], "conditioning": ["6", 0]}, "Guider")
    node("10", "RandomNoise", {"noise_seed": seed}, "Noise")
    node("11", "KSamplerSelect", {"sampler_name": sampler}, "Sampler")
    if fast:
        node("12", "ManualSigmas", {"sigmas": FAST_SIGMAS}, "FAST 4-step sigmas")
    else:
        node("12", "BasicScheduler", {"model": ["2", 0], "scheduler": "simple", "steps": int(steps), "denoise": 1.0},
             f"Scheduler simple / {steps} steps")
    node("13", "SamplerCustomAdvanced", {
        "noise": ["10", 0], "guider": ["9", 0], "sampler": ["11", 0], "sigmas": ["12", 0],
        "latent_image": ["6", 1],
    }, "Sampling video + audio")
    node("14", "VAEDecode", {"samples": ["13", 0], "vae": ["4", 0]}, "Decoding video")
    node("15", "VAEDecodeAudio", {"samples": ["13", 0], "vae": ["5", 0]}, "Decoding audio")
    node("16", "CreateVideo", {"images": ["14", 0], "audio": ["15", 0], "fps": FPS, "bit_depth": 8},
         "Muxing video")
    node("17", "SaveVideo", {"video": ["16", 0], "filename_prefix": filename_prefix, "format": "mp4", "codec": "auto"},
         "Saving mp4")
    return g


# ----------------------------------------------------------------- prompt text

def format_timecode(t: float) -> str:
    t = max(0.0, t)
    m = int(t // 60)
    s = t - m * 60
    return f"{m:02d}:{s:04.1f}".replace(".0", "") if s != int(s) else f"{m:02d}:{int(s):02d}"


def compose_h3_prompt(description: str, soundscape: str = "", music: str = "No music.",
                      shots: list[dict] | None = None) -> str:
    """The three-section prompt layout H3 was trained on. `shots` is an
    optional list of {"start": s, "end": s, "text": str} — when given, the
    description becomes numbered [Shot i | mm:ss-mm:ss] blocks with
    `description` as the shared preamble."""
    parts = ["integrated_multimodal_description:", ""]
    if shots:
        if description.strip():
            parts += [description.strip(), ""]
        for i, sh in enumerate(shots, start=1):
            parts.append(f"[Shot {i} | {format_timecode(sh['start'])}-{format_timecode(sh['end'])}]")
            parts.append(sh["text"].strip())
            parts.append("")
    else:
        parts += [description.strip(), ""]
    parts += ["overall_soundscape:", "", (soundscape or "Natural ambience matching the scene.").strip(), ""]
    parts += ["non_diegetic_music:", "", (music or "No music.").strip()]
    return "\n".join(parts).strip() + "\n"


def timeline_to_shots(prompt: str, seconds: float) -> tuple[str, list[dict]]:
    """Convert the storyboard timeline DSL (`|` segments, `[3s]` tags, `*`
    global anchor) into H3 shot blocks. Returns (preamble, shots). A plain
    prompt returns ("", []) so callers fall back to a single description."""
    tag = re.compile(r"^\[(\d+(?:\.\d+)?)\s*(s|f)\]\s*", re.I)
    global_parts, segs = [], []
    for raw in prompt.split("|"):
        text = raw.strip()
        if not text:
            continue
        if text.startswith("*"):
            global_parts.append(text.lstrip("*").strip())
            continue
        dur = None
        m = tag.match(text)
        if m:
            n = float(m.group(1))
            dur = n if m.group(2).lower() == "s" else n / FPS
            text = text[m.end():].strip()
        if text:
            segs.append([text, dur])
    if len(segs) <= 1 and not global_parts:
        return "", []
    if len(segs) <= 1:
        # only a global anchor + one segment: still worth one shot block
        pass
    fixed = sum(d for _, d in segs if d)
    autos = [s for s in segs if not s[1]]
    share = max((seconds - fixed) / len(autos), 0.3) if autos else 0
    for s in autos:
        s[1] = share
    total = sum(d for _, d in segs) or seconds
    scale = seconds / total if total > 0 else 1.0
    shots, t = [], 0.0
    for text, d in segs:
        d = d * scale
        shots.append({"start": t, "end": min(seconds, t + d), "text": text})
        t += d
    return " ".join(global_parts), shots
