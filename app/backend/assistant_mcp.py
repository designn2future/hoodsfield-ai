"""
Hoodsfield Assistant — MCP server (stdio) used ONLY by the Assistant's headless Claude session.

Gives Claude the studio's pipeline as tools (stills, H3 clips, chaos cut, contact sheets) plus the two that make it an
assistant you can walk away from: `report` (a progress note the app shows on every screen) and `ask_user` (stops and waits
for the user's approval, answered from the PC or the phone). It talks to the running backend; env: VSA_URL, ASSISTANT_RUN,
ASSISTANT_DIR.
"""
import base64
import json
import mimetypes
import os
import re
import sys
import time
import uuid
from pathlib import Path

import httpx

BASE = os.getenv("VSA_URL", "http://127.0.0.1:8000").rstrip("/")
RUN = os.getenv("ASSISTANT_RUN", "")
DIR = Path(os.getenv("ASSISTANT_DIR", str(Path.home() / "hoodsfield_assistant")))
DIR.mkdir(parents=True, exist_ok=True)
import app_settings
OUTPUT = app_settings.output_dir()
TIMEOUT_S = 1800


def _client(read=TIMEOUT_S):
    return httpx.Client(timeout=httpx.Timeout(60.0, read=read), trust_env=False)


def _board(op, **kw):
    """Tell the app's live board what is happening (never fails the tool)."""
    if not RUN:
        return
    try:
        with _client(15) as c:
            c.post(f"{BASE}/api/assistant/runs/{RUN}/board", json={"op": op, **kw})
    except Exception:
        pass


def _wait_job(c, job_id, now=None, shot=None):
    last = 0.0
    with c.stream("GET", f"{BASE}/api/events/{job_id}") as r:
        for line in r.iter_lines():
            if not line.startswith("data:"):
                continue
            ev = json.loads(line[5:])
            if now and ev.get("type") == "progress" and time.time() - last > 2.5:
                last = time.time()
                _board("now", text=now, shot=shot, progress=round(ev.get("value", 0) / max(1, ev.get("max", 1)), 3))
            if ev.get("type") == "done":
                return ev["url"], ev.get("media", "")
            if ev.get("type") == "error":
                raise RuntimeError(ev.get("text", "job failed"))
    raise RuntimeError("event stream ended without a result")


def _save(c, url, media, stem):
    ext = {"image/png": ".png", "video/mp4": ".mp4", "image/jpeg": ".jpg"}.get(media, ".bin")
    p = DIR / f"{stem}_{uuid.uuid4().hex[:6]}{ext}"
    p.write_bytes(c.get(f"{BASE}{url}").content)
    return p


def _img_item(p: Path):
    return {"type": "image", "data": base64.b64encode(p.read_bytes()).decode(), "mimeType": mimetypes.guess_type(p.name)[0] or "image/png"}


def _small(p: Path, side=900) -> Path:
    """A smaller jpeg of an image so what Claude looks at stays cheap."""
    import cv2
    im = cv2.imread(str(p))
    if im is None:
        return p
    h, w = im.shape[:2]
    k = side / max(h, w)
    if k < 1:
        im = cv2.resize(im, (int(w * k), int(h * k)), interpolation=cv2.INTER_AREA)
    q = DIR / f"look_{uuid.uuid4().hex[:6]}.jpg"
    cv2.imwrite(str(q), im, [cv2.IMWRITE_JPEG_QUALITY, 82])
    return q


