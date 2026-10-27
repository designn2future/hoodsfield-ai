---
name: minimax-h3-prompting
description: Write high-quality prompts for the MiniMax H3 video model (text-to-video, image-to-video, reference-to-video) with native audio. Use when the user wants to write, improve, debug or batch-generate H3 / Hailuo 3 video prompts, storyboards or shot lists, or asks why an H3 clip looks floaty, low-detail, distorted or has unwanted music/text.
---

# MiniMax H3 prompting

H3 generates picture **and sound in one pass**, so a good prompt is a short *production brief*, not an image caption. Describe what happens over time, what the camera does, what is heard, and what must not appear.

## 1. The workflow

1. **Decide the mode.** Image-to-video (a still is the exact first frame; the still carries the look, the prompt carries the *motion*), reference-to-video (`<Picture 1>` style references for identity), or text-to-video (the prompt carries everything).
2. **The still is frame 0 - never write a beat that starts earlier than it.** If the still shows the bike at the cliff lip, do not open the brief with the bike far down the road; H3 will snap back and replay. Begin the first beat from the state the still shows.
3. **Put the detail in the still, the motion in the prompt.** For image-to-video, spend the effort on the still (Flux 3 / Qwen): real architecture, species of tree, materials, lighting. Then the prompt only has to say what moves.
4. **One primary action per shot, one primary camera move.** Four camera moves + three actions + a transformation gets compressed into mush. Split into separate clips instead and cut between them.
5. **Draft at 4-5 s, deliver longer.** Composition and sound usually resolve at 5 s. Lengthen only after the short one works.
6. **Review and iterate on one variable at a time** (seed, wording, camera, resolution), never several at once.

## 2. Prompt structure (in this order)

```
[Style contract]  Medium, lens/film look, palette, time of day, the look that must not drift.
[Timeline]        [0s-3s] one action ...   [3s-6s] next beat ...   (contiguous, one idea per slice)
Camera:           explicit move or explicit "locked off, no cuts".
Physics:          gravity / inertia / speed wording for anything that falls, crashes or flies.
Audio:            layers - ambience, then sound effects with timing, then dialogue; music or "No music."
On-screen text:   exact strings in quotes, or "no on-screen text".
Constraints:      what must not happen (see section 6).
```

For H3's trained three-field layout the same content maps to
`integrated_multimodal_description` (visual + physics + camera + constraints), `overall_soundscape` (ambience, SFX, dialogue) and `non_diegetic_music` (score, or `No music.`). Keep the three fields separate.

Length: documented maximum is about 7,000 characters. Short is fine when a still/reference supplies the look; text-to-video needs a full shot list.

## 3. Writing rules

- **Concrete beats adjectives.** Replace "cinematic", "beautiful", "epic", "dynamic" with things the model can draw: lens, light direction, materials, species, weather, scale cues.
- **Trajectories, not verbs.** Starting state -> movement -> ending state, with speed and contact points. "The bike accelerates along the road, trunks whip past in motion blur, the trees end, it launches off the lip of the cliff and the camera tilts down to the canyon floor" - not "bike goes off cliff".
- **Separate subject motion, camera motion and cuts** into their own phrases. Never bundle them.
- **Scale cues** make things feel huge: tiny people, a car, a tree line, spray, mist, shadows swallowing a street.
- **Foreground particles inside the shot** sell realism (dirt hitting the lens, rain drops, spray, embers, dust). Ask for them in the prompt; post-production overlays look fake.
- **State absences.** "No music", "no voice", "no subtitles", "no vehicles on the road". If you do not, the model invents them.
- **Anything that must stay fixed** gets named: "keep the outfit, hair and location from the first frame".
- **Describe visible actions, not emotions or metaphors.**
- **Natural language camera terms**: dolly in/out, track left/right, pan, tilt up/down, crane up, rack focus, handheld, locked-off, whip pan, orbit. Unstated camera tends to default to a slow dolly.
- Fast motion leaves the model less room to resolve clean geometry. Keep it fast but singular.

## 4. Physics wording that works

Floaty, weightless debris is the most common tell. Add, and mean it:

> Realistic gravity and momentum: loose objects fall and accelerate, nothing floats or hovers; heavy items drop faster than light ones; natural motion blur.

For falls: say what accelerates (the camera, the objects), which way is down, and what rushes toward the lens. For impacts: sequence it (wave hits the base -> glass bursts outward -> floors engulfed -> dust and spray reach the lens).

## 5. Audio

