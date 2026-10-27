# Seamless loops (study, lofi and sleep videos)

The long "study with me" and lofi videos on YouTube are usually one calm scene (a rainy window, a forest, a fireplace) with a little motion that repeats for hours under a music track. The hard part is the loop: the end has to hand over to the start so smoothly that nobody can tell where it wraps. **Seamless Loop Studio** does that on your own PC.

Open it from the **Loops** icon in the left rail, **Create → Seamless Loops**, or the *Seamless study loop* chip on Home.

## Two ways to build a loop (and a way to combine them)

| | **AI clip** | **Layers** |
|---|---|---|
| How | An image-to-video model animates your picture, Hoodsfield steadies it and finds the loop | A perfectly still picture with effect layers on top, blended with screen / add / soft light, like an After Effects comp |
| Good at | Organic, surprising motion: glowing lotuses, flowing water, curtains of aurora | Perfect stillness, crisp detail, exact control, any length |
| Seamless because | the best loop point is found and the join is blended | every layer runs on an exact cycle, so the last frame is followed by the first (frame N equals frame 0) |
| Needs the GPU | yes | no |

**The best results combine them.** Make the AI loop first, then press **Add effect layers on top**: sparkling stars, drifting petals, fireflies, film grain and a vignette ride on top of the AI motion at full resolution.

### Templates: the quickest way to see how it works
At the top of the page, **New here? Open a ready-made template** opens a scene with its layers already set up (an *Enchanted paradise* with an aurora, waterfalls, petals and fireflies, and a *Cozy rainy study room*). Everything is editable: switch layers off, move the sliders, change colours and blend modes, press **Preview a frame** to see the result instantly, then **Render the loop**. Templates need no GPU, so they work on any PC.

## The three steps

### 1. Your scene
- **Animate a picture.** Drop a calm, wide picture (make one in Make Image first if you like). Pick a mood (rainy window, forest and falling leaves, fireplace, snowfall, city at night, sunset by the sea), adjust the motion text if you want, choose MiniMax H3 (up to 7 s, best detail) or Wan 2.2 (5 s, very steady), and press **Animate this picture**.
  - *Make it loop-friendly* sends your picture as both the first and the last frame, so the motion tends to return to where it started.
  - Every prompt starts with "the camera is completely locked off" and ends with "everything else stays perfectly still, no people, no sudden changes", because anything that *happens* is what a viewer notices on repeat.
- **I already have a clip.** Drop any short clip (3 to 30 seconds) with calm, steady motion.

### 2. Make it seamless
Press **Make the seamless loop**. Hoodsfield steadies the picture, finds the start point and length where the clip matches itself best, freezes everything that is not meant to move, and cross-fades the join. You get:
- the loop, playing on repeat right in the page;
- a **seam rating** (*Seamless*, *Very good*, *Check the seam*, *Visible seam*), measured by comparing the jump at the wrap with the biggest step the loop makes by itself;
- **Watch the seam** to jump to the last second and see it wrap;
- **Hold the picture still** (default 70%): how firmly the background is locked. **Show what moves** displays the result: white is animated, black is held perfectly still;
- an optional **Upscale to 1080p** (Real-ESRGAN) that keeps the loop seamless, because every frame is upscaled the same way.

If the clip contains something sudden (an object moved, a flash, a cut), the page tells you when, and builds the loop from the calmest stretch.

### 3. Export a long video
Choose 10 minutes up to 3 hours (or type your own), optionally add **your music**. With music you can make the video exactly as long as the track, with a fade-out at the end. The picture is **copied, not re-encoded**, so even three hours takes seconds and every repeat is bit-identical. (A heavy loop, for example 1080p with film grain, is compressed once to about 9 Mbps first, otherwise hours of it would run to tens of gigabytes. Expect roughly 1.2 GB per hour at 1080p.) The file is saved to `Hoodsfield_Output/Loops` and offered for download.

## Layers

| Layer | What it does |
|---|---|
| Rain, Snow, Petals & leaves, Fireflies & orbs, Twinkling stars | Particles that fall, sway, tumble, drift on slow loops or twinkle. Optional **area** limits some to part of the picture (for example rain only through the window) |
| Mist, Aurora glow | Tiling noise scrolled by a whole texture width per loop, tinted and placed in the sky or along the ground |
| Waterfall flow, Water glitter | Find the bright, nearly colourless parts of your picture (waterfalls) or the lower part (a lake) and stream or sparkle only there |
| Light flicker, Camera breathing | Lamps and glows breathe softly; a tiny slow push-in and back (about 1.7 % at most) |
| Vignette, Film grain | Darker corners; fine moving grain over everything |