def _sheet(video: Path, n=8, cols=4, tile_w=220) -> Path:
    """Evenly spaced frames of a video as one contact sheet image."""
    import cv2
    import numpy as np
    cap = cv2.VideoCapture(str(video))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    tiles = []
    for i in range(n):
        idx = int((total - 1) * i / max(1, n - 1))
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, f = cap.read()
        if not ok:
            continue
        h, w = f.shape[:2]
        f = cv2.resize(f, (tile_w, int(h * tile_w / w)))
        cv2.putText(f, f"{idx / fps:.1f}s", (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 1, cv2.LINE_AA)
        tiles.append(f)
    cap.release()
    if not tiles:
        raise RuntimeError("could not read any frames")
    th = tiles[0].shape[0]
    rows = []
    for r in range(0, len(tiles), cols):
        row = tiles[r:r + cols]
        while len(row) < cols:
            row.append(np.zeros((th, tile_w, 3), np.uint8))
        rows.append(np.hstack(row))
    out = DIR / f"sheet_{video.stem}_{uuid.uuid4().hex[:4]}.jpg"
    cv2.imwrite(str(out), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 80])
    return out


def _post_event(kind, text="", media=None):
    if not RUN:
        return {}
    try:
        with _client(30) as c:
            r = c.post(f"{BASE}/api/assistant/runs/{RUN}/event", json={"kind": kind, "text": text, "media": [str(m) for m in (media or [])]})
            return r.json() if r.status_code == 200 else {}
    except Exception:
        return {}


# ----------------------------------------------------------------- tools

def t_report(a):
    r = _post_event("say", a.get("message", ""), a.get("media"))
    note = (r or {}).get("inbox") or ""
    return [{"type": "text", "text": "ok" + (f"\nNEW MESSAGE FROM THE USER (follow it): {note}" if note else "")}]


def _gate():
    """Honour the app's Pause button: wait here (before starting a new step) while the user has paused the project."""
    shown = False
    while True:
        try:
            with _client(15) as c:
                s = c.get(f"{BASE}/api/assistant/runs/{RUN}/state").json()
        except Exception:
            return
        if s.get("cancelled"):
            raise RuntimeError("The user stopped this project.")
        if not s.get("paused"):
            if shown:
                _board("now", text="")
            return
        if not shown:
            _board("now", text="⏸ Paused. Press Continue when you are ready.", progress=None)
            shown = True
        time.sleep(3)


def t_set_shots(a):
    _board("shots", shots=a["shots"])
    _board("stage", stage="script")
    return [{"type": "text", "text": f"board set with {len(a['shots'])} shots"}]


def t_mark_result(a):
    _board("mark", shot=int(a["shot"]), path=a["path"], status=a.get("status", "rejected"), reason=a.get("reason", ""))
    return [{"type": "text", "text": "marked"}]


def t_ask_user(a):
    _board("now", text="")
    with _client(30) as c:
        r = c.post(f"{BASE}/api/assistant/runs/{RUN}/ask", json={"title": a.get("title", "Approval"), "message": a.get("message", ""),
                                                                   "media": [str(m) for m in a.get("media", [])], "options": a.get("options") or ["Approve", "Change something"],
                                                                   "picks": a.get("picks") or [], "suggestions": a.get("suggestions") or []})
        r.raise_for_status()
        aid = r.json()["id"]
    t0 = time.time()
    while time.time() - t0 < 12 * 3600:
        time.sleep(3)
        try:
            with _client(30) as c:
                s = c.get(f"{BASE}/api/assistant/runs/{RUN}/approval/{aid}").json()
        except Exception:
            continue
        if s.get("answered"):
            note = s.get("note") or ""
            return [{"type": "text", "text": f"USER ANSWERED: {s.get('choice')}" + (f"\nNOTE: {note}" if note else "")}]
        if s.get("cancelled"):
            raise RuntimeError("The user cancelled this project.")
    raise RuntimeError("The user did not answer for 12 hours.")


def _characters() -> dict:
    """Named character references the user attached: lowercase name -> picture path."""
    f = os.getenv("ASSISTANT_REFS", "")
    try:
        refs = json.loads(Path(f).read_text(encoding="utf-8")) if f and Path(f).is_file() else []
    except Exception:
        refs = []
    return {r["char"].lower(): (r["char"], r["path"]) for r in refs if r.get("char") and r.get("kind") == "image"}


