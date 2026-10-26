# Workflow templates

Six templates ship here:

- `ltx_depth_workflow.json` — 3D scene depth-sequence → LTX video
  (used by `POST /api/generate`, selected via `WORKFLOW_FILE`)
- `sketch_image_workflow.json` — sketch → image, plain img2img fallback
  (used by `POST /api/generate_image` when no ControlNet is chosen;
  extra token: `"__SKETCH_IMAGE__"`)
- `sketch_controlnet_workflow.json` — sketch → image via scribble ControlNet:
  exact composition at full denoise. Used automatically when a ControlNet is
  picked in the UI. Extra tokens: `"__CONTROLNET__"`, `"__CN_STRENGTH__"`.
  Requires a ControlNet model in `ComfyUI/models/controlnet`
  (SDXL: MistoLine or controlnet-union-sdxl; SD1.5: control_v11p_sd15_scribble).
  Note: the sketch is inverted in-graph (scribble CNs expect white-on-black).
- `ltx_i2v_workflow.json` — storyboard scene image → LTX video
  (used by `POST /api/generate_i2v`, selected via `WORKFLOW_I2V_FILE`).
  PLACEHOLDER like the depth workflow — verify `LTXVImgToVideo` against your
  installed LTX pack. Extra token: `"__FIRST_FRAME__"`.
- `krea2_workflow.json` — native Krea 2 (Qwen3-VL-conditioned DiT)
  text-to-image, with optional moodboard reference images and optional
  multi-face swap. Used by `POST /api/generate_krea`, selected via
  `WORKFLOW_KREA_FILE`. Extra tokens: `"__GGUF_MODEL__"`,
  `"__TEXT_ENCODER__"`, `"__VAE_NAME__"`, `"__ENHANCER_STRENGTH__"`.
- `sketch_krea2_workflow.json` — sketch → image via native Krea 2 img2img
  (`LoadImage`→`ImageScale`→`VAEEncode`→`KSampler` at partial `denoise`,
  same mechanism as `sketch_image_workflow.json` but with Krea 2's loader
  chain instead of `CheckpointLoaderSimple`). Used by `POST
  /api/generate_image` when `backend=krea2` is selected, selected via
  `WORKFLOW_SKETCH_KREA_FILE`. Same tokens as `krea2_workflow.json` plus
  `"__SKETCH_IMAGE__"` and `"__DENOISE__"`. Shares the plain-`CLIPTextEncode`/
  `ConditioningZeroOut` fix from `krea2_workflow.json` (see that entry
  below) — same censorship concern, same fix. LoRA chain and face-swap
  splicing are applied by the backend exactly as in `/api/generate_krea`
  (reuses `append_lora_chain`/`append_faceswap_chain` from `workflow.py`
  unchanged).

  **Three structure modes**, selected via `krea_structure_mode`:
  - `"img2img"` (default) — the mechanism above. No ControlNet equivalent
    exists for this backend, so composition-adherence and photorealism
    share the `denoise` knob, same tension as the SD path without
    ControlNet — and Krea2's flow-matching schedule (`shift=1.15`) doesn't
    map denoise values 1:1 with SD's classic schedule, so the same numeric
    denoise tends to preserve *less* of the sketch on Krea2 than on SD
    (confirmed empirically — denoise 0.7 on Krea2 behaved like ~0.9 would
    on SD).
  - `"reference"` — `workflow.py::use_vision_reference` swaps the positive
    prompt node for `TextEncodeKrea2` with the sketch wired to its `image1`
    slot (same vision-conditioning path moodboard uses — semantic, not
    pixel-level) and replaces the img2img latent with a fresh
    `EmptySD3LatentImage`, forcing `denoise=1.0`. Intended to decouple
    "looks photorealistic" from "follows my composition" the way ControlNet
    does for SD — **in practice this did not pan out**: confirmed
    empirically (including with aggressive "this is a real photograph, not
    a drawing" prompt language, which made no difference) that the vision
    path also reproduces the *reference image's rendering style* onto the
    described subject — a line-art sketch input produces a line-art-styled
    subject regardless of prompt wording, with a photorealistic-only
    background. It also doesn't lock framing/composition precisely (semantic
    guidance, not pixel-locked). Left in as an option since it may suit a
    *photographic* reference image better than a line sketch, but it's not
    the recommended sketch-to-photorealistic path.
  - `"two_pass"` — `workflow.py::add_two_pass_refine` runs ordinary img2img
    (above) at `denoise` (low, e.g. 0.4 — locks composition, looks
    sketch-like) then chains a second `KSampler` directly onto that latent
    at `refine_denoise` (higher, e.g. 0.55), reusing pass 1's model/
    conditioning/sampler/seed. The second pass starts from pass 1's own
    shaded, proportioned output rather than bare linework, so a denoise
    level that would erase a sketch's composition instead has real
    photographic material to preserve — this is the standard two-pass/
    hires-fix technique. Added after both `"img2img"` alone (forced a choice
    between sketch-like or composition-drift) and `"reference"` (style
    leakage, loose framing) failed to give a clean result.

  **`sketch_blur`** (Krea2 only, applies in `"img2img"`/`"two_pass"` modes,
  and also affects `"reference"` mode since it shares the same uploaded
  file): Gaussian-blurs the sketch in `main.py` (Pillow) before it's ever
  uploaded to ComfyUI. Rationale: crisp black-on-white linework is a
  high-contrast edge, which a diffusion sampler treats as real structure to
  preserve, not an artifact to erase — confirmed empirically that this is
  why even a fairly aggressive `two_pass` refine still read as "a drawing."
  Softening the lines into gradients first should let the sampler treat the
  sketch as a compositional hint rather than literal content to reproduce.
  Considered but not pursued: a real Krea2 ControlNet exists
  (`facok/comfyui-krea2-controlnet` + `Patil/Krea-2-depth-controlnet`), but
  the only public trained weights are depth-only, and that model's own card
  warns flat 2D/line-art input produces "nearly-uniform depth maps, so
  control will be weak" — not useful for a hand-drawn sketch specifically.

