"""
Hoodsfield — MCP server (stdio).

Lets any MCP client drive this studio's local tools: Flux 3 image
generation/editing, character sheets, upscale / interpolate / background
removal / ffmpeg edits, MiniMax H3 image-to-video and Genjutsu video-to-video.
It is a thin client of the running backend (http://127.0.0.1:8000), so start
the backend + ComfyUI first. No third-party dependency beyond httpx.

Register it with your MCP client (stdio):
    <venv>\\Scripts\\python.exe <repo>\\app\\backend\\mcp_server.py

Every tool returns file paths under VSA_MCP_OUT (default D:\\vsa_work\\mcp_out);
image results are also returned inline so the agent can look at them.
"""

import base64
import json
import mimetypes
import os
import sys
import time
import uuid
from pathlib import Path

import httpx

BASE = os.getenv("VSA_URL", "http://127.0.0.1:8000").rstrip("/")
OUT = Path(os.getenv("VSA_MCP_OUT", r"D:\vsa_work\mcp_out"))
OUT.mkdir(parents=True, exist_ok=True)
LIB = json.loads((Path(__file__).parent / "cinema_library.json").read_text(encoding="utf-8"))
TIMEOUT_S = float(os.getenv("VSA_MCP_TIMEOUT", "1800"))


# ----------------------------------------------------------------- helpers

def _find(lst, key, val):
    return next((x for x in lst if x.get(key) == val), None)


def rig_to_prompt(rig: dict) -> str:
    """Same compiler as the app's Cinema rig (frontend/src/cinema.js)."""
    parts = []
    for lib_key, field, key in [("shot_sizes", "shot", "id"), ("angles", "angle", "id"), ("camera_bodies", "body", "id"),
                                ("lenses", "lens", "id"), ("focal_lengths", "focal", "mm"), ("apertures", "aperture", "f"),
                                ("lighting", "light", "id"), ("film_looks", "film", "id")]:
        v = rig.get(field)
        if v is None:
            continue
        item = _find(LIB[lib_key], key, v)
        if item and item.get("text"):
            parts.append(item["text"])
    return ", ".join(parts)


def _client() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(60.0, read=TIMEOUT_S), trust_env=False)


def _wait_job(c: httpx.Client, job_id: str) -> tuple[str, str]:
    """Follow the SSE stream until done/error; returns (url, media)."""
    with c.stream("GET", f"{BASE}/api/events/{job_id}") as r:
        for line in r.iter_lines():
            if not line.startswith("data:"):
                continue
            ev = json.loads(line[5:])
            if ev.get("type") == "done":
                return ev["url"], ev.get("media", "")
            if ev.get("type") == "error":
                raise RuntimeError(ev.get("text", "job failed"))
    raise RuntimeError("event stream ended without a result")


def _save(c: httpx.Client, url: str, media: str, stem: str) -> Path:
    ext = {"image/png": ".png", "video/mp4": ".mp4", "image/gif": ".gif", "image/jpeg": ".jpg", "video/webm": ".webm"}.get(media, ".bin")
    data = c.get(f"{BASE}{url}").content
    p = OUT / f"{stem}_{uuid.uuid4().hex[:6]}{ext}"
    p.write_bytes(data)
    return p


def _files(paths: list[str], field: str):
    out = []
    for p in paths:
        pp = Path(p)
        out.append((field, (pp.name, pp.read_bytes(), mimetypes.guess_type(pp.name)[0] or "application/octet-stream")))
    return out


def _result(path: Path, extra: str = "") -> list[dict]:
    items = [{"type": "text", "text": f"{path}{(' — ' + extra) if extra else ''}"}]
    if path.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp") and path.stat().st_size < 4_000_000:
        items.append({"type": "image", "data": base64.b64encode(path.read_bytes()).decode(), "mimeType": mimetypes.guess_type(path.name)[0] or "image/png"})
    return items


def _job(c: httpx.Client, endpoint: str, data: dict, files: list, stem: str) -> Path:
    r = c.post(f"{BASE}{endpoint}", data={k: str(v) for k, v in data.items() if v is not None}, files=files or None)
    if r.status_code != 200:
        raise RuntimeError(f"{endpoint} -> {r.status_code}: {r.text[:500]}")
    j = r.json()
    url, media = _wait_job(c, j["job_id"])
    return _save(c, url, media, stem), j


# ----------------------------------------------------------------- tools

def t_generate_image(a):
    prompt = a["prompt"]
    if a.get("rig"):
        clause = rig_to_prompt(a["rig"])
        if clause:
            prompt = f"{prompt.rstrip('. ')}. {clause}."
    w, h = a.get("width", 1024), a.get("height", 1024)
    if a.get("aspect"):
        aw, ah = (float(x) for x in a["aspect"].split(":"))
        k = ((a.get("megapixels", 1.0) * 1e6) / (aw * ah)) ** 0.5
        w, h = round(aw * k / 16) * 16, round(ah * k / 16) * 16
    with _client() as c:
        p, j = _job(c, "/api/generate_flux3",
                    {"prompt": prompt, "width": w, "height": h, "steps": a.get("steps", 8), "seed": a.get("seed", -1),
                     "upsample": str(bool(a.get("upsample", False))).lower()},
                    _files(a.get("reference_images", []), "refs"), "image")
    return _result(p, f"seed {j['seed']}; prompt used: {j.get('prompt', prompt)[:300]}")


