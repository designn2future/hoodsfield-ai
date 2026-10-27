# Seamless loops (study, lofi and sleep videos)

The long "study with me" and lofi videos on YouTube are usually one calm scene (a rainy window, a forest, a fireplace) with a little motion that repeats for hours under a music track. The hard part is the loop: the end has to hand over to the start so smoothly that nobody can tell where it wraps. **Seamless Loop Studio** does that on your own PC.

Open it from the **Loops** icon in the left rail, **Create → Seamless Loops**, or the *Seamless study loop* chip on Home.

## The three steps

### 1. Your scene
- **Animate a picture.** Drop a calm, wide picture (make one in Make Image first if you like). Pick a mood (rainy window, forest and falling leaves, fireplace, snowfall, city at night, sunset by the sea), adjust the motion text if you want, choose MiniMax H3 (up to 7 s, best detail) or Wan 2.2 (5 s, very steady), and press **Animate this picture**.
  - *Make it loop-friendly* sends your picture as both the first and the last frame, so the motion tends to return to where it started.
  - Every prompt starts with "the camera is completely locked off" and ends with "everything else stays perfectly still, no people, no sudden changes", because anything that *happens* is what a viewer notices on repeat.
- **I already have a clip.** Drop any short clip (3 to 30 seconds) with calm, steady motion.

### 2. Make it seamless
Press **Make the seamless loop**. Hoodsfield looks at every frame of your clip, finds the start point and length where the clip matches itself best, and cross-fades the join. You get:
- the loop, playing on repeat right in the page;
- a **seam rating** (*Seamless*, *Very good*, *Check the seam*, *Visible seam*), measured by comparing the jump at the wrap with the biggest step the loop makes by itself;
- **Watch the seam** to jump to the last second and see it wrap;
- an optional **Upscale to 1080p** (Real-ESRGAN) that keeps the loop seamless, because every frame is upscaled the same way.

If the clip contains something sudden (an object moved, a flash, a cut), the page tells you when, and builds the loop from the calmest stretch.

### 3. Export a long video
Choose 10 minutes up to 3 hours (or type your own), optionally add **your music**. With music you can make the video exactly as long as the track, with a fade-out at the end. The picture is **copied, not re-encoded**, so even three hours takes seconds and every repeat is bit-identical. The file is saved to `Hoodsfield_Output/Loops` and offered for download.

## How the seamless join works

Pick a start frame `a` and a loop length `N`. The loop plays source frames `a … a+N-1`, and its first `L` frames are a smooth cross-fade from the frames that would have come *after* the loop (`a+N …`) into the real frames at the start. When the loop wraps, the last frame is followed by something that looks like the next source frame, so the motion continues instead of jumping.

The choice of `(a, N)` is the whole trick: Hoodsfield compares every frame with every other frame and picks the pair where those two cross-faded streams look most alike, so the blend has almost nothing to hide. It never picks a stretch that contains a jump in the footage.

In a test with a generated rainy-window scene, all 19 repeat boundaries of a 95 second export had a frame-to-frame change smaller than the largest change the loop makes on its own, which is what "can't be told apart from ordinary motion" means in numbers.

## Tips for a clean result

- Lock the camera and ask for **one or two tiny motions**: swaying leaves, rain, steam, flickering light.
- No people, hands, text or lighting changes.
- Don't use physics words ("things fall"). In a calm scene they make the model knock objects around; the H3 prompt coach leaves that line out for calm prompts.
- A longer source gives a longer, less obvious loop. 7 seconds is the practical maximum from one H3 clip; you can also chain two clips on the Timeline and loop the result.
- If the rating says *Check the seam* or *Visible seam*, generate again with less movement or make the blend longer.

## Uploading to YouTube

Export at 1080p (use the upscale button), keep the music track the length of the video, and upload. For very long videos (several hours) the file is a few GB because the picture is stored once per repeat; the export is already a standard H.264 MP4. Make sure you have the rights to the music you use.

## Limits

- Needs a clip with a mostly steady camera. A slow push-in or pan cannot loop.
- The loop length is limited by the source: about 4 to 6 seconds from one 7 second clip.
- Audio inside the clip is dropped; the export uses the music you add (or silence).
