# Hoodsfield — Change Log / Session Notes

*(Renamed from "Video Studio AI" on 2026-10-17.)*

Running log of changes, so any later conversation can
pick up from here. Newest first.

---

## 2026-10-29: Lip-sync on MiniMax H3, Swap & Perform, characters with voices, Ads presenter, phone fixes

- **Lip-sync now runs on MiniMax H3 with a voice file** (`ltx_routes.py` `_lipsync_h3`, `MiniMaxH3AddGuide`): H3 makes the face and the sound together, so the lips follow the voice; the original audio is re-attached afterwards. The spoken words are transcribed (Whisper) and sent in the prompt. A MediaPipe mouth check (`lipalign.py`, `mouth_worker.py`, `models/face_landmarker.task`) triggers one extra take if the mouth hardly moves. *Best* (0.8 MP) uses the 8-step sampler. LTX 2.3 stays as the fallback (it also aligns the start of the lips to the voice).
- **Swap & Perform** (new page, rail *Perform*, `SwapPerform.jsx`): clip + "who to replace" + a character in, a clip out where the character has taken that person's place (whole person, via a full-body reference and Qwen) and performs the clip's own audio. See `docs/PERFORM.md`.
- **Characters have a voice** (Character Studio picker; Voice "Speak as"; Lip-sync "Say it in X's voice"). Voices generated on the Voice page save to the Gallery automatically; Lip-sync can pick any Gallery voice. Character Studio gained *Remove character* and *New scene with this character*.
- **Ads presenter**: choose a character; talking-to-camera shots are lip-synced in their voice, product shots get a voice-over (`/api/tools/ffmpeg` op `voiceover`). The presenter's plain-background sheet views are used so the photo's background does not leak into the ad.
- **Loops**: the stabiliser now follows camera drift frame by frame and smooths its corrections (static-region jitter 0.90 px to 0.17 px on a real clip). *Animate a picture* (H3) is the default tab with a locked-camera prompt and sigma shift 6; one-click window masks follow round windows; a *Recent loops* list recovers finished loops the page missed.
- **First-time Tour** (`Tour.jsx`), replayable from the top bar. Phone layouts for Ad Studio and Character Studio.
- The session notes in `docs/handoff` were replaced by a neutral handoff; `lipsync_src.mp4` was removed from `tools/assets` (the shipped banner is unchanged).

---

## 2026-10-27 — Seamless Loop Studio (study / lofi / sleep videos)

- **New page** (`components/LoopStudio.jsx`, rail icon *Loops*, Create menu, Home chip): (1) animate a picture with H3 or Wan, first frame = last frame = the picture, with calm-scene prompt presets, or bring a clip; (2) make it seamless; (3) export 10 min to 3 h, optionally with the user's music (length can match the track, fade-out). Optional Real-ESRGAN upscale of the loop (frame-independent, so the loop stays seamless).
- **Backend** (`loop_routes.py`): decodes the clip at 128x72, builds the all-pairs frame distance matrix, finds the start `a` and length `N` where the cross-faded streams (frames a.. vs a+N..) look most alike, never straddling a jump in the footage (cuts and model glitches are detected and reported as ranges), builds the loop with an ffmpeg `blend` smoothstep cross-fade, and rates the seam against the loop's own largest natural step. Export uses `-stream_loop` with `-c:v copy` (the loop is encoded without B-frames and with a closed GOP so copying is exact).
- **Verified**: a generated rainy-window clip (H3, anchored first/last frame) became a 5 s loop rated *seamless*; a 95 s export had 19 repeat boundaries, every one smaller than the largest normal frame step (6.4e-3 vs 7.8e-3). The whole page was driven in headless Chrome (upload, make, export).
- **H3 prompt coach**: no longer adds the "objects fall and accelerate" physics line to calm prompts ("locked off", "perfectly still", "very gently"...) and `rain` no longer counts as a falling-object word. The first loop test showed why: that line made the model throw a book off the desk. The skill got a "Calm scenes and seamless loops" section.
- `generateH3()` accepts a last frame (`api.js`); docs: `docs/LOOPS.md`.
- **Layers mode** (`layer_engine.py`, `LayerBuilder.jsx`, `/api/loop/layers`, `/api/loop/layers_preview`; suggested by the user from the After Effects workflow): a perfectly still background plus overlay layers (rain, snow, petals, fireflies, stars, mist, aurora, waterfall flow, water glitter, light flicker, camera breathing, vignette, grain) composited with screen / add / normal / soft light / overlay / multiply. Every layer runs on an exact cycle (integer passes, integer phase turns, noise scrolled by a whole texture width), so the loop closes by construction: verified frame N == frame 0 (diff 4e-16) for every layer and both templates at 6/10/13 s. A layer can be limited to a `box` (rain only through the window). Layers can also be added on top of an AI loop (`base_loop_id`), rendered at exact 1920x1080.
- **Templates** (`backend/assets/templates/*`, `/api/loop/templates`): *Enchanted paradise*, *Cozy rainy study room*, *Snowy cabin night* and *Neon rain alley*, each a still picture + layer stack; opening one fills the Layers tab, editable, renders without a GPU.
- **Hold the picture still** (`loop_still.py`, later the same day): the first loops showed a slow dissolve at the seam. Cause, measured: AI clips drift (the "locked-off" clip zoomed ~2% over its first 4 s and kept shimmering), so a cross-fade blends two different pictures. Now: stabilise each frame (block phase correlation, robust affine fit, bilinear warp), skip the settling period, crop the uncovered border, level brightness, build the loop's still plate (per-pixel median) and activity map, freeze everything that is not really moving, and cross-fade only the moving parts. First/last frame difference 1.84 -> 0.69 levels, 78-89% of the pixels held perfectly still, brightness drift 2.7 -> 0.17 levels. New `stillness` option (UI slider), `GET /api/loop/mask/{id}` ("show what moves"), pure numpy, memmap-backed; falls back to the plain cross-fade if anything in it fails.

---

## 2026-10-27 — 0.2.0: Settings, setup check, installer

- **Settings page** (`View → Settings`, gear icon): one place for ComfyUI address/folder (with auto-detect), extra model folders, ComfyUI start-up options, work/output folders, GPU profile, local AI (Ollama), H3 prompt coach, remote-access login and the memory guard. Saved to `backend/hoodsfield_settings.json` (git-ignored). `app_settings.py` applies it to the environment before any other module is imported, so every existing `os.getenv` keeps working. Priority: defaults < OS env < `.env` < Settings. Fields marked `restart` apply after **Restart the studio** (button in the Settings bar).
- **Setup check** (`GET /api/health/check`, shown in Settings and once on first run as a banner): Python, ffmpeg, ComfyUI, GPU/VRAM, ComfyUI folder, required node classes, model readiness (Model manager), RAM, disk, Ollama — each with a fix hint. `GET /api/diagnostics` (Copy diagnostics) for bug reports.
- **GPU profiles** (8/12/16/24 GB, `auto` reads ComfyUI): new H3 scenes start with the profile's draft preset and size (`SCENE_VIDEO_DEFAULTS`); longest clip follows the profile (`H3_MAX_FRAMES`).
- **H3 prompt coach preview** under the H3 prompt box (`H3CoachPreview.jsx`).
- **Video upscale no longer runs out of memory**: clips over ~60 frames are cut frame-exactly into 48-frame parts, upscaled one after another as ONE job (`CompositeJob`) and joined losslessly (audio kept). A single 7 s clip used to hold ~9 GB of float frames and the memory guard cancelled it.
- **Portability**: removed machine-specific paths (`D:\ComfyUI-LTX2`, `C:\ComfyUI-models`, the ComfyUI start flags in the watchdog) in favour of Settings. `Install_Hoodsfield.bat` (venv, packages, web UI build, setup check), `Start_Hoodsfield.bat` reads the folder/options from Settings via `launch_info.py` and opens Settings if ComfyUI is not found. `Remote_Access.ps1` explains the one extra download.
- **Docs/repo**: README rewrite, `docs/SETUP.md`, `MODELS.md`, `TROUBLESHOOTING.md`, `SECURITY.md`, `CONTRIBUTING.md`, CI workflow.

---

## 2026-10-23 — Assistant (idea in, finished video out, approvals on PC or phone)

- **What it is**: `assistant_routes.py` starts a headless agent session per project (a local model in Lite mode). The session may only use the tools in `assistant_mcp.py` plus Read (no shell, no file edits) and follows `assistant_playbook.md` (4 approvals: script, stills, clips, final cut; escalation ladder; H3 lessons; versioned outputs, never overwrites).
- **Tools** (`assistant_mcp.py`): `report`, `ask_user` (blocks until answered in the app, up to 12 h), `make_still` (Flux 3 / Qwen), `make_clip` (H3 + chaos_analyze + contact sheet), `contact_sheet`, `build_cut` (chaos cut -> Hoodsfield_Output/<name>_vN.mp4).
- **UI**: new Assistant tab (`AssistantPanel.jsx`, `assistant.css`): start form, project list, live timeline, approval cards with pictures/videos and a note box, message to the assistant, Stop, Resume. Live over the shared feed (`{type:'assistant'}`), same on PC and phone.
- **Verified**: a plumbing run (report -> ask_user -> answer -> finish) completed in ~15 s through the API. NOT yet verified: a full real project (stills, clips, cut), the screen on a real phone.
- Runs persist in `vsa_work/assistant/<id>/run.json`; a backend restart marks running ones "interrupted" and Resume continues the same session.

---

## 2026-10-22 — Phone access + live sync between PC and phone

- **Phone access**: backend already binds 0.0.0.0:8000; `Phone_Access_Setup.bat` (run as admin once) opens the private-network firewall port. Open `http://<PC IP>:8000` on the phone (same Wi-Fi). No login: keep it on the home network.
- **Phone layout** (`frontend/src/phone.css`, imported last in `main.jsx`): at <=820 px the nav rail becomes a bottom tab bar, banner shrinks, Image Studio stacks controls above results, 16 px inputs, hover-only buttons always visible on touch.
- **Stage 1, shared feed**: `main._feed()` broadcasts started/progress/done/error for every job on `GET /api/feed` (SSE) and `GET /api/feed/recent?since=` (catch-up). `sharedFeed.jsx` imports finished images started on ANOTHER screen into the gallery and the Image Studio results (`hf-remote-result` event), and shows a "Generating on another device" pill. `api.js` `localJobs` marks this screen's own jobs.
- **Stage 2, shared session** (`session_routes.py`, `sharedSession.jsx`): the PC holds one copy of the project (state JSON + asset blobs in `vsa_work/shared_session/`). Screens push changes (1.5 s tick, signature compare) and pull on `{type:'session'}` announcements; last writer wins; `gen` progress and board pan/zoom stay per screen. Image Studio reference photos sync separately (`/api/session/refs`, `{type:'refs'}`), so a photo added on the phone appears on the PC. `SyncBadge` shows Synced/Syncing/Not synced.
- **Also fixed**: Qwen Generate mode now honors the aspect ratio when a reference is attached (`match_ref_size` only in Edit mode); hint when the prompt has a reference but no "image 1".
- **Not verified**: the browser automation was blocked ("different extension") during the sync test, so session sync is verified only through the API (PUT/GET/blob/refs with curl) and the build, not as a live PC-and-phone run.
- **Sync loop fixed (2026-10-22, later)**: the Image Studio canvas list used to ride in `fluxSettings.resultIds`; two screens fought over it and pushed every ~1.5 s (session rev went 7 -> 130+ in minutes, UI flickered, GPU/browser busy). Now the canvas list syncs like the reference photos (`/api/session/results`, `{type:'results'}`; push only on a local change, apply a pulled list without pushing it back), the server strips any `resultIds`, and `sharedSession.jsx` has a circuit breaker (more than 6 pushes in 20 s pauses pushing for 60 s). Results area is a CSS grid with `scrollbar-gutter: stable` (the old multi-column layout could flip column count). If the session rev climbs while idle, a screen is looping: `curl localhost:8000/api/session` twice and diff.
- Gotcha: the PC project folder was renamed twice (`HOODSFIELD AI` now). The backend is two python processes (venv launcher + child); kill both to restart.