def t_edit_image(a):
    files = _files([a["image_path"], *a.get("reference_images", [])], "refs")
    if a.get("mask_path"):
        files += _files([a["mask_path"]], "mask")
    with _client() as c:
        p, _ = _job(c, "/api/generate_flux3",
                    {"prompt": a["instruction"], "match_ref_size": "true", "steps": a.get("steps", 8), "seed": a.get("seed", -1),
                     "mask_feather": a.get("mask_feather", 12)}, files, "edit")
    return _result(p)


def t_character_views(a):
    views = a.get("views") or ["in a three-quarter view turned slightly to the left", "in a left side profile view",
                               "seen from directly behind", "as a full-body shot standing, head to toe"]
    out = []
    with _client() as c:
        for v in views:
            prompt = (f"Show the exact same person from image 1, {v}, on a plain neutral light-grey studio background with soft even lighting. "
                      "Keep the face, hair, skin tone, age and clothing identical to image 1.")
            p, _ = _job(c, "/api/generate_flux3", {"prompt": prompt, "width": 832, "height": 1088, "steps": 8},
                        _files([a["image_path"]], "refs"), "charview")
            out.append(p)
    items = [{"type": "text", "text": "\n".join(str(p) for p in out)}]
    return items


def t_upscale(a):
    with _client() as c:
        p, _ = _job(c, "/api/tools/upscale", {"scale": a.get("scale", 2)}, _files([a["path"]], "file"), "upscaled")
    return _result(p)


def t_remove_background(a):
    with _client() as c:
        p, _ = _job(c, "/api/tools/remove_bg", {"background": a.get("background", "alpha")}, _files([a["path"]], "file"), "cutout")
    return _result(p)


def t_interpolate(a):
    with _client() as c:
        p, _ = _job(c, "/api/tools/interpolate", {"multiplier": a.get("multiplier", 2), "mode": a.get("mode", "smooth")},
                    _files([a["path"]], "file"), "interp")
    return _result(p)


def t_video_edit(a):
    op = a["op"]
    with _client() as c:
        r = c.post(f"{BASE}/api/tools/ffmpeg", data={k: str(v) for k, v in a.items() if k not in ("path",) and v is not None},
                   files=_files([a["path"]], "file"))
        if r.status_code != 200:
            raise RuntimeError(f"ffmpeg {op}: {r.status_code} {r.text[:400]}")
    ext = ".png" if op in ("first_frame", "last_frame") else ".gif" if op == "gif" else ".mp4"
    p = OUT / f"{op}_{uuid.uuid4().hex[:6]}{ext}"
    p.write_bytes(r.content)
    return _result(p)


def t_image_to_video(a):
    data = {"prompt": a["prompt"], "seconds": a.get("seconds", 5), "aspect": a.get("aspect", "16:9"),
            "preset": a.get("preset", "fast"), "seed": a.get("seed", -1), "lock_still": "true"}
    with _client() as c:
        p, j = _job(c, "/api/generate_h3", data, _files([a["image_path"]], "image"), "video")
    return _result(p, f"seed {j['seed']}")


def t_genjutsu(a):
    """Edit first frame with Flux 3 (instruction + refs), then LTX video-to-video."""
    with _client() as c:
        fr = c.post(f"{BASE}/api/tools/ffmpeg", data={"op": "first_frame"}, files=_files([a["video_path"]], "file"))
        fr.raise_for_status()
        first = OUT / f"gj_first_{uuid.uuid4().hex[:6]}.png"
        first.write_bytes(fr.content)
        g, _ = _job(c, "/api/generate_flux3", {"prompt": a["instruction"], "match_ref_size": "true", "steps": 8},
                    _files([str(first), *a.get("reference_images", [])], "refs"), "gj_guide")
        files = _files([a["video_path"]], "video") + _files([str(g)], "guide")
        p, j = _job(c, "/api/genjutsu", {"prompt": a.get("prompt", a["instruction"]), "denoise": a.get("denoise", 0.75),
                                         "seconds": a.get("seconds", 5), "megapixels": a.get("megapixels", 0.3),
                                         "seed": a.get("seed", -1)}, files, "genjutsu")
    return _result(p, f"guide frame: {g}")


def t_list_library(a):
    what = a.get("what", "camera_moves")
    if what not in LIB:
        return [{"type": "text", "text": f"unknown list; choose from {', '.join(LIB)}"}]
    slim = [{k: v for k, v in it.items() if k in ("id", "label", "cat", "text", "video", "mm", "f", "blurb", "mask", "refs", "options", "needs_text")} for it in LIB[what]]
    return [{"type": "text", "text": json.dumps(slim, ensure_ascii=False)}]


