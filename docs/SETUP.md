# Setup guide

Hoodsfield is the studio; **ComfyUI** is the engine. You install both, once.

## 1. Install ComfyUI

1. Install [ComfyUI](https://github.com/comfyanonymous/ComfyUI) (the Windows portable build or a manual install both work) and make sure it starts.
2. Install [ComfyUI-Manager](https://github.com/ltdrdata/ComfyUI-Manager) if you do not have it. It installs custom nodes in two clicks.
3. Note the folder that contains ComfyUI's `main.py`. Hoodsfield asks for it in Settings (or finds it itself).

### Custom node packs

Different features use different packs. Install the ones for the features you want; the **setup check** (Settings) tells you exactly which node classes are missing.

| Pack | Needed for |
|---|---|
| ComfyUI-VideoHelperSuite | Loading and saving video everywhere (Video Lab, upscaling, exports) |
| comfyui-kjnodes | Batched video upscaling |
| comfyui-frame-interpolation | RIFE slow-motion and smoothing |
| ComfyUI-GGUF | Wan 2.2 (GGUF models) |
| ComfyUI-LTXVideo | LTX 2.3 video, motion control, Genjutsu video-to-video, lip-sync fallback |
| int8 support for Flux 3 / MiniMax H3 INT8 models | The INT8 model files (see [MODELS.md](MODELS.md)) |
| comfyui_nvidia_rtx_nodes | Optional: fast RTX video upscaler |
| ComfyUI-Krea2T-Enhancer, comfyui-krea2-text-encoder | Optional: Krea 2 |

### Models

Weights are large and have their own licences, so Hoodsfield never downloads them for you. **Model manager** (menu: Create → Model manager) shows, per feature, what is installed and what is missing, with a link to each file. The list is also in [MODELS.md](MODELS.md).

Start with one engine, for example **Flux 3 Klein** for pictures and **MiniMax H3** for video, and add more later.

## 2. Install Hoodsfield

Requirements: Windows 10/11, Python 3.10 or newer ("Add python.exe to PATH" ticked), Node.js 18 or newer.

```bat
git clone https://github.com/designn2future/hoodsfield-ai
cd hoodsfield-ai
Install_Hoodsfield.bat
```

The installer creates `app\backend\.venv`, installs the Python packages, builds the web UI and tells you whether your ComfyUI folder was found. Run it again whenever you update.

## 3. Start

```bat
Start_Hoodsfield.bat
```

It starts ComfyUI (using the start-up options from Settings) if it is not running, starts the studio and opens <http://localhost:8000>.

`Keep_Hoodsfield_Running.bat` is an optional supervisor that restarts the studio if it ever exits.

## 4. First run: the Settings page

A banner offers the **setup check**. Work top to bottom:

1. **ComfyUI & folders**: confirm the folder (use *Detect*), add extra model folders if your models live on another drive.
2. **Graphics card**: accept the recommended profile for your VRAM.
3. **Setup check → Run**: fix anything red, then look at anything amber.

Settings are saved in `app\backend\hoodsfield_settings.json`. Some changes (marked *restart*) apply after a restart; Settings shows a **Restart the studio** button when that is needed.

## Updating

```bat
git pull
Install_Hoodsfield.bat
```

## Uninstalling

Delete the folder. Nothing is installed outside it, except, if you used it, `app\backend\hf_auth.json` (the remote-access login).
