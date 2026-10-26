# Hoodsfield

**A local-first AI film studio built on ComfyUI.** Storyboard, generate, edit and cut a short film on your own GPU: no API keys, no cloud, no per-clip fees.

Hoodsfield is a React + FastAPI app that drives a local ComfyUI server. It was built for Comfy's *Open Source Higgsfield* contest, and its promo reel was made with Hoodsfield itself.

## What it does

| Area | Highlights |
|---|---|
| **Image** | Flux 3 text-to-image with a Cinema rig (camera, lens, light, film look); reference images; Qwen / Flux 3 instruction editing with brush masks; before/after slider in Explore |
| **Video** | MiniMax H3 (primary), LTX 2.3 and Wan 2.2 image-to-video; extend any clip from its last frame; Genjutsu video-to-video (motion transfer, object swap, restyle) |
| **Scene Composer** | Block a shot in 3D (props, posable figures, camera), then render it through depth-controlled generation |
| **Characters** | Consistent characters from a photo: turnaround sheets, outfit lock |
| **Timeline editor** | Multi-track editor: grades, LUTs, effects, camera moves, keyframes, shot-matching colour, beat detection, auto-captions, animated titles, background removal to transparent WebM, ffmpeg export |
| **Audio** | Stable Audio ambience, local TTS, lip-sync |
| **Video Lab** | Real-ESRGAN upscale, RIFE slow-mo, BiRefNet cutouts, reverse, loop, reframe and more |
| **Extras** | Phone/foldable layout, PC and phone share one session, optional remote access behind a login |

## Requirements

- Windows 10/11 (the launcher scripts are `.bat`; the Python and web code is portable)
- NVIDIA GPU. Developed on an RTX 4060 Ti 16 GB with 48 GB RAM. Smaller cards work with smaller models.
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) with the custom nodes and models for the engines you want to use. The in-app **Models** panel lists what is missing for each tool.
- Python 3.10+, Node 18+, ffmpeg (a bundled copy is used if `imageio-ffmpeg` is installed)

Model weights are **not** included and each has its own licence (Flux 3, MiniMax H3, LTX, Wan, Qwen, Stable Audio, Real-ESRGAN, BiRefNet). Check them before commercial use.

## Setup

```bat
git clone https://github.com/synexonline/hoodsfield-ai
cd hoodsfield-ai\app

:: backend
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
cd ..

:: frontend
cd frontend
npm install
npm run build
cd ..\..
```

Point the app at your ComfyUI folder (defaults to `D:\ComfyUI-LTX2`):

```bat
setx COMFY_ROOT "C:\path\to\ComfyUI"
setx COMFY_DIR  "C:\path\to\ComfyUI"
```

Edit `COMFY` at the top of `Start_Hoodsfield.bat` too, then run it. It starts ComfyUI (if it is not already running) and the studio, and opens <http://localhost:8000>. `Keep_Hoodsfield_Running.bat` restarts the studio if it exits.

Manual start:

```bat
cd app\backend
.venv\Scripts\python main.py
```

For frontend development run `npm run dev` in `app/frontend`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI server |
| `COMFY_ROOT` / `COMFY_DIR` | `D:\ComfyUI-LTX2` | ComfyUI install folder |
| `VSA_WORK_DIR` | system temp `vsa_work` | Job database and outputs |
| `HF_AUTH_FILE` | `backend/hf_auth.json` | Remote-access login (created by `Set_Remote_Password.bat`) |

## Notes for low-VRAM or PCIe-limited GPUs

On a 16 GB card, anything else holding VRAM (Chrome WebGL tabs, remote desktop) can slow renders about 10x because weights stream over PCIe. Close other GPU apps while rendering.

## Licence

Apache-2.0, see [LICENSE](LICENSE). The app code is open source. Model weights and third-party ComfyUI nodes are under their own licences.