def t_camera_prompt(a):
    parts = []
    mv = _find(LIB["camera_moves"], "id", a.get("camera_move", ""))
    if mv:
        parts.append(mv["text"])
    fx = _find(LIB["effects"], "id", a.get("effect", ""))
    if fx:
        parts.append(fx["video"])
    rig = rig_to_prompt(a.get("rig", {})) if a.get("rig") else ""
    return [{"type": "text", "text": json.dumps({"video_motion_prompt": ". ".join(p[0].upper() + p[1:] for p in parts), "still_prompt_clause": rig})}]


S = {"type": "string"}
N = {"type": "number"}
TOOLS = {
    "generate_image": (t_generate_image, "Generate an image with Flux 3 Klein (~5 s). Optional reference_images (paths) for character/style/product guidance, Cinema rig (camera body/lens/focal/aperture/film/light ids from list_library), prompt upsampling.",
        {"prompt": S, "aspect": {**S, "description": "e.g. 16:9, 9:16, 1:1"}, "width": N, "height": N, "megapixels": N, "steps": N, "seed": N,
         "upsample": {"type": "boolean"}, "reference_images": {"type": "array", "items": S}, "rig": {"type": "object"}}, ["prompt"]),
    "edit_image": (t_edit_image, "Instruction-edit an image with Flux 3 (relight, change outfit, swap object, restyle, new angle…). Optional mask_path (white = area allowed to change) for exact inpainting; reference_images become 'image 2', 'image 3' in the instruction.",
        {"image_path": S, "instruction": S, "mask_path": S, "reference_images": {"type": "array", "items": S}, "steps": N, "seed": N, "mask_feather": N}, ["image_path", "instruction"]),
    "character_views": (t_character_views, "Build a consistent-character sheet from one photo: extra views (3/4, profile, back, full-body…) generated by Flux 3 reference editing.",
        {"image_path": S, "views": {"type": "array", "items": S}}, ["image_path"]),
    "upscale": (t_upscale, "Real-ESRGAN upscale of an image or video (scale 1.5–4).", {"path": S, "scale": N}, ["path"]),
    "remove_background": (t_remove_background, "BiRefNet background removal. Image: background=alpha gives a transparent PNG. Video: background=green|blue|white|black|grey.",
        {"path": S, "background": S}, ["path"]),
    "interpolate": (t_interpolate, "RIFE frame interpolation of a video. mode=smooth (higher fps) or slowmo.", {"path": S, "multiplier": N, "mode": S}, ["path"]),
    "video_edit": (t_video_edit, "ffmpeg ops on a video: reverse, speed(factor), boomerang, loop(loops), trim(start,end), reframe(aspect,fit=blur|crop|black), mute, gif, first_frame, last_frame.",
        {"path": S, "op": S, "factor": N, "start": N, "end": N, "loops": N, "aspect": S, "fit": S}, ["path", "op"]),
    "image_to_video": (t_image_to_video, "Animate a still with MiniMax H3 (native audio). Slow (minutes). Put camera move language in the prompt (see camera_prompt).",
        {"image_path": S, "prompt": S, "seconds": N, "aspect": S, "preset": S, "seed": N}, ["image_path", "prompt"]),
    "genjutsu": (t_genjutsu, "Video-to-video: keep a clip's motion/camera but swap a character/object or restyle it. Edits frame 1 with Flux 3 per `instruction` (+reference_images), then LTX 2.3 re-renders the clip. denoise 0.5–0.9 (higher = bigger change).",
        {"video_path": S, "instruction": S, "prompt": S, "reference_images": {"type": "array", "items": S}, "denoise": N, "seconds": N, "megapixels": N, "seed": N}, ["video_path", "instruction"]),
    "list_library": (t_list_library, "Browse the studio's libraries: camera_moves (80), effects, camera_bodies, lenses, focal_lengths, apertures, shot_sizes, angles, film_looks, lighting, styles, edit_tools.",
        {"what": S}, []),
    "camera_prompt": (t_camera_prompt, "Compile a camera move + effect id into video prompt text, and a Cinema rig into a still-prompt clause.",
        {"camera_move": S, "effect": S, "rig": {"type": "object"}}, []),
}


# ----------------------------------------------------------------- JSON-RPC (stdio, newline-delimited)

def _send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        if method == "initialize":
            _send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": params.get("protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {}}, "serverInfo": {"name": "hoodsfield", "version": "1.0"}}})
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [
                {"name": n, "description": d, "inputSchema": {"type": "object", "properties": props, "required": req}}
                for n, (_, d, props, req) in TOOLS.items()]}})
        elif method == "tools/call":
            name, args = params.get("name"), params.get("arguments") or {}
            try:
                if name not in TOOLS:
                    raise RuntimeError(f"unknown tool {name}")
                content = TOOLS[name][0](args)
                _send({"jsonrpc": "2.0", "id": mid, "result": {"content": content}})
            except Exception as e:  # tool errors are results, not protocol errors
                _send({"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{"type": "text", "text": f"{type(e).__name__}: {e}"}]}})
        elif method == "ping":
            _send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif mid is not None:
            _send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}})


if __name__ == "__main__":
    main()
