"""
Regenerates the Home-screen banner clips (frontend/public/showcase/*.mp4 + *.jpg)
using THIS app's own backend — every banner is a live demo of the feature it
advertises. Needs the backend (:8000) and ComfyUI running. ~40 min on an RTX 4060 Ti.

    backend\\.venv\\Scripts\\python.exe tools\\make_showcase.py [--only hero,flux,...] [--force]

Steps are resumable: finished intermediates live in VSA_WORK_DIR/showcase and are
skipped on the next run. All subjects are original / unbranded.
"""

import argparse
import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "frontend" / "public" / "showcase"
WORK = Path(os.getenv("VSA_WORK_DIR", r"D:\vsa_work")) / "showcase"
BASE = "http://127.0.0.1:8000"
OUT.mkdir(parents=True, exist_ok=True)
WORK.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(HERE.parent / "backend"))
from audio_analysis import ffmpeg_exe  # noqa: E402

FF = ffmpeg_exe()
c = httpx.Client(timeout=httpx.Timeout(60.0, read=3000.0), trust_env=False)
W, H = 960, 540


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def ff(*args):
    r = subprocess.run([FF, "-y", "-hide_banner", "-loglevel", "error", *map(str, args)], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr[-2500:])


def job(endpoint, data, files=None) -> bytes:
    r = c.post(BASE + endpoint, data={k: str(v) for k, v in data.items() if v is not None}, files=files)
    if r.status_code != 200:
        raise RuntimeError(f"{endpoint}: {r.status_code} {r.text[:400]}")
    jid = r.json()["job_id"]
    with c.stream("GET", f"{BASE}/api/events/{jid}") as s:
        for line in s.iter_lines():
            if line.startswith("data:"):
                ev = json.loads(line[5:])
                if ev["type"] == "done":
                    return c.get(BASE + ev["url"]).content
                if ev["type"] == "error":
                    raise RuntimeError(ev["text"])
    raise RuntimeError("no result")


def cached(name, fn, force=False) -> Path:
    p = WORK / name
    if p.exists() and not force:
        return p
    log("make", name)
    p.write_bytes(fn())
    return p


def flux(name, prompt, w=1344, h=768, seed=7, refs=(), match=False, force=False) -> Path:
    files = [("refs", (Path(r).name, Path(r).read_bytes(), "image/png")) for r in refs] or None
    return cached(name, lambda: job("/api/generate_flux3", {"prompt": prompt, "width": w, "height": h, "steps": 8,
                                                           "seed": seed, "match_ref_size": str(match).lower()}, files), force)


def wan(name, still: Path, prompt, seconds=3, aspect="16:9", mp=0.3, force=False) -> Path:
    return cached(name, lambda: job("/api/generate_wan", {"prompt": prompt, "seconds": seconds, "aspect": aspect,
                                                         "megapixels": mp, "smooth": "true"},
                                    [("image", (still.name, still.read_bytes(), "image/png"))]), force)


def norm(src: Path, dst: Path, vf="", dur=None):
    """Normalise any clip to 960x540 H.264, no audio, web-friendly."""
    scale = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1,fps=30"
    ff("-i", src, "-vf", f"{scale}{(',' + vf) if vf else ''}", *( ["-t", dur] if dur else []), "-an",
       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "27", "-preset", "slow", "-movflags", "+faststart", dst)
    ff("-i", dst, "-frames:v", 1, "-q:v", 4, dst.with_suffix(".jpg"))


def slideshow(images: list[Path], dst: Path, each=1.2, fade=0.35, zoom=True):
    """Crossfaded Ken-Burns slideshow."""
    clips = []
    for i, im in enumerate(images):
        cp = WORK / f"_ss_{dst.stem}_{i}.mp4"
        frames = int((each + fade) * 30)
        z = (f"zoompan=z='min(zoom+0.0006,1.12)':d={frames}:s={W}x{H}:fps=30" if zoom else f"scale={W}:{H}")
        ff("-loop", 1, "-i", im, "-vf", f"scale={W*2}:{H*2}:force_original_aspect_ratio=increase,crop={W*2}:{H*2},{z}",
           "-t", each + fade, "-pix_fmt", "yuv420p", cp)
        clips.append(cp)
    args, filt, last = [], "", "[0:v]"
    for cp in clips:
        args += ["-i", cp]
    t = each
    for i in range(1, len(clips)):
        filt += f"{last}[{i}:v]xfade=transition=fade:duration={fade}:offset={t:.2f}[v{i}];"
        last, t = f"[v{i}]", t + each
    ff(*args, "-filter_complex", filt.rstrip(";"), "-map", last, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "27", dst)


