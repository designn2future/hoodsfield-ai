"""Hoodsfield Originals: short films for the Explore page, made end to end by the app's own pipeline.

For each film: Flux 3 stills -> Wan 2.2 clips (4 s each) -> Real-ESRGAN 2x -> ffmpeg edit (cross-dissolves, colour grade,
vignette, film grain, burned-in captions, title card) + a Stable Audio Open score generated in ComfyUI.
Phases are grouped by model family (all stills, then all clips, then all upscales) so the GPU swaps models as rarely as possible.

    backend\\.venv\\Scripts\\python.exe tools\\make_films.py [--only marfa,hallway,train] [--phase stills|clips|upscale|assemble]

Everything is cached in D:\\vsa_work\\films, so it can be stopped and resumed.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import make_showcase as ms  # noqa: E402  (reuses its ComfyUI job helpers; its __main__ block does not run on import)
from PIL import Image, ImageDraw, ImageFilter  # noqa: E402

OUT = ms.OUT
FILMS_DIR = ms.WORK / "films"
FILMS_DIR.mkdir(exist_ok=True)
log = ms.log
V, H_ = (1080, 1920), (1920, 1080)

FILMS = [
    {
        "id": "marfa", "title": "LIGHTS OVER MARFA", "tagline": "2:14 AM. West Texas. Something is above the road.",
        "genre": "UFO · found footage", "aspect": "9:16", "size": V, "flux": (768, 1344),
        "grade": "eq=contrast=1.12:saturation=0.82:brightness=-0.03,colorbalance=bs=0.08:bm=0.05:rs=-0.04",
        "audio": "low ominous drone, distant desert wind, faint electronic hum slowly rising, deep sub bass swell, cinematic horror sound design, no melody",
        "shots": [
            {"still": "A lone pickup truck parked on a desert highway at night under an enormous starry sky, three faint amber lights hanging above the horizon, long exposure feel, cinematic, photorealistic, vertical composition",
             "motion": "Slow push-in toward the truck, the three amber lights drift slightly, dust moves across the road, stars twinkle", "caption": "Marfa, Texas. 2:14 AM."},
            {"still": "Close-up of a young woman's face lit by dim headlight glow, looking up at the sky with fear and awe, three small amber lights reflected in her eyes, night, shallow depth of field, photorealistic",
             "motion": "She slowly lifts her chin and stares upward, her eyes widen, hair stirs in the wind, subtle handheld movement", "caption": "They weren't stars."},
            {"still": "Three glowing amber orbs in a perfect triangle formation hovering above a dark mountain ridge line at night, faint haze, stars, cinematic wide shot, photorealistic",
             "motion": "The three orbs glide slowly across the sky in formation and flicker softly, clouds drift, camera slowly pans right", "caption": "They moved together."},
            {"still": "A field of cattle at night illuminated by a single wide column of white light shining down from above, grass flattened, dust swirling, cinematic, photorealistic, vertical composition",
             "motion": "Grass whips and swirls violently in the beam, dust rises into the light, the light slowly intensifies, cattle stand frozen", "caption": "Then everything went silent."},
            {"still": "A massive dark triangular craft hanging silently above a desert highway and a tiny pickup truck, three dim lights on its underside, vast scale, night sky, cinematic, photorealistic",
             "motion": "Slow tilt up revealing the enormous scale of the dark craft above, the underside lights pulse slowly, the truck stays still", "caption": "It was already above us."},
        ],
        "end": ("LIGHTS OVER MARFA", "FOUND FOOTAGE"),
        "tips": ["Open on the stillest, widest frame so the first move is the scare.", "Hold captions to 3-5 words; viewers read them in half a second.", "Cut on the light, not the sound: the beam is your match cut."],
    },
    {
        "id": "hallway", "title": "DON'T LOOK BEHIND YOU", "tagline": "Third floor. Power's out. Someone left the bathroom door open.",
        "genre": "Horror", "aspect": "9:16", "size": V, "flux": (768, 1344),
        "grade": "eq=contrast=1.18:saturation=0.7:brightness=-0.05,colorbalance=gs=0.06:gm=-0.03:bs=0.06",
        "audio": "dark ambient horror drone, distant creaking wood, slow heartbeat, dissonant strings swelling, cinematic sound design, no melody",
        "shots": [
            {"still": "A long dark hallway in an old apartment building, a single flickering bulb, peeling wallpaper, a girl in a hoodie walking away holding a flashlight, cinematic horror, photorealistic, vertical composition",
             "motion": "Handheld camera slowly follows her down the hallway, the bulb flickers, her flashlight beam sways on the walls", "caption": "Power's been out for an hour."},
            {"still": "Extreme close-up of a frightened girl's face lit by a flashlight from below, sweat on her forehead, wide eyes, listening intently, dark background, photorealistic, cinematic horror",
             "motion": "Slow push-in on her face, her eyes dart to the side, she holds her breath, slight handheld shake", "caption": "Did you hear that?"},
            {"still": "A bathroom mirror reflecting the girl from behind, and in the reflection a door behind her stands slightly open into darkness, harsh cold light, grime, cinematic horror, photorealistic",
             "motion": "The door in the reflection slowly creaks open wider into the dark, the light flickers, she does not move", "caption": "That door was closed."},
            {"still": "A flashlight beam sweeping a dim bedroom and revealing a tall pale figure standing motionless in the far corner, long limbs, face turned away, cinematic horror, photorealistic, vertical composition",
             "motion": "The flashlight beam sweeps across the room and settles on the tall figure, the figure stays perfectly still, light flickers", "caption": "Don't turn around."},
            {"still": "Extreme close-up of a human eye in the dark, the pupil reflecting a tall pale silhouette standing right behind, shallow depth of field, cinematic horror, photorealistic",
             "motion": "The pupil dilates slowly and the reflected silhouette steps closer, light flickers, a single tear runs down", "caption": "It was never in the house."},
        ],
        "end": ("DON'T LOOK BEHIND YOU", "HORROR SHORT"),
        "tips": ["Put the scare one beat later than viewers expect.", "Silence before the reveal: drop the bed to nothing for half a second.", "A reflection is the cheapest jump-scare staging there is."],
    },
    {
        "id": "train", "title": "LAST TRAIN", "tagline": "A winter night. One platform. One more chance.",
        "genre": "Cinematic drama", "aspect": "9:16", "size": V, "flux": (768, 1344),
        "grade": "eq=contrast=1.08:saturation=0.92,colorbalance=rs=0.05:bs=-0.04:rh=0.03:bh=-0.02",
        "audio": "melancholic cinematic ambient pads with soft felt piano, distant train rumble, gentle rain, emotional, slow, no drums",
        "shots": [
            {"still": "An empty subway platform at night, wet reflective floor, a single glowing station sign, cold blue and warm sodium light, cinematic wide shot, anamorphic, photorealistic",
             "motion": "Slow dolly forward along the platform, light flickers on the wet floor, mist drifts across", "caption": "11:48 PM"},
            {"still": "A woman in a long camel coat waiting alone on a train platform, breath visible in the cold air, looking down the tunnel, shallow depth of field, cinematic, photorealistic",
             "motion": "She shifts her weight and looks down the tunnel, breath fogs, hair moves in the draft, slight push-in", "caption": "The last train of the night."},
            {"still": "A subway train arriving at a platform, headlights sweeping across the tiled walls and the woman, motion blur, cinematic, anamorphic lens flare, photorealistic",
             "motion": "The train rolls in, headlights sweep across the platform and her face, her coat whips in the wind", "caption": "Then it was here."},
            {"still": "Through a train window at night, the city skyline rolling by with soft bokeh lights, the faint reflection of a woman's face in the glass, cinematic, photorealistic",
             "motion": "City lights stream past the window, the reflection of her face stays still, subtle rattle of the train", "caption": "Some goodbyes take a whole city."},
            {"still": "A woman in a camel coat stepping off a train onto a quiet snowy station platform at dawn, soft pink sky, snow falling, cinematic wide shot, photorealistic",
             "motion": "She steps onto the platform and walks forward, snow falls gently, soft dawn light grows, camera slowly pulls back", "caption": "Morning."},
        ],
        "end": ("LAST TRAIN", "A SHORT FILM"),
        "tips": ["Match the cut to the train's headlights for a free transition.", "Let the final shot breathe: 4 seconds of quiet beats another caption.", "Pad the score a half-second early so the music leads the picture."],
    },
]


def font(name, size):
    return ms.font(name, size)


def caption_png(text, size, path):
    w, h = size
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    fs = int(h * 0.036) if h > w else int(h * 0.052)
    f = font("segoeuib.ttf", fs)
    # wrap to ~86% width
    words, lines, cur = text.split(), [], ""
    for wd in words:
        t = f"{cur} {wd}".strip()
        if d.textlength(t, font=f) > w * 0.86 and cur:
            lines.append(cur); cur = wd
        else:
            cur = t
    lines.append(cur)
    lh = int(fs * 1.25)
    y0 = int(h * (0.76 if h > w else 0.84)) - (len(lines) - 1) * lh // 2
    for i, ln in enumerate(lines):
        tw = d.textlength(ln, font=f)
        x = (w - tw) / 2
        y = y0 + i * lh
        shadow = Image.new("RGBA", size, (0, 0, 0, 0))
        ImageDraw.Draw(shadow).text((x, y + 4), ln, font=f, fill=(0, 0, 0, 230))
        im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(6)))
        d.text((x, y), ln, font=f, fill=(255, 255, 255, 255), stroke_width=max(2, fs // 16), stroke_fill=(0, 0, 0, 255))
    im.save(path)


def title_png(title, sub, size, path):
    w, h = size
    im = Image.new("RGB", size, (0, 0, 0))
    d = ImageDraw.Draw(im)
    fs = int(h * 0.05) if h > w else int(h * 0.09)
    f, f2 = font("segoeuib.ttf", fs), font("segoeui.ttf", int(fs * 0.42))
    words, lines, cur = title.split(), [], ""
    for wd in words:
        t = f"{cur} {wd}".strip()
        if d.textlength(t, font=f) > w * 0.84 and cur:
            lines.append(cur); cur = wd
        else:
            cur = t
    lines.append(cur)
    lh = int(fs * 1.2)
    y = h / 2 - (len(lines) * lh) / 2 - fs * 0.4
    for ln in lines:
        d.text(((w - d.textlength(ln, font=f)) / 2, y), ln, font=f, fill=(255, 255, 255))
        y += lh
    d.line(((w * 0.4, y + fs * 0.2), (w * 0.6, y + fs * 0.2)), fill=ms.ACCENT, width=3)
    d.text(((w - d.textlength(sub, font=f2)) / 2, y + fs * 0.45), sub, font=f2, fill=ms.ACCENT)
    im.save(path)


def score(film, seconds):
    """Stable Audio Open (local, via ComfyUI) -> flac path."""
    out = FILMS_DIR / f"{film['id']}_score.flac"
    if out.exists():
        return out
    g = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "stable_audio_open_1.0.safetensors"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5_base_stable_audio.safetensors", "type": "stable_audio"}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": film["audio"], "clip": ["2", 0]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "vocals, speech, drums, bright cheerful music, distortion, noise", "clip": ["2", 0]}},
        "5": {"class_type": "ConditioningStableAudio", "inputs": {"positive": ["3", 0], "negative": ["4", 0], "seconds_start": 0.0, "seconds_total": float(seconds)}},
        "6": {"class_type": "EmptyLatentAudio", "inputs": {"seconds": float(seconds), "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {"seed": 7, "steps": 60, "cfg": 5.0, "sampler_name": "dpmpp_3m_sde_gpu", "scheduler": "exponential",
                                                    "denoise": 1.0, "model": ["1", 0], "positive": ["5", 0], "negative": ["5", 1], "latent_image": ["6", 0]}},
        "8": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["7", 0], "vae": ["1", 2]}},
        "9": {"class_type": "SaveAudio", "inputs": {"audio": ["8", 0], "filename_prefix": f"vsa/score_{film['id']}"}},
    }
    r = ms.c.post("http://127.0.0.1:8188/prompt", json={"prompt": g})
    r.raise_for_status()
    pid = r.json()["prompt_id"]
    for _ in range(600):
        h = ms.c.get(f"http://127.0.0.1:8188/history/{pid}").json()
        if pid in h:
            files = h[pid]["outputs"]["9"]["audio"][0]
            data = ms.c.get("http://127.0.0.1:8188/view", params={"filename": files["filename"], "subfolder": files["subfolder"], "type": files["type"]}).content
            out.write_bytes(data)
            return out
        time.sleep(2)
    raise RuntimeError("score timed out")


def probe_dur(p):
    r = subprocess.run([ms.FF, "-hide_banner", "-i", str(p)], capture_output=True, text=True).stderr
    import re
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", r)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def assemble(film):
    fid, (W, Hh) = film["id"], film["size"]
    XF, END = 0.4, 1.4
    clips = [FILMS_DIR / f"{fid}_s{i}_up.mp4" for i in range(len(film["shots"]))]
    durs = [probe_dur(p) for p in clips]
    # normalise every clip to the delivery size/fps, then chain xfades
    norm = []
    for i, p in enumerate(clips):
        n = FILMS_DIR / f"{fid}_s{i}_n.mp4"
        ms.ff("-i", p, "-vf", f"scale={W}:{Hh}:force_original_aspect_ratio=increase:flags=lanczos,crop={W}:{Hh},setsar=1,fps=30,format=yuv420p",
              "-an", "-c:v", "libx264", "-crf", 14, "-preset", "slow", n)
        norm.append(n)
    chain, cur, t_acc = [], "[v0]", durs[0]
    inputs = []
    for p in norm:
        inputs += ["-i", p]
    for i in range(len(norm)):   # one timebase for every input, or xfade refuses to link them
        chain.append(f"[{i}:v]setpts=PTS-STARTPTS,fps=30[v{i}]")
    for i in range(1, len(norm)):
        off = t_acc - XF
        chain.append(f"{cur}[v{i}]xfade=transition=fade:duration={XF}:offset={off:.3f}[x{i}]")
        cur = f"[x{i}]"
        t_acc = off + durs[i]
    body_dur = t_acc
    # title card
    tp = FILMS_DIR / f"{fid}_title.png"
    title_png(film["end"][0], film["end"][1], (W, Hh), tp)
    n_in = len(norm)
    inputs += ["-loop", 1, "-t", END, "-framerate", 30, "-i", tp]
    chain.append(f"[{n_in}:v]setpts=PTS-STARTPTS,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st={END - 0.4}:d=0.4,fps=30[card]")
    chain.append(f"{cur}[card]xfade=transition=fade:duration=0.5:offset={body_dur - 0.5:.3f}[vid]")
    total = body_dur - 0.5 + END
    # captions: one PNG per shot, faded in/out, shown over the middle of each shot
    cur = "[vid]"
    starts = []
    acc = 0.0
    for i, d in enumerate(durs):
        starts.append(acc)
        acc += d - XF
    k = n_in + 1
    for i, shot in enumerate(film["shots"]):
        cp = FILMS_DIR / f"{fid}_cap{i}.png"
        caption_png(shot["caption"], (W, Hh), cp)
        cs, cd = starts[i] + 0.7, min(2.6, durs[i] - 1.2)
        inputs += ["-loop", 1, "-t", f"{cd:.2f}", "-framerate", 30, "-i", cp]
        chain.append(f"[{k}:v]format=rgba,fade=t=in:st=0:d=0.3:alpha=1,fade=t=out:st={cd - 0.3:.2f}:d=0.3:alpha=1,setpts=PTS+{cs:.2f}/TB[c{i}]")
        chain.append(f"{cur}[c{i}]overlay=0:0:eof_action=pass[o{i}]")
        cur = f"[o{i}]"
        k += 1
    # grade + vignette + grain on top of everything but the title card timing is fine (subtle)
    chain.append(f"{cur}{film['grade']},vignette=PI/5,noise=alls=6:allf=t,format=yuv420p[final]")
    sc = score(film, int(total) + 2)
    inputs += ["-i", sc]
    out = FILMS_DIR / f"{fid}_final.mp4"
    ms.ff(*inputs, "-filter_complex", ";".join(chain), "-map", "[final]", "-map", f"{k}:a",
          "-af", f"afade=t=in:st=0:d=1.2,afade=t=out:st={total - 1.6:.2f}:d=1.6,loudnorm=I=-16:TP=-1.5:LRA=9",
          "-t", f"{total:.2f}", "-c:v", "libx264", "-crf", 17, "-preset", "slow", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
          "-movflags", "+faststart", out)
    return out, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--phase", default="all")
    a = ap.parse_args()
    films = [f for f in FILMS if not a.only or f["id"] in a.only.split(",")]
    ph = a.phase

    if ph in ("all", "stills"):
        for f in films:
            for i, s in enumerate(f["shots"]):
                ms.flux(f"film_{f['id']}_s{i}.png", s["still"], w=f["flux"][0], h=f["flux"][1], seed=700 + i * 13 + len(f["id"]))
        log("stills done")
    if ph in ("all", "clips"):
        for f in films:
            for i, s in enumerate(f["shots"]):
                still = ms.WORK / f"film_{f['id']}_s{i}.png"
                clip = ms.wan(f"film_{f['id']}_s{i}.mp4", still, s["motion"], seconds=4, aspect=f["aspect"], mp=0.4)
                log("clip", f["id"], i)
    if ph in ("all", "upscale"):
        for f in films:
            for i, _ in enumerate(f["shots"]):
                up = FILMS_DIR / f"{f['id']}_s{i}_up.mp4"
                if up.exists():
                    continue
                src = ms.WORK / f"film_{f['id']}_s{i}.mp4"
                up.write_bytes(ms.job("/api/tools/finalize", {"scale": 2, "smooth": 1}, [("file", (src.name, src.read_bytes(), "video/mp4"))]))
                log("upscaled", f["id"], i)
    if ph in ("all", "assemble"):
        meta = []
        for f in films:
            out, total = assemble(f)
            dst = OUT / f"film_{f['id']}.mp4"
            ms.ff("-i", out, "-c", "copy", "-movflags", "+faststart", dst)
            ms.ff("-ss", total * 0.38, "-i", out, "-frames:v", 1, "-q:v", 3, OUT / f"film_{f['id']}.jpg")
            meta.append({k: f[k] for k in ("id", "title", "tagline", "genre", "aspect", "tips")} | {
                "video": f"film_{f['id']}.mp4", "poster": f"film_{f['id']}.jpg", "seconds": round(total, 1),
                "shots": [{"n": i + 1, "prompt": s["still"], "motion": s["motion"], "caption": s["caption"]} for i, s in enumerate(f["shots"])],
                "score": f["audio"]})
            log("film done", f["id"], round(total, 1), "s")
        p = OUT / "films.json"
        old = {m["id"]: m for m in (json.loads(p.read_text(encoding="utf-8")) if p.exists() else [])}
        for m in meta:
            old[m["id"]] = m
        order = [f["id"] for f in FILMS]
        p.write_text(json.dumps([old[i] for i in order if i in old], indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
