"""
Pose from a photo.

POST /api/scene/pose   multipart: file=<image>  [max_people=6]
  -> {width, height, poses:[{image:[[x,y,z,vis,presence]*33], world:[[x,y,z,vis]*33], box:[x0,y0,x1,y1]}]}   (people ordered left to right)

MediaPipe runs in its own virtual environment (backend/.venv-pose) so it can never disturb the app's packages, on the CPU so it never
competes with a render for the GPU. The model file is backend/models/pose_landmarker_heavy.task.
"""
import asyncio
import json
import subprocess
import tempfile
from pathlib import Path

from fastapi import File, Form, HTTPException, UploadFile

HERE = Path(__file__).resolve().parent
PY = HERE / ".venv-pose" / "Scripts" / "python.exe"
WORKER = HERE / "pose_worker.py"
MODEL = HERE / "models" / "pose_landmarker_heavy.task"


def _run(image_path: str, max_people: int) -> dict:
    out = tempfile.mktemp(suffix=".json")
    r = subprocess.run([str(PY), str(WORKER), image_path, out, str(MODEL), str(max_people)], capture_output=True, text=True, timeout=120,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if r.returncode != 0 or not Path(out).exists():
        raise RuntimeError((r.stderr or r.stdout or "pose worker failed")[-400:])
    try:
        return json.loads(Path(out).read_text(encoding="utf-8"))
    finally:
        Path(out).unlink(missing_ok=True)


def register(app, m):
    @app.post("/api/scene/pose")
    async def scene_pose(file: UploadFile = File(...), max_people: int = Form(6)):
        if not PY.exists() or not MODEL.exists():
            raise HTTPException(503, "The pose reader is not installed (backend/.venv-pose and backend/models/pose_landmarker_heavy.task).")
        data = await file.read()
        if not data or len(data) > 40_000_000:
            raise HTTPException(400, "Send a photo under 40 MB.")
        suffix = Path(file.filename or "x.png").suffix.lower()
        if suffix not in (".png", ".jpg", ".jpeg", ".webp", ".bmp"):
            suffix = ".png"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(data)
            path = f.name
        try:
            return await asyncio.to_thread(_run, path, max(1, min(8, max_people)))
        except subprocess.TimeoutExpired:
            raise HTTPException(504, "Reading the pose took too long.")
        except RuntimeError as e:
            raise HTTPException(500, f"Pose reader failed: {e}")
        finally:
            Path(path).unlink(missing_ok=True)
