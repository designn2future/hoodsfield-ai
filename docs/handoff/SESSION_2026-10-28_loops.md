# Hoodsfield: handoff, 2026-10-28 (Loops / one-click loop)

Read this first in a new conversation. It replaces re-reading the old chat. (Older background: `docs/handoff/HANDOFF.md` in the repo and Claude's memory notes, which load automatically.)

## 0. The user and how to work with them
- The user is building **Hoodsfield**, a local-first AI film studio on ComfyUI, for the Comfy "Open Source Higgsfield" contest. **Deadline Fri 2026-10-30 9 AM PT; the user targets Thursday 10-29.** The user pushes the repo and submits the Typeform themself (GitHub account `designn2future`, repo `designn2future/hoodsfield-ai`).
- **Product principle (their words): a highly AI-driven app. Users should not tweak dials or trace masks; very little effort should give great results.** Anything that needs the user to tune values is the wrong design.
- Style: **short answers, action first.** They get frustrated by long text ("a lot to read but nothing done"). They were angry when I made their loop for them unasked ("I'll do it myself"). Do not run their pipeline for them; ask before changing things they did not request. They are tired and stressed: keep it calm and brief.
- They prefer tool calls to proceed without asking, but confirm before downloads/installs and before anything outward-facing (pushing, posting).

## 1. Where things are
| What | Path |
|---|---|
| **Source of truth (the running app)** | `C:\Users\synex\OneDrive\Desktop\HOODSFIELD AI\app` |
| Git worktree with my local commits | `C:\Users\synex\hf-cloud-test` (branch `subpixel-integration`, latest `c1937b2`, NOT pushed) |
| Original repo checkout | `C:\Users\synex\hoodsfield-ai` (`main`, pushed to GitHub through the templates + UI-fix commits) |
| Launcher | `...\HOODSFIELD AI\Start_Hoodsfield.bat` (fixed today for folder paths with spaces) |
| Studio data (gallery, shared session) | `D:\vsa_work` |
| ComfyUI | `D:\ComfyUI-LTX2` (port 8188), logs in `D:\ComfyUI-LTX2\user\comfyui_8188.log` |
| Deliverables | `...\HOODSFIELD AI\final\` (reel, walkthrough 2:02, Typeform draft, `Loops\` videos, `Loops\test_pictures\` for testing) |

**Workflow:** edit in the Desktop `app` folder (CRLF files), rebuild the frontend (`cd app\frontend; npm run build`), restart the studio, then copy changed files into `hf-cloud-test` (convert to LF with `sed 's/\r$//'`) and commit there. The user pushes.

**Restarting the studio:** close its window, run `Start_Hoodsfield.bat` (it starts ComfyUI too if needed), then Ctrl+F5 in the browser. A backend change always needs a restart: "Method not allowed" on a new route means the studio was not restarted.

## 2. What exists in Loops now (the Loops rail icon)
Page = `frontend/src/components/LoopStudio.jsx`. Default tab is now **✨ One-click loop**; the older tabs sit behind "More ways to make a loop ▾" (Animate a picture with MiniMax H3, I already have a clip, Layers, Living scene).

**One-click loop** (`MagicLoop.jsx`, route `POST /api/loop/magic/analyze`, form fields `image`, `hint`):
1. User drops a picture. The backend sends a 1024 px copy to **the user's connected Claude account** (`claude -p --tools Read --allowedTools Read --no-session-persistence --output-format json --model sonnet`, via `claude_cli._run`), about 7 to 20 s. Claude acts as a lofi-video art director and returns JSON: `scene`, `title`, `indoors`, `reason`, `water` polygons, `keep_still` polygons (docks, rocks), `window_box`, `sky_box`, `aurora_color`, and `effects` (mist, water_motion, glints, rain, snow, fireflies, stars, aurora, flicker, each 0 to 1). Prompt text is `MAGIC_PROMPT` in `loop_routes.py`. If Claude is not connected or fails, a gentle default plan is used and the page says so.
2. `decide()` in `MagicLoop.jsx` picks the engine: weather (rain/snow), indoors, or non-water scenes use the **layer engine** (CPU, about 5 to 8 min, route `/api/loop/layers`, outdoor effects confined to `window_box`); water and fog-only outdoors scenes use the **GPU scene** (`LivingScene.jsx` in `simple` mode, fast).
3. The page shows a plain-words summary and the director's reason, one **Make my loop** button, a "Fine-tune (optional)" drawer, and a **"Not what you pictured? Tell me in a few words"** box that re-plans with the user's hint.
4. Result appears in the existing "Your loop" card with seam rating and the long-video export (step 3).

**GPU scene (fog + water):** `frontend/src/gpuScene.js` (WebGL shader, approved look: fog amount 0.45, height 0.4, wisp size 0.38, water motion 0.5, glints 0.45, glint style 0.3), `LivingScene.jsx`. Every motion goes round whole circles per loop, so frame N equals frame 0. The browser draws each frame on the user's GPU and uploads JPEGs to `POST /api/loop/gpu/start`, `/api/loop/gpu/{id}/frame/{i}`, `/api/loop/gpu/{id}/finish` (ffmpeg encodes the loop). The water mask comes from Claude's polygons (or the user's tracing in the Fine-tune drawer).

**Make loop from an AI clip** (`loop_routes.py` `_make_still_loop`, `loop_still.py`): sub-pixel ECC stabiliser (OpenCV, `refine_ecc`), freeze mask with absolute limits (`freeze_mask`), settling period taken from the coarse estimate (`_settle_index`). Known weakness: a source clip with a sudden jolt gives a very short loop (the app warns).

**Layers tab:** exact-cycle layers (`layer_engine.py`). NOTE: the **Mist layer was rewritten** on 10-27 (organic, slower, Fourier modes); the user then said it still looked bad and moved to the GPU scene. **Open question for the user: revert the Layers mist to the original?** Backup: `layer_engine.py.bak-mist-20261027`. This also affects the 4 templates (paradise, cozy_room, cabin, neon).

## 3. Verified, and not verified
- Verified (headless Chrome with software WebGL, throwaway studios): one-click on a lake, a rainy neon alley, a snowy cabin, and a window nook with aurora (plans were sensible); full GPU render at 640 px to a seamless loop; hint re-plan on the nook (rain outside, aurora off).
- **Not verified:** a full-size (1920 px, 300-frame) GPU render on the user's real graphics card; a full layer-engine render started from the one-click page (it uses the old, working `/api/loop/layers`); the one-click page on the user's own machine after restart (they were about to try it).

## 4. Open work, in priority order
1. **Let the user try one-click on real pictures** and fix what feels wrong. Their complaint so far: the first plan for a cozy window nook added fog (fixed with the art-director prompt).
2. **Element-level animation (user's stated goal: "Claude identifies elements, figures out how to animate them, and masks them").** Today Claude can only place water, still regions, a window and the sky. Next: Claude outlines each element and names a motion type (steam rising, curtain/leaf sway, candle or lamp flicker, flag, hair), the app applies that motion only inside the outline. Suggested design: pack masks into RGBA channels of the GPU shader's mask texture (ripple, sway, flicker, rise/steam), loop-safe with whole-number cycles, driven by the same JSON. Also steam from a mug was mentioned by Claude but cannot be animated yet.
3. Decide on the **Layers mist revert** (section 2).
4. Update the **walkthrough and Typeform draft** to mention the one-click loop (walkthrough Loops scene still shows the old tabs/templates; builder scripts are in the scratchpad `walk\build_loops_scene.py`, may be gone).
5. The user must **push** `subpixel-integration` (or ask me), then merge on GitHub; also Typeform submission and video uploads are theirs.
6. Minor: `.env` line 28 `VSA_WORK_DIR` is corrupted (a vertical tab replaces `\v`); it works by luck (resolves to `D:\vsa_work`). Offer to fix to `D:/vsa_work`. The idea-helper (keywords to prompts) was superseded by the one-click hint box.

## 5. Hazards and gotchas (these cost hours)
- **Test studios must be started with their own `PORT` env** (e.g. `PORT=8041 ... uvicorn main:app --port 8041`) plus temp `HOODSFIELD_SETTINGS`, `VSA_WORK_DIR`, `HOODSFIELD_OUTPUT`. Otherwise the ComfyUI watchdog inside a test studio watches port 8000, "restarts" the user's studio with the test environment, and the user's work lands in test folders (this happened 10-27). Always stop test studios and headless Chrome when done. Leftover test processes on ports 8003, 8004, 8013 and 8031 may still exist; the user can stop them with: `Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match '--port (8003|8004|8013|8031|8041)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`.
- **Never run `npm run build` while headless Chrome is open** (locked video files leave `dist` half deleted and the live studio blank). Kill the Chrome started with `--remote-debugging-port=9333` first.
- **Heredocs in the shell tool strip backslashes** (breaks Windows paths and regexes). Put scripts with backslashes in files with the Write tool, or use `chr(92)`.
- Headless Chrome for WebGL tests: `--headless=new --remote-debugging-port=9333 --user-data-dir=<scratchpad>/cdp-profile3 --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`. The CDP helper is `<scratchpad>/cdp/cdp.mjs`. To fill a drop zone use `DOM.setFileInputFiles` on `.st-card .dz-wrap input[type=file]`; click edges of an SVG exactly at 0 or 1 miss, use 0.01/0.99.
- Local vision model `qwen3-vl` via Ollama is far too slow here (9 min, empty answer) because ComfyUI uses the GPU; use the user's Claude account instead.
- The Chrome gallery (143 images) is in profile "Profile 1" (IndexedDB for `localhost:8000`); a backup is in `final\Backup_browser_gallery_localhost8000_2026-10-27`. Do not clear browser data.
- The installer test used a path without spaces, which hid a launcher bug; test with the real folder name `HOODSFIELD AI`.

## 6. Quick commands
```
# is everything up?
curl -s localhost:8000/api/health         # studio (comfy_reachable should be true)
curl -s localhost:8188/system_stats       # ComfyUI

# status of local work
cd C:\Users\synex\hf-cloud-test ; git log --oneline | head -5 ; git status -sb

# publish (the user does this)
cd C:\Users\synex\hf-cloud-test ; git push -u origin subpixel-integration
```
