"""
Smoke test for the Flux 3 / Studio-toolbox stack. Run with the backend and
ComfyUI up:

    .venv\\Scripts\\python.exe smoke_test.py

Checks: health, model discovery, a 512px Flux 3 render, a reference edit with a
brush mask (verifies only masked pixels change) and that the ffmpeg tool route
is registered. GPU-heavy video tools (upscale / Genjutsu) are left out on purpose.
"""

import io
import json
import sys
import time

import httpx
from PIL import Image, ImageChops, ImageDraw

BASE = "http://127.0.0.1:8000"
c = httpx.Client(timeout=httpx.Timeout(30.0, read=900.0), trust_env=False)
ok_all = True


def check(name, cond, detail=""):
    global ok_all
    ok_all &= bool(cond)
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {detail}")


def run_job(endpoint, data, files):
    r = c.post(BASE + endpoint, data=data, files=files)
    r.raise_for_status()
    jid = r.json()["job_id"]
    with c.stream("GET", f"{BASE}/api/events/{jid}") as s:
        for line in s.iter_lines():
            if line.startswith("data:"):
                ev = json.loads(line[5:])
                if ev["type"] == "done":
                    return c.get(BASE + ev["url"]).content
                if ev["type"] == "error":
                    raise RuntimeError(ev["text"])
    raise RuntimeError("no result")


h = c.get(BASE + "/api/health").json()
check("backend + ComfyUI reachable", h.get("comfy_reachable"))
m = c.get(BASE + "/api/flux3/models").json()
check("Flux 3 models found", m.get("ready"), str(m.get("defaults")))
t = c.get(BASE + "/api/tools/models").json()
check("tool models (upscale / bg removal / RIFE)", t.get("upscalers") and t.get("bg_models") and t.get("rife"), str(t))

t0 = time.time()
png = run_job("/api/generate_flux3", {"prompt": "a red apple on a wooden table, studio light", "width": 512, "height": 512, "steps": 8}, None)
img = Image.open(io.BytesIO(png)).convert("RGB")
check("Flux 3 text-to-image", img.size == (512, 512) and max(img.getextrema())[1] > 40, f"{time.time()-t0:.1f}s, not black: {img.getextrema()}")

mask = Image.new("RGB", img.size, "black")
ImageDraw.Draw(mask).ellipse((150, 150, 360, 360), fill="white")
mbuf, ibuf = io.BytesIO(), io.BytesIO()
mask.save(mbuf, "PNG"); img.save(ibuf, "PNG")
out = run_job("/api/generate_flux3", {"prompt": "Replace the marked region with a shiny green pear. Keep everything else identical.", "match_ref_size": "true", "steps": 8},
              [("refs", ("src.png", ibuf.getvalue(), "image/png")), ("mask", ("mask.png", mbuf.getvalue(), "image/png"))])
edited = Image.open(io.BytesIO(out)).convert("RGB").resize(img.size)
diff = ImageChops.difference(img, edited).convert("L").point(lambda v: 255 if v > 25 else 0)
bb = diff.getbbox()
check("Brush-mask inpaint changes only the masked area", bb and bb[0] >= 120 and bb[1] >= 120 and bb[2] <= 390 and bb[3] <= 390, f"changed bbox {bb}")

check("ffmpeg tool endpoint registered", c.post(BASE + "/api/tools/ffmpeg", data={"op": "reverse"}, files={"file": ("x.mp4", b"x", "video/mp4")}).status_code in (200, 500))

print("\nALL PASS" if ok_all else "\nSOME CHECKS FAILED")
sys.exit(0 if ok_all else 1)
