"""
Job API + composite jobs.

GET    /api/jobs                list history (live progress merged in)
GET    /api/jobs/{id}           one job
GET    /api/jobs/{id}/media     the output (works after a restart)
GET    /api/jobs/{id}/thumb     small JPEG preview (cached)
DELETE /api/jobs/{id}           forget a job (does not delete ComfyUI's file)
POST   /api/jobs/clear          clear finished history
GET    /api/queue               ComfyUI queue with our job titles + model families

Composite jobs: a CompositeJob is an async task that runs several ComfyUI graphs and/or
ffmpeg steps and exposes ONE job id to the browser (same SSE/`/api/video` contract as
every other job). Sub-jobs are recorded with `parent=<id>`.
"""

import asyncio
import io
import json
import subprocess
import time
import uuid
from pathlib import Path

import httpx
from fastapi import Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

import jobs
from audio_analysis import ffmpeg_exe


def register(app, m):
    jobs.init()

    # ------------------------------------------------------------ helpers

    def _live(j: dict) -> dict:
        mem = m.JOBS.get(j["id"])
        if mem and mem.get("status") == "running":
            j["status"] = "running"
            j["progress"] = mem.get("progress", 0.0)
            j["status_text"] = mem.get("status_text", j.get("status_text") or "")
        return j

    def _output_file(j: dict) -> tuple[str, dict | None]:
        """('file', path) | ('comfy', {filename, subfolder, type}) | ('', None)"""
        out = j.get("output")
        if isinstance(out, dict):
            if out.get("file"):
                return "file", out["file"]
            if out.get("filename"):
                return "comfy", out
        return "", None

    @app.get("/api/jobs")
    async def list_jobs(limit: int = 100, status: str = "", kind: str = "", children: bool = False):
        return {"jobs": [_live(j) for j in jobs.list_jobs(limit, status, kind, children)]}

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str):
        j = jobs.get(job_id)
        if not j:
            raise HTTPException(404, "Unknown job")
        return _live(j)

    @app.delete("/api/jobs/{job_id}")
    async def delete_job(job_id: str):
        jobs.delete(job_id)
        return {"ok": True}

    @app.post("/api/jobs/clear")
    async def clear_jobs():
        for j in jobs.list_jobs(5000, include_children=True):
            if j["status"] in ("done", "error", "cancelled", "interrupted"):
                jobs.delete(j["id"])
        return {"ok": True}

    @app.get("/api/jobs/{job_id}/media")
    async def job_media(job_id: str):
        j = jobs.get(job_id)
        if not j:
            raise HTTPException(404, "Unknown job")
        kind, out = _output_file(j)
        if kind == "file":
            if not Path(out).exists():
                raise HTTPException(404, "Output file was removed")
            return FileResponse(out, media_type=m._media_for(out))
        if kind == "comfy":
            params = {"filename": out["filename"], "subfolder": out.get("subfolder", ""), "type": out.get("type", "output")}

            async def stream():
                async with httpx.AsyncClient(timeout=None, trust_env=False) as client:
                    async with client.stream("GET", f"{m.COMFY_URL}/view", params=params) as r:
                        async for chunk in r.aiter_bytes():
                            yield chunk
            return StreamingResponse(stream(), media_type=m._media_for(out["filename"]))
        raise HTTPException(404, "This job has no output")

    @app.get("/api/jobs/{job_id}/source")
    async def job_source(job_id: str):
        """The picture an edit started from (kept for edits made after this was added)."""
        for f in (jobs.WORK_DIR / "job_sources").glob(f"{Path(job_id).name}.*"):
            return FileResponse(f, media_type=m._media_for(str(f)))
        raise HTTPException(404, "No original was kept for this job")

    @app.get("/api/jobs/{job_id}/thumb")
    async def job_thumb(job_id: str):
        cache = jobs.WORK_DIR / "thumbs"
        cache.mkdir(exist_ok=True)
        tp = cache / f"{job_id}.jpg"
        if tp.exists():
            return FileResponse(tp, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})      # devices keep thumbnails instead of re-asking
        j = jobs.get(job_id)
        if not j:
            raise HTTPException(404, "Unknown job")
        kind, out = _output_file(j)
        data, name = b"", ""
        if kind == "file":
            p = Path(out)
            name = p.name
            data = p.read_bytes() if p.exists() else b""
        elif kind == "comfy":
            name = out["filename"]
            async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
                r = await client.get(f"{m.COMFY_URL}/view", params={"filename": name, "subfolder": out.get("subfolder", ""), "type": out.get("type", "output")})
                data = r.content if r.status_code == 200 else b""
        if not data:
            raise HTTPException(404, "No preview")
        src = cache / f"{job_id}_src{Path(name).suffix}"
        src.write_bytes(data)
        r = await asyncio.to_thread(subprocess.run, [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", "-i", str(src), "-frames:v", "1",
                                                       "-vf", "scale=320:-2", "-q:v", "5", str(tp)], capture_output=True)
        try:
            src.unlink()
        except OSError:
            pass
        if not tp.exists():
            raise HTTPException(500, "Could not make a preview")
        return FileResponse(tp, media_type="image/jpeg")

    @app.get("/api/queue")
    async def queue():
        """ComfyUI's running + pending prompts annotated with our job info and model family."""
        async with httpx.AsyncClient(timeout=10, trust_env=False) as client:
            r = await client.get(f"{m.COMFY_URL}/queue")
            q = r.json()
        by_prompt = {j.get("prompt_id"): j for j in jobs.list_jobs(500, include_children=True) if j.get("prompt_id")}

        def ann(item, state):
            pid = item[1]
            j = by_prompt.get(pid, {})
            return {"prompt_id": pid, "state": state, "job_id": j.get("id"), "kind": j.get("kind"), "family": j.get("family"), "title": j.get("title")}
        return {"running": [ann(i, "running") for i in q.get("queue_running", [])],
                "pending": [ann(i, "pending") for i in q.get("queue_pending", [])]}

    async def _reorder(order_fn):
        """Re-submit ComfyUI's pending prompts in a new order (same prompt_id / client_id, so job monitors keep working)."""
        async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
            q = (await client.get(f"{m.COMFY_URL}/queue")).json()
            pend = q.get("queue_pending", [])
            running = q.get("queue_running", [])
            by_prompt = {j.get("prompt_id"): j for j in jobs.list_jobs(500, include_children=True) if j.get("prompt_id")}
            def fam(it):
                return (by_prompt.get(it[1]) or {}).get("family") or jobs.classify(it[2])[1]
            cur = fam(running[0]) if running else None
            new = order_fn(pend, fam, cur)
            if [i[1] for i in new] == [i[1] for i in pend]:
                return {"changed": False, "pending": len(pend)}
            await client.post(f"{m.COMFY_URL}/queue", json={"delete": [i[1] for i in pend]})
            for it in new:
                extra = it[3] if isinstance(it[3], dict) else {}
                body = {"prompt": it[2], "prompt_id": it[1], "extra_data": extra}
                if extra.get("client_id"):
                    body["client_id"] = extra["client_id"]
                r = await client.post(f"{m.COMFY_URL}/prompt", json=body)
                if r.status_code != 200:
                    raise HTTPException(502, f"Re-queue failed: {r.text[:200]}")
            return {"changed": True, "pending": len(new)}

    @app.post("/api/queue/optimize")
    async def queue_optimize():
        """Group pending work by model family (every model swap costs minutes over this GPU's x1 link). The family that
        is running now goes first; otherwise families keep their first-seen order; order inside a family is unchanged."""
        def order(pend, fam, cur):
            seen = ([cur] if cur else []) + [fam(i) for i in pend]
            ranks = {}
            for f in seen:
                ranks.setdefault(f, len(ranks))
            return sorted(pend, key=lambda i: ranks[fam(i)])  # sorted() is stable
        return await _reorder(order)

    @app.post("/api/queue/prioritize")
    async def queue_prioritize(prompt_id: str = Form(...)):
        def order(pend, fam, cur):
            hit = [i for i in pend if i[1] == prompt_id]
            return hit + [i for i in pend if i[1] != prompt_id]
        return await _reorder(order)

    # ------------------------------------------------------------ composite jobs

    class CompositeJob:
        """Runs several steps behind one job id. Use as:
             cj = CompositeJob("video-long", "Long shot", steps=4)
             cj.start(coro_fn)    # coro_fn(cj) does the work, finishes with cj.finish(path)
        """

        def __init__(self, kind: str, title: str, steps: int, params: dict | None = None, family: str = ""):
            self.id = uuid.uuid4().hex[:12]
            self.kind, self.title, self.steps, self.done_steps = kind, title, max(1, steps), 0
            self.job = m._new_job(self.id)
            self.job["status_text"], self.job["progress"] = "Starting…", 0.0
            jobs.upsert(self.id, kind=kind, family=family or "composite", title=title[:300], params=params or {}, started=time.time(), status="running")

        async def push(self, ev: dict):
            if ev["type"] == "progress":
                inner = ev["value"] / max(1, ev["max"])
                self.job["progress"] = (self.done_steps + inner) / self.steps
            elif ev["type"] == "status":
                self.job["status_text"] = ev["text"]
            await self.job["queue"].put({"type": "progress", "value": int(self.job.get("progress", 0) * 1000), "max": 1000}
                                         if ev["type"] == "progress" else ev)

        async def status(self, text: str):
            self.job["status_text"] = text
            await self.job["queue"].put({"type": "status", "text": text})

        async def step_done(self):
            self.done_steps += 1
            self.job["progress"] = self.done_steps / self.steps
            await self.job["queue"].put({"type": "progress", "value": int(self.job["progress"] * 1000), "max": 1000})

        async def run_graph(self, graph: dict, label: str = "") -> bytes:
            """Submit one ComfyUI graph as a sub-job; forward its progress; return the output bytes."""
            sub = uuid.uuid4().hex[:12]
            async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
                await m._submit(client, json.dumps(graph), sub)
            jobs.upsert(sub, parent=self.id)
            if label:
                await self.status(label)
            sj = m.JOBS[sub]
            while True:
                if self.job.get("cancelled"):
                    await m.cancel_job(sub)
                    raise RuntimeError("Cancelled")
                try:
                    ev = await asyncio.wait_for(sj["queue"].get(), timeout=3000)
                except asyncio.TimeoutError:
                    raise RuntimeError("Timed out waiting for ComfyUI")
                if ev["type"] == "progress":
                    await self.push(ev)
                elif ev["type"] == "error":
                    raise RuntimeError(ev["text"])
                elif ev["type"] == "done":
                    break
            v = sj["video"]
            async with httpx.AsyncClient(timeout=300, trust_env=False) as client:
                r = await client.get(f"{m.COMFY_URL}/view", params={"filename": v["filename"], "subfolder": v["subfolder"], "type": v["type"]})
                r.raise_for_status()
            return r.content

        def finish(self, path: Path):
            self.job["file"], self.job["media"] = str(path), m._media_for(str(path))
            self.job["status"] = "done"
            self.job["progress"] = 1.0
            jobs.upsert(self.id, status="done", finished=time.time(), output={"file": str(path)})
            asyncio.get_event_loop().create_task(self.job["queue"].put({"type": "done", "url": f"/api/video/{self.id}", "media": self.job["media"]}))

        def fail(self, msg: str):
            cancelled = self.job.get("cancelled") or msg == "Cancelled"
            self.job["status"], self.job["error"] = ("cancelled" if cancelled else "error"), msg
            jobs.upsert(self.id, status=self.job["status"], error=msg[:500], finished=time.time())
            asyncio.get_event_loop().create_task(self.job["queue"].put({"type": "error", "text": "Cancelled" if cancelled else msg}))

        def start(self, coro_fn):
            async def runner():
                try:
                    await coro_fn(self)
                except Exception as e:
                    self.fail(str(e))
            asyncio.get_event_loop().create_task(runner())
            return self

    m.CompositeJob = CompositeJob