def link_names(prompt: str, paths: list) -> tuple[str, list, bool]:
    """@Harvey -> 'Harvey (the person from image N)' and Harvey's picture joins the reference list as image N."""
    chars = _characters()
    if not chars:
        return prompt, paths, False
    paths = list(paths)
    pat = re.compile("@(" + "|".join(re.escape(v[0]) for v in sorted(chars.values(), key=lambda v: -len(v[0]))) + r")(?!\w)", re.I)
    pos, said = {}, set()

    def sub(mm):
        key = mm.group(1).lower()
        nm, path = chars[key]
        if key not in pos:
            if path not in paths:
                paths.append(path)
            pos[key] = paths.index(path) + 1
        if key in said:
            return nm
        said.add(key)
        return f"{nm} (the person from image {pos[key]})"
    out = pat.sub(sub, prompt)
    return out, paths, bool(pos)


def t_make_still(a):
    _gate()
    a = dict(a)
    a["prompt"], a["reference_images"], has_char = link_names(a["prompt"], a.get("reference_images", []))
    unlinked = sorted({m_.group(1) for m_ in re.finditer(r"(?<![\w@])@([A-Za-z][\w-]{1,29})", a["prompt"])})      # @Names with no attached picture
    if unlinked and os.getenv("ASSISTANT_CHAR_MODE", "combo") != "flux":
        has_char = True
    aw, ah = (float(x) for x in a.get("aspect", "9:16").split(":"))
    k = ((float(a.get("megapixels", 1.0)) * 1e6) / (aw * ah)) ** 0.5
    w, h = round(aw * k / 16) * 16, round(ah * k / 16) * 16
    refs = [Path(p) for p in a.get("reference_images", [])]
    engine = a.get("engine", "flux3")
    if has_char:      # the user's setting decides how pictures with a named character are made
        mode = os.getenv("ASSISTANT_CHAR_MODE", "combo")
        framing = str(a.get("framing", "close")).lower()
        if mode == "qwen" or (mode == "combo" and framing in ("close", "medium")):
            engine = "qwen"
        elif mode == "flux" or (mode == "combo" and framing in ("wide", "far")):
            engine = "flux3"
    data = {"prompt": a["prompt"], "width": w, "height": h, "seed": a.get("seed", -1)}
    if engine == "qwen":
        ep = "/api/generate_qwen21"
        data.update(steps=25, cfg=1.0, match_ref_size=False)
    else:
        ep = "/api/generate_flux3"
        data.update(steps=8, cfg=1.0, match_ref_size=False)
    files = [("refs", (p.name, p.read_bytes(), mimetypes.guess_type(p.name)[0] or "image/png")) for p in refs]
    shot, label = int(a.get("shot") or 0), a.get("label", "")
    eng_name = "Qwen" if engine == "qwen" else "Flux 3"
    what = (f"Making a still for shot {shot}" + (f" ({label})" if label else "") + f" with {eng_name}" + (" (about 1-2 min)" if engine == "qwen" else "")) if shot else f"Making a still with {eng_name}"
    if shot:
        _board("stage", stage="stills")
    _board("now", text=what, shot=shot, progress=0)
    with _client() as c:
        r = c.post(f"{BASE}{ep}", data={k: str(v) for k, v in data.items()}, files=files or None)
        if r.status_code != 200:
            raise RuntimeError(f"{ep} -> {r.status_code}: {r.text[:400]}")
        j = r.json()
        url, media = _wait_job(c, j["job_id"], what, shot)
        p = _save(c, url, media, "still")
    if shot:
        _board("add", kind="still", shot=shot, media=[str(p)], seed=j["seed"], label=label or eng_name, prompt=a["prompt"][:600])
    _board("now", text="")
    names = ", ".join("@" + n for n in unlinked)
    warn = (f"\nWARNING: {names} has NO reference picture attached, so this picture did not use one and the character will not match. "
            "Tell the user (report) and ask them to attach the character on the project screen; do not keep regenerating.") if unlinked else ""
    return [{"type": "text", "text": f"{p}  (seed {j['seed']}, {w}x{h}, engine {eng_name}){warn}"}, _img_item(_small(p))]