def wipe(a: Path, b: Path, dst: Path, hold=0.8, dur=1.0, transition="wiperight"):
    """a -> b with a wipe; both held for `hold` s."""
    cps = []
    for n, im in (("a", a), ("b", b)):
        cp = WORK / f"_wipe_{dst.stem}_{n}.mp4"
        ff("-loop", 1, "-i", im, "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps=30",
           "-t", hold + dur, "-pix_fmt", "yuv420p", cp)
        cps.append(cp)
    ff("-i", cps[0], "-i", cps[1], "-filter_complex", f"[0:v][1:v]xfade=transition={transition}:duration={dur}:offset={hold}[v]",
       "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "27", dst)


def hstack(a: Path, b: Path, dst: Path):
    half = W // 2
    ff("-i", a, "-i", b, "-filter_complex",
       f"[0:v]scale={half}:{H}:force_original_aspect_ratio=increase,crop={half}:{H},setsar=1,fps=30[l];"
       f"[1:v]scale={half}:{H}:force_original_aspect_ratio=increase,crop={half}:{H},setsar=1,fps=30[r];[l][r]hstack=2[v]",
       "-map", "[v]", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "27", dst)


def concat(parts: list[Path], dst: Path):
    lst = WORK / f"_cat_{dst.stem}.txt"
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts))
    ff("-f", "concat", "-safe", 0, "-i", lst, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "27", dst)


# ---------------------------------------------------------------- showcase steps

def step_hero(force):
    s = flux("hero.png", "Cinematic still of a lone woman in a glossy yellow raincoat walking away down a narrow neon-lit alley in heavy rain at night, "
             "steam rising from vents, reflections on wet asphalt, teal and magenta neon signs, anamorphic lens flare, shallow depth of field, shot on ARRI Alexa 35", force=force)
    v = wan("hero_wan.mp4", s, "A lone woman in a yellow raincoat walks away down a rainy neon alley, rain streaking through the light, steam drifting from vents, "
            "neon signs flickering and reflecting on the wet street. The camera glides slowly forward behind her. Cinematic, moody.", force=force)
    norm(v, OUT / "hero.mp4")


def step_flux(force):
    prompts = [
        "Close-up portrait of an elderly sailor with a weathered face and white beard, soft window light, 85mm, f/1.4",
        "Macro product photograph of a crystal perfume bottle on white marble with soft caustic reflections, studio lighting",
        "A turquoise alpine lake surrounded by snow peaks at sunrise, golden light on the ridges, wide angle",
        "A steaming bowl of ramen with soft egg, scallions and chili oil, moody restaurant lighting, shallow depth of field",
        "Interior of a futuristic library with curved white wood shelves and a glass dome flooded with daylight, architectural photography",
        "A vast castle on a cliff with a dragon circling at dusk, epic fantasy matte painting, dramatic clouds",
    ]
    imgs = [flux(f"flux_{i}.png", p, seed=100 + i, force=force) for i, p in enumerate(prompts)]
    slideshow(imgs, WORK / "flux_raw.mp4", each=0.9, fade=0.3)
    norm(WORK / "flux_raw.mp4", OUT / "flux.mp4")


def step_cinema(force):
    s = flux("cinema.png", "Epic wide shot of an ancient moss-covered stone temple in a misty jungle at sunrise, god rays through the canopy, "
             "a tiny explorer standing on the steps, volumetric fog, shot on 35mm film, anamorphic", seed=21, force=force)
    v = wan("cinema_wan.mp4", s, "The camera performs a slow cinematic crane-up and push-in toward the temple, god rays shifting through drifting mist, "
            "leaves swaying, the explorer climbing the steps. Epic scale, 35mm film look.", force=force)
    norm(v, OUT / "cinema.mp4")


def step_edit(force):
    base = flux("edit_base.png", "A young man in a denim jacket sitting at a sunny sidewalk cafe terrace in a European city at midday, candid photo", seed=33, force=force)
    night = flux("edit_night.png", "Relight the scene with cold moonlight and warm street lamps at night. Keep the subject, composition and colors of objects the same; only change the lighting, shadows and atmosphere.",
                 refs=[base], match=True, seed=5, force=force)
    jacket = flux("edit_jacket.png", "Change the person's outfit to a glossy red leather biker jacket. Keep their face, pose, body and the background identical.",
                  refs=[base], match=True, seed=5, force=force)
    wipe(base, night, WORK / "edit_a.mp4", transition="wipeleft")
    wipe(night, jacket, WORK / "edit_b.mp4", transition="wipeleft")
    wipe(jacket, base, WORK / "edit_c.mp4", transition="wipeleft")
    concat([WORK / "edit_a.mp4", WORK / "edit_b.mp4", WORK / "edit_c.mp4"], WORK / "edit_raw.mp4")
    norm(WORK / "edit_raw.mp4", OUT / "edit.mp4")


def step_characters(force):
    base = flux("char_base.png", "Studio portrait of a 30-year-old woman with short copper-red hair and freckles, green eyes, wearing a navy utility jacket, neutral expression, plain light-grey background",
                w=832, h=1088, seed=44, force=force)
    views = [base]
    for i, v in enumerate(["in a three-quarter view turned slightly to the left", "in a left side profile view", "as a full-body shot standing relaxed, head to toe", "with a warm natural smile in a close-up portrait"]):
        views.append(flux(f"char_v{i}.png",
                          f"Show the exact same person from image 1, {v}, on a plain neutral light-grey studio background with soft even lighting. Keep the face, hair, skin tone, age and clothing identical to image 1.",
                          w=832, h=1088, refs=[base], seed=9, force=force))
    slideshow(views, WORK / "char_raw.mp4", each=0.9, fade=0.3, zoom=False)
    norm(WORK / "char_raw.mp4", OUT / "characters.mp4")