---

## 2026-10-19 (late) — Scare videos: doorbell, nursery cam, trail cam

- **New genres/looks**: `monitor_cam` + `babycam` look (IR black and white, 15 fps), `trail_cam` + `trailcam` look (IR flash, 10 fps), `doorbell` + `doorbellcam`. All are in `ONCE_LOOKS` (App.jsx): the look is applied once on the final cut, so build from clips that do not already carry it.
- **Chaos cut additions**: `scare_at` jump-scare sting (panel input, -1 = none), caption styles `stamp:` (timestamp), `strip:` (trail-cam black data bar along the bottom), `reply:`; `||` separates overlays. Panel auto-picks the look from the genre's `post` when Style = Fixed camera.
- **Escalation rule** (user called the doorbell video "boring"): every scare video needs a ladder: calm, tiny wrongness, plainly happening, faster plus a second thing, everything stops and something is there, payoff. No visible faces/phones.
- **Files** (Desktop\Hoodsfield_Output): `the_doorbell_v1`, `the_nursery_v1` (black figure with eyes, user disliked eyes), `v2` (smoke, too heavy), `v3` (subtle shadow in the chair, USER LIKED), `v4` (shadow faded toward an empty-room plate so the chair shows through, partial), `the_trailcam_v1` (liked overall), `v2` (longer fingers, figure pushed back; user said it "just plain sucks", no specifics yet).
- **Open items**: (1) nursery transparency: H3 renders apparitions opaque, v4 fades in post (`Tempo\ghost.py`, percentile "empty room" plate) but the chair is static behind it and shots 5/6 grew a faint wall hanging. Next try: regenerate shots 5/6 with the chair slowly rocking and a clear wall, then fade the shadow. (2) trail cam v2: ask what failed (likely the mannequin-like figure or the over-warped hand); option: tall dark branch-like silhouette, milder hand.
- **H3 lessons**: figures walk toward the camera even when told they do not (use the first ~1.2 s slowed 3x); strangers appear unless "no other person appears"; image models resist very long fingers (post-warp with an OpenCV radial stretch, k~1.75; 2.4 pushes fingers off-frame); apparitions come out opaque.
- **Browser gotchas**: a tab with a beforeunload dialog cannot be reloaded/closed, open a new tab; restoring autosave needs a fresh page load plus the "Restore it" banner; use http://127.0.0.1:8000 for automation (separate IndexedDB from the user's localhost:8000).
- **Never overwrite** `THE_DRIVE_HOME_1986_FINAL_LOCKED.mp4`.

---

## 2026-10-19 — Real-footage realism: Handheld POV genre, Chaos cut, mic mishaps

