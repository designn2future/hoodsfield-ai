# Hoodsfield

*An open-source, local-first AI film studio — Flux 3, Wan 2.2, MiniMax H3 and LTX 2.3 on your own GPU, driven by ComfyUI.*

A storyboard-first studio driving a **ComfyUI + LTX 2.3 turbo** installation.
The home screen is an **infinite canvas** (ComfyUI-style dot grid): pan by
dragging, zoom with the wheel. Generated images collect in the floating
**Gallery** dock; drag (or click) them onto the board to create **scene
cards** — each card has its own prompt and a **▶ Video** button that runs
image→video (LTX i2v). Scenes are auto-numbered left-to-right as your
storyboard order.

Tools open as full-screen overlays from the floating bar:

- **✏️ Sketch** — pencil/pen/eraser pad. With a scribble ControlNet installed,
  your doodle becomes pure structure and the prompt supplies full realism
  (exact composition at denoise 1.0). Falls back to img2img otherwise.
- **🎬 3D Studio** — grey-block scene + camera keyframes → depth-pass
  sequence → LTX video.
- **🖼️ Krea 2** — native Krea 2 (Qwen3-VL-conditioned DiT) text-to-image.
  Add moodboard reference images for style/subject guidance, and face-swap
  rows to pin specific faces onto specific people in the output
  (left-to-right index). See `backend/workflows/README.md` for the required
  ComfyUI custom nodes and model files.

**💾 Save / 📂 Open** — projects persist as a single `.vstudio` file
containing the storyboard graph, settings, and every sketch, image, and video
(self-contained; share or reopen anywhere).

```
Browser (React + Three.js / canvas)  →  FastAPI proxy  →  ComfyUI (RTX 4060 Ti)
```

## Studio toolbox (Flux 3 era)

Hoodsfield opens on a **Home** screen of banner cards (each one a looping clip made by the studio itself); the left rail jumps between tools. **View → Theme** switches the neon accent (cyan by default).

Open from **Create** in the menu bar. Scene stills use **Flux 3 Klein** by default (**Engine** menu switches back to Krea 2).

| Tool | What it does |
|---|---|
| ⚡ **Flux 3 Image Studio** | ~5 s text→image, BFL prompt upsampler, reference images, variations, **Cinema rig** (camera body · lens · focal · aperture · light · film look · HEX palette) |
| 🪄 **Edit Studio** | 16 instruction-edit tools with brush-mask inpainting: relight, try-on, product placement, background/character swap, 30 art styles, headshot, restore, new camera angle, effects |
| 🧬 **Character Studio** | Consistent characters without training: photo → turnaround/full-body/expression sheet; casting a character sends photo + views as references |
| 🌀 **Genjutsu** | Video-to-video: **Motion transfer**, **Object swap**, **Restyle** — keeps the clip's motion and camera |
| 🧰 **Video Lab** | Real-ESRGAN upscale, RIFE smooth/slow-mo, BiRefNet cutout/green-screen, ReActor face swap on video, reverse, speed, boomerang, loop, trim, reframe, frames, GIF |
| 🎥 Scene editor | 80 camera moves + 33 effects picker, ⏭ Extend clip, 🌀 Genjutsu, 🧰 Video Lab |
| 🛍️ **Ad Studio** | Product link or photo → UGC / unboxing / hero / how-to ad storyboard on the board (Click-to-Ad equivalent) |
| 🎞️ **Wan 2.2 engine** | Third video engine (Scene editor → Engine): image-to-video, first/last frame, text-to-video, LoRA pairs, silent, Lightning 4-step |
| ✏️ **Sketch → Image** | New Flux 3 backend: the drawing is a reference image |

**Agent access (MCP):** `claude mcp add hoodsfield -- <repo>\app\backend\.venv\Scripts\python.exe <repo>\app\backend\mcp_server.py`
(the backend and ComfyUI must be running). Tools: generate_image, edit_image, character_views, upscale, remove_background, interpolate, video_edit, image_to_video, genjutsu, list_library, camera_prompt.

## Requirements

- Node 18+ and Python 3.10+ (dev machine — your MacBook is fine; nothing heavy
  runs locally, all generation happens on the ComfyUI box)
- A running ComfyUI with LTX 2.3 turbo (video) and any SD checkpoint (sketch
  mode). The shipped workflow templates assume **VideoHelperSuite** is
  installed for video I/O.