def step_sketch(force):
    p = WORK / "sketch_in.png"
    im = Image.new("RGB", (1344, 768), "white")
    d = ImageDraw.Draw(im)
    d.polygon([(0, 560), (260, 300), (430, 470), (640, 220), (900, 500), (1100, 330), (1344, 520), (1344, 768), (0, 768)], outline="black", width=5)
    d.ellipse((1050, 90, 1170, 210), outline="black", width=5)
    d.rectangle((520, 520, 720, 640), outline="black", width=5)
    d.polygon([(500, 520), (620, 440), (740, 520)], outline="black", width=5)
    d.rectangle((600, 570, 640, 640), outline="black", width=4)
    for x in (180, 270, 880, 980, 1070):
        d.polygon([(x, 650), (x - 40, 740), (x + 40, 740)], outline="black", width=4)
        d.polygon([(x, 600), (x - 30, 690), (x + 30, 690)], outline="black", width=4)
    im.save(p)
    out = flux("sketch_out.png", "Turn this drawing into the finished image described here: a photorealistic alpine valley at sunrise, a small wooden cabin with smoke from the chimney, "
               "pine trees, snowy peaks lit golden. Follow the drawing's composition, layout, proportions and shapes exactly; replace the linework with real materials, lighting and detail.",
               refs=[p], match=True, seed=12, force=force)
    wipe(p, out, WORK / "sketch_raw.mp4", hold=1.0, dur=1.2, transition="wiperight")
    norm(WORK / "sketch_raw.mp4", OUT / "sketch.mp4")


def step_ads(force):
    s = flux("ads.png", "A cheerful young woman at a bright kitchen table holding up a pair of matte black over-ear wireless headphones toward the camera with a surprised smile, "
             "candid smartphone video frame, bright natural daylight", seed=61, force=force)
    v = wan("ads_wan.mp4", s, "She holds the headphones up to the camera with a delighted smile, turns them slightly to show the design, then nods happily. Handheld selfie-style camera with a gentle wobble.", force=force)
    norm(v, OUT / "ads.mp4")


def step_genjutsu(force):
    hero = WORK / "hero_wan.mp4"
    if not hero.exists():
        step_hero(force)
    first = c.post(BASE + "/api/tools/ffmpeg", data={"op": "first_frame"}, files=[("file", ("h.mp4", hero.read_bytes(), "video/mp4"))]).content
    fp = WORK / "gj_first.png"
    fp.write_bytes(first)
    guide = flux("gj_guide.png", "Redraw this image as a high-quality hand-painted anime illustration with clean linework and cel shading. Keep the composition, subjects and poses identical.",
                 refs=[fp], match=True, seed=3, force=force)
    gj = cached("gj_out.mp4", lambda: job("/api/genjutsu", {
        "prompt": "A high-quality hand-painted anime illustration in the style of a Japanese animated film, flat cel shading, bold ink outlines, painted backgrounds. A woman in a yellow raincoat walks away down a rainy neon alley. The same motion and camera movement as the original footage.",
        "denoise": 0.92, "seconds": 3, "megapixels": 0.3, "guide_hold": 16},
        [("video", ("h.mp4", hero.read_bytes(), "video/mp4")), ("guide", ("g.png", guide.read_bytes(), "image/png"))]), force)
    hstack(hero, gj, WORK / "gj_cmp.mp4")
    norm(WORK / "gj_cmp.mp4", OUT / "genjutsu.mp4")


def step_lab(force):
    hero = WORK / "hero_wan.mp4"
    if not hero.exists():
        step_hero(force)
    cut = cached("lab_cut.mp4", lambda: job("/api/tools/remove_bg", {"background": "green"},
                                            [("file", ("h.mp4", hero.read_bytes(), "video/mp4"))]), force)
    hstack(hero, cut, WORK / "lab_cmp.mp4")
    norm(WORK / "lab_cmp.mp4", OUT / "lab.mp4")


def step_wan(force):
    parts = []
    for n, src in (("wan_a", Path(os.getenv("WAN_A", ""))), ("wan_b", Path(os.getenv("WAN_B", "")))):
        if src.is_file():
            parts.append(src)
    if not parts:
        s = flux("wan.png", "A weathered fisherman mending a net on a misty wooden dock at dawn, soft blue light, 35mm photograph", seed=77, w=1024, h=1024, force=force)
        parts = [wan("wan_wan.mp4", s, "A weathered fisherman mends a fishing net on a misty dock at dawn, his hands working the rope, gentle waves, slow push-in camera.", aspect="1:1", force=force)]
    norm(parts[0], OUT / "wan.mp4")



# ---------------------------------------------------------------- composed banners (no GPU: built from the stills above)

FONT_DIR = Path(os.getenv("WINDIR", r"C:\Windows")) / "Fonts"