- Layer it: ambience -> physical SFX tied to timestamps -> dialogue (exact line in quotes, delivery noted) -> music.
- Name the absences: "No music." / "No voice."
- Dialogue must fit the clip length (read it aloud).
- If the clip will be scored in an editor, ask for "No music" and keep only ambience/SFX. Generated H3 SFX can sound warbly on large effects (engines, water); mute and score separately when it matters.

## 6. Constraint line (always include)

> No on-screen text, subtitles or watermark. No morphing, warping or melting of objects. No extra or duplicated people or limbs; hands and faces stay natural. No unrequested hard cuts or scene changes.

Add specifics per shot: "no vehicles moving", "no hands or feet visible", "no cars driving toward the wave". Models love adding traffic and bodies; ban them.

## 7. Quality settings (local ComfyUI H3)

- Use the **quality** preset (8-step, `res_multistep`) for anything final; **fast** (4-step) is only for drafts - it softens detail and hurts faces and foam/water.
- Resolution is the biggest detail lever: 0.4 MP is draft; **0.7-0.95 MP** for hero shots (VRAM permitting). Match the still's aspect; 21:9 stills give wide, cinematic frames (crop to 16:9 in the edit if needed).
- Length steps on a 17k+5 frame grid at 24 fps (about 4.5 s, 5.2 s ... 7.3 s max here).
- Close the browser's GPU tabs (WebGL, video) while rendering on a PCIe-limited card; other VRAM use can slow renders ~10x.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Floaty debris / no weight | Physics clause, name what falls and accelerates, add motion blur |
| Looks like a PS3 game / copy-pasted trees | Higher-detail still (species, bark, undergrowth, haze), quality preset, 0.7+ MP, concrete material words |
| Distorted faces | Keep faces small or out of frame in action shots; wide shot to establish, closer only where identity matters |
| Cartoonish foam / spiky water | Describe mass and glass-like wave faces, spray only at the base; cut away before the foam resolves |
| Unwanted cars / people / hands | Ban them explicitly in constraints and in the still prompt |
| Warbly or low-quality audio | Request ambience only, "No music", replace big SFX in the edit |
| Unwanted dissolves | State "hard cuts only" or "one continuous shot, no cuts" |
| Drift in the last frame | Supply a last frame (`end_image`) |
| Clip jumps back / seems to replay after ~1 s | The first beat of the brief does not match the state shown in the still, so H3 "rewinds". Make beat 1 continue from exactly what the still shows (same position, pose, distance), or trim the first second in the edit |
| Text garbled | Quote the exact string; generic "HUD/labels" comes back as glyph-shaped noise |

## 9. Worked examples (from the Hoodsfield launch reel)

**Cliff jump (image-to-video, 7.3 s, 0.85 MP, quality preset)**
> Style: photoreal, 35 mm, golden shafts of light through old-growth forest. [0s-3s] A motorcycle accelerates at tremendous speed along a gravel road; the camera tracks beside it as tree trunks whip past in motion blur; gravel and dirt clods fly from the rear wheel and spatter the lens. [3s-5s] The trees suddenly end; the bike launches off the edge of a huge cliff. [5s-7s] The camera tilts sharply down to reveal a thousand-foot drop to a canyon floor as the bike flies out over the abyss. Camera: tracking, then a downward tilt. Physics: realistic momentum and gravity. Audio: engine roar, wind, gravel; no music. Constraints: no on-screen text, no morphing, no extra riders.

**Skyline impact with birds (21:9, 5 s, 0.95 MP)**
> Huge flocks of birds explode off the rooftops and streak toward the camera in panic as the colossal wave crashes into the base of the skyscrapers behind them; glass bursts outward in glittering shards; the lower floors are engulfed in white water and mist; spray droplets splatter the lens; the camera shakes and pulls back. Photoreal disaster-film physics. Audio: rumbling roar, wings, breaking glass; no music, no voice.

**First-person free fall (5 s)**
> Terminal-velocity free fall: the camera tumbles and spins, wind buffeting, the smoking airliner above shrinks into the clouds, heavy debris plummets past faster than the camera, the ocean rushes up toward the lens, intense motion blur, realistic gravity, nothing floats. No hands, no feet, no people visible.

## Sources

Synthesized from third-party H3 guides (MiniMax's own docs were not directly reachable) and the Hoodsfield render tests:
- https://www.atlascloud.ai/blog/tips/minimax-h3-prompt-guide
- https://www.weshop.ai/solutions/models/mini-max-h3-prompt-guide-formula-storyboards-templates-and-common-mistakes
- https://www.kapwing.com/resources/how-to-prompt-minimax-h3-hailuo-3-0-a-guide-for-ai-video-creators/
- https://leadde.ai/blog/mini-max-h3-prompt-guide
Field names and limits differ slightly between guides; treat them as community guidance and verify against MiniMax's documentation.
