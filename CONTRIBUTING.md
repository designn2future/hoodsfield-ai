# Contributing

Thanks for looking. The project is small enough that a pull request with a clear description is plenty.

## Run it for development

```bat
Install_Hoodsfield.bat
cd app\backend
.venv\Scripts\python main.py          :: studio on http://localhost:8000 (needs ComfyUI for real generations)
```

Without a GPU you can click through the whole UI with mock mode: set `COMFY_MOCK=1` in `app/backend/.env` (generations are simulated).

For the web UI with hot reload: `cd app\frontend && npm run dev`.

## Layout

| Path | What |
|---|---|
| `app/backend` | FastAPI app. `main.py` registers one `*_routes.py` module per feature. `app_settings.py` loads Settings into the environment before anything else is imported. |
| `app/frontend/src` | React UI. `App.jsx` owns the pages ("overlays"); `components/` has one file per page. |
| `docs/` | Setup, Claude, models, troubleshooting, the H3 prompting skill |

## Conventions

- New backend feature: a `*_routes.py` with `register(app, m)` and one line in `main.py`.
- A new option goes in the field list in `app/backend/app_settings.py` and shows up in Settings automatically; mark it `restart` if it is read at import time.
- Keep machine-specific paths out of code; use Settings / environment variables.
- Do not commit `hoodsfield_settings.json`, `hf_auth.json`, `.env` or anything under `vsa_work/`.

## Before you open a PR

```bat
cd app\backend && .venv\Scripts\python -m compileall -q .
cd ..\frontend && npm run build
```

CI runs the same two checks.