def font(name, size):
    from PIL import ImageFont
    for f in (FONT_DIR / name, Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")):
        try:
            return ImageFont.truetype(str(f), size)
        except OSError:
            continue
    return ImageFont.load_default()


def _still(name) -> Image.Image:
    p = WORK / name
    if not p.exists():
        raise RuntimeError(f"{name} missing - run the step that creates it first (hero, cinema, ads, edit, characters, flux)")
    return Image.open(p).convert("RGB")


def _cover(im: Image.Image, w: int, h: int) -> Image.Image:
    k = max(w / im.width, h / im.height)
    im = im.resize((int(im.width * k) + 1, int(im.height * k) + 1))
    x, y = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def _rounded_mask(w, h, r):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w, h), r, fill=255)
    return m


ACCENT = (20, 232, 255)


def step_board(force):
    """A pan across a storyboard canvas: dotted grid, numbered scene cards joined by connectors."""
    H2, CW, CH, GAP = 1080, 560, 315, 150
    names = [("hero.png", "Neon alley", True), ("cinema.png", "The temple", True), ("ads.png", "Product reveal", True),
             ("edit_night.png", "Cafe at night", False), ("edit_jacket.png", "Leather jacket", False), ("flux_2.png", "Alpine dawn", False)]
    total = 120 + len(names) * (CW + GAP)
    strip = Image.new("RGB", (total, H2), (11, 13, 17))
    d = ImageDraw.Draw(strip)
    for x in range(0, total, 46):
        for y in range(0, H2, 46):
            d.ellipse((x, y, x + 2, y + 2), fill=(38, 43, 54))
    y0 = (H2 - CH) // 2 - 40
    fb, fs, ft = font("segoeuib.ttf", 30), font("segoeui.ttf", 22), font("segoeuib.ttf", 24)
    prev = None
    for i, (img, title, done) in enumerate(names):
        x0 = 120 + i * (CW + GAP)
        # connector to previous card
        if prev is not None:
            d.line((prev, y0 + CH // 2, x0, y0 + CH // 2), fill=(*ACCENT,), width=4)
            d.polygon([(x0, y0 + CH // 2), (x0 - 16, y0 + CH // 2 - 9), (x0 - 16, y0 + CH // 2 + 9)], fill=ACCENT)
        prev = x0 + CW
        # card shadow + body
        card = Image.new("RGB", (CW, CH + 96), (22, 25, 32))
        card.paste(_cover(_still(img), CW, CH), (0, 0))
        cd = ImageDraw.Draw(card)
        cd.text((18, CH + 14), title, font=fb, fill=(235, 240, 248))
        if done:
            cd.polygon([(20, CH + 58), (20, CH + 78), (38, CH + 68)], fill=ACCENT)
        cd.text((50 if done else 18, CH + 54), "clip ready" if done else "still ready - tap to animate", font=fs, fill=ACCENT if done else (139, 147, 163))
        glow = Image.new("RGB", (CW + 40, CH + 136), (11, 13, 17))
        strip.paste(Image.new("RGB", (CW + 24, CH + 120), (6, 7, 10)), (x0 - 12, y0 - 8))
        strip.paste(card, (x0, y0), _rounded_mask(CW, CH + 96, 22))
        d.rounded_rectangle((x0, y0, x0 + CW, y0 + CH + 96), 22, outline=ACCENT if done else (58, 65, 80), width=4 if done else 2)
        # number badge
        d.ellipse((x0 - 18, y0 - 18, x0 + 34, y0 + 34), fill=ACCENT)
        d.text((x0 + 8, y0 - 12), str(i + 1), font=ft, fill=(2, 20, 24))
    sp = WORK / "board_strip.png"
    strip.save(sp)
    D = 7.0
    out = WORK / "board_raw.mp4"
    ff("-loop", 1, "-i", sp, "-vf", f"crop=1920:1080:x='(iw-1920)*(0.5-0.5*cos(PI*t/{D}))':y=0,scale={W}:{H},fps=30,format=yuv420p",
       "-t", D, "-c:v", "libx264", "-crf", "27", out)
    norm(out, OUT / "board.mp4")


def step_mcp(force):
    """Animated agent session: typed tool calls with results appearing as thumbnails."""
    from PIL import ImageFilter
    FW, FH, FPS, D = 1280, 720, 30, 9.0
    mono, monob, ui = font("consola.ttf", 23), font("consolab.ttf", 23), font("segoeuib.ttf", 22)
    lab = font("segoeuib.ttf", 17)
    thumbs = {n: _cover(_still(n), 260, 150) for n in ("hero.png", "ads.png", "cinema.png")}
    OK = (110, 231, 183)
    script = [  # (start s, text, colour, chars/s)
        (0.3, "> Moody neon alley, a woman in a yellow raincoat.", (235, 240, 248), 38),
        (2.0, "  hoodsfield.generate_image  aspect=16:9", ACCENT, 64),
        (2.8, "  OK  image_4f2a.png  -  4.8 s", OK, 80),
        (3.6, "> Animate it: slow dolly-in. Then make it anime.", (235, 240, 248), 38),
        (5.2, "  hoodsfield.image_to_video  seconds=3", ACCENT, 64),
        (6.0, "  OK  video_91c0.mp4  -  32 fps", OK, 80),
        (6.7, "  hoodsfield.genjutsu  restyle=anime", ACCENT, 64),
        (7.5, "  OK  genjutsu_77c1.mp4", OK, 80),
    ]
    pops = [(3.0, "hero.png", "generate_image"), (6.1, "ads.png", "image_to_video"), (7.6, "cinema.png", "genjutsu")]
    frames_dir = WORK / "mcp_frames"
    frames_dir.mkdir(exist_ok=True)
    for old in frames_dir.glob("*.png"):
        old.unlink()
    bg = Image.new("RGB", (FW, FH), (9, 11, 15))
    glow = Image.new("RGB", (FW, FH), (0, 0, 0))
    ImageDraw.Draw(glow).ellipse((FW * 0.45, -FH * 0.3, FW * 1.2, FH * 0.7), fill=(8, 70, 80))
    bg = Image.blend(bg, glow.filter(ImageFilter.GaussianBlur(140)), 0.9)
    win = (60, 70, FW - 60, FH - 70)
    TX = win[2] - 300 - 34            # thumbnails column
    for f in range(int(D * FPS)):
        t = f / FPS
        im = bg.copy()
        d = ImageDraw.Draw(im, "RGBA")
        d.rounded_rectangle(win, 22, fill=(16, 19, 25, 235), outline=(60, 68, 84, 255), width=2)
        d.rounded_rectangle((win[0], win[1], win[2], win[1] + 52), 22, fill=(26, 30, 38, 255))
        for k, c in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
            d.ellipse((win[0] + 22 + k * 28, win[1] + 18, win[0] + 36 + k * 28, win[1] + 32), fill=c)
        d.text((win[0] + 130, win[1] + 13), "Claude  -  hoodsfield MCP", font=ui, fill=(160, 170, 186))
        y = win[1] + 80
        for start, text, color, cps in script:
            if t < start:
                continue
            n = min(len(text), int((t - start) * cps))
            shown = text[:n]
            d.text((win[0] + 30, y), shown, font=monob if color == ACCENT else mono, fill=color)
            if n < len(text):
                cx = win[0] + 30 + d.textlength(shown, font=mono)
                d.rectangle((cx + 2, y + 3, cx + 13, y + 27), fill=ACCENT)
            y += 46
        for i, (pt, img, label) in enumerate(pops):
            if t < pt:
                continue
            k = min(1.0, (t - pt) / 0.35)
            ease = 1 - (1 - k) ** 3
            ty = win[1] + 74 + i * 168
            off = int((1 - ease) * 70)
            alpha = int(255 * ease)
            th = thumbs[img].convert("RGBA")
            th.putalpha(Image.eval(_rounded_mask(260, 150, 14), lambda v: v * alpha // 255))
            # sit the 260-wide thumb at the right edge of the 300-wide column
            im.paste(th, (TX + 40 + off, ty), th)
            d2 = ImageDraw.Draw(im, "RGBA")
            d2.rounded_rectangle((TX + 40 + off, ty, TX + 300 + off, ty + 150), 14, outline=(*ACCENT, alpha), width=3)
            tw = d2.textlength(label, font=lab)
            d2.rounded_rectangle((TX + 48 + off, ty + 8, TX + 48 + off + tw + 16, ty + 34), 8, fill=(5, 8, 12, int(210 * ease)))
            d2.text((TX + 56 + off, ty + 11), label, font=lab, fill=(*ACCENT, alpha))
        im.save(frames_dir / f"f_{f:04d}.png")
    raw = WORK / "mcp_raw.mp4"
    ff("-framerate", FPS, "-i", frames_dir / "f_%04d.png", "-vf", f"scale={W}:{H},fade=t=in:st=0:d=0.3,fade=t=out:st={D-0.5}:d=0.5,format=yuv420p",
       "-c:v", "libx264", "-crf", "26", raw)
    norm(raw, OUT / "mcp.mp4")
    ff("-ss", 6.8, "-i", OUT / "mcp.mp4", "-frames:v", 1, "-q:v", 4, OUT / "mcp.jpg")   # poster: mid-session, not the faded first frame


def step_timeline(force):
    """Animated NLE: playhead sweeps a multi-track timeline while the preview dissolves between clips and a caption appears."""
    import math
    import shutil
    FW, FH, FPS, D = 1280, 720, 30, 8.0
    imgs = ["hero.png", "cinema.png", "ads.png", "flux_2.png"]
    clips = [(110, 420, 0), (400, 700, 1), (680, 960, 2), (940, 1190, 3)]   # (x0, x1, image idx) on the V1 track, overlapping = dissolve
    fb, fs, ft = font("segoeuib.ttf", 22), font("segoeui.ttf", 16), font("segoeuib.ttf", 54)
    PX0, PX1 = 110, 1190
    px, py, pw, ph = 330, 28, 620, 349
    covers = [_cover(_still(n), pw, ph) for n in imgs]
    thumbs = [_cover(_still(n), 150, 56) for n in imgs]
    BG, PANEL, LINE, MUTE = (11, 13, 17), (20, 23, 30), (42, 48, 60), (139, 147, 163)
    frames_dir = WORK / "tl_frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True)
    rng_w = [(0.35 + 0.65 * abs(math.sin(i * 0.37) * math.cos(i * 0.11))) for i in range(160)]
    n = int(D * FPS)
    for f in range(n):
        t = f / FPS
        k = min(1.0, t / (D - 0.8))
        ease = 0.5 - 0.5 * math.cos(math.pi * k)
        head = PX0 + (PX1 - PX0) * ease
        im = Image.new("RGB", (FW, FH), BG)
        d = ImageDraw.Draw(im, "RGBA")
        # preview: dissolve across overlap zones
        idx = 0
        for i, (a, b, _) in enumerate(clips):
            if head >= a:
                idx = i
        base = covers[idx].copy()
        if idx > 0:
            a0 = clips[idx][0]
            ov = clips[idx - 1][1] - a0
            fade = max(0.0, min(1.0, (head - a0) / ov)) if ov > 0 else 1.0
            base = Image.blend(covers[idx - 1], covers[idx], fade)
        im.paste(base, (px, py))
        d.rectangle((px - 2, py - 2, px + pw + 1, py + ph + 1), outline=LINE, width=2)
        if 520 < head < 940:   # caption clip on the Text track
            a = int(255 * min(1.0, (head - 520) / 40) * min(1.0, (940 - head) / 40))
            tw = d.textlength("HOODSFIELD", font=ft)
            d.rounded_rectangle((px + pw / 2 - tw / 2 - 20, py + ph - 96, px + pw / 2 + tw / 2 + 20, py + ph - 24), 14, fill=(0, 0, 0, int(a * 0.6)))
            d.text((px + pw / 2 - tw / 2, py + ph - 94), "HOODSFIELD", font=ft, fill=(255, 255, 255, a))
        # transport
        d.rounded_rectangle((px + pw / 2 - 20, py + ph + 12, px + pw / 2 + 20, py + ph + 40), 14, fill=ACCENT)
        d.polygon([(px + pw / 2 - 5, py + ph + 18), (px + pw / 2 - 5, py + ph + 34), (px + pw / 2 + 8, py + ph + 26)], fill=(2, 20, 24))
        d.text((px + 6, py + ph + 14), f"0:{t:04.1f}", font=fs, fill=MUTE)
        # ruler + track lanes
        ty = 445
        for s_ in range(0, 9):
            x = PX0 + s_ * (PX1 - PX0) / 8
            d.line((x, ty - 14, x, ty), fill=LINE, width=2)
            d.text((x + 4, ty - 20), f"{s_}s", font=fs, fill=MUTE)
        lanes = [("OVERLAY", 456, 40), ("TEXT", 502, 40), ("VIDEO", 548, 64), ("AUDIO", 618, 56)]
        for name, y, h in lanes:
            d.rounded_rectangle((20, y, FW - 20, y + h), 8, fill=PANEL)
            d.text((30, y + h / 2 - 9), name, font=fs, fill=MUTE)
        # clips grow in over the first second
        g = min(1.0, t / 1.0)
        for i, (a, b, ii) in enumerate(clips):
            bb = a + (b - a) * g
            d.rounded_rectangle((a, 548, bb, 612), 8, fill=(30, 56, 66), outline=ACCENT, width=2)
            tw_ = int(min(bb - a - 4, 150))
            if tw_ > 20:
                im.paste(thumbs[ii].crop((0, 0, tw_, 56)), (a + 2, 552))
            d.text((a + 8, 552), f"clip {i + 1}", font=fs, fill=(255, 255, 255))
        # text clip + overlay clip
        d.rounded_rectangle((520, 502, 520 + 420 * g, 542), 8, fill=(70, 50, 120), outline=(160, 123, 255), width=2)
        d.text((530, 510), "HOODSFIELD", font=fs, fill=(235, 225, 255))
        d.rounded_rectangle((700, 456, 700 + 260 * g, 496), 8, fill=(26, 70, 80), outline=(52, 245, 197), width=2)
        d.text((710, 464), "logo", font=fs, fill=(210, 255, 245))
        # audio waveform
        for j in range(int((PX1 - PX0) / 6 * g)):
            hh = rng_w[j % len(rng_w)] * 22
            x = PX0 + j * 6
            d.line((x, 646 - hh, x, 646 + hh), fill=(255, 77, 240, 200), width=3)
        # playhead
        d.line((head, ty - 14, head, 674), fill=ACCENT, width=3)
        d.polygon([(head - 9, ty - 16), (head + 9, ty - 16), (head, ty - 2)], fill=ACCENT)
        im.save(frames_dir / f"f_{f:04d}.png")
    raw = WORK / "timeline_raw.mp4"
    ff("-framerate", FPS, "-i", frames_dir / "f_%04d.png", "-vf", f"scale={W}:{H},fade=t=in:st=0:d=0.3,fade=t=out:st={D-0.5}:d=0.5,format=yuv420p",
       "-c:v", "libx264", "-crf", "26", raw)
    norm(raw, OUT / "timeline.mp4")
    ff("-ss", 4.5, "-i", OUT / "timeline.mp4", "-frames:v", 1, "-q:v", 4, OUT / "timeline.jpg")


def step_lipsync(force):
    """Real lip-sync result (tools/assets/lipsync_src.mp4, made by /api/lipsync) beside the animated voice waveform that drives it."""
    src = HERE / "assets" / "lipsync_src.mp4"
    out = WORK / "lipsync_raw.mp4"
    lab = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lab)
    ld.text((60, H // 2 - 135), "Your voice", font=font("segoeuib.ttf", 36), fill=(255, 255, 255, 255))
    ld.text((60, H // 2 + 105), "their lips", font=font("segoeuib.ttf", 36), fill=(*ACCENT, 255))
    lp = WORK / "lipsync_labels.png"
    lab.save(lp)
    fc = (f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=28:3,eq=brightness=-0.25[bg];"
          f"[0:v]scale=-2:{H - 60}[fg];"
          f"[0:a]volume=4,showwaves=s=420x200:mode=cline:scale=sqrt:draw=full:colors=0x14e8ff:rate=30,format=yuva420p[wave];"
          f"[bg][fg]overlay=x=W-w-70:y=30[a];[a][wave]overlay=x=60:y=(H-h)/2-10[b];[b][1:v]overlay=0:0[v]")
    ff("-stream_loop", 1, "-i", src, "-i", lp, "-filter_complex", fc, "-map", "[v]", "-an", "-t", 6, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-r", 30, out)
    norm(out, OUT / "lipsync.mp4")


EXAMPLES = [
    # id, title, engine, prompt, (w, h), aspect, motion prompt for Wan (None = still only)
    ("astro", "Astronaut in bloom", "Flux 3 → Wan", "An astronaut sitting in a field of wildflowers at golden hour, helmet reflecting the sunset, cinematic, shallow depth of field",
     (1344, 768), "16:9", "Slow push-in, wildflowers sway in the breeze, the astronaut slowly turns their head, warm sunlight flickers"),
    ("temple", "Sunken temple", "Flux 3 → Wan", "Ancient stone temple underwater, shafts of sunlight piercing the blue water, schools of small fish, volumetric light, wide angle",
     (1344, 768), "16:9", "Camera drifts slowly forward through the water, fish swim past, light shafts shimmer"),
    ("samurai", "Samurai in the mist", "Flux 3 → Wan", "A lone samurai standing at the foot of Mount Fuji at dawn, low mist, cloak moving in the wind, cinematic, muted colors",
     (768, 1344), "9:16", "Mist drifts across the ground, the cloak flutters in the wind, slow camera tilt up"),
    ("ramen", "Night food stall", "Flux 3", "Cyberpunk street food vendor at night serving noodles under neon signs, steam rising, rain-slick pavement, reflections",
     (1344, 768), "16:9", None),
    ("cabin", "Snowed-in cabin", "Flux 3", "Cozy log cabin interior with a crackling fireplace, wool blankets, snowy pine forest visible through the window, warm light",
     (1344, 768), "16:9", None),
    ("editorial", "Red coat, salt flat", "Flux 3", "Fashion editorial photograph of a model in a long red coat standing on a white salt flat, deep blue sky, minimalist, medium format",
     (896, 1152), "3:4", None),
    ("island", "Tiny island city", "Flux 3", "Isometric miniature floating island city with tiny buildings, bridges and waterfalls, soft pastel colors, tilt-shift, 3D render",
     (1024, 1024), "1:1", None),
    ("fox", "Watercolor fox", "Flux 3", "Hand-painted watercolor of a red fox curled up in an autumn forest, loose brushwork, paper texture, soft washes of ochre and teal",
     (1024, 1024), "1:1", None),
    ("kitchen", "70s space kitchen", "Flux 3", "Retro-futurist 1970s space station kitchen, orange and avocado tones, chrome appliances, round windows showing Earth, wide angle, film grain",
     (1344, 768), "16:9", None),
    ("smoothie", "Dragon-fruit splash", "Flux 3", "Macro photograph of a dragon fruit smoothie splashing out of a glass, droplets frozen in mid-air, vivid magenta, studio lighting, high-speed flash",
     (896, 1152), "3:4", None),
]


def step_explore(force):
    """Real example renders for the Explore page: Flux 3 stills (+ Wan motion for a few) and showcase/recipes.json."""
    from PIL import Image
    recipes = []
    for eid, title, engine, prompt, (w, h), aspect, motion in EXAMPLES:
        still = flux(f"ex_{eid}.png", prompt, w=w, h=h, seed=300 + len(recipes), force=force)
        jpg = OUT / f"ex_{eid}.jpg"
        im = Image.open(still).convert("RGB")
        im.thumbnail((1280, 1280))
        im.save(jpg, quality=84)
        entry = {"id": f"ex-{eid}", "title": title, "engine": engine, "prompt": prompt, "aspect": aspect, "image": f"ex_{eid}.jpg"}
        if motion:
            clip = wan(f"ex_{eid}_wan.mp4", still, motion, seconds=3, aspect=aspect, force=force)
            dst = OUT / f"ex_{eid}.mp4"
            ff("-i", clip, "-vf", "scale=-2:576,fps=30", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26",
               "-preset", "slow", "-movflags", "+faststart", dst)
            entry["video"] = f"ex_{eid}.mp4"
            entry["motion"] = motion
        recipes.append(entry)
        (OUT / "recipes.json").write_text(json.dumps(recipes, indent=1), encoding="utf-8")   # partial progress is usable
        log("explore example", eid, "done")


RESTYLE_PAIRS = [
    # (source clip, source label, look id, aspect)
    ("assets/src_fisher.mp4", "Fisherman", "anime-cel", "16:9"),
    ("assets/src_fisher.mp4", "Fisherman", "clay", "16:9"),
    ("assets/src_fisher.mp4", "Fisherman", "oil", "16:9"),
    ("../frontend/public/showcase/hero.mp4", "Neon alley", "anime-cyber", "16:9"),
    ("../frontend/public/showcase/hero.mp4", "Neon alley", "spiderverse", "16:9"),
    ("../frontend/public/showcase/hero.mp4", "Neon alley", "pixel", "16:9"),
    ("../frontend/public/showcase/ex_temple.mp4", "Sunken temple", "anime-shinkai", "16:9"),
    ("../frontend/public/showcase/ex_astro.mp4", "Astronaut", "pixar", "16:9"),
    ("../frontend/public/showcase/ex_astro.mp4", "Astronaut", "lego", "16:9"),
    ("../frontend/public/showcase/ex_samurai.mp4", "Samurai", "ukiyoe", "9:16"),
]


def step_restyles(force):
    """Genjutsu Bold restyle examples for Explore: first frame redrawn by Flux 3 Edit, then structure-locked LTX re-render."""
    looks = {l["id"]: l for l in json.loads(subprocess.run(
        ["node", "--input-type=module", "-e", "import {VIDEO_LOOKS as V} from './src/videoLooks.js'; console.log(JSON.stringify(V))"],
        cwd=HERE.parent / "frontend", capture_output=True, text=True, encoding="utf-8", check=True).stdout)}
    rpath = OUT / "recipes.json"
    for src, label, lid, aspect in RESTYLE_PAIRS:
        look = looks[lid]
        src_p = (HERE / src).resolve()
        name = f"rs_{src_p.stem.replace('src_', '').replace('ex_', '')}_{lid}"
        out_mp4 = OUT / f"{name}.mp4"
        if not out_mp4.exists() or force:
            t0 = WORK / f"{name}_in.mp4"
            ff("-i", src_p, "-t", 3, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", 18, t0)
            frame = WORK / f"{name}_f0.png"
            ff("-i", t0, "-frames:v", 1, frame)
            if name == "rs_fisher_anime-cel":
                raw = HERE / "assets" / "rs_fisher_anime-cel.mp4"
            else:
                guide = cached(f"{name}_guide.png", lambda: job("/api/generate_flux3", {"prompt": look["edit"], "steps": 8, "seed": 11, "match_ref_size": "true"},
                                                                 [("refs", ("f0.png", frame.read_bytes(), "image/png"))]), force)
                raw = cached(f"{name}_raw.mp4", lambda: job("/api/motion_control", {"prompt": f"{look['prompt']}. The same motion and camera movement as the original footage.",
                                                                                     "seconds": 3, "megapixels": 0.3, "control_strength": 1.0},
                                                             [("video", ("v.mp4", t0.read_bytes(), "video/mp4")), ("guide", ("g.png", guide.read_bytes(), "image/png"))]), force)
            ff("-i", raw, "-vf", "scale=-2:576,fps=30", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "slow", "-movflags", "+faststart", out_mp4)
            ff("-i", out_mp4, "-frames:v", 1, "-q:v", 4, OUT / f"{name}.jpg")
        recipes = json.loads(rpath.read_text(encoding="utf-8")) if rpath.exists() else []
        recipes = [r for r in recipes if r["id"] != f"rs-{name}"]
        recipes.append({"id": f"rs-{name}", "title": f"{label} → {look['label']}", "engine": "Genjutsu · Bold restyle", "aspect": aspect,
                        "prompt": f"{look['prompt']}", "image": f"{name}.jpg", "video": f"{name}.mp4", "restyle": look["label"]})
        rpath.write_text(json.dumps(recipes, indent=1), encoding="utf-8")
        log("restyle", name, "done")


STEPS = {"hero": step_hero, "flux": step_flux, "cinema": step_cinema, "edit": step_edit, "characters": step_characters,
         "sketch": step_sketch, "ads": step_ads, "genjutsu": step_genjutsu, "lab": step_lab, "wan": step_wan,
         "board": step_board, "mcp": step_mcp, "timeline": step_timeline, "lipsync": step_lipsync, "explore": step_explore, "restyles": step_restyles}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    todo = [s for s in (a.only.split(",") if a.only else STEPS) if s]
    for s in todo:
        if (OUT / f"{s}.mp4").exists() and not a.force and not a.only:
            log("skip", s, "(exists)")
            continue
        log("== step", s)
        try:
            STEPS[s](a.force)
        except Exception as e:  # keep going: one failed banner must not block the rest
            log("STEP FAILED", s, e)
    log("done ->", OUT)
