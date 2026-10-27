# Hoodsfield handoff (2026-10-27)

## Cloud session limits
A cloud session has no GPU, no ComfyUI, no models and no Windows. It **can**: edit and review backend and frontend code, build the frontend, run CPU-only code (`layer_engine.py`, `loop_still.py`, loop routes with ffmpeg via `imageio-ffmpeg`), write docs. It **cannot**: generate images/video (Flux 3, Krea2, MiniMax H3, LTX, Wan), upscale, or run the full studio. Anything GPU-bound must be verified later on the user's PC.

## Where things are
- Source of truth on the user's PC: `C:\Users\synex\OneDrive\Desktop\HOODSFIELD AI\app`. This repo is a copy; the user syncs and pushes it. If this checkout and that folder differ, the PC folder wins.
- Seamless Loop Studio: `app/backend/{loop_routes,loop_still,layer_engine}.py`, `app/frontend/src/components/{LoopStudio,LayerBuilder}.jsx`, `docs/LOOPS.md`, templates in `app/backend/assets/templates/{paradise,cozy_room}`.

## Open work (in priority order)
1. **DONE and verified on the PC (2026-10-27).** Sub-pixel stabilise + adaptive freeze are built into Make loop (`loop_still.py`: `refine_ecc`, `freeze_mask`, `measure_jitter`, Lanczos `warp`; used by `_make_still_loop`). OpenCV is in `requirements.txt` but optional at runtime (falls back to the numpy pipeline). Real-clip result on the raw H3 paradise clip: vertical drift range 14.3 px -> 0.86 px, jitter 0.44 -> 0.12 px rms (the current numpy pipeline gave 3.8 px / 0.29); 51% of the picture frozen (tree, rocks) while sky, aurora, lotuses and water still move; seam rated seamless. `freeze_mask` thresholds are percentiles of the clip's own activity, clamped to absolute limits (lo 1-6, hi 3-14 levels): without the clamp a fully moving clip still had its calmest pixels frozen and a static one kept its grain. Open idea: a temporal smoothing step in `refine_ecc` was removed because it hurt on synthetic jitter; not re-tested on real clips.
2. Two more example loops (user request): layers-only scenes (a still plus exact-cycle layers, so zero jitter), e.g. a snowy cabin at night and a neon rainy city street. Add them as templates in `app/backend/assets/templates/<id>/{still.jpg,template.json}` (see `docs/handoff/` scripts and the existing `template.json` files for the format). Stills must be generated on the user's PC (Flux 3, 1664x928).
3. Typeform draft and walkthrough: optionally add a loops scene (user decides).
4. Untested: Wan engine in Loop Studio; the "Upscale the loop" button was only tested via the API.

## Verified facts worth keeping
- Layers loops are exactly periodic (frame N equals frame 0, diff 4e-16) at 6/10/13 s.
- Decode a loop with `-fps_mode passthrough` (the fps filter duplicates its last frame).
- Export copies the loop with `-stream_loop N -c:v copy`; loops over 14 Mbps are compressed once (crf 20, maxrate 9M).
- MiniMax H3: use `coach=false` for calm scenes; the coach's "things fall" line makes objects fly.
- Never save settings from a test studio without `HOODSFIELD_SETTINGS` set: it overwrites the real file.

## User's own to-dos
Push this repo (GitHub `designn2future/hoodsfield-ai`), upload the videos, submit the Typeform. Contest deadline: Fri 2026-10-30 9 AM PT (user targets Thursday).