Each layer has **Amount**, **Speed** (whole turns per loop), **Opacity**, a **colour** where it makes sense and a **blend mode**. Rendering is plain numpy (no GPU); a 10 second 1080p loop takes about 5 to 8 minutes.

**Verified.** For every layer and for both templates, frame N is bit-for-bit frame 0 (largest difference 4e-16, floating-point rounding) at 6, 10 and 13 second lengths.

## Why AI video loops show a slow dissolve, and what Hoodsfield does about it

A plain cross-fade between the end and the start of an AI clip is visible even when the two frames look alike, because **video models cannot hold a picture perfectly still**. In a rainy-window test the first four seconds of a "locked-off" clip slowly zoomed by about 2 percent (the whole picture slid 10 to 20 pixels at the edges) before settling, and afterwards every surface kept shimmering by a few brightness levels. Blend two such moments and the whole picture visibly dissolves and "breathes" at the seam.

So the loop is built in four steps:

1. **Stabilise.** Each frame's drift against the clip's steady state is measured (phase correlation on a grid of blocks, a robust affine fit for shift and zoom) and warped back. Frames from the settling period are skipped, and the small border that stabilising uncovers is cropped away.
2. **Find the still plate.** The per-pixel median of the loop is a clean, noise-free picture.
3. **Find what really moves.** The per-pixel activity around the plate marks rain, steam, leaves, flames and twinkling lights.
4. **Freeze the rest.** Everything that is not meant to move is replaced by the plate, so it is identical in every frame and cannot dissolve. Only the moving parts keep their motion and take part in the cross-fade. Brightness is also levelled frame to frame.

Measured on the rainy-window clip: the first and last frame differed by 1.84 brightness levels on average across the whole picture before, and by 0.69 afterwards, with the difference confined to the steam, plant and lamp light. 78 to 89 percent of the pixels are held perfectly still, and the brightness drift over the loop fell from 2.7 to 0.17 levels.

## How the seamless join works

Pick a start frame `a` and a loop length `N`. The loop plays source frames `a … a+N-1`, and its first `L` frames are a smooth cross-fade from the frames that would have come *after* the loop (`a+N …`) into the real frames at the start. When the loop wraps, the last frame is followed by something that looks like the next source frame, so the motion continues instead of jumping.

The choice of `(a, N)` matters a lot: Hoodsfield compares every frame with every other frame and picks the pair where those two cross-faded streams look most alike, so the blend has almost nothing to hide. It never picks a stretch that contains a jump in the footage.

In a test with a generated rainy-window scene, all 19 repeat boundaries of a 95 second export had a frame-to-frame change smaller than the largest change the loop makes on its own, which is what "can't be told apart from ordinary motion" means in numbers.

## Tips for a clean result

- Lock the camera and ask for **one or two tiny motions**: swaying leaves, rain, steam, flickering light.
- No people, hands, text or lighting changes.
- Don't use physics words ("things fall"). In a calm scene they make the model knock objects around; the H3 prompt coach leaves that line out for calm prompts.
- A longer source gives a longer, less obvious loop. 7 seconds is the practical maximum from one H3 clip; you can also chain two clips on the Timeline and loop the result.
- If the background still seems to breathe, raise **Hold the picture still**. If something you wanted to move looks frozen, lower it.
- If the rating says *Check the seam* or *Visible seam*, generate again with less movement or make the blend longer.

## Uploading to YouTube

Export at 1080p (use the upscale button), keep the music track the length of the video, and upload. For very long videos (several hours) the file is a few GB because the picture is stored once per repeat; the export is already a standard H.264 MP4. Make sure you have the rights to the music you use.

## Limits

- Needs a clip with a mostly steady camera. A slow push-in or pan cannot loop (a small unwanted zoom or drift is corrected; a deliberate camera move is not).
- The loop length is limited by the source: about 4 to 6 seconds from one 7 second clip.
- Audio inside the clip is dropped; the export uses the music you add (or silence).
