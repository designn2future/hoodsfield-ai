"""Shared session: one copy of the working project (scenes, prompts, settings, gallery) kept on the PC so every screen
(PC browser, phone) shows the same thing and updates live. The browser tabs are views; the server is the copy.

  GET  /api/session              -> {rev, savedAt, state, assets:[manifest]}          (no file bytes)
  PUT  /api/session              -> {rev, missing:[ids needing upload]}               body {clientId, state, assets:[manifest]}
  PUT  /api/session/blob/{id}    -> store one asset's bytes (raw body, content-type = mime)
  GET  /api/session/blob/{id}    -> that asset's bytes
  GET  /api/session/refs         -> {rev, refs:[{id,name}]}   the Image Studio's reference photos (separate from the gallery)
  PUT  /api/session/refs         -> body {clientId, refs:[{id,name}]}

Every change is announced on the shared feed (/api/feed) as {type: "session" | "refs", rev, clientId}; a screen ignores
announcements carrying its own clientId. Last writer wins. Files live in VSA_WORK_DIR/vsa_work/shared_session/.
"""
import json
import re
import time

from fastapi import HTTPException, Request
from fastapi.responses import Response

import jobs

ROOT = jobs.WORK_DIR / "shared_session"
BLOBS = ROOT / "blobs"
BLOBS.mkdir(parents=True, exist_ok=True)
STATE = ROOT / "state.json"
REFS = ROOT / "refs.json"
RESULTS = ROOT / "results.json"
_SAFE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _read(p, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write(p, obj):
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj), encoding="utf-8")
    tmp.replace(p)


def _id(i: str) -> str:
    if not _SAFE.match(i or ""):
        raise HTTPException(400, "bad id")
    return i


def register(app, m):
    @app.get("/api/session")
    async def get_session():
        s = _read(STATE, {"rev": 0, "savedAt": 0, "state": None, "assets": []})
        for a in s.get("assets", []):
            f = BLOBS / a["id"]
            a["have"] = f.exists()
        return s

    @app.get("/api/session/revs")
    async def get_revs():
        """Tiny poll target for screens whose live stream is blocked (some tunnels/proxies buffer server-sent events)."""
        return {"rev": _read(STATE, {"rev": 0}).get("rev", 0), "results": _read(RESULTS, {"rev": 0}).get("rev", 0),
                "refs": _read(REFS, {"rev": 0}).get("rev", 0)}

    @app.put("/api/session")
    async def put_session(request: Request):
        body = await request.json()
        old = _read(STATE, {"rev": 0})
        fs = (body.get("state") or {}).get("fluxSettings")
        if isinstance(fs, dict):
            fs.pop("resultIds", None)      # old builds kept the canvas list in the settings; two screens then fought over it
        manifest = [a for a in body.get("assets", []) if _SAFE.match(str(a.get("id", "")))]
        rev = int(old.get("rev", 0)) + 1
        _write(STATE, {"rev": rev, "savedAt": time.time(), "state": body.get("state"), "assets": manifest})
        keep = {a["id"] for a in manifest}
        refs = {r["id"] for r in _read(REFS, {"refs": []}).get("refs", [])}
        for f in BLOBS.iterdir():          # assets the client removed from the gallery
            if f.name not in keep and f.name not in refs and time.time() - f.stat().st_mtime > 120:   # grace: a fresh upload may not be listed yet
                try:
                    f.unlink()
                except OSError:
                    pass
        missing = [a["id"] for a in manifest if not (BLOBS / a["id"]).exists()]
        m._feed({"type": "session", "rev": rev, "clientId": body.get("clientId", "")})
        return {"rev": rev, "missing": missing}

    @app.put("/api/session/blob/{asset_id}")
    async def put_blob(asset_id: str, request: Request):
        data = await request.body()
        (BLOBS / _id(asset_id)).write_bytes(data)
        m._feed({"type": "session", "rev": _read(STATE, {"rev": 0}).get("rev", 0), "clientId": request.headers.get("x-client-id", ""), "blob": asset_id})
        return {"ok": True, "bytes": len(data)}

    @app.get("/api/session/blob/{asset_id}")
    async def get_blob(asset_id: str):
        f = BLOBS / _id(asset_id)
        if not f.exists():
            raise HTTPException(404, "not uploaded yet")
        return Response(content=f.read_bytes(), media_type="application/octet-stream")

    @app.get("/api/session/results")
    async def get_results():
        return _read(RESULTS, {"rev": 0, "ids": []})

    @app.put("/api/session/results")
    async def put_results(request: Request):
        body = await request.json()
        old = _read(RESULTS, {"rev": 0})
        rev = int(old.get("rev", 0)) + 1
        ids = [_id(str(i)) for i in body.get("ids", [])][:30]
        _write(RESULTS, {"rev": rev, "ids": ids})
        m._feed({"type": "results", "rev": rev, "clientId": body.get("clientId", "")})
        return {"rev": rev}

    @app.get("/api/session/refs")
    async def get_refs():
        r = _read(REFS, {"rev": 0, "refs": []})
        r["refs"] = [x for x in r.get("refs", []) if (BLOBS / x["id"]).exists()]
        return r

    @app.put("/api/session/refs")
    async def put_refs(request: Request):
        body = await request.json()
        old = _read(REFS, {"rev": 0})
        rev = int(old.get("rev", 0)) + 1
        refs = [{"id": _id(str(x["id"])), "name": str(x.get("name", ""))[:120]} for x in body.get("refs", [])]
        _write(REFS, {"rev": rev, "refs": refs})
        m._feed({"type": "refs", "rev": rev, "clientId": body.get("clientId", "")})
        return {"rev": rev}
