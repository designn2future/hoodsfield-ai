# Troubleshooting

Start with **Settings → Setup check → Run**. It tests most of what is listed here and says what to do. **Copy diagnostics** (top of Settings) gives you a short report to paste into a bug report. It contains no secrets.

| Problem | Likely cause and fix |
|---|---|
| "Hoodsfield is not installed yet" when starting | Run `Install_Hoodsfield.bat` first. |
| The studio opens on Settings and says ComfyUI folder not found | Click **Detect**, or paste the folder that contains `main.py`. Save, then run `Start_Hoodsfield.bat` again. |
| *ComfyUI is not running* in the setup check | Start ComfyUI, or fix the address under Settings → ComfyUI & folders. `Start_Hoodsfield.bat` starts it for you. |
| *Missing custom nodes* | Install the listed packs with ComfyUI-Manager and restart ComfyUI. See [SETUP.md](SETUP.md). |
| A feature says its model is missing | Open the **Model manager**. It lists every file and where to get it. Models on another drive: add the folder under *Extra model folders*. |
| Renders are suddenly 10x slower | Something else is using VRAM (browser tabs with WebGL or video, remote desktop). On a PCIe-limited 16 GB card weights then stream over the bus. Close them. |
| A long job was cancelled and the log says memory | The **memory guard** interrupted it to keep Windows alive. Close big programs, or lower the thresholds in Settings → Safety. Video upscaling now splits long clips by itself so this should not happen there. |
| *Lite mode* is greyed out | Install [Ollama](https://ollama.com), run `ollama pull qwen2.5:14b-instruct`, make sure Ollama is running. |
| An H3 clip jumps back or replays after about a second | The first beat of the prompt did not match the still. Make beat one continue from exactly what the still shows, or trim the first second. The prompt coach adds a line for this. |
| Warbly or low-quality H3 audio | Ask for ambience only ("No music."), mute the clip and score it in the Timeline. |
| Phone cannot open Hoodsfield | PC and phone must be on the same network; open `http://<PC address>:8000`. For access from anywhere use `Remote_Access.bat` and set a login in Settings → Remote access. |
| "Changes apply after a restart" | Click **Restart the studio** in the bar at the bottom of Settings (or close and start it again). |
| The page looks old after an update | Hard-refresh the browser (Ctrl+F5). |

## Log files

`app\backend\vsa_work\studio_console.log` (when started by the keep-alive script), `backend_out.log` / `backend_err.log`, and `vsa_work\comfy_watchdog.log` for ComfyUI restarts.

## Still stuck

Open an issue at <https://github.com/designn2future/hoodsfield-ai/issues> and paste the output of **Copy diagnostics**.