## Run

**Windows one-click:** double-click `Start_Hoodsfield.bat` (one folder above `app/`). It starts ComfyUI if needed, starts the backend, and opens
http://localhost:8000: after `npm run build` in `app/frontend`, the backend serves the built UI itself (no Vite needed). Menu → 🧰 Model manager shows what is installed.
Manual start (below) still works and is the way to develop.

Backend:

```bash
cd app/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # edit COMFY_URL if ComfyUI isn't on localhost:8188
python main.py              # serves on :8000
```

Frontend (second terminal):

```bash
cd app/frontend
npm install
npm run dev                 # http://localhost:5173 (proxies /api to :8000)
```

The header shows a green "ComfyUI connected" pill when the whole chain is up.

**Both Mac and PC work** — the app is a browser UI + Python backend; only
ComfyUI needs to run somewhere reachable (`COMFY_URL`). Localhost, or the
GPU box over LAN (start ComfyUI there with `--listen 0.0.0.0`).

## Testing sketch → image on a Mac with local ComfyUI

This path needs no LTX and no custom nodes — only core ComfyUI nodes plus any
SD checkpoint. With ComfyUI running on the Mac (default `127.0.0.1:8188`),
just start both servers and use the Sketch → Image tab; the **Model
checkpoint** dropdown lists what's installed in your ComfyUI and the app
injects it into the workflow. On a 16 GB Mac, an SD 1.5 checkpoint at
512–768 px is the comfortable zone (SDXL will be slow/tight on memory).

## Testing the UI with no ComfyUI at all (mock mode)

Set `COMFY_MOCK=1` in `backend/.env`. Generation is simulated: progress
streams normally, sketch mode returns your drawing back, and video mode
returns an animated GIF of your depth frames (a great way to sanity-check
camera moves and depth encoding). The header shows "Mock mode".

## ⚠️ Before your first video: swap in the real workflow

Per the MVP plan, **step 1 — nailing the depth-conditioned LTX workflow by
hand inside ComfyUI — is still the critical unknown.** The templates in
`backend/workflows/` are educated placeholders; your installed LTX node pack
will likely differ. Once your manual workflow produces a good video:
export it in **API format** (dev mode → Export (API)), add the placeholder
tokens, and drop it in. Full instructions and the token table are in
`backend/workflows/README.md`. No app code changes needed.

## Using the 3D editor

1. Add primitives from the left toolbar; move/rotate/scale with the gizmo
   (or type exact values in the Inspector).
2. Scrub the timeline, frame your view, hit **+ Keyframe** — repeat at
   different times to define the camera move. **Play** previews it;
   **Lens** looks through the shot camera.
3. Toggle **Depth view** to see exactly what LTX will receive
   (white = near, black = far; tune "Depth far" so your scene uses the
   full range).
4. Write a prompt (it supplies *all* aesthetics — the scene is just
   structure), pick quality settings, **Generate**.

## Quality / speed controls

| Control | Effect |
|---|---|
| Presets | Draft 512×288 @ 4 steps · Balanced 768×448 @ 8 · Quality 960×544 @ 12 |
| Width/Height | Snapped to /32. VRAM cost ∝ resolution × frames — start low |
| Duration + FPS | Frame count auto-quantized to LTX's native 8n+1 |
| Steps | LTX turbo sweet spot ≈ 4–8; more = slower, marginal gains |
| CFG | Turbo likes low values (~2–3) |
| Denoise | v2v strength: lower = closer to depth structure |
| Seed | −1 = random; reuse a seed to iterate on a look |

On the 4060 Ti (16 GB): Draft ≈ fast iteration; Quality at ~5 s (121 frames)
is near the comfortable ceiling — if you OOM, drop resolution first, then
frame count.

## Layout

```
app/
├── backend/
│   ├── main.py            # FastAPI: /api/generate, /api/generate_image, SSE, video proxy
│   ├── workflow.py        # placeholder injection into workflow JSON
│   └── workflows/         # ComfyUI API-format templates (+ swap instructions)
└── frontend/
    └── src/
        ├── three/Studio.js        # scene, gizmo, camera keyframes, depth exporter
        ├── components/            # Toolbar, Inspector, Timeline, GeneratePanel,
        │                          # SketchMode (canvas), SketchPanel
        └── api.js                 # multipart submit + SSE progress
```
