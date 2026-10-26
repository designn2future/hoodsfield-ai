# LoRA + GGUF troubleshooting session — 2026-07-13

Findings from a debugging session on the "can't enable a LoRA when using the video GGUF"
issue, plus a follow-up issue (generation not reaching ComfyUI) that is still open.

**No code was changed in this session.** This doc records the diagnosis and the
recommended fixes so they can be applied later.

---

## Issue 1 — Video LoRA controls greyed out when a GGUF model is selected

### Symptom
In the scene detail popup (video panel), with an existing/imported image as the scene
source and a GGUF picked in "Video model (GGUF)", the **+ Add LoRA** button and LoRA
dropdown are greyed out and unclickable.

### Root cause
**There is no coupling between the GGUF selection and the LoRA controls.** GGUF + LoRA
together is a fully supported path end-to-end:

- Frontend (`app/frontend/src/App.jsx` ~line 234) sends both `gguf_model` and the
  `loras` array to the backend.
- Backend (`app/backend/main.py`, i2v endpoint ~line 1006) applies both: it swaps the
  transformer on graph node `844:286` (`UnetLoaderGGUF.unet_name`) and chains
  `LoraLoaderModelOnly` nodes via `set_video_lora_chain()`
  (`app/backend/workflow.py:117`).

The LoRA controls (`app/frontend/src/components/LoraRows.jsx:20,33`) disable for
exactly two reasons:

1. `busy` — a generation is running for that scene (everything in the panel disables).
2. `!loraOptions.length` — the LoRA list from `/api/loras` is **empty**. The dropdown
   then shows "— none found / ComfyUI offline —".

The observed grey-out was case 2: a **stale empty LoRA list**. The list is fetched from
ComfyUI once when a panel mounts. If the browser tab loaded while ComfyUI was still
starting (or briefly unreachable), the fetch returns `[]` and is never retried:

- `SceneDetail.jsx` refetches on every popup open (it unmounts on close), so it
  recovers on reopen — *if* ComfyUI is up by then.
- `SketchPanel.jsx` / `KreaPanel.jsx` are **kept mounted for the whole session**
  (`App.jsx` ~line 602, sketch overlay is `display:none` when closed), so their
  one-time fetch at page load never retries. A tab opened before ComfyUI finished
  starting keeps an empty LoRA list until a full page reload.

### Verified during the session
- Backend (`:8000`), ComfyUI (`:8188`), and Vite dev server (`:5173`) all up; those are
  the only relevant listeners, so the app tab is served by the dev server.
- `/api/loras` returned **56 LoRAs** both directly against the backend and through the
  Vite proxy from the page origin.
- The built `dist/` bundle matches current source (has the Video LoRAs UI).
- ComfyUI queue was empty (no stuck generation ⇒ `busy` ruled out).
- Project save/load strips `gen` state (`src/project.js:30,53`), so a loaded project
  can't restore a stuck-busy scene.

### Workaround (no code change)
1. **File → Save Project** (no autosave — a refresh wipes the board).
2. Refresh the page (F5) with the ComfyUI badge green.
3. Reopen the project; LoRA controls populate.

### Recommended fix (not yet applied)
Refetch the model/LoRA/GGUF/text-encoder/VAE option lists when a panel becomes visible
(or when the ComfyUI status badge transitions to online), instead of only once at
mount. Cheapest version: in `SketchPanel`/`KreaPanel`, key the fetch `useEffect` on the
overlay-visible prop; better version: lift list fetching into a small shared hook that
retries on ComfyUI reconnect.

---

## Issue 2 — Generation from an imported image never reaches ComfyUI (OPEN)

### Symptom
Generating an image from an imported image (img2img / remix path): ComfyUI shows no
sign of receiving the prompt.

### Status
Investigation was interrupted before evidence was collected. Not yet diagnosed.

### Next diagnostic steps
1. Check ComfyUI history for whether a prompt arrived at all:
   `GET http://127.0.0.1:8188/history?max_items=8`.
2. Check what the app shows: stuck at "Uploading…"? An error message under the
   progress bar? (The panel surfaces backend HTTP errors in a `.error` div.)
3. Check the backend terminal (uvicorn on `:8000`) for a traceback — the request path
   is frontend → FastAPI `/api/sketch` → ComfyUI `/prompt`; a 4xx/5xx from the backend
   (e.g. "No GGUF checkpoints installed", missing checkpoint for the SD backend, or an
   upload failure) never reaches ComfyUI.
4. Note: if the tab still has the stale state from Issue 1 (empty model lists), the
   sketch generate request can be sent with an empty/never-picked checkpoint or
   encoder — same page reload applies before retesting.

---

## Environment reference

| Component | Where | Notes |
|---|---|---|
| Frontend dev server | `http://localhost:5173` | Vite, proxies `/api` → `:8000` (`vite.config.js`) |
| Backend (FastAPI) | `http://127.0.0.1:8000` | `app/backend/main.py`, proxy to ComfyUI |
| ComfyUI | `http://127.0.0.1:8188` | Model lists come from its `/object_info` |
| LoRA list endpoint | `/api/loras` | Returns core `LoraLoader` picker contents |
| GGUF list endpoint | `/api/gguf_models` | Returns `UnetLoaderGGUF` picker contents |