Goal (from the user's reference TikTok clips): output that people cannot tell from real found footage. What the references have in common: nobody looks at the lens, the camera is badly aimed, dark and murky, 480x864 at ~200 kbps, the threat arrives late and partial, one continuous take, loud room/road noise with muffled voices and an abrupt end. Everything below was built to get there and verified on the "The Drive Home, Nevada 1986" test video.

- **Handheld POV genre** (`genres.py` `phone_pov`): director rules (nobody looks at the camera, badly aimed, threat late and partial, keep geometry consistent, period-correct tech, no devices shown) + a dark overcast still style. Pick it in the top-bar genre menu. Tip: leave `[CHARACTERS]` out of POV shots (a named character triggers the "face fully visible, sharp focus" clause and pinned faces); put voices in `[SFX]` as off-screen speech.
- **TikTok repost look** (`footage.py` preset `tiktok`; `tools_routes.py` crf>=31, maxrate 380k): dark curves, soft, starved bitrate. For this genre it is applied ONCE to the whole cut (`tkRenderFinal`), so every shot shares one look and the shake runs across cuts.
- **Focus setting** (top bar): genre default / off / some / a lot. "off" also strips "focus hunting / soft focus" from still and motion prompts (`genreStore.js` `scrubFocus`).
- **Per-shot Chaos slider** (Produce step, `scene.chaos` 0-100) + "Escalate chaos" button: `chaosPhrase()` writes camera-movement wording into the next clip's prompt; the final pass shakes harder or softer per shot (`footage.build(shake_env=...)`, time-varying shake envelope, ramp at every cut).
- **Sound design**: `car interior` ambience; **mic mishaps** (`sounddesign.mic_flaws`: hand over the mic = muffled and quieter with scrapes, cloth brushes, wind buffeting, overload distortion); `crowd` layers (overlapping voice recordings placed at times with gains); `ambience_fade` (the road roar dies with the engine). The mix is normalised to ~-22 dBFS RMS, so any loudness climb must be applied after it.
- **Chaos cut** (`chaos_cut.py`, `ChaosCutPanel.jsx`, `chaosCut.js`; routes `/api/tools/chaos_analyze|chaos_plan|chaos_cut`; Cut & Render step): finds each clip's glitch tail (the video model sometimes invents a new scene in its last second; detected from thumbnail differences with brightness removed, glitches spike 0.4-0.9 vs <0.17 clean), finds spoken lines with speech recognition and trims AROUND them, shortens shots toward the climax (pace relaxed/fast/very fast), balances each shot's loudness, escalates chaos, lays overlapping family voice beds (calm -> uneasy -> alarm -> screaming), applies mic mishaps, builds the level to the climax, and renders N random audio takes keeping the one with no mid-build level drops. Editable plan table (in/out/chaos/gain per shot) before building. Voice beds are generated in-app (six H3 clips at 0.12 MP, only their audio is used).
- **H3 LoRA picker** (Scene detail > Advanced; `build_h3_graph(loras=...)` via `LoraLoaderModelOnly`; "Use these on every clip" default). Verified the LoRA changes output (same seed, very different clip).
- **Re-roll until the line is heard** (Produce step): regenerates a clip until speech recognition hears its quoted line (max 5 tries; every take stays in the gallery). The video model only sometimes speaks an off-screen line.
- **Crash fixes this session**: `JobsPanel.jsx` (black screen when `/api/queue` returned an error body) + `PanelBoundary.jsx`; backend websocket keepalive (`ping_interval=None`) so long H3 jobs are not killed by "1011 keepalive ping timeout".
- **Known limits**: the video model cannot reliably speak screamed/off-screen lines (retry or reuse a good take's audio, `plan.segments[].audio_clip`); speech recognition cannot transcribe screaming, so crowd chaos is checked by level, not words; AI voices are the weakest part (a separate TTS/voice-actor pass would help).
- **UGC vlog genre + Vlog style** (2026-10-19, later): `ugc_vlog` genre (ordinary apartment, filmer only seen as a hand/foot, one small thing moves by itself, dry voice-over) with the brighter `ugc` footage look; Chaos cut **Style = Vlog** (calm chaos, relaxed pace, no crowd, room tone). Built from the user's reference "haunted apartment" TikToks.
- **Narration**: each shot's `[VOICEOVER]` line is spoken by Chatterbox in a chosen voice (picker + audio preview in the Chaos cut panel; `synth_line()` in chaos_cut.py) and laid over the cut, spilling across cuts like a real vlog; the GPU is released afterwards.
- **On-screen text**: `[TEXT ON SCREEN]` lines become captions (white bold text on a black rounded box) or, with a `reply:` prefix, a generic "Reply to a comment" bubble (`caption_png`/`burn_captions`, Pillow + ffmpeg overlay, applied after the look so text stays sharp). No TikTok/Wyze logos or handles by design.
- **Continuity reference ("Same room as")** per shot (`scene.refSceneId`, Produce step): the other shot's still is passed to Flux 3 as a reference so the same room, lamp and props come back; a missing reference shot is made first. A reference that is too strong copies the shot (fix: use another shot, e.g. the fallen-lamp shot, as the reference). **Redo picture** button per shot.
- **Planner fixes**: a model glitch is never searched for in the first 40% of a clip (whip-pans/falls are filmed action); `payoff` beats keep their full length (up to 4.4 s); chaos 0 = locked-off camera (no shake).
- **Locked-off shots**: the genre's handheld motion wording gets appended to every motion prompt and fights "the camera never moves"; for a static event shot, replace the whole motion prompt with strict wording (camera never moves/pans/tilts, view stays the same).
- **Save output** (`/api/tools/save_output`): every chaos cut is also written to `Desktop\Hoodsfield_Output\`.
- **Browser gotcha**: the autosave lives in IndexedDB per ORIGIN and has ONE `latest` slot. Two windows on `http://localhost:8000` overwrite each other's autosave; use `http://127.0.0.1:8000` for a second session (separate storage).
- **Doorbell cam video + Fixed-camera style** (2026-10-19, later): Chaos cut **Style = Fixed camera** (doorbell / security cam: chaos 0, no shake, quiet, timestamps, no narration). New `doorbellcam` look in footage.py (no extra lens distortion, no zoom, 15 fps, mild compression). Caption syntax: several overlays per shot separated by `||`, each plain, `reply:` (comment bubble with the generated commenter photo) or `stamp:` (small corner timestamp, like a camera app). Doorbell genre rules now forbid any visible face (silhouettes, edge-of-frame figures, a coat filling the lens).
- **Per-clip looks are no longer baked in for `tiktok` / `ugc` / `doorbell` genres** (`ONCE_LOOKS` in App.jsx): the look is applied once to the finished cut. Before this, a clip generated under the doorbell genre already carried the doorbell look + date stamp + "MOTION DETECTED", and the Chaos cut applied a second look on top (double stamps, dark crop). Clips generated before this change still have the old look baked in: build from the raw clips in `ComfyUI/output/vsa/h3/` (see door_build.py approach: POST /api/tools/chaos_cut with raw clips) or regenerate them.
- **Lessons**: the shake zoom crops the frame even at chaos 0 unless the plan's shake is `none` (Fixed camera sets it); the glitch detector can mistake a deliberate porch-light flicker for a glitch (set the shot's `out` by hand); strict wording per shot ("no other person appears", "the camera never moves") is needed because the video model adds walkers and moves the camera.
- **Nursery cam + trail cam videos and the escalation rule** (2026-10-19, late): the user called the doorbell video "boring, didn't build up, didn't scare", so every scare video is now scripted as an escalation ladder: calm hook -> tiny wrongness -> plainly happening -> faster/second thing -> everything stops and something that was not there is now there -> payoff (it turns to / reaches for the camera). New genres `monitor_cam` (baby monitor / pet cam, look `babycam`) and `trail_cam` (look `trailcam`), both encoding that ladder in their director rules; new caption style `strip:` (a trail camera's black data bar along the bottom edge); Chaos cut option "Jump-scare sting at (seconds)" (`plan.scare_at`) puts a swell + held silence + hit on the payoff. Verified escalation numerically (frame-difference energy in the chair area rose 0.001 -> 0.005 -> 0.007 -> 0.010 across the nursery shots). Outputs: `the_nursery_v1.mp4`, `the_trailcam_v1.mp4`.
- **Faces**: the horror here never shows a face (silhouette with blank head + two IR eye-reflection dots; a pale featureless figure far down a trail; a huge pale hand; a coat filling the lens). Strict wording per shot ("no other person appears", "the camera never moves") is what keeps the video model from adding strangers or moving the camera.
- **Hand-built reference**: the locked test video and its assembly script are in `Desktop\Hoodsfield_Output\THE_DRIVE_HOME_1986_FINAL_LOCKED.mp4` / `..._recipe_assemble_chaos_cut.py`.

---

## 2026-10-17 (night) — Job core, drafts, long shots, motion control, lip-sync, timeline

**Hardware finding:** the GPU sits on a PCIe x1 link, so Wan/LTX cost is dominated by streaming weights, not resolution. Drafts therefore cut *models*, not pixels.
- **Job core** (`jobs.py`, `jobs_routes.py`): every generation is recorded in SQLite (`VSA_WORK_DIR/jobs.sqlite`) with live progress, thumbs, a family-aware queue view and composite jobs (`CompositeJob`) behind one id. **Jobs panel** in the rail; `/api/jobs`, `/api/queue`.
- **Draft -> finalize:** Wan draft = high-noise expert only ("motion preview", ~44 s warm vs ~400 s) plus "Render full quality · same seed"; H3 drafts finalize via ESRGAN (+RIFE) in one graph (`/api/tools/finalize`, ~51 s).
- **Long shots** (`/api/wan/long`): Ollama beat plan, segments chained by last-frame hand-off with an identity anchor, ffmpeg concat. *Not yet verified live.*
- **Motion control** (`ltx_routes.py`): LTX 2.3 Union-Control IC-LoRA with canny structure from a reference video. Verified (knight / harbour). Pose/depth models are not installed.
- **Lip-sync / Talk page:** LTX audio-to-video with a frozen-audio mask (first version had weak sync; fixed below with a lead-in). DubIt IC-LoRA (HF-gated) would be a further upgrade but is no longer needed for usable sync.
- **Timeline editor** (`timeline.js`, `TimelineEditor.jsx`, `timeline_routes.py`): multi-track (video, overlay, text, audio), split/trim/speed/ripple/snap, auto dissolve on overlap, captions, audio mix, colour look, ffmpeg export. Model tests: `node src/timeline.test.mjs`. Browser-verified: add clips, overlap -> 0.5 s dissolve, text, export to Gallery.

- **Auto-QA** (`qa_routes.py`, Scene editor "🔍 Check quality"): instant heuristics (black / frozen / blurry / flicker / jump cuts / chaos) on a decoded 6 fps sample, scored 0-100 (verified on synthetic black, frozen and blurred clips and real renders), optional "+ AI review" with local Qwen-VL (works but ~7 min while ComfyUI holds the GPU, so opt-in). `/api/qa/rank` ranks several takes (best-of-N).
- **Model manager** (`models_routes.py`, `ModelManager.jsx`, menu → 🧰 Model manager): per-feature manifest (Flux 3, Wan, LTX, H3, tools) showing installed files + sizes, disk free on C:/D:, and links for missing/gated models (DubIt needs the HF licence accepted).
- **Packaging (first pass):** the backend serves `frontend/dist` on :8000 when it exists, and `Start_Hoodsfield.bat` launches ComfyUI + studio + browser. No installer yet.

- **Long-shot colour drift fixed:** segment 2 of the first live long shot had drifted to mean RGB ~(167,161,175) vs (117,118,124) for segment 1. Each segment is now pulled back to segment 0's per-channel mean/contrast (`match_colour`, `wan_routes.py`) *before* its last frame becomes the next segment's start, so drift can't compound. Live re-test: segment-2 brightness 165 -> 121 (reference 120); chroma creep (saturation 29 vs 19.5) is now also scaled back (`match_colour` returns mean, contrast, saturation; verified on the real segments: 29.0 -> 18.1). Within-segment end-of-clip oversharpening is not addressed.
- **Job-queue batching:** `POST /api/queue/optimize` regroups ComfyUI's pending prompts by model family (running family first) by re-submitting with the same prompt_id/client_id; `POST /api/queue/prioritize` moves one job to the front. Jobs panel: "⇅ Group by model" and a ▲ per pending chip. Verified live (flux, tools, flux, tools, flux -> flux, flux, tools, tools; all finished).
- **Timeline banner clip:** `make_showcase.py --only timeline` renders an animated multi-track editor (playhead sweep, dissolve, caption, audio waveform) -> `showcase/timeline.mp4/.jpg`.
- **Lip-sync fixed (measured):** the earlier "weak sync" reading was partly a measuring error (lag window too narrow) but mostly real: contact sheets showed the mouth stayed shut for the first ~0.4 s because clip frame 0 is the closed-mouth still. `/api/lipsync` now pads the speech with a silent lead-in (`lead_seconds`, default 0.6), renders at 25 fps (the template's conditioning rate), trims the lead-in off and muxes the *original* voice. Same face/audio: mouth-motion vs speech r=0.22 @250 ms lag -> r=0.64 @42 ms (shuffled-audio 95th pct 0.17); output audio is exact (r=1.00). It is now a composite job (`video-lipsync`).

- **Lip-sync Studio banner:** real clip (`tools/assets/lipsync_src.mp4`, an actual `/api/lipsync` result) beside the animated voice waveform; `make_showcase.py --only lipsync`.

- **Explore & remix page** (`Explore.jsx`, `explore.css`, rail 🧭 Explore + menu): masonry wall of every finished render (thumbs, hover-to-play video, engine-coloured glow) plus 8 starter recipes built from the showcase clips; search + filters (Everything / My renders / Recipes / Videos / Images). Click opens a remix sheet: big player, editable prompt with one-tap style chips, **✦ Generate my own from this** (new prompt-first scene on the board), and hand-offs: Animate still, Edit, Make it talk, Restyle (Genjutsu), Add to timeline, Download. Browser-verified: grid, sheet, chip + generate, image -> timeline bin.
- **Browser-tested this session:** Jobs panel (history + thumbs), Lip-sync page (face + speech in -> talking clip with audio, 2 s clip end to end), Genjutsu "Structure lock" (motion control: knight clip -> samurai, structure kept), scene Quality-check card (100/100 on a clean clip), model manager, timeline, Explore. Fix found while testing: IC-LoRA jobs were labelled "LTX video" instead of "Motion control" (`jobs.classify`).

- **Genjutsu Restyle rebuilt: 33 looks in 6 groups** (`videoLooks.js`): Anime (cel, Ghibli, Shinkai sky, 90s retro, cyberpunk, manga B&W), 3D & toys (Pixar, claymation, LEGO, low-poly, felt, voxel), Painted (oil, watercolor, Arcane-style painterly 3D, ukiyo-e, storybook gouache, impressionist), Drawn & graphic (comic, Spider-Verse, rotoscope, pencil, pixel art, blueprint), Film & retro (noir, Wes Anderson, VHS, synthwave, Technicolor), Crafts (paper cutout, stained glass, embroidery, origami, marble & gold). Each look carries its own Flux 3 first-frame instruction and video prompt naming the *medium* (the old one-line presets left the footage's photographic look in place, hence the weak anime). New **Bold** engine (default): the first frame is redrawn by Flux 3 Edit, then LTX Union-Control IC-LoRA rebuilds the clip from its edges/motion only; **Gentle** keeps the old blend. Live test, photoreal fisherman clip -> Anime (cel) Bold: clean ink lines, flat cel shading, painted sky, stable across frames, motion preserved. Other looks are written but not individually rendered yet.
- **MOSS-Image evaluated and removed** at the user's request (about 5x slower than Flux 3 per image: 50 steps at CFG 3 vs 8 steps at CFG 1). Node pack, weights and clone deleted.

- **Hoodsfield Originals (Explore):** three 19 s 9:16 short films made end to end locally by `tools/make_films.py` (Flux 3 stills -> Wan 2.2 4 s clips -> Real-ESRGAN 2x -> ffmpeg edit with dissolves, grade, vignette, grain, burned-in captions, title card, Stable Audio Open score): LIGHTS OVER MARFA (UFO), DON'T LOOK BEHIND YOU (horror), LAST TRAIN (drama). Explore has a hero carousel with phone-frame playback, "Watch & explore" sheet (shot-by-shot prompts, producer notes, score prompt) and "Remix this shot" / "Make my own version". Known weak spots: the close-up face in the hallway film and a stray object in the first train shot.
- **Voiceover (Chatterbox, MIT, local):** new Voice page + `/api/tts/*`. The engine lives in its own env (`D:\vsa_voice\cb`, torch 2.6 cu124) and runs as a small server (`voice/voice_server.py`) that auto-unloads from VRAM after 5 idle minutes. 86 reference voices from the old Shorts Generator app, plus upload/record. Spells out times/years/numbers. Verified on GPU (about 70 s including model load). XTTS v2 was tried first and rejected by ear (whispy). Chatterbox embeds an inaudible watermark.
- **Cinema skin (from the Google Stitch redesign):** `cinema.css` + local Space Grotesk/Geist fonts, line-icon rail, obsidian glass surfaces, cyan/violet/magenta accents, status pills, gradient-hairline modals. Theme "Cinema (cyan + violet)" is the new default; other themes still selectable.

- **Cinema skin v2 (page refinements):** found a CSS cascade-order bug (cinema.css loaded before home.css, so many overrides silently lost); now imported last in main.jsx. Genjutsu: monitor frame with file/resolution/duration chips, sectioned panel with badge sliders, Stylization-rigor cards, sticky footer with time estimate. Timeline: labelled bin tabs, media cards, Cinema-monitor bar, colour-dotted tracks, circular transport, gradient export. Character Studio: cast pill strip, turnaround cards, docked inspector. Screenshots in ui_screenshots_v3.

- **Cinema skin v2, remaining pages:** Image studio, Edit studio, Video lab and Lip-sync now use the same docked inspector (header badge, scrolling body, sticky gradient action footer). Ad Studio rebuilt to the Stitch layout: URL + upload bar, parameters card, format archetype cards, storyboard-flow list with total length, and a Directing inspector (aspect tiles, summary, create button). Screenshots in ui_screenshots_v3.

- **Cinema skin v2, Board + scene editor:** empty state rebuilt (pill, big title, five template cards with tags, tip), workspace HUD (nodes, x/y, zoom), glass node scene cards with gradient edges, floating gallery dock, scene editor lightbox with gradient border, segmented Still/Video tabs and cyan section headings.

- **Cinema skin v2, Jobs / Model manager / wizards / shot strip:** Jobs gets a luminous header, status pills and a prominent glowing Running-now card; Model manager gets drive meters and a framed feature list; the Music Video and TikTok wizards get a connected stepper and gradient-edge panel; the shot strip gets cyan selection and glass rows.

- **Genjutsu character swap fixed with a real face swap:** a text-driven image edit only blends in a reference face (blonde clip + brunette reference scored 34% ArcFace match, baseline between the two women is 29%, i.e. no transfer). Motion transfer with a reference now runs InSwapper (insightface, CPU, `face_swap.py`, `/api/face/swap`) on the clip's first frame, then a Flux 3 pass restores skin detail, and the result is verified with an ArcFace match (`/api/face/match`): blonde -> brunette now scores 72%. Takes are deterministic per input, with a take picker and a 'New take' re-roll. Redundant 'replace the woman…' text no longer goes into the image prompt. Not yet verified: the full video render from a swapped first frame; hair/outfit stay those of the source clip.

- **Explore tile menu:** every tile has a ⋯ menu (and the detail sheet a button): *Remove from Explore* hides it (saved in the browser, a Hidden chip lets you restore it); *Delete from history* (your own renders) forgets the job in Jobs too, the file stays on disk.

- **Qwen Image 2.1 integrated** (`qwen21.py`, `qwen_routes.py`, Image studio engine switch): text-to-image and multi-reference editing with the installed `qwen_image_2.1_int8_convrot` + `qwen3vl_8b_fp8_scaled` + `qwen_image_2.1_vae_bf16` (ComfyUI core nodes `TextEncodeQwenImage21`, `QwenImage21Cache`; euler/simple, 25 steps, CFG 1). Verified: text-to-image 1024x1024 in 138 s cold; reference edit (blonde -> short dark bob, face kept) in 45 s warm. Qwen LoRAs from the 'Qwen Image 2.1' folder are listed when the engine is selected. Turbo and the prompt-rewrite encoders from the templates are not installed, so not wired.

---

## 2026-10-18
- **Scene Composer** (new page): block a shot in 3D, then generate an image that obeys the blocking. A depth render of the layout drives
  Qwen Image 2.1 + Fun-Controlnet-Union (`/api/scene/generate`). Photo -> 3D: Depth Anything 3 (depth), MoGe (field of view) and
  Florence-2 (objects/faces) rebuild a photo as an editable scene (`/api/scene/analyze`), so the loop is photo -> 3D -> tweak -> regenerate.
- Posable figures (Poser-style): 17 joints with realistic limits (toggle), fingers + hand poses, face for readable facing direction,
  drag-a-wrist/ankle IK with hinge-exact elbows/knees, 14 poses, mirror, face-camera / look-at-lens, height/width/build.
- Scene Composer v2: parametric male/female bodies (lofted torso, lathe limbs, hair styles) with Poser-style anatomy sliders (bust, waist,
  hips, glutes, thighs, calves, arms, neck, head, muscle) that change the depth silhouette AND are described to the model in words.
- Stage directions ("a tall woman crouches behind a seated man, pointing at him"): positions, poses, aims and frames the cast. Uses a local
  LLM via Ollama when running (`/api/scene/direct`), else a built-in parser. Auto-adds chairs for seated people, auto-frames the camera.
- Scene Composer v3: sculpted Poser-style heads (soft nose/lips/chin, thin brows, scalp-shell hair), seamless lofted torsos, skin-tone bodies;
  real furniture (couch, armchair, chair, bench, stool, bed, table) with proper seat/back/arm heights; people sit on it (pelvis on cushion, back
  to backrest, feet on floor, shared couches); arm/leg actions ("arm along the back of the couch", "right leg stretched out on the couch",
  "foot up", "ankle over knee") from text or dropdowns; Look/Setting presets; layout lock releases at 70% so real detail can form.
- **Genres / niches** (top bar selector): Cinematic, Found-footage horror, Body cam, Security camera, Doorbell cam, VHS / analog horror, Night vision,
  Phone / UGC. A genre sets the still-image look, the video camera behaviour, the AI writer/director's rules (TikTok + music-video scripts), the soundscape
  and the finishing camera look. Raw-footage genres strip cinematic vocabulary from every prompt.
- **Found-footage camera look** (Video Lab -> Look, `op=footage`, `backend/footage.py`): handheld shake (to "Blair Witch"), focus hunting, exposure hunting, low-res + tape
  wear, grain, vignette, lens distortion, scan lines, chroma bleed, glitches, REC / timecode / date overlays, cheap-mic audio with room tone and wind.
  Auto-applies to finished clips when the genre has a camera look.
- **Found-footage sound design** (Video Lab -> Sound, `/api/tools/sound`, `backend/sounddesign.py`): ambience beds (local Stable Audio Open: forest/city/lake/basement; or synthesised wind, room tone,
  house, hospital), a creeping drone with distant knocks and creaks, operator breathing and footsteps, mic bumps placed on the camera's real jolts (measured from the video with phase correlation),
  a jump scare with a swell and a silent beat, and a cheap-microphone chain. Genre auto-finish: the camera look and the sound design run on every finished clip.
- **Fix: TikTok final render was muting every clip** (`clipGain: 0`): voices and the genre sound design were dropped and the file had no audio track. Clip audio is now on by default with a control.
- **Scare design**: "How scary?" (subtle / creepy / terrifying) adds an escalation arc to the writer; `genres.ensure_scare` guarantees an escalating, visible unsettling detail in the stills of shots 2..n
  (image models only draw what the prompt names); per-shot "😱 Scarier" (`/api/story/scarify`); soundtrack generator (`/api/tools/score`, Stable Audio) and "add scares and sound to the finished video".
- **Story Room** (TikTok wizard step 1 + "Make a video"): an in-app producer/screenwriter chat that writes the shot list straight into the Script step. Engine: local Ollama. Richer script format ([STILL]/[MOTION]/[DIALOGUE]/[CHARACTERS]/[SFX]/[BEAT]) and a script inbox.
- Edit Studio character swap now runs InSwapper (exact identity) on the chosen face (paint a mask or say left/right/all), then a detail pass.
- Shared `GenProgress` bar (percent, step x/y, elapsed, ETA, cancel) across every generation panel; reference-image drag-to-prompt tagging.

## 2026-10-17 (evening) — Renamed to **Hoodsfield**, neon theme system

The app is now **Hoodsfield** (wordmark, window title, README/CHANGELOG, backend title, MCP server key `hoodsfield`; the project folder and `.vstudio` extension are unchanged).
New palette: **Neon Cyan** (`#14e8ff` → electric blue) with a cyan → violet → magenta headline, dark ink on accent-filled buttons. Everything now reads CSS variables
(`--accent`, `--accent2`, `--accent-rgb`, `--accent-ink`), and **View → Theme** switches between Neon Cyan, Electric Violet, Hot Magenta, Neon Mint, Laser Blue and the
old Glowstick Orange (saved in localStorage; definitions in `THEMES`, `features.js`). The Storyboard and Agent / MCP cards now have real banner clips too (`board`: a pan across a canvas of numbered scene cards; `mcp`: an animated agent session) — both composed from existing stills, no GPU needed (`make_showcase.py --only board,mcp`). Also fixed a README escape glitch in the MCP command. Dev-server note: Vite did not notice file
changes inside this OneDrive folder once — restart `npm run dev` if CSS looks stale (and make sure only one Vite is running).

---

## 2026-10-17 (later) — Wan 2.2 engine, Genjutsu guide-hold, and the v2 interface

**Wan 2.2 as the third video engine** (`wan_routes.py`, `WanOptions.jsx`): `/api/generate_wan` runs the two-expert A14B pipeline (high-noise expert for the
first half of the steps, low-noise expert for the rest) on the installed Q6_K GGUFs with the Lightning 4-step LoRAs. Image-to-video, **first/last frame** and
**text-to-video** are all verified (3 s clip ≈ 6.5 min cold, ≈ 4.5 min warm at 0.3 MP; T2V fox clip 263 s; first/last clip opens and lands exactly on the two
stills). Optional RIFE ×2 smoothing (16 → 32 fps), user LoRA pairs auto-matched high/low (`pairWanLoras`), and `/api/wan/enhance_prompt` (Ollama rewrites a rough
idea into Wan's subject + scene + motion + camera + light structure; verified). Wan is silent. Scene editor → Engine → "Wan 2.2".

**Genjutsu:** new `guide_hold` (default 8 frames, UI slider "New-look hold"): the first N source frames are replaced by the edited guide frame before encoding, so
the swap persists beyond a single latent frame (the first version snapped back to the source layout almost immediately).

**Interface v2** (the app now opens on **Home**): Higgsfield-style banner cards whose looping clips are generated by the studio itself
(`tools/make_showcase.py` → `frontend/public/showcase/*.mp4`), persistent left **nav rail** (Home · Image · Edit · Cast · Genjutsu · Lab · Ads · Board),
a cinematic **tool header banner** on every tool, a real **Flux stage** (large results, prompt-idea cards, animate-to-board), drag-and-drop **DropZone** empty
states, an actionable empty Board, and an **Agent / MCP** page that shows the exact command for this machine (`/api/mcp/info`). Files: `features.js` (single
catalogue), `Home.jsx`, `NavRail.jsx`, `ToolBanner.jsx`, `BannerVideo.jsx`, `DropZone.jsx`, `McpPage.jsx`, `home.css`.
**Verified (same day):** Wan first/last-frame, text-to-video, prompt enhancer (UI + API) and LoRA pairing (all 7 installed Wan pairs match); **Genjutsu through the real UI**
(drop clip → Object swap → "Preview first frame" → Transform with keep-original-audio): the red beanie persisted at 1.4 s of a 2.7 s result, i.e. well past the first frame, and the
result carried an audio track (mux works). Showcase banners total 3.3 MB (`frontend/public/showcase`).
To rebuild the banners: `backend\.venv\Scripts\python.exe tools\make_showcase.py [--only hero,flux,...] [--force]` (~40 min, backend + ComfyUI running).

---

## 2026-10-17 — Flux 3 integration + Higgsfield-parity toolbox (open rebuild for the Comfy contest)

**Why:** Flux 3 Klein (open weights, already on disk) renders 1024² in ~5 s on this GPU, and Comfy is running a
"rebuild Higgsfield" contest (Genjutsu + Cinema Studio named). This session made Flux 3 the default image engine and
added the Higgsfield feature set — locally, no APIs. Pre-change backup: `Documents\VSA_backups\Video_Studio_AI_pre-flux3_20261017.tar.gz`.

**Backend (new files):**
- `flux3.py` / `flux3_routes.py` — `/api/flux3/models`, `/api/flux3/upsample` (BFL Qwen3.5-9B prompt upsampler), `/api/generate_flux3`
  (text-to-image, N reference images via `ReferenceLatent`, LoRAs, face-swap, **brush-mask inpaint** composited onto the original so pixels outside
  the mask are bit-identical). Recipe: UNETLoader `flux3_image_klein_sd_int8_convrot`, CLIPLoader type `flux3`, VAE `flux3_klein_ae`,
  Flux2Scheduler 8 steps, CFGGuider cfg 1. **`flux-3-klein-base-fp8r` renders solid black on this ComfyUI** (loader reports unexpected `weight_scale` keys) — unused.
- `tools_routes.py` — `/api/tools/upscale` (Real-ESRGAN, fp16, ~1.4 s/frame), `/interpolate` (RIFE 4.9, smooth fps or slow-mo), `/remove_bg` (BiRefNet: alpha PNG, or video on
  solid/green screen), `/ffmpeg` (reverse, speed, boomerang, loop, trim, reframe w/ blurred fill, first/last frame, mute, GIF, mux_audio), `/models`.
- `genjutsu_routes.py` — `/api/genjutsu` video-to-video: source clip → LTX 2.3 latent, partial denoise (`SplitSigmasDenoise`), latent frame 0 pinned to a Flux-edited guide frame, stage 1 only.
- `mcp_server.py` + `cinema_library.json` — stdio MCP server exposing the studio to any agent (generate/edit image, character views, upscale, cutout, interpolate, ffmpeg ops, image-to-video, Genjutsu, libraries).
- Fixed the legacy LTX 2.3 template: `LTXVSpatioTemporalTiledVAEDecode` no longer exists → core `VAEDecodeTiled` (backup `ltx23_i2v_workflow.json.bak-pre-vaedecodetiled`).
- `.env`: `VSA_WORK_DIR=D:sa_work` (C: is ~99% full), `COMFY_ROOT=D:\ComfyUI-LTX2` (videos are handed to ComfyUI by absolute path).
- Models downloaded to `D:\ComfyUI-LTX2\models`: `background_removal/birefnet.safetensors` (MIT), `upscale_models/RealESRGAN_x4plus(.pth)` + `_anime_6B` (BSD).

**Frontend (new):** `cinema.js` (Cinema rig data: 14 camera bodies, 12 lenses, focal/aperture, film looks, lighting, HEX palettes; **80 camera moves; 33 one-click effects**),
`Flux3Panel` (+`CinemaRig`), `EditStudio` + `editTools.js` (16 tools: free edit, brush inpaint, remove object, relight, grade, try-on, product placement, background, character swap,
30 mixed-media styles, headshot, skin, expression/age, restore/colorize, new angle, effects), `CharacterStudio` (Soul-ID equivalent: one photo → turnaround / full-body / expression sheets;
scenes cast with a character send the photo + 2 views as references), `VideoLab`, `GenjutsuStudio` (motion transfer · object swap · restyle), `MotionPicker` in the scene editor,
Engine menu (scene stills: Flux 3 default / Krea 2), Flux 3 backend in the Sketch pad, "Extend clip" (last frame → next scene), Gallery 🪄/🧰/🌀 shortcuts, Flux settings saved in `.vstudio`.

**Also added:** `ads_routes.py` + `AdStudio` + `adTemplates.js` (**Ad Studio**, the local Click-to-Ad: product link → scraped title/description/photos → UGC / unboxing / hero / how-to storyboard of
scenes on the board, product photo fed to Flux 3 as a reference; SSRF-guarded — loopback/private hosts refused), `smoke_test.py` (run after any ComfyUI update), staged-upload pruning.

**Verified live:** Flux generate + 2-variant batch with Cinema rig through the real UI; reference edit; brush inpaint through the UI (only masked pixels changed); character sheet identity across profile/back/full-body;
upscale (image + video), RIFE 30→60 fps with audio, BiRefNet cutout (alpha + green screen), ffmpeg ops; MCP protocol handshake + catalogue tools; **Genjutsu restyle** end-to-end (3 s clip → claymation via
Flux-edited first frame + LTX V2V at 80% freedom: layout, camera push and character path preserved, ~5 min incl. model load); **Ad Studio** end-to-end through the UI (Allbirds URL → 5-scene UGC storyboard → Flux 3 still of a person holding the real product); `smoke_test.py` all pass.

**Follow-up (same day):** `/api/tools/face_swap` + Video Lab "Face swap" (ReActor on every frame of a video or a still; faces pinned left→right). ReActor v0.6.2 loads fine on this ComfyUI — the old
numpy-ABI note no longer applies; image swap verified visually, video swap ran to completion. **Genjutsu motion transfer** verified end-to-end through the MCP `genjutsu` tool (a woman in a red jacket replaces the
plumber in a 3 s mushroom-world clip; same path + camera push; 318 s incl. model load). Character Studio verified through the UI (create from prompt → turnaround view). Mask-inpaint also covered by `smoke_test.py`.

**Known gaps / next:** Lip-sync studio for arbitrary audio, Wan 2.2 as a third video engine, Ad Studio scripts are template-driven (no LLM
rewrite yet — Ollama was offline), Video Lab / Genjutsu / Edit Studio screens were exercised via API + DOM checks (browser screenshots were intermittently blocked by a Chrome extension error).

---

## 2026-09-07 (session 3) — Automated fix for the multi-panel "cut to" still bug found last session

**Context:** picking up from session 2 below — that session found the real cause of some TikTok-wizard stills
containing multiple scenes/panels in one image (a pasted `[VISUAL]` block describing more than one moment via
a screenplay-style `Cut to:` transition) and fixed the *symptom* (the ⧉ split button's `ttIndex` ordering) but
never added anything to catch the *cause* automatically — a user still had to notice a bad render and manually
split the shot by hand. Session 2's in-progress manual split-editing was never saved (lived only in React
state, browser tab closed) — this session started fresh, so nothing from that in-progress edit was recovered
or needed to be; the fix below makes that manual workaround unnecessary for any future paste-import.

**Fix, in `app/backend/story.py`:** added `_CUT_MARKER_RE`/`_split_on_cut_markers`/`_split_multi_moment_shots`,
wired into `parse_pasted_script` right after the raw `## SHOT N` blocks are parsed and before `normalize_script`
runs. Any shot whose `[VISUAL]` text contains a `(then/we/now/smash/match) cut(s) to` transition is now split
into separate consecutive shots at each transition automatically — duration divided evenly between them,
titles suffixed `(cont.)`, SFX/narration carried to both halves. A human-readable summary ("Split \"X\" into N
shots — its [VISUAL] described more than one moment...") is surfaced through the existing `result["warning"]`
field, which `TikTokPanel.jsx`'s already-existing `.pt-warn` hint renders — no frontend changes needed. The
LLM-written path (`write_script`/`normalize_script`) was already protected by an explicit "CRITICAL" instruction
in `story._SYSTEM` added previously; this closes the one remaining gap, which was specifically the no-LLM
pasted-script import path. Deliberately narrow (only the literal "cut to" phrase, not "meanwhile"/"later"/etc.)
to avoid false-split of shots that are narratively multi-beat but visually one continuous frame — session 2
noted shot 7 ("The Escape") read as multi-beat in voiceover but rendered clean as a single shot, so an overly
broad trigger would have wrongly split it too.

**Verified:** direct Python call against a synthetic shot mirroring session 2's real "Footsteps Upstairs" text
correctly split into a basement half and an upstairs half, each with clean single-moment `stillPrompt`/
`motionPrompt` and no leftover "Cut to" text; the untouched single-moment "The Night Call"-style shot passed
through unchanged. Then live end-to-end through the real running app (restarted the backend — it was running
`main.py` directly with no `--reload`, so the code edit needed a manual restart to take effect): pasted a
2-shot test script with one `Cut to:` shot into Create → TikTok Video → Script → paste box in the actual
browser UI, clicked "Parse pasted script", confirmed the UI showed "Imported script — 3 scenes" with the split
warning banner, and the resulting 3 scene cards (Footsteps Upstairs / Footsteps Upstairs (cont.) / The Night
Call) each had correct clean prompts and durations. Did not run an actual Krea 2 generation to visually confirm
no contact-sheet image (root cause is the literal prompt text, which is directly and verifiably fixed — the
offending "cut to" text is simply no longer present in any single still_prompt).

---

## 2026-09-07 (session 2) — First real TikTok production run; found + fixed a scene-ordering bug; session paused mid-fix, NOT SAVED

**Context:** ran the user's real script (`%USERPROFILE%\Downloads\haunted-house-next-door-SCRIPT.md`, 8 shots,
horror/realtor POV) through the TikTok wizard end-to-end in the live browser: paste-import → parsed correctly
(8 scenes, style captured) → Produce ▶ Everything → all 8 stills + all 8 H3 clips generated successfully
(~40 min). Cool Teal Horror grade selected on Cut & Render (matches the script's own `[COLOR GRADE]` spec).
**Final video was NOT yet rendered** — see below.

**Real bug found by the user, watching the clips:** shots 3 (Footsteps Upstairs) and 4 (The Night Call) each
had a mid-prompt `Cut to …` describing a second, unrelated moment in the same `[VISUAL]` block. Krea 2 rendered
these as a multi-panel *comic-strip* still (2-3 stacked frames in one image) instead of one frozen moment, and
H3 then animated that composite — so the clip visibly jump-cuts between unrelated scenes instead of playing as
one continuous theatrical shot. Confirmed by zooming the board thumbnails; shot 7 (The Escape) also *reads* as
multi-beat in the voiceover but rendered as a single clean continuous frame, so it did **not** need splitting —
this is a per-shot judgment call, not "always split shots with cut to")

**Real product bug found + fixed in `app/frontend/src/App.jsx` (`tkScenesToBoard`):** the existing "split this
shot in two" (⧉) button in the Script-step scene editor (built last session — see 2026-09-06 entry below)
duplicates a shot so you can trim each half separately, but `ttIndex` (the field that decides final render
order) was assigned by a running *count* of scenes at click-time, not by the shot's position in
`tk.script.scenes`. That means the split button only ever produced a correct result if used *before* the
scenes were first added to the board — the *only* time you'd actually notice a multi-cut shot needs splitting
is *after* watching the generated clip, i.e. always after the scenes are already on the board. Used that way
(as done this session), the new half got appended to the very end of the story instead of inserted where it
belongs. **Fix:** `tkScenesToBoard` now derives `ttIndex` from each entry's index in the `tk.script.scenes`
array (which is already in the right order — duplicate() inserts right after the original) and resyncs
`ttIndex` on every already-placed tk scene to match, every time "Add scenes to board" runs. This means editing
+ duplicating a shot that's already on the board now correctly reorders everything, so it does *not* require
deleting/regenerating the unaffected later scenes (Unplugged System / Message / Escape / Aftermath) — a much
cheaper fix than the ~40 extra minutes of GPU time a full-regeneration workaround would have cost. **Fix is
unverified live** — read carefully but the click needed to test it (see blocker below) never happened this
session.

**In-progress edit state when the session paused (all live in React state only, see SAVE WARNING below):**
- Scene 3 "Footsteps Upstairs": edited in place, still/motion prompt trimmed to just the basement-descent
  beat ("Interior POV descending into a dim unfinished basement, hand reaching for a light switch. Suddenly
  the ceiling above creaks — dust drifts down. Handheld, urgent, unsettling. Realistic. [color grade
  sentence] [no-overlay clause] [realism clause]"), still/clip **not yet regenerated** for this new prompt.
- That scene was duplicated (⧉) and the copy's still/motion prompt set to the "rushing upstairs" beat ("POV
  rushing up a staircase into an empty, sunlit living room. Camera whips left and right: nobody there. Doors
  open to empty bedrooms. Handheld, urgent, unsettling. Realistic. [color grade sentence] [no-overlay clause]
  [realism clause]") — this duplicate is **not yet added to the board** (still lives only in the Script-step
  local list, "Add N scenes to the board" button pending).
- Scene 4 "The Night Call": edited in place, trimmed to just the phone-on-nightstand beat ("Nighttime. A
  phone lighting up on a nightstand, caller ID unknown, clock reads 9:45 PM. Cinematic realism. [color grade
  sentence] [no-overlay clause] [realism clause]"), still/clip **not yet regenerated**.
- Scene 4 was **not yet duplicated** — still need to: click its ⧉ split button, then set the copy's
  still/motion prompt to the sprinklers-exterior beat: "The same ranch house at night, lawn sprinklers
  spraying hard in the dark, streetlights casting long shadows. Cold blue palette, eerie stillness behind the
  water. Cinematic realism. Streetlight glow stays within the cool palette. [color grade sentence] [no-overlay
  clause] [realism clause]".
- The `[no-overlay clause]`/`[realism clause]` above = `_NO_OVERLAY_CLAUSE`/`_REALISM_CLAUSE` from
  `app/backend/story.py` (lines ~107-116), manually re-appended by hand to every edited prompt above — editing
  the textarea directly bypasses `normalize_script`'s automatic append, which only runs once at parse time.
  Any *further* manual prompt edits in this workflow need the same clauses appended by hand to stay consistent
  with the other (un-split) scenes.

**Exact resume steps, in order:**
1. Reopen the app, `Create → TikTok Video`, `3 · Script` step — confirm the in-progress edits above are still
   there (only true if the browser tab was never closed/refreshed; nothing below was saved to a `.vstudio`
   file this session — see warning).
2. Click The Night Call's ⧉ split button, paste the sprinklers-exterior prompt above into both Still prompt
   and Motion prompt of the new duplicate.
3. Click "+ Add N scenes to the board" (should be "Add 2 scenes" at that point). **Verify the `ttIndex` fix
   actually worked**: go to `5 · Cut & Render` and confirm the list reads Hook, Innocent House, Footsteps
   (basement), Footsteps (upstairs), Night Call (phone), Night Call (sprinklers), Unplugged System, Message,
   Escape, Aftermath — 10 scenes in that exact order. If it's wrong, the `tkScenesToBoard` fix has a bug —
   don't just push through, go fix it (the collision math is spelled out in this session's design discussion,
   not repeated here).
4. Back in `4 · Produce`, "Generate N missing stills" then "Generate N missing clips" (or ▶ Everything) —
   should only regenerate the 4 new/edited scenes, leaving the other 6 already-good clips untouched.
5. `5 · Cut & Render`: Cool Teal Horror grade should already be selected (persists in `tk.cut.look`); click
   "Render final video".
6. **Save the project** (`File → Save`) once happy with the result — this hasn't been done at any point this
   session.

**Blocker that paused the session:** Chrome browser automation (click + screenshot + `javascript_exec`) started
failing mid-session with `Cannot access a chrome-extension:// URL of different extension`, while text-only
tools (read page content, set form/textarea values) kept working — used the latter exclusively for the in-place
edits above. Two Chrome browser instances are connected to the automation account (a macOS one and this
Windows machine); explicitly selecting the Windows one did not clear the error, so it's not a stale-selection
issue — most likely needs the extension restarted or a stray `chrome-extension://` tab/popup closed by hand.

**⚠️ SAVE WARNING:** none of this session's work (the full 8-scene batch render, the in-place edits above, or
the code fix) was saved via `File → Save` — it all lives only in the browser tab's live React state (and the
edited source file, which persists as a normal file). If that tab is closed or reloaded before saving, the
generated stills/clips and the in-progress split-editing all need to be redone from scratch (though the script
paste-import and the full first batch render only take ~40 min to reproduce, faster than debugging further).

---

## 2026-09-06 — TikTok Video wizard (story → script → scenes), new parallel wizard

Second wizard alongside Music Video, for short-form vertical videos: feed it an existing mp4 and/or jpgs
carrying a rough story idea, understand that story (local speech-to-text on any narration + local vision
description of the content), then have an LLM director write a hook-first scene list and produce it
through the same still (Krea 2) → clip (MiniMax H3) pipeline. **No TTS/voiceover generation** — speech-to-
text is for understanding the *input* story only; output relies on H3's own dialogue/lip-sync, same as MV.

### Backend

`whisper_stt.py` (new): local faster-whisper transcription (CPU, `int8` compute type, lazy-loaded singleton
model). `story.py` (new): sibling to `director.py` but writes a **flat, ordered** scene list (no
setups/sections — a short vertical video is one linear narrative, hook → build → payoff → cta) rather than
`director.py`'s nested `setups[].shots[]`; reuses `director.py`'s hard-won per-shot safety nets (plural-
framing fix, left-to-right face-swap ordering, face-visibility clause, continuity restatement) via direct
import instead of duplicating them. New endpoints in `main.py`, all following the existing
`describe_video`/`mv_analyze` conventions (`MOCK` short-circuit, `WORK_DIR` temp file, `asyncio.to_thread`
for blocking work): `POST /api/story/transcribe` (mp4 → transcript), `POST /api/story/describe_video` /
`POST /api/story/describe_images` (content-focused vision description — subjects/actions/setting, the
opposite exclusion of the existing style-only `_VIDEO_STYLE_INSTRUCTION`), `POST /api/story/script`
(mirrors `/api/mv/script`'s Ollama-with-template-fallback pattern). `director.scene_h3_prompt` and
`/api/mv/render` are reused unchanged for story scenes — both were already generic enough (only read
`motionPrompt`/`characters`/`dialogue`/`soundscape`, or a plain EDL of clip pieces). Added
`faster-whisper>=1.0` to `requirements.txt` — installed clean into the existing CPU-only `.venv` (no
torch/CUDA conflicts, confirmed before adding). Verified: ast-parse, direct import against real
`director`/`h3` modules, `template_script` unit-run, and full HTTP smoke test of all 4 new endpoints under
`COMFY_MOCK=1` (including the LLM-down → template-fallback path).

### Frontend

`TikTokPanel.jsx` (new): 5-step wizard (Story input incl. transcribe/describe buttons + length preset →
Cast → Script → Produce → Cut & Render), structurally mirrors `MusicVideoPanel.jsx` but without any
beat-cut/section UI — Cut & Render is a straight sequential concat in script order (optional background
music, no beat alignment). `App.jsx`: new `tk` state (mirrors `mv`), `TikTokPanel` mounted as a new
`overlay === 'tk'` block, MenuBar → Create → "TikTok Video…". **Key shared-code decision**: generalized
`runBatch`/`stopBatch` (the sequential still→clip producer) to filter `s.mv || s.tk` sorted by
`s.mv ? mvIndex : ttIndex` instead of being MV-only — this is the one change that let Produce work for
both wizards with zero duplicated batch logic; `generateSceneStill`/`generateScene` needed no changes at
all (already keyed off generic scene fields). Also generalized the script-style auto-append in
`generateSceneStill` (was `scene.mv`-only) to check `scene.tk` too, so TikTok's director-written style
paragraph gets folded into still prompts the same safety-net way MV's does. `.vstudio` format bumped to
v4 (adds `tk`, same optional/backward-compatible pattern as `mv` in v3). Asset GC
(`onClearUnusedAssets`) and New Project reset extended to cover `tk`'s asset references. New asset kind
`storyref` for uploaded source mp4/jpgs (excluded from drag-to-board, same treatment as `styleref`).
Verified: `npm run build` clean.

### Known gaps for next session

- No burned-in captions (the whisper segment timestamps are available for this later, but unused for now).

## 2026-09-06 (same day, follow-up) — TikTok wizard live-verified end to end; unrelated ComfyUI env drift fixed

Live-tested in the browser with real ComfyUI + real Ollama + real faster-whisper (no mocks): uploaded a
synthetic test mp4 (SAPI narration over an ffmpeg test pattern) → real transcription (word-for-word
accurate) → real vision content description (correctly described the on-screen pattern) → real LLM script
(Ollama qwen2.5:7b-instruct wrote a correct hook/build/build/build/payoff/cta 6-scene script, safety-net
clauses correctly applied) → scenes added to board in order with beat labels → Produce ▶ Everything hit
real ComfyUI and generated 2 real Krea 2 stills before the batch was stopped (clip/H3 generation not
exercised live this pass, but it's the unmodified code path already proven for MV scenes — only the
generalized `runBatch` filter is new, and that was what was just proven working). Board UI displayed tk
scenes correctly with no MV-specific chip UI, as designed.

**Unrelated infra fixed along the way** (pre-existing environment drift in `D:\comfyui-ltx2`'s system
Python312, NOT caused by this feature, no app code touched): ComfyUI wouldn't start at all, missing several
packages already pinned in its own `requirements.txt` — `SQLAlchemy`, `alembic`, `comfy-aimdo==0.4.11`,
`comfy-kitchen==0.2.26` — plus `triton-windows==3.1.0.post17` (Windows community wheel matched to the
installed torch 2.5.1+cu121) for `--use-sage-attention`/`--enable-triton-backend`. All confirmed with the
user before installing, all just `pip install`s of exactly what the repo already declares — no git
operations, no code changes to ComfyUI. **comfyui-reactor (face-swap) still fails to import** —
`numpy.dtype size changed... Expected 96 from C header, got 88` (numpy 2.x ABI break against a compiled
extension built for numpy 1.x). Confirmed pre-existing (ComfyUI's `requirements.txt` doesn't pin numpy, so
nothing installed this session changed it) — **not fixed**. Any scene with named characters (face-swap)
will fail in either wizard until this is resolved, likely an insightface/onnxruntime/numpy version pin
mismatch.

---

## 2026-09-07 — Cross-scene consistency (LUT + realism safety net), paste-a-written-script import, and a real H3 bug fix

Prompted by planning a real project (an 8-shot horror script written for direct MiniMax H3 use) and wanting
consistent look across scenes without reference images, plus an explicit "no AI slop" requirement.

### Color-grade LUT (post-process consistency)

Since a TikTok project often has no reference photos to condition generation the way Music Video's style
refs do, added a real post-process color grade applied once to the *finished cut* — every scene shares one
consistent look no matter how individual generations drifted, rather than hoping the model matches itself
across seeds. `render.py`: new `LOOKS` dict (id -> label + ffmpeg video-filter chain: `none`,
`clean_realistic`, `cinematic_warm`, `cool_teal_horror`, `kodak_film`, `moody_contrast`) and a `look` param
on `render_edl()` inserted into the filter graph right after `concat`, before fade-out. `cool_teal_horror`
was built to match a real script's own production notes verbatim (teal-shadow lift, ~70% saturation,
crushed blacks, subtle grain, edge vignette) — confirming this is exactly the workflow real short-form
scripts already assume ("prompt-level grading gets you close... apply a single LUT after, so drift is
corrected once"). New `GET /api/looks` endpoint; `/api/mv/render` gained a `look` Form param. All 5 filter
chains verified directly against ffmpeg (`-h filter=...` for exact param names, then a live `-vf` smoke
test) before wiring in, plus a full `render_edl()` run with a look applied. Frontend: `TikTokPanel.jsx`
Cut & Render step gained a "Color grade" dropdown; `App.jsx`'s `tkRenderFinal` passes `tk.cut.look` through.
Backend-generic — reusable by the Music Video wizard's Cut & Render later, just not wired into that UI yet.

### Realism / no-AI-slop safety net

New "Realistic look" checkbox in `TikTokPanel.jsx` Step 1 (`tk.realistic`, default **on**). When true,
`story.py` folds a photoreal instruction into the LLM director's prompt (`_REALISM_INSTRUCTION`) *and*
deterministically appends `_REALISM_CLAUSE` to every still_prompt regardless of source (LLM, template
fallback, or pasted script) — same "don't just ask the model nicely, also patch the output" pattern as the
existing face-visibility/plural-framing safety nets. Separately and **unconditionally** (no toggle — this
one was a hard requirement, not a preference): `story.py`'s `_SYSTEM` prompt now forbids caption-overlay/
subtitle/watermark/emoji text as part of a still or motion prompt (distinct from *diegetic* on-screen text
that's physically part of the scene, e.g. a phone screen — that's still fine), and `normalize_script` now
runs `_strip_overlay_language()` + `_strip_emoji()` on every still/motion prompt and appends
`_NO_OVERLAY_CLAUSE` regardless of realism setting. Verified: emoji regex tested against the real script's
own emoji (😨👻🔑⚠️); overlay-phrase stripping tested; both clauses confirmed present (correct em-dash, not
corrupted — an earlier console-encoding scare during testing turned out to be a terminal display artifact,
not real file corruption) in a live-parsed scene's still prompt in the browser.

### Paste-a-written-script import

New `story.parse_pasted_script(text, max_seconds, realistic)` — deterministic regex parser (no LLM call)
for a script already written shot-by-shot in the `## SHOT N — Title (mm:ss–mm:ss)` / `**[VISUAL]**`/
`**[VOICEOVER]**`/`**[SFX]**` format a script written for direct MiniMax H3 use tends to take. Extracts a
`**[COLOR GRADE]**` blockquote (if present) as the script's shared `style`; per-shot duration from the
header's mm:ss range; `[VISUAL]` seeds *both* still_prompt and motion_prompt (there's no reliable automatic
way to split "frozen moment" vs "what moves" from one paragraph without another LLM pass — meant to be
hand-trimmed after import); `[VOICEOVER]` kept as a new informational-only `narration` field (nothing here
feeds a TTS/lip-sync path — no TTS in this app, by earlier design); `[TEXT ON SCREEN]` is dropped entirely
(caption overlays, never something for the image model to render). New `POST /api/story/parse_script`
endpoint. Found and fixed two real parser bugs during testing against the actual target script: (1) a
`_TAG_RE` lookahead that let one shot's SFX/last-tag capture swallow trailing markdown (a `---` separator,
even the next section's heading, for the very last shot) — fixed by adding `\n-{3,}` and `\n#{1,6}` as
additional stop conditions; (2) a dead `cta` branch in `template_script`'s beat-assignment (unreachable
because `payoff` was checked first for the same index) — removed. Frontend: `TikTokPanel.jsx` Script step
gained a "— or paste a script you already wrote —" textarea + parse button, and per-shot split (⧉,
duplicates a shot so a multi-moment shot like "descend to basement... cut to rushing upstairs" — which this
still-first pipeline can't represent as one shot — can be divided and hand-trimmed) / remove (✕) buttons.
Verified end-to-end live in the browser against the user's real 8-shot script: correct title/beat/duration
extraction per shot, correct style extraction, correct narration/SFX separation, split and remove both
confirmed working.

### Real bug found and fixed: H3 video generation was completely broken

While live-testing the above, hit `RuntimeError: Failed to set fp16 accumulation, this requires pytorch
2.7.1 or higher` on every H3 clip attempt — not a new regression, a pre-existing bug in `h3.py`:
`build_h3_graph()` hardcoded `"enable_fp16_accumulation": True` on the `DiffusionModelLoaderKJ` node
unconditionally, but that node's feature needs pytorch ≥2.7.1 (confirmed installed: 2.5.1+cu121) and raises
instead of degrading gracefully. **This affected all H3 video generation app-wide — Music Video and Empty
Scene too, not just TikTok** — both call the same shared `build_h3_graph`/`/api/generate_h3` path. Fixed
properly rather than just flipping the hardcoded value: new `main.py::_supports_fp16_accumulation()` queries
ComfyUI's own `/system_stats` (which reports `pytorch_version` directly), parses it, and caches whether
≥2.7.1 for the process lifetime — self-adapting if torch is ever upgraded, instead of assuming a version
that doesn't hold on every box this app runs against. `build_h3_graph()` gained an `enable_fp16_accumulation`
param (default `False`, matching the node's own safe default) instead of the hardcoded `True`. Verified: the
helper correctly returns `False` against this box's real ComfyUI; then a full live H3 clip generation (Empty
Scene, real ComfyUI, no mocks) ran clean through model loading → 4-step sampling → audio+video VAE decode →
a real playable clip on the board — the exact job that crashed before now succeeds in ~262s.

### Unrelated infra note

`D:\comfyui-ltx2`'s Python312 environment had more package drift than first found last session —
`comfy-kitchen`/`comfy-aimdo`/`triton-windows` were the tip of it; the fp16 issue above is a *code* bug, not
an environment one, and would recur even on a freshly-installed environment matching this repo's actual
pinned torch version. If the user later upgrades to pytorch ≥2.7.1, the new auto-detection means the
`enable_fp16_accumulation` optimization turns back on automatically — no code change needed.

### Known gaps for next session

- Color grade dropdown not yet added to the Music Video wizard's Cut & Render UI (backend already supports
  it via the same `look` param — just needs the same `<select>` MusicVideoPanel.jsx already has a slot for).
- `comfyui-reactor` (face-swap) is still broken — see the previous entry, not addressed this session.
- The haunted-house test script was parsed live but never added to the board / produced — the user's own
  next session, not a leftover test artifact to clean up.

---

## 2026-09-05 (later same day) — production-quality shot coverage, style refs, Camera Console

Prompted by planning a real project (a Weeknd/Playboi Carti-style preview featuring a custom character).

### Director rewrite: setups + coverage, real cross-cutting

Real music videos aren't one shot per moment — a handful of recurring **setups** (locations/looks) each
get **coverage** (2-4 shots: wide/medium/close-up/insert/OTS/POV) and the edit cross-cuts between setups
all song long, often returning to the same setup later. `director.py` now writes exactly that structure:
LLM/template output is `setups[].shots[]` (each setup carries `continuity` text auto-folded into every one
of its shots' still prompts, and a `sections` **list** — a setup can be scheduled into 2+ sections so it
recurs), flattened to the same flat `scenes` list the app already consumed for backward compatibility.
`mvEdit.js::buildEdl` now cross-cuts on `sections`/`setupId` instead of one `section` int: within a shared
section it prefers a **different setup** than the previous cut (real interweaving), and a setup scheduled
into multiple sections naturally reappears later (the callback pattern). Verified: unit tests confirm
correct per-section setup membership, no back-to-back same-setup cuts when alternatives exist, no
back-to-back same-shot repeats when only one setup is available, and full backward-compat with an
older flat-`scenes` LLM reply. `MusicVideoPanel.jsx`'s script-review step is now grouped by setup card
(name/location/continuity/section-toggle-chips + its shots nested inside, add/remove shot, remove setup);
the cut-strip/legend/EDL list now colour by **setup** (not per-shot) so a recurring setup visibly returns
in the same colour. `template_script` (no-LLM fallback) mirrors the same setup/coverage/recurrence shape.
**Found during testing**: this machine's Ollama (qwen3-vl:latest, the only model pulled) is nearly
unusable for the director right now — `nvidia-smi` showed 15.7/16GB VRAM held by ComfyUI's CUDA
allocator even at idle (freed-in-app memory isn't returned to the OS until the process restarts; ComfyUI's
own `/free` endpoint doesn't help), so Ollama gets ~1GB and falls back to slow CPU inference. A trivial
"say OK" chat call didn't return in 60s. **Fix**: restart ComfyUI before a director session to release
its cached VRAM, or pull a small non-VL text model (`ollama pull qwen2.5:7b` or similar) — `pick_text_model`
already prefers non-VL models when one's installed.

### Style / environment reference images

New asset kind `styleref` (upload in the wizard's Cast step, or per-scene via `SceneDetail`'s toggle
chips): unlike character photos these condition environment/mood, two ways at once — the raw images
feed Krea 2's own vision-conditioning path (`generateKrea`'s existing `moodboard` param, newly wired into
`generateSceneStill`, which auto-picks a bf16 text encoder for that call only since the vision path can't
run on fp8), and `POST /api/describe_images_style` (new, mirrors the existing describe-video-style
endpoint) asks Ollama's vision model to fold them into a text paragraph appended to the Visual style
field the director writes against. New mv scenes seed `styleRefs` from the wizard's uploaded pool automatically.

### Camera Console (3D Studio)

Replaced the flat translate/rotate/scale-only camera experience with two purpose-built widgets in the
Toolbar: **`CameraCube.jsx`** — a live mini Three.js orientation gizmo (the Blender/Maya "view cube"
pattern) that mirrors the editor camera's current rotation and snaps to a clicked face via
`Studio.snapView()` (new — tweens position+rotation, keeps the orbit target/zoom, epsilon-tilts top/bottom
to avoid an OrbitControls gimbal flip). **`CameraDial.jsx`** — a radial 5-mode joystick (orbit / arc /
pan-tilt / dolly / crane, hand-drawn SVG icons) that continuously drives `Studio.applyCameraMove()` (new)
while held, each mode moving the camera differently (orbit sweeps azimuth/elevation around the target;
arc locks elevation for a flat sweep; pan rotates the camera in place and drags the target along so
orbiting afterward still feels right; dolly/crane push along view-axis / world-Y). A "⌂ Home" button
tweens back to the establishing view. Verified live in-browser: cube-click snapped a clean front view,
joystick drag visibly orbited the camera, zero console errors. Toolbar column widened 128→172px to fit.

---

## 2026-09-05 — MiniMax H3 video overhaul + AI music-video director

### Big picture

The app's video engine is now **MiniMax H3** (native video+audio, dialogue,
lip-sync), replacing LTX 2.3 as the default (LTX 2.3 kept as a legacy engine
per-scene). The storyboard workflow is now explicitly **text → still (Krea 2)
→ video (H3 from that still)**, because H3 alone renders on-screen text/signage
poorly at t2v but inherits a sharp still's text/wardrobe/composition when used
i2v. New: a **Music Video** wizard that takes a song + character photos +
concept and writes, shoots, and beat-cuts a whole video.

### New backend modules

- **`backend/h3.py`** — MiniMax H3 API-graph builder (no template JSON; built
  in Python since the recipe branches a lot: image-to-video vs
  reference-to-video, FAST 4-step manual sigmas vs 8-step BasicScheduler).
  Frame-grid snapping (17k+5 @ 24fps), canvas-from-aspect (0.4MP def., /32),
  the 3-section H3 prompt format (`integrated_multimodal_description` /
  `overall_soundscape` / `non_diegetic_music`), and the storyboard `|`/`[3s]`/
  `*` timeline DSL → numbered `[Shot i | mm:ss-mm:ss]` blocks. Verified against
  live `object_info` schemas (all 5 graph shapes — i2v, i2v+last-frame,
  reference, t2v, plain-UNETLoader — pass a full input/enum/link validator).
- **`backend/audio_analysis.py`** — zero-dependency (ffmpeg + numpy only)
  music analysis: mono decode via the `imageio-ffmpeg`-bundled binary, STFT
  spectral-flux onset envelope, autocorrelation tempo estimate with a
  110 BPM log-normal prior, Ellis-style DP beat tracker, downbeat phase from
  4-beat energy alignment, bar-level loudness/brightness change-point section
  detection (intro/verse/build/chorus/bridge/outro), 10 Hz energy curve for
  the UI. Verified on a real 96s track: 120.24 BPM, 192 beats, 6 sensible
  sections in 0.4s.
- **`backend/director.py`** — the "director": builds a structured prompt from
  the song analysis + cast + concept, calls local Ollama (`/api/chat`,
  `format:"json"`) for a scene-by-scene shot list (still prompt + motion
  prompt + dialogue + soundscape per scene, section-aware, energy-aware), with
  strict normalization/validation of whatever comes back. **`template_script`**
  is a deterministic no-LLM fallback (location bank + shot-size-by-energy) so
  the feature works with Ollama off. `scene_h3_prompt` composes the final H3
  prompt for a scene (prepends the "lock to still" instruction + dialogue).
- **`backend/render.py`** — final-cut assembly via ffmpeg
  `filter_complex`: per-piece trim/scale/pad/fps-normalize (`tpad`+`trim` so
  odd source frame rates don't drift the beat grid), concat, optional
  clip-audio mix under the music track (trimmed to the edit's start offset +
  length), fade-out, h264/aac mp4. Verified: 4-piece edit from two real mp4s
  landed exactly on requested cut points post-fix (padding cured a 1-frame
  short-piece bug caught by an ffprobe frame-count check).

### Backend endpoints (`main.py`)

- `POST /api/generate_h3` — MiniMax H3 image/reference/text-to-video. Resolves
  model/text-encoder/video-VAE/audio-VAE from ComfyUI by regex (prefers
  `minimax*h3`-named files; **video VAE must be the `fp16` file — the
  `int8_convrot` one decodes to solid black**, learned the hard way in an
  earlier session, guarded against here too). Clamped to `H3_MAX_FRAMES=175`
  (7.3s — the "7 second" ceiling on this GPU) via env override.
- `POST /api/mv/analyze`, `POST /api/mv/script`, `POST /api/mv/h3_prompt`,
  `POST /api/mv/render` — the music-video pipeline endpoints.
- `GET /api/h3/models`, `GET /api/llm/status` — catalog/status for the UI.
- Job progress text now shows each node's **human title** (e.g. "Encoding
  prompt + keyframe (Qwen3-VL 32B)…") instead of a bare node id — reads from
  the graph's own `_meta.title`, so any future template/graph gets this free.
- WS/SSE timeouts raised 600s/900s → 2400s (H3 cold-loads ~40GB off an HDD
  before the first progress tick; a queued job behind one saw nothing for
  the whole run at the old timeout).
- `/api/vaes` now de-duplicates (ComfyUI was listing some files twice,
  causing the React "duplicate key" console warning in the Krea 2 panel).

### Bug found and fixed: Krea 2 generation was completely broken

`ComfyUI-Krea2T-Enhancer` — wired into every Krea 2 graph "as a safe no-op at
strength 0" — currently throws `krea2t_enhancer_wrapper() takes from 4 to 6
positional arguments but 7 were given` on this ComfyUI build (a third-party
node/ComfyUI version mismatch, not this app's code). That blocked **every**
Krea 2 still (original panel, sketch-to-Krea, and the new scene-still path)
outright. Fixed in `workflow.py::bypass_enhancer_when_zero()`: at strength 0
(the default everywhere), delete the node from the graph and rewire whoever
consumed its output straight to the model ref, instead of calling into it.
Enhancer strength > 0 is still broken pending an upstream fix to that node
pack — leave it at 0 until then. Verified end-to-end: real still generated
through the scene detail's "Generate still" after the fix.

### Frontend: storyboard rebuilt around still → video

- **`src/h3.js`** — frame-grid/canvas/aspect helpers mirroring `h3.py`,
  `imageAspect`/`videoMeta` (read a blob's real dimensions/duration back for
  asset metadata), scene defaults.
- **Scenes now carry a still prompt AND a motion prompt** — `SceneDetail.jsx`
  is reorganized into "1 · Still (key frame)" (Krea 2 prompt, aspect, cast
  picker for face-swap, seed) and "2 · Video" (engine picker — H3 default,
  LTX 2.3 legacy — motion/dialogue/soundscape/music, clip length from the
  live H3 frame grid, fast/quality preset, lock-to-still toggle, advanced
  sigma-shift/sampler knobs). "Generate video" is disabled until a still
  exists. `SceneCard.jsx` shows an engine tag, a length+quality mini-picker,
  and a "🎨 Generate still" button when there's no image yet.
- **`Create` menu**: "🎵 Music Video…" and "🎞️ Empty Scene (prompt → still →
  clip)" replace the old bare board (dragging a gallery image onto the board
  still works too).
- Gallery (`HistoryDock.jsx`) now shows **audio tracks** (🎵 tile, click opens
  the Music Video panel) and **character photos** as distinct tile kinds.

### Frontend: Music Video wizard (`MusicVideoPanel.jsx`, `mvEdit.js`)

Five-step flow, all state lives in `App.jsx`'s `mv` object (persisted in
`.vstudio` v3):
1. **Track** — upload, see BPM/beats/sections on a canvas strip (energy curve
   + section colour bands + beat/downbeat ticks), drag-select an edit range.
2. **Cast** — character photos, name + description (manual or "👁 Describe"
   via the existing Ollama vision endpoint), become face-swap references.
3. **Script** — concept/style/lyrics/aspect/scene-count/clip-length/quality →
   director writes the shot list (LLM or template); every field is editable
   inline before "+ Add N scenes to the board" creates real scene cards
   (`scene.mv=true`, `mvIndex` for cut order), matching cast names to
   uploaded character asset ids.
4. **Produce** — one-at-a-time batch runner (stills, then clips, or both;
   stoppable) over the music-video scenes, with a live status list; can jump
   to any scene's full detail view mid-batch.
5. **Cut & Render** — **`mvEdit.js::buildEdl`** is the beat-aligned auto-cut:
   walks the beat grid, picks a cut length from a `{fast,medium,slow,auto}`
   style table (auto follows section energy + tempo), snaps ≥4-beat cuts to
   the nearest downbeat, prefers scenes tagged for the current section, never
   repeats the same scene back-to-back (falls back gracefully when a section
   has only one clip), and consumes each clip **progressively** (later reuses
   show a later moment of the same clip, not a random re-scrub). Reproducible
   per seed; "🎲 Reshuffle" bumps it. Renders via `/api/mv/render` (music +
   clip-audio mix levels, fade-out, native/1080/720 output size) to a
   downloadable final mp4 asset.
- Verified `buildEdl` with a standalone Node test: on-beat cut points,
  contiguous coverage of the full range, no back-to-back repeats, in-range
  trim points, and reproducibility, across all 4 cut styles plus a
  no-beat-detected fallback and a limited edit range.

### Project format v3

`.vstudio` now also persists `mv` (music-video wizard state, track/cast asset
ids, script, cut settings — not the transient `scriptError`). v1/v2 files
still load. Scene fields grew (`stillPrompt`, `engine`, `frames`, `cast`,
`dialogue`, `soundscape`, `music`, mv-scene metadata) — `App.jsx::onLoad`
backfills `SCENE_VIDEO_DEFAULTS` onto older scenes so old projects still open.

### Known gaps / next session

- **Ollama wasn't running during this session** — the LLM director path is
  implemented and unit-tested (`director.py` functions called directly) but
  not exercised live end-to-end; the template fallback was. Start Ollama with
  a text model pulled (`ollama pull qwen3` or similar) to use the real
  director. `/api/llm/status` and the MenuBar's "LLM ●/○" pill show whether
  it's reachable.
- **Krea2T-Enhancer strength > 0 is still broken** (see above) — third-party
  node pack issue, needs an upstream fix or a replacement node.
- The Music Video wizard's steps 3–5 (script review, produce batch, cut
  timeline) were exercised via code review and the `mvEdit.js` unit test, but
  not a full live click-through in this session (an in-session source edit
  triggered a Vite full-reload mid-walkthrough, which wiped the in-progress
  wizard state — a testing artifact, not a product bug, but worth knowing:
  editing non-component `.js` files while the wizard has unsaved state will
  reset it). The core mechanics (track analysis, still generation, H3 video
  generation with dialogue+soundscape, real audio in the output file) were
  each verified live and independently.
- `H3_MAX_FRAMES` (175 = 7.3s) is a soft ceiling tuned for this GPU — raise
  the `H3_MAX_FRAMES` env var if VRAM allows longer clips later.

---

## 2026-07-16 — Model-selection fixes, safetensors support, project naming, snapshots, video style analysis

### Environment facts (worth knowing before touching anything)

- **ComfyUI**: `D:\ComfyUI-LTX2`, port 8188. Launch:
  `python main.py --use-sage-attention --fast fp16_accumulation --async-offload`
  (`fp16_accumulation` and `--async-offload` added this session — speed advice for the RTX 4060 Ti 16GB).
- **App backend**: runs from **`app\backend\.venv`** (NOT the system Python 3.12), port 8000, `python main.py`. No auto-reload — **backend code changes need a manual restart**.
- **Frontend**: Vite; build with `npm run build` in `app\frontend`, served from `dist/` by the backend — browser hard-refresh (Ctrl+Shift+R) picks up a new build, no process restart needed.
- Installed into the backend venv this session: `opencv-python-headless 5.0.0.93`, `numpy 2.5.1` (for video frame extraction).
- Ollama runs locally (port 11434) with `qwen3-vl:latest` — used by describe_image and the new describe_video.

### Bug fixed: wrong model silently selected (the "censored output" saga)

- **Symptom 1 (crash)**: `Sizes of tensors must match… expected 30720 got 4096` — an LTX-architecture GGUF was loaded in the Krea image pipelines. 30720 = LTX gemma embedding width; 4096 = Krea 2's Qwen3-VL width.
- **Symptom 2 (censored / ignores prompt & sketch, no crash)**: sketch panel was on `10Eros_v1-Q4_K_M.gguf` (not a Krea-2-arch model; accepts 4096-dim context so it runs, produces garbage-adherence "safe" images).
- **Root cause**: model dropdowns defaulted to the first file alphabetically; `10Eros…` sorts first (digit prefix). Each panel (Sketch / Krea) saves its **own** model selection.
- **Fixes**:
  - `SketchPanel.jsx` / `KreaPanel.jsx`: GGUF default now `pickDefault(m, /krea/i)`.
  - `backend/main.py`: both server-side fallbacks prefer a Krea-named file too.
- **Key learning**: base `Krea-2-Turbo-Q4_K_M.gguf` is NOT censored when the user's LoRA stack is applied — LoRAs at proper strengths are what carry the content. LoRA strength 0.0 = bare base model = censored-looking output.

### Feature: plain-safetensors diffusion models selectable (not just GGUF)

- `/api/gguf_models` now merges `UnetLoaderGGUF` (gguf) + core `UNETLoader` (safetensors) lists; response key stays `gguf_models`.
- `backend/workflow.py::use_plain_unet_loader(graph, node_id, name)` — swaps the template's loader node to `UNETLoader` (`weight_dtype: "default"`) when the picked file isn't `.gguf`. Applied in: sketch-krea path (node `"1"`), krea txt2img (node `"1"`), i2v video (node `"844:286"`).
- Motive: `krea2TurboUncensored_v1.safetensors` (12.24 GB, models/unet) was invisible to the app.

### Feature: project naming

- `.vstudio` format v2 (`project.js`): `name` stored in the payload and used as the download filename (sanitized). v1 files still load (name falls back to filename).
- Save (Ctrl+S) prompts for a name the first time then reuses it; **Save Project As…** (new File-menu item, Ctrl+Shift+S) always prompts.
- Project name shown in the MenuBar (`.proj-name` style in styles.css).
- Project files now also persist `kreaSettings`, `sketchLoras`, `kreaLoras` (previously lost on save/load). Moodboard/face-swap uploads are still transient (never saved).

### Feature: generation snapshots (restorable iterations)

- `api.js::submitAndStream` resolves `{url, media, seed}` — the **actual seed**, so `-1` random runs are reproducible.
- Every Sketch→Image result asset's meta: `{prompt, sourceSketchId, source: 'sketch_krea2'|'sketch_sd', settings (incl. used seed), loras}`. Krea results likewise (`source:'krea2'`) + loras.
- `App.jsx::restoreGeneration(asset)` — restores the full iteration: settings, LoRAs, seed, and the source sketch back onto the pad (sketch sources) or reopens the Krea panel (krea sources).
- `HistoryDock.jsx`: **⟲ button** on generated images that carry a snapshot. `editSketch`/`editKrea` also restore `meta.loras` now.
- Snapshots live in asset meta → embedded in `.vstudio` → survive save/load. Pre-2026-07-16 assets have no snapshot (no ⟲ button).

### Feature: 🎞️ Style from reference video (music-video aesthetics → Krea prompt)

- `POST /api/describe_video` (`backend/main.py`): mp4 upload → `_extract_video_frames` (cv2; even sampling skipping first/last 5%, seek-fallback, ≤768px JPEG, runs in `asyncio.to_thread`) → `_ollama_vision(images, _VIDEO_STYLE_INSTRUCTION)` (multi-image; refactored out of `_ollama_describe`).
- The instruction extracts **transferable style only** (grade, palette, lighting, grain/halation, lens, composition, era, mood, wardrobe/set) and explicitly excludes people/faces/story — composes with the user's own subject.
- Frontend: `api.js::describeVideo`, button under the Prompt box in `KreaPanel.jsx`; appends the style paragraph to the prompt (comma-joined). `frames` param clamped 2–12, default 6.
- Verified end-to-end on `LTX_00003.mp4` → proper style paragraph from qwen3-vl.
- Best practice: type the subject FIRST, then hit the button — Krea leans on early tokens.

### Fix: LoRA strength footgun

- Clearing a strength input silently coerced to `0` (LoRA no-op → "censored" output mystery). `LoraRows.jsx`: empty field snaps back to 1.0 on blur; any row at 0 shows "⚠ 0 = off" on the label.

### Known state / loose ends

- **User's proven direct-ComfyUI Krea recipe** (from `output/krea2/i_00326_.png` metadata): 14 steps, euler/**simple**, cfg 1, `wan_2.1_vae`, qwen3vl fp8 encoder on CPU, LoRA stack: Detailer-KREA2 1.0, nicegirls 1.0, realism_engine_v2 0.7, lenovo 1.25, penis_size 0.5, rwFlaccid 0.15.
- App templates still use scheduler `normal` + qwen_image_vae; **offered but not done**: switch templates to `simple` / try wan VAE if adherence lags.
- Speed advice given (not app changes): try fp8_scaled Krea checkpoint vs Q4 GGUF; NVIDIA "Prefer No Sysmem Fallback" for python.exe; fp16_accumulation only helps fp16-compute models (~15–25% when it applies).
- Krea2T-Enhancer node: third-party, aggressive conditioning amplifier; app passes strength 0 (true no-op). Advice: leave 0, try 0.3–0.7 only for prompt drift.
- Depth-ControlNet sketch feature from 2026-07-10 is still **paused mid-implementation** (see the project notes) — dispatch branch in `main.py`, frontend wiring, and custom-node installs remain.

---

## 2026-07-14 (earlier session, summary)

- Killed stale ComfyUI processes; identified backend vs ComfyUI process pairs (backend = the `main.py` without `--use-sage-attention`).
- ComfyUI speed flags recommended: `--use-sage-attention --fast fp16_accumulation` (+ later `--async-offload`).
- Advice on fp8 vs GGUF for RTX 4060 Ti 16GB, LoRA options with fp8 (partial offload / bake / dual-model strategy).