The backend does NOT know ComfyUI's node graph — it just injects values into
whatever API-format JSON lives here. **The shipped `ltx_depth_workflow.json` is
a best-guess placeholder** (plan step 1 — nailing the real depth workflow
inside ComfyUI's UI — hasn't happened yet). Node names for your installed
LTX 2.3 turbo pack will almost certainly differ.

## How to swap in your real workflow

1. Build the depth-conditioned LTX workflow by hand in ComfyUI's UI until it
   produces a good video from a folder of depth PNGs + a prompt.
2. Enable **dev mode** in ComfyUI settings, then use
   **Export (API format)** — *not* the regular save.
3. Open the exported JSON and replace the values you want the app to control
   with these tokens (set the field's whole value to the quoted token):

   | Token | Injected as | Meaning |
   |---|---|---|
   | `"__PROMPT__"` | string | positive prompt |
   | `"__NEGATIVE_PROMPT__"` | string | negative prompt |
   | `"__WIDTH__"` / `"__HEIGHT__"` | int | output resolution |
   | `"__NUM_FRAMES__"` | int | frame count (8n+1) |
   | `"__FPS__"` | int | frame rate |
   | `"__STEPS__"` | int | sampler steps |
   | `"__CFG__"` | float | guidance scale |
   | `"__SEED__"` | int | seed |
   | `"__DENOISE__"` | float | v2v denoise strength |
   | `"__FRAMES_DIR__"` | string | folder of uploaded depth PNGs, e.g. `input/vsa_ab12cd` |
   | `"__FRAMES_SUBFOLDER__"` | string | just the subfolder name, e.g. `vsa_ab12cd` |
   | `"__FIRST_FRAME__"` | string | `vsa_ab12cd/frame_00000.png` (for LoadImage nodes) |

4. Save it here and point `WORKFLOW_FILE` in `backend/.env` at it.

Tokens can also appear inline inside longer strings
(e.g. `"cinematic still, __PROMPT__"`).

## Krea 2 (`krea2_workflow.json`)

Requires ComfyUI-GGUF, and the `comfyui-krea2-text-encoder` +
`ComfyUI-Krea2T-Enhancer` custom node packs (Krea 2 is a natively-supported
architecture as of ComfyUI 0.26 — `CLIPLoader`'s `type` dropdown includes
`"krea2"`).

- **Checkpoint**: any Krea 2 Turbo GGUF (`UnetLoaderGGUF`).
- **Text encoder**: Qwen3-VL-4B. The **fp8** variant
  (`qwen3vl_4b_fp8_scaled.safetensors`) works for text-only prompts. **Moodboard
  images require a bf16/fp16 variant** (`qwen3vl_4b_bf16.safetensors`, from
  `huggingface.co/Comfy-Org/Krea-2`) — the installed `TextEncodeKrea2` node
  raises an explicit error if you attach a reference image while the encoder
  is loaded FP8 ("the Qwen3-VL text encoder is loaded in FP8, which ComfyUI's
  vision tower cannot run on the image path").
- **VAE**: `qwen_image_vae.safetensors` (official Comfy-Org pairing — despite
  `supported_models.Krea2` tagging its latent format as `Wan21`, that's just a
  16-channel/8x-spatial shape match, not the actual VAE to use).
- **Moodboard images do NOT need a separate Qwen-Image-Edit checkpoint.**
  `TextEncodeKrea2` feeds reference images through Krea 2's own text-encoder
  vision path (no VAE, no reference-latent) and accepts an unbounded number of
  slots — the backend adds `image1`, `image2`, ... directly onto that node's
  `inputs` after loading the template, so there's no fixed cap.
- **Positive prompt encoding — plain `CLIPTextEncode`, not `TextEncodeKrea2`,
  unless a moodboard image is attached.** `TextEncodeKrea2` wraps every prompt
  in a chat-instruction template (`system: "Describe the image..." / user:
  {prompt} / assistant:`) before it reaches the Qwen3-VL encoder. Since that
  encoder is a full instruction-tuned VLM (not a bare CLIP), casting it into
  an "assistant" persona this way measurably softens/sanitizes explicit
  prompts compared to sending the prompt straight to the encoder — confirmed
  by diffing against a known-good standalone ComfyUI workflow that used plain
  `CLIPTextEncode` and produced uncensored output from the identical
  checkpoint. `TextEncodeKrea2` is used only when moodboard images are
  attached (it's the only node with image slots); the chat-template softening
  may still apply there and hasn't been separately verified — if moodboard
  generations come out oddly conservative, try overriding `TextEncodeKrea2`'s
  optional `system_prompt` input.
- **Negative conditioning is `ConditioningZeroOut`** (zeroing the positive
  conditioning) rather than a real encode of a negative-prompt string —
  matches the verified reference workflow, and is a no-op difference at
  `cfg=1.0` regardless (ComfyUI skips the uncond pass entirely at cfg=1).
- **LoRAs**: the backend chains core `LoraLoader` nodes (not the `rgthree`
  Power Lora Loader widget node, to stay generic/available on any ComfyUI
  install) onto the model+clip before the enhancer/encoder stage, in the
  order supplied.
- **Enhancer** (`ComfyUI-Krea2T-Enhancer`) is always wired into the model
  chain, downstream of any LoRA chain; `strength=0` is a documented no-op in
  the node's own code, so it's safe to leave connected and controlled purely
  by the strength slider.
- Like `ltx_depth_workflow.json`, the `KSampler` steps/cfg defaults here
  (8 steps, cfg 1.0, euler/normal) are a reasonable turbo-model guess, not a
  documented recommendation — no official steps/cfg guidance was published
  for the turbo variant at the time this was written. Tune against real
  output.

## Notes

- Depth frames are uploaded as 8-bit grayscale PNGs, **white = near**,
  black = far, linearly normalized between the camera near plane and the
  editor's "Depth far" setting.
- The placeholder template assumes VideoHelperSuite (`VHS_LoadImagesPath`,
  `VHS_VideoCombine`) is installed — most video setups have it.
- Output detection: the backend looks in history for `gifs`, `videos`, or
  `images` outputs, in that order — VHS_VideoCombine's MP4 shows up under
  `gifs`, so any standard save node works.
