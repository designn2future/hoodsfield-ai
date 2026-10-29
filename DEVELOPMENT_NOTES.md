# Hoodsfield: development notes

Local-first AI film studio on ComfyUI (FastAPI backend in `app/backend`, React/Vite frontend in `app/frontend`). Contest entry: Comfy "Open Source Higgsfield".

**Start here: `docs/handoff/HANDOFF.md`** (current state, what is unfinished, what a cloud session can and cannot do).

## Ground rules
- Match the surrounding code: comment density, naming, idiom.
- Nothing may break the existing app. Test studios use a temp `HOODSFIELD_SETTINGS`, `VSA_WORK_DIR` and `HOODSFIELD_OUTPUT` so a real user's settings and gallery are never touched.
- Settings live in `app/backend/app_settings.py` (imported first in `main.py`). Priority: defaults < OS env < `backend/.env` < `hoodsfield_settings.json` (git-ignored).
- Frontend build: `cd app/frontend && npm ci && npm run build`. CI is in `.github/workflows/ci.yml`.
- Do not push, publish, or submit anything on the maintainer's behalf.