def t_make_clip(a):
    _gate()
    img = Path(a["still_path"])
    data = {"description": a["description"], "soundscape": a.get("soundscape", "quiet room tone, no voices, no music"), "music": "No music.",
            "frames": a.get("frames", 107), "megapixels": a.get("megapixels", 0.4), "preset": "fast", "seed": a.get("seed", -1), "lock_still": "true"}
    shot = int(a.get("shot") or 0)
    what = f"Animating shot {shot} (about 1-3 min)" if shot else "Animating a clip (about 1-3 min)"
    if shot:
        _board("stage", stage="clips")
    _board("now", text=what, shot=shot, progress=0)
    with _client() as c:
        r = c.post(f"{BASE}/api/generate_h3", data={k: str(v) for k, v in data.items()}, files=[("image", (img.name, img.read_bytes(), "image/png"))])
        if r.status_code != 200:
            raise RuntimeError(f"generate_h3 -> {r.status_code}: {r.text[:400]}")
        j = r.json()
        url, media = _wait_job(c, j["job_id"], what, shot)
        p = _save(c, url, media, "clip")
        _board("now", text="Checking the clip", shot=shot)
        an = {}
        try:
            ra = c.post(f"{BASE}/api/tools/chaos_analyze", files={"file": (p.name, p.read_bytes(), "video/mp4")}, timeout=300)
            an = ra.json() if ra.status_code == 200 else {}
        except Exception:
            pass
    sheet = _sheet(p)
    if shot:
        _board("add", kind="clip", shot=shot, media=[str(p)], seed=j["seed"], prompt=a["description"][:600])
    _board("now", text="")
    keep = {k: an.get(k) for k in ("duration", "safe_end", "glitch_at", "speech", "loudness") if k in an}
    return [{"type": "text", "text": f"{p}  (seed {j['seed']})\nanalysis: {json.dumps(keep)}\ncontact sheet: {sheet}"}, _img_item(sheet)]


def t_contact_sheet(a):
    p = Path(a["video_path"])
    s = _sheet(p, int(a.get("frames", 8)), int(a.get("columns", 4)))
    return [{"type": "text", "text": str(s)}, _img_item(s)]


def t_look_at_reference(a):
    """Show Claude a reference the user attached: the picture itself, or a video's contact sheet."""
    f = os.getenv("ASSISTANT_REFS", "")
    refs = json.loads(Path(f).read_text(encoding="utf-8")) if f and Path(f).is_file() else []
    if not refs:
        return [{"type": "text", "text": "The user attached no references."}]
    n = int(a.get("n", 0))
    sel = [r for r in refs if not n or r["n"] == n]
    out = []
    for r in sel:
        out.append({"type": "text", "text": f"[{r['n']}] {r['kind']} {r['name']} (role {r['role']}) {r.get('label', '')}"})
        if r["kind"] == "image":
            out.append(_img_item(_small(Path(r["path"]))))
        elif r["kind"] == "video" and r.get("sheet"):
            out.append(_img_item(Path(r["sheet"])))
        elif r["kind"] == "audio":
            out.append({"type": "text", "text": f"audio {r.get('duration')}s, {r.get('bpm')} BPM, sections {r.get('sections')}"})
    return out


def _next_version(name: str) -> Path:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip() or "video"
    n = 1
    while (OUTPUT / f"{stem}_v{n}.mp4").exists():
        n += 1
    return OUTPUT / f"{stem}_v{n}.mp4"


