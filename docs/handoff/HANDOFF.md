# Hoodsfield handoff

For any developer or coding assistant picking this project up.

## What a cloud session can and cannot do
A cloud session has no GPU, no ComfyUI, no models and no Windows. It **can** edit and review backend and frontend code, build the frontend, run CPU-only code (`layer_engine.py`, `loop_still.py`, loop routes with ffmpeg via `imageio-ffmpeg`) and write docs. It **cannot** generate images or video (Flux 3, Qwen, MiniMax H3, LTX, Wan), upscale, or run the full studio. Anything GPU-bound has to be verified on a PC with ComfyUI and the models installed.

## Where things are
- Backend: `app/backend` (FastAPI). Frontend: `app/frontend` (React + Vite). Docs: `docs/`.
- Run and settings: see the README and `docs/CLAUDE.md`. Settings live in `app/backend/app_settings.py`; the machine's own `hoodsfield_settings.json` and `.env` are git-ignored and never committed.
- Loops: `loop_routes.py`, `loop_still.py`, `layer_engine.py`, `docs/LOOPS.md`.
- Lip-sync, Swap & Perform, Ads presenter, voices: `docs/PERFORM.md`.
- Roadmap: `docs/ROADMAP.md`.

## Ground rules
- Match the surrounding code (comment density, naming, idiom).
- Test studios must use their own `PORT`, `HOODSFIELD_SETTINGS`, `VSA_WORK_DIR` and `HOODSFIELD_OUTPUT`, so a test never touches real settings, the gallery or a running studio.
- Never save settings from a test studio without `HOODSFIELD_SETTINGS` set: it overwrites the real file.
- Do not commit personal files: generated media from your own gallery, voice samples, tokens or keys.

## Verified facts worth keeping
- Layers loops are exactly periodic (frame N equals frame 0). Decode a loop with `-fps_mode passthrough`.
- MiniMax H3 makes the face and the sound together; feeding it a voice file through `MiniMaxH3AddGuide` (audio) makes the lips follow that voice. The lip-sync route re-attaches the original audio afterwards.
- H3 keeps the eyes it sees in the first frame: give it a first frame with clear, open eyes.
- Use `ffmpeg -t <duration>` (not `-shortest`) when padding audio against a stream-copied video: `-shortest` never ends.
- Use H3 with `coach=false` for calm scenes.
