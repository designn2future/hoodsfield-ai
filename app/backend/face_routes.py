"""POST /api/face/match: does the face in `cand` look like the face in `ref`? (ArcFace similarity, CPU.)

Used by Genjutsu to check that a character swap actually carried the reference person over, instead of just changing the frame.
"""
import asyncio
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

from fastapi import File, HTTPException, UploadFile
from fastapi.responses import Response

PY = Path(os.getenv("COMFY_ROOT", r"D:\ComfyUI-LTX2")) / "venv" / "Scripts" / "python.exe"
SCRIPT = Path(__file__).resolve().parent / "face_sim.py"
SWAP = Path(__file__).resolve().parent / "face_swap.py"


def register(app, m):
    @app.post("/api/face/match")
    async def face_match(ref: UploadFile = File(...), cand: UploadFile = File(...), src: UploadFile | None = File(None)):
        if not PY.is_file():
            raise HTTPException(501, "ComfyUI python (insightface) not found")
        with tempfile.TemporaryDirectory() as td:
            paths = []
            for name, up in (("ref", ref), ("cand", cand), ("src", src)):
                if up is None:
                    continue
                p = Path(td) / f"{name}_{uuid.uuid4().hex[:6]}.png"
                p.write_bytes(await up.read())
                paths.append(str(p))
            r = await asyncio.to_thread(subprocess.run, [str(PY), str(SCRIPT), *paths], capture_output=True, text=True, timeout=120,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        lines = [ln for ln in r.stdout.splitlines() if ln.strip().startswith("{")]
        if not lines:
            raise HTTPException(500, "face check failed: " + (r.stderr or r.stdout)[-300:])
        return json.loads(lines[-1])


    @app.post("/api/face/swap")
    async def face_swap(target: UploadFile = File(...), ref: UploadFile = File(...), all_faces: bool = False,
                        pick: str = "largest", mask: UploadFile | None = File(None)):
        """InSwapper: put the reference person's face onto the target's face (exact identity, unlike a text-driven edit)."""
        if not PY.is_file():
            raise HTTPException(501, "ComfyUI python (insightface) not found")
        with tempfile.TemporaryDirectory() as td:
            t, rf, out = Path(td) / "t.png", Path(td) / "r.png", Path(td) / "o.png"
            t.write_bytes(await target.read())
            rf.write_bytes(await ref.read())
            args = [str(PY), str(SWAP), str(t), str(rf), str(out), "all" if all_faces else pick]
            if mask is not None:
                mp = Path(td) / "m.png"
                mp.write_bytes(await mask.read())
                args.append(str(mp))
            r = await asyncio.to_thread(subprocess.run, args, capture_output=True, text=True, timeout=180,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            lines = [ln for ln in r.stdout.splitlines() if ln.strip().startswith("{")]
            info = json.loads(lines[-1]) if lines else {"ok": False, "reason": (r.stderr or "")[-200:]}
            if not info.get("ok") or not out.exists():
                raise HTTPException(422, info.get("reason", "face swap failed"))
            return Response(out.read_bytes(), media_type="image/png")
