# LTX 3D-Scene Web App — MVP Plan

A standalone web app with an in-browser 3D scene/camera editor that drives an
existing **ComfyUI + LTX 2.3 turbo** installation for video generation. No
third-party 3D application (Blender, etc.) required — scene building, camera
motion, and generation all live in one app.

---

## Target hardware (generation box)

- **GPU:** NVIDIA RTX 4060 Ti, 16 GB VRAM
- **System RAM:** 48 GB
- **Role:** Runs ComfyUI + LTX 2.3 turbo. The web app's backend proxy talks to
  ComfyUI's HTTP + WebSocket API on this machine.

16 GB VRAM is comfortable for LTX turbo. It comfortably handles the MVP's
short, moderate-resolution, depth-conditioned clips. Resolution/length budget
is discussed under **Constraints** below.

---

## The core insight

**LTX does not ingest 3D geometry.** Like all diffusion video models, it
conditions on **image sequences**, not meshes. The community "import a 3D scene
into ComfyUI" nodes really do:

```
3D scene → render to per-frame images → feed as control/latent conditioning → diffusion
```

So the Three.js viewer's real job is **to be a real-time renderer that emits a
controllable per-frame image sequence** — something browsers do well.

The chosen conditioning route is a **depth-guided video** (LTX depth /
ControlNet path, or a v2v pass at moderate denoise), because:

- Three.js renders a depth pass essentially for free (already in the depth buffer).
- Depth is forgiving of an ugly grey-block scene — the model reads only
  **structure + motion**; the **text prompt** supplies all aesthetics.
- It cleanly splits *"what moves where"* (the 3D editor's job) from *"what it
  looks like"* (the prompt's job).

---

## Architecture

```
┌─────────────────────────────────────┐
│  Browser (React + Three.js)          │
│  • Scene editor: add primitives,     │
│    transform gizmo                   │
│  • Camera keyframes + timeline       │
│  • Offscreen depth render → N PNGs   │
│  • Prompt box, Generate button       │
└──────────────┬──────────────────────┘
               │ POST /generate
               │ { frames[], prompt, fps, steps }
┌──────────────▼──────────────────────┐
│  Backend proxy (FastAPI)             │
│  • Holds ltx_depth_workflow.json     │
│    (template with {{placeholders}})  │
│  • Uploads frames to ComfyUI /upload │
│  • Injects prompt + frame refs       │
│  • POST /prompt, listen on /ws       │
│  • Relay progress (SSE) → browser    │
│  • Return final video URL            │
└──────────────┬──────────────────────┘
               │ ComfyUI HTTP + WebSocket API
┌──────────────▼──────────────────────┐
│  ComfyUI + LTX 2.3 turbo (RTX 4060 Ti)│
└──────────────────────────────────────┘
```

The proxy exists so the browser never needs to know ComfyUI's node graph, and
so CORS / websocket handling live in one place.

---

## Build order (back-to-front, to de-risk)

Priority for this first MVP: **prove the pipeline end-to-end.** Build the
unknown/hard part first; leave UI polish for last.

### 1. Nail the ComfyUI depth workflow by hand
Get LTX turbo producing a video conditioned on a sequence of depth PNGs + a
prompt, **inside ComfyUI's own UI. No web app yet.** This is the biggest
unknown — LTX 2.3's exact node names, native depth conditioning vs. a v2v
ControlNet path, frame-count limits, VRAM behavior on the 4060 Ti. Until this
works manually, nothing else matters. Then **export the graph as API-format
JSON** — that becomes the backend template.

### 2. Backend proxy against that template
A `/generate` endpoint that takes a folder of PNGs + prompt and does:
upload → inject prompt + frame refs → submit `/prompt` → poll `/ws` → return
video. Test with a throwaway depth sequence rendered anywhere.

### 3. Three.js depth exporter (minimal)
A minimal scene (one rotating cube, hardcoded camera orbit) that renders a
depth pass to N frames and POSTs them to the backend. Proves
browser → backend → ComfyUI → video.

### 4. The editor UX (last)
Add primitives, a transform gizmo (`TransformControls`), camera keyframe
timeline. Everything downstream already works, so this is pure iteration.

If steps 1–3 produce a video, the concept is proven.

---

## Constraints & gotchas (they bite later)

- **VRAM / length budget (16 GB).** LTX turbo is light, but depth-conditioned
  video cost scales with resolution × frame count. Start conservative
  (e.g. ~512–768 px, short clip) and push up once the pipeline is proven.
- **Depth encoding must match the workflow's expectation** — near/far
  normalization, 16-bit vs 8-bit, white-is-near vs white-is-far. A mismatch
  produces garbage that *looks* like a model problem but is really an export
  bug. Standardize this in the Three.js depth material.
- **Frame count / temporal length.** LTX has a native frame-count sweet spot.
  The camera timeline should quantize to that rather than allowing arbitrary
  durations.

---

## Suggested stack

- **Frontend:** Vite + React + Three.js (+ `three-stdlib` for
  `TransformControls` / `OrbitControls`). Raw Three.js over R3F for the MVP =
  fewer moving parts.
- **Backend:** FastAPI (Python) — natural fit since ComfyUI is Python; SSE for
  progress streaming.
- **Transport:** PNG sequence over multipart for the MVP (simple, debuggable).
  Optimize to a packed format only if too slow.

---

## Open items to resolve next

1. **Manual ComfyUI depth → LTX workflow** — the real unknown. Need the
   installed LTX 2.3 node pack name / a screenshot of the current graph to
   design the depth-conditioned version. **Do this first.**
2. Confirm networking: is the web app served from the same PC as ComfyUI, or a
   separate dev machine on the LAN? (Affects CORS + host config.)
3. Decide native LTX depth conditioning vs. v2v ControlNet path once the node
   pack is known.