def t_build_cut(a):
    _gate()
    segs_in = a["shots"]
    profile = a.get("profile", "cam")
    segs = [{"clip": i, "in": float(s.get("in", 0.0)), "out": float(s["out"]), "chaos": float(s.get("chaos", 0.0)), "gain": float(s.get("gain", -8.0)),
             "caption": s.get("caption", ""), "narration": ""} for i, s in enumerate(segs_in)]
    plan = {"segments": segs, "crowd": [], "total": sum(s["out"] - s["in"] for s in segs), "look": a.get("look", "tiktok"),
            "shake": a.get("shake", "none" if profile == "cam" else "blair witch"), "wear": a.get("wear", "medium"), "grain": a.get("grain", "medium"),
            "focus": "off", "glitches": "none", "ambience": "none", "unease": "none", "bumps": False, "flaws": "off", "cheap_mic": False, "ambience_fade": None,
            "ramp": {"from_db": 3, "to_db": 6, "curve": 1.4}, "auto_seed": 2, "seed": int(a.get("seed", 11)), "profile": profile, "voice": "",
            "reply_header": "Reply to a comment", "scare_at": float(a.get("scare_at", -1)),
            "quality": a.get("quality", "high"), "out_width": int(a.get("width", 720))}
    files = [("clips", (f"c{i}.mp4", Path(s["path"]).read_bytes(), "video/mp4")) for i, s in enumerate(segs_in)]
    _board("stage", stage="cut")
    _board("now", text="Cutting the video together (captions, look, sound)", progress=None)
    with _client() as c:
        r = c.post(f"{BASE}/api/tools/chaos_cut", data={"plan": json.dumps(plan), "bed_names": ""}, files=files)
        if r.status_code != 200:
            raise RuntimeError(f"chaos_cut -> {r.status_code}: {r.text[:500]}")
    out = _next_version(a.get("name", "assistant_video"))
    out.write_bytes(r.content)
    sheet = _sheet(out, 12, 6, 150)
    _board("now", text="")
    return [{"type": "text", "text": f"saved {out} ({len(r.content)} bytes, {plan['total']:.1f}s). contact sheet: {sheet}"}, _img_item(sheet)]


