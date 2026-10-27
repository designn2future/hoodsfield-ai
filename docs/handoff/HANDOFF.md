# Hoodsfield handoff (2026-10-27)

## Cloud session limits
A cloud session has no GPU, no ComfyUI, no models and no Windows. It **can**: edit and review backend and frontend code, build the frontend, run CPU-only code (`layer_engine.py`, `loop_still.py`, loop routes with ffmpeg via `imageio-ffmpeg`), write docs. It **cannot**: generate images/video (Flux 3, Krea2, MiniMax H3, LTX, Wan), upscale, or run the full studio. Anything GPU-bound must be verified later on the user's PC.

## Where things are
- Source of truth on the user's PC: `C:\Users\synex\OneDrive\Desktop\HOODSFIELD AI\app`. This repo is a copy; the user syncs and pushes it. If this checkout and that folder differ, the PC folder wins.
- Seamless Loop Studio: `app/backend/{loop_routes,loop_still,layer_engine}.py`, `app/frontend/src/components/{LoopStudio,LayerBuilder}.jsx`, `docs/LOOPS.md`, templates in `app/backend/assets/templates/{paradise,cozy_room}`.

## Open work (in priority order)
1. **Build the sub-pixel stabilise + freeze-still pass into "Make loop".** Today the hold-still pipeline (`loop_still.py`) leaves about 11 px of drift and 0.5 px of jitter on AI clips (measured on the Enchanted Paradise hybrid loop). Two manual scripts in this folder fixed it to 0.06 px rms and should become a function used by `_make_still_loop` in `loop_routes.py`:
   - `stabilise_ecc_subpixel.py`: OpenCV ECC affine at 960 px against a per-pixel median plate (sparkle/moving pixels masked out), 4 iterations, one Lanczos resample with a constant 1.025 zoom to hide borders.
   - `freeze_static_regions.py`: output = mask * frame + (1 - mask) * plate, mask from per-pixel temporal deviation (smoothstep between the 45th and 80th percentile, dilated, blurred).
   - `measure_jitter.py`: the metric (range and frame-to-frame rms of translation vs the plate).
   - They have hard-coded paths: parameterise them. They need `opencv-python-headless` and `numpy` (opencv is **not yet** in `app/backend/requirements.txt`; make it optional with a fallback to the current pipeline, as `_make_still_loop` already falls back on error).
   - A dense DIS-optical-flow warp was also tried and was no better than the affine pass; do not repeat it.
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
