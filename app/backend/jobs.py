"""
Persistent job history for Hoodsfield (SQLite in VSA_WORK_DIR/jobs.sqlite).

Every ComfyUI submission made through `main._submit` is recorded automatically —
its kind (image-flux3, video-wan, ...), a human title (the prompt), the model
family it needs (used by the queue to batch work and avoid costly model swaps on
this x1-PCIe GPU), timing, status and the output file. Composite jobs (long
shots, finalize chains) are recorded by `jobs_routes.CompositeJob`.
"""

import json
import os
import sqlite3
import tempfile
import threading
import time
from pathlib import Path

WORK_DIR = Path(os.getenv("VSA_WORK_DIR", tempfile.gettempdir())) / "vsa_work"
WORK_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = WORK_DIR / "jobs.sqlite"
OUT_DIR = WORK_DIR / "outputs"          # files produced by composite jobs
OUT_DIR.mkdir(parents=True, exist_ok=True)
_lock = threading.Lock()

COLS = ["id", "parent", "kind", "family", "title", "status", "status_text", "error", "created", "started",
        "finished", "output", "params", "prompt_id"]


def _conn():
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    return c


def init():
    with _lock, _conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, parent TEXT, kind TEXT, family TEXT, title TEXT, status TEXT, status_text TEXT,
            error TEXT, created REAL, started REAL, finished REAL, output TEXT, params TEXT, prompt_id TEXT)""")
        c.execute("CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created DESC)")
        # anything still "running" at startup was interrupted by a restart
        c.execute("UPDATE jobs SET status='interrupted', finished=? WHERE status IN ('running','queued')", (time.time(),))


def upsert(job_id: str, **f):
    f = {k: (json.dumps(v) if k in ("output", "params") and not isinstance(v, str) and v is not None else v) for k, v in f.items()}
    with _lock, _conn() as c:
        row = c.execute("SELECT id FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row:
            sets = ", ".join(f"{k}=?" for k in f)
            if sets:
                c.execute(f"UPDATE jobs SET {sets} WHERE id=?", (*f.values(), job_id))
        else:
            f.setdefault("created", time.time())
            f.setdefault("status", "running")
            cols = ["id", *f.keys()]
            c.execute(f"INSERT INTO jobs ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", (job_id, *f.values()))


def _row(r) -> dict:
    d = dict(r)
    for k in ("output", "params"):
        if d.get(k):
            try:
                d[k] = json.loads(d[k])
            except Exception:
                pass
    return d


def get(job_id: str) -> dict | None:
    with _lock, _conn() as c:
        r = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return _row(r) if r else None


def list_jobs(limit: int = 100, status: str = "", kind: str = "", include_children: bool = False) -> list[dict]:
    q, args = "SELECT * FROM jobs WHERE 1=1", []
    if not include_children:
        q += " AND (parent IS NULL OR parent='')"
    if status:
        q += " AND status=?"; args.append(status)
    if kind:
        q += " AND kind LIKE ?"; args.append(kind + "%")
    q += " ORDER BY created DESC LIMIT ?"; args.append(limit)
    with _lock, _conn() as c:
        return [_row(r) for r in c.execute(q, args).fetchall()]


def delete(job_id: str):
    with _lock, _conn() as c:
        c.execute("DELETE FROM jobs WHERE id=? OR parent=?", (job_id, job_id))


# ---------------------------------------------------------------- classification

def classify(graph: dict) -> tuple[str, str, str]:
    """(kind, model family, title) from a ComfyUI API graph."""
    classes = {n.get("class_type", "") for n in graph.values() if isinstance(n, dict)}
    text = ""
    for n in graph.values():
        if not isinstance(n, dict):
            continue
        ins = n.get("inputs", {})
        for k in ("text", "prompt", "global_prompt", "description"):
            v = ins.get(k)
            if isinstance(v, str) and len(v.strip()) > 3 and n.get("class_type") != "TextGenerate":
                text = text or v.strip()
    unets = " ".join(str(n.get("inputs", {}).get("unet_name", "")) for n in graph.values() if isinstance(n, dict)).lower()
    if "SplitSigmasDenoise" in classes:
        return "video-genjutsu", "ltx", text or "Genjutsu"
    if any(c.startswith("MiniMaxH3") or c == "DiffusionModelLoaderKJ" for c in classes):
        return "video-h3", "h3", text or "H3 video"
    if classes & {"WanImageToVideo", "WanFirstLastFrameToVideo"} or "wan2" in unets:
        return "video-wan", "wan", text or "Wan video"
    if "GetICLoRAParameters" in classes:
        return "video-control", "ltx", text or "Motion control"
    if "LTXVImgToVideoInplace" in classes or "EmptyLTXVLatentVideo" in classes:
        return "video-ltx", "ltx", text or "LTX video"
    if "TextEncodeQwenImage21" in classes:
        return ("image-qwen21-edit" if any(k.startswith("images.") for n in graph.values() if isinstance(n, dict) for k in n.get("inputs", {})) else "image-qwen21"), "qwen21", text or "Qwen Image 2.1"
    if "Flux2Scheduler" in classes:
        return ("image-flux3-edit" if "ReferenceLatent" in classes else "image-flux3"), "flux3", text or "Flux 3 image"
    if "TextGenerate" in classes:
        return "prompt-upsample", "flux3", "Prompt upsample"
    if "UpscaleModelLoader" in classes:
        return "tool-upscale", "tools", "Upscale"
    if "RIFE VFI" in classes:
        return "tool-interpolate", "tools", "Frame interpolation"
    if "LoadBackgroundRemovalModel" in classes:
        return "tool-cutout", "tools", "Background removal"
    if "ReActorFaceSwapOpt" in classes:
        return "tool-faceswap", "tools", "Face swap"
    if "UnetLoaderGGUF" in classes or "TextEncodeKrea2" in classes:
        return "image-krea2", "krea2", text or "Krea 2 image"
    return "other", "other", text or "ComfyUI job"
