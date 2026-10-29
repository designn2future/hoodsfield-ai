# Hoodsfield roadmap

What comes after the contest submission. Nothing here is promised; it is the list of what we would build next.

## Next: real HD for video
- **Open H3 2K regeneration.** NVIDIA's Open-H3-Regenerate-2K (NVlabs/Sana) takes a low-resolution MiniMax H3 draft, enlarges its latent and refines it in about three steps, instead of just stretching pixels. The documented case is a 768P draft (1344x768, the size Hoodsfield's H3 clips already come out at) to 2560x1440. Plan: first check it runs on a 16 GB consumer GPU (NVIDIA's speed numbers are from a B200 server card) and works with our ComfyUI, then add it as an optional "HD regenerate" step after a clip is made, and in Loops before the long-video export. Source: <https://nvlabs.github.io/Sana/Open-H3-Regenerate-2K/>

## Loops
- **Element-level animation.** Claude outlines each moving element (steam, curtains, candle flicker, flags, hair) and names a motion type; the app animates only inside the outline, with whole-number cycles so the loop stays seamless.
- **Decide the Layers "mist" look.** The mist layer was rewritten on 2026-10-27; revert to the original or keep.

## Characters, voice and ads
- **Lip-synced ad shots.** Ads currently use a presenter voice-over (the presenter does not talk on screen). Next: an optional lip-synced pass for the talking-to-camera shots, using the character's voice.
- **Lip-sync quality.** Output is 448x640 and takes about 7 minutes for 6 seconds. A larger resolution and a faster path would make it useful for finished ads.
- **Tidy the voice library.** The 86 stock "Library voice" entries are all one voice; hide or replace them with distinct voices.
