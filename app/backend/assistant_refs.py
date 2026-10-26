"""Reference material for the Assistant: images, video and audio the user attaches to a project.

prepare() turns each upload into something the Assistant can use:
  image -> a copy it can pass to make_still as a reference image (and look at)
  video -> a contact sheet to look at, a few full-size frames usable as references, duration and cut pacing
  audio -> duration, tempo, beat times and loud sections, so the cut can land on the sound
"""
import re
import shutil
import uuid
from pathlib import Path

IMG = {".png", ".jpg", ".jpeg", ".webp"}
VID = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}
AUD = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}
ROLES = {"character": "keep this person/character", "setting": "use this place/location", "style": "match this look and mood",
         "pacing": "match this editing rhythm", "audio": "cut to this sound", "other": "use as the idea suggests"}


def kind_of(name: str) -> str:
    e = Path(name).suffix.lower()
    return "image" if e in IMG else "video" if e in VID else "audio" if e in AUD else ""


def _sheet_and_frames(video: Path, out: Path, n_sheet=8, n_frames=4):
    import cv2
    import numpy as np
    cap = cv2.VideoCapture(str(video))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    dur = total / fps
    # cut pacing: compare small grayscale histograms of frames ~every 0.1 s
    step = max(1, int(fps / 10))
    prev, cuts, i = None, [], 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if i % step == 0:
            ok, f = cap.retrieve()
            if ok:
                h = cv2.calcHist([cv2.cvtColor(cv2.resize(f, (64, 36)), cv2.COLOR_BGR2GRAY)], [0], None, [32], [0, 256])
                h = h / (h.sum() + 1e-9)
                if prev is not None and float(np.abs(h - prev).sum()) > 0.6:
                    cuts.append(round(i / fps, 1))
                prev = h
        i += 1
    tiles = []
    for k in range(n_sheet):
        idx = int((total - 1) * k / max(1, n_sheet - 1))
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, f = cap.read()
        if not ok:
            continue
        h, w = f.shape[:2]
        f = cv2.resize(f, (240, int(h * 240 / w)))
        cv2.putText(f, f"{idx / fps:.1f}s", (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 1, cv2.LINE_AA)
        tiles.append(f)
    frames = []
    for k in range(n_frames):
        idx = int((total - 1) * (k + 0.5) / n_frames)
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, f = cap.read()
        if ok:
            p = out / f"{video.stem}_frame{k + 1}.png"
            cv2.imwrite(str(p), f)
            frames.append(str(p))
    cap.release()
    sheet = ""
    if tiles:
        th, cols = tiles[0].shape[0], 4
        rows = []
        for r in range(0, len(tiles), cols):
            row = tiles[r:r + cols]
            while len(row) < cols:
                row.append(np.zeros((th, 240, 3), np.uint8))
            rows.append(np.hstack(row))
        sheet = str(out / f"{video.stem}_sheet.jpg")
        cv2.imwrite(sheet, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 82])
    return dur, cuts, sheet, frames


def prepare(upload_dir: Path, items: list[dict], dest: Path, start: int = 1) -> list[dict]:
    """items: [{id, name, label, role}] already uploaded to upload_dir. Returns the prepared references."""
    dest.mkdir(parents=True, exist_ok=True)
    out = []
    for it in items:
        src = upload_dir / Path(it.get("file", "")).name
        k = kind_of(it.get("name", ""))
        if not k or not src.is_file():
            continue
        safe = f"{uuid.uuid4().hex[:4]}_{Path(it['name']).name}"
        p = dest / safe
        shutil.copyfile(src, p)
        ref = {"n": start + len(out), "kind": k, "name": it["name"], "path": str(p), "role": it.get("role") if it.get("role") in ROLES else "other",
               "label": (it.get("label") or "").strip()[:200], "char": re.sub(r"[^\w -]", "", (it.get("char") or "")).strip()[:30]}
        try:
            if k == "video":
                dur, cuts, sheet, frames = _sheet_and_frames(p, dest)
                ref.update(duration=round(dur, 1), cuts=cuts[:60], sheet=sheet, frames=frames)
                ref["pacing"] = f"{len(cuts) + 1} shots in {dur:.1f}s (about {dur / (len(cuts) + 1):.1f}s per shot)" if dur else ""
            elif k == "audio":
                import audio_analysis
                a = audio_analysis.analyze(str(p))
                ref.update(duration=a["duration"], bpm=a["bpm"], beats=a["beats"][:200], downbeats=a["downbeats"][:80], sections=a["sections"])
        except Exception as e:
            ref["problem"] = f"{type(e).__name__}: {e}"[:200]
        out.append(ref)
    return out


def describe(refs: list[dict]) -> str:
    """The text block that goes into the Assistant's brief."""
    if not refs:
        return ""
    lines = ["REFERENCE MATERIAL the user attached (use it; look at the images with `look_at_reference`):"]
    for r in refs:
        head = f"  [{r['n']}] {r['kind']} '{r['name']}' - role: {r['role']} ({ROLES[r['role']]})" + (f" - user says: {r['label']}" if r["label"] else "")
        lines.append(head)
        if r["kind"] == "image":
            lines.append(f"      file: {r['path']}")
            if r.get("char"):
                lines.append(f"      CHARACTER NAME: @{r['char']} - write @{r['char']} in your make_still prompts; the tool attaches this picture and numbers it for you (never write 'image N' yourself)")
        elif r["kind"] == "video":
            lines.append(f"      {r.get('duration', '?')}s, {r.get('pacing', '')}. cuts at: {r.get('cuts')}")
            lines.append(f"      full-size frames you can pass to make_still as reference_images: {r.get('frames')}")
        elif r["kind"] == "audio":
            if r.get("bpm"):
                lines.append(f"      {r['duration']}s, {r['bpm']} BPM; downbeats (s): {r['downbeats'][:24]}; sections: {r['sections']}")
            lines.append(f"      file: {r['path']}")
        if r.get("problem"):
            lines.append(f"      (could not fully analyse: {r['problem']})")
    return "\n".join(lines)