S = {"type": "string"}
N = {"type": "number"}
TOOLS = {
    "report": (t_report, "Tell the user what you are doing (short, plain). Shown live in the app on every device. Optional media = file paths of images/videos to show. May return a new message from the user: follow it.",
               {"message": S, "media": {"type": "array", "items": S}}, ["message"]),
    "ask_user": (t_ask_user, "STOP and wait for the user's decision (they answer from the PC or phone, possibly hours later). Show what they need to judge via media (image/video paths). options = the buttons (e.g. [\"Approve\", \"Change something\", \"Start over\"]). Optional `picks` = variations: one group per shot {shot, label, options:[{path, label}]} (first option = your recommendation); the user taps one per shot and you get \"USER PICKED\". Optional `suggestions` = 2-4 short tappable ideas the user can add as a note (e.g. 'Closer shot of Harvey'). Returns their choice and any note.",
                 {"title": S, "message": S, "media": {"type": "array", "items": S}, "options": {"type": "array", "items": S},
                  "picks": {"type": "array", "items": {"type": "object", "properties": {"shot": N, "label": S, "options": {"type": "array", "items": {"type": "object", "properties": {"path": S, "label": S}}}}}},
                  "suggestions": {"type": "array", "items": S}}, ["title", "message"]),
    "set_shots": (t_set_shots, "Put the shot plan on the live board the user watches (call right after you write the script, before approval 1, and again if the plan changes). shots = [{n, title (3-5 words), still (the frozen moment), motion, caption}].",
                  {"shots": {"type": "array", "items": {"type": "object", "properties": {"n": N, "title": S, "still": S, "motion": S, "caption": S}}}}, ["shots"]),
    "mark_result": (t_mark_result, "On the live board, mark a still or clip as 'chosen' or 'rejected' with a short plain reason (e.g. 'a person walks toward the camera'). Always mark every result you throw away so the user can see what you checked.",
                    {"shot": N, "path": S, "status": S, "reason": S}, ["shot", "path", "status"]),
    "make_still": (t_make_still, "Generate one still image (Flux 3 Klein, ~10 s; engine 'qwen' is slower, ~1-2 min, better for text/detail). aspect default 9:16. For a named character from the brief, just write @Name in the prompt (e.g. '@Harvey stands at the console'): the tool attaches that character's picture and numbers it. reference_images = other image paths (a location, a style) to keep consistent (name them 'image 1' in the prompt in the order you list them). Pass `framing` ('close' = face fills the frame, 'medium' = person from the waist up, 'wide' = person small or far): when a named character is in the shot the app picks the best engine for that framing itself (Qwen for close/medium, Flux 3 for wide, unless the user chose otherwise), so just describe the framing truthfully. Pass `shot` (its number on the board) so it appears live; `label` names a variation (e.g. 'closer'). Returns the file path and the image so you can judge it.",
                   {"prompt": S, "aspect": S, "engine": S, "megapixels": N, "seed": N, "shot": N, "label": S, "framing": S, "reference_images": {"type": "array", "items": S}}, ["prompt"]),
    "make_clip": (t_make_clip, "Turn a still into a ~4 s video clip with sound (MiniMax H3, 1-3 min). description = what moves and what the camera does (add 'no other person appears' and 'the camera never moves' when needed). Pass `shot` so it appears live. Returns the clip path, an analysis (duration, glitch tail start, speech) and a contact sheet of frames to inspect.",
                  {"still_path": S, "description": S, "soundscape": S, "frames": N, "seed": N, "shot": N}, ["still_path", "description"]),
    "look_at_reference": (t_look_at_reference, "See the reference material the user attached (n = its number from the brief, 0 = all). Shows images as-is and videos as a contact sheet.",
                          {"n": N}, []),
    "contact_sheet": (t_contact_sheet, "Evenly spaced frames of any video as one image, to check it.", {"video_path": S, "frames": N, "columns": N}, ["video_path"]),
    "build_cut": (t_build_cut, "Assemble the final video from clips: per-shot in/out seconds, gain (dB, quiet ~-12, payoff ~-4), caption (stamp:/strip:/reply: prefixes, || between overlays), look (babycam, trailcam, doorbellcam, ugc, tiktok), profile ('cam' fixed camera / 'vlog' / 'panic'), scare_at (second of the payoff sting, -1 none), quality ('high' default: upscaled to `width` 720 px with a generous bitrate, same grain/look; 'standard' = the old crushed look), name. Saves to Hoodsfield_Output as <name>_vN.mp4 (never overwrites). Returns path + contact sheet.",
                  {"shots": {"type": "array", "items": {"type": "object", "properties": {"path": S, "in": N, "out": N, "gain": N, "chaos": N, "caption": S}, "required": ["path", "out"]}},
                   "look": S, "profile": S, "scare_at": N, "name": S, "seed": N, "quality": S, "width": N}, ["shots", "name"]),
}


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
            _send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": params.get("protocolVersion", "2024-11-05"),
                                                            "capabilities": {"tools": {}}, "serverInfo": {"name": "hoodsfield_assistant", "version": "1.0"}}})
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [
                {"name": n, "description": d, "inputSchema": {"type": "object", "properties": props, "required": req}} for n, (_, d, props, req) in TOOLS.items()]}})
        elif method == "tools/call":
            name, args = params.get("name"), params.get("arguments") or {}
            try:
                if name not in TOOLS:
                    raise RuntimeError(f"unknown tool {name}")
                _send({"jsonrpc": "2.0", "id": mid, "result": {"content": TOOLS[name][0](args)}})
            except Exception as e:
                _send({"jsonrpc": "2.0", "id": mid, "result": {"isError": True, "content": [{"type": "text", "text": f"{type(e).__name__}: {e}"}]}})
        elif method == "ping":
            _send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif mid is not None:
            _send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}})


if __name__ == "__main__":
    main()
