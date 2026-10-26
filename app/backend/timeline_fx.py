"""
Per-clip colour grades, effects and camera moves for the Timeline export, plus the catalogue the editor shows.

A clip can carry:
  grade: "teal_orange" | "lut:<file>"     + gradeAmt 0..1 (how strongly it mixes over the original)
  fx:    [{"id": "glow", "amt": 0.5}, ...]  (stacked in order, max 4)
  cam:   {"id": "push_in", "amt": 0.5}      a virtual camera move (v1 clips and stills; Ken Burns on photos)

GRADES / FX / CAMS are the one source of truth: `catalog()` is served to the editor (labels, groups, a CSS approximation for
the live preview) and the functions below turn the same ids into ffmpeg filters, so the export matches what the user picked.
"""
import os
import re
from pathlib import Path

LUT_DIR = Path(os.getenv("VSA_WORK_DIR", os.getenv("TEMP", "."))) / "vsa_work" / "luts"

# ----------------------------------------------------------------------------- colour grades
# id: (label, group, ffmpeg filter chain, css approximation for the preview)
GRADES: dict[str, tuple[str, str, str, str]] = {
    # --- cinema
    "teal_orange": ("Teal & Orange", "Cinema", "colorbalance=rs=-0.10:gs=-0.02:bs=0.12:bm=0.03:rh=0.12:gh=0.04:bh=-0.10,eq=contrast=1.08:saturation=1.15", "contrast(1.08) saturate(1.2) hue-rotate(-6deg)"),
    "blockbuster": ("Blockbuster", "Cinema", "curves=preset=medium_contrast,colorbalance=rs=-0.06:bs=0.08:rh=0.08:bh=-0.06,eq=saturation=1.18:contrast=1.05", "contrast(1.12) saturate(1.2)"),
    "cinematic_warm": ("Cinematic Warm", "Cinema", "curves=preset=medium_contrast,colorbalance=rs=0.05:bs=-0.06:rm=0.03:bm=-0.03:rh=0.02:bh=-0.01,eq=saturation=1.08", "contrast(1.08) sepia(0.15) saturate(1.1)"),
    "moody_contrast": ("Moody Contrast", "Cinema", "curves=preset=strong_contrast,eq=saturation=0.85", "contrast(1.25) saturate(0.85)"),
    "bleach_bypass": ("Bleach Bypass", "Cinema", "eq=saturation=0.45:contrast=1.25,curves=preset=medium_contrast", "saturate(0.5) contrast(1.3)"),
    "low_key": ("Low Key", "Cinema", "eq=brightness=-0.1:contrast=1.25:saturation=0.9,vignette=PI/4", "brightness(0.85) contrast(1.25)"),
    "high_key": ("High Key", "Cinema", "eq=brightness=0.1:contrast=0.9:saturation=0.9", "brightness(1.12) contrast(0.9) saturate(0.9)"),
    "crushed_blacks": ("Crushed Blacks", "Cinema", "curves=all='0/0 0.15/0.02 1/1',eq=contrast=1.05", "contrast(1.2) brightness(0.92)"),
    "desaturated_war": ("Desaturated War", "Cinema", "eq=saturation=0.55:contrast=1.2,colorbalance=rs=0.02:bs=-0.02", "saturate(0.55) contrast(1.2)"),
    "clean_realistic": ("Clean Realistic", "Cinema", "eq=contrast=1.04:saturation=1.03", "contrast(1.04) saturate(1.03)"),
    # --- film stocks
    "kodak_portra": ("Kodak Portra", "Film", "colorbalance=rs=0.03:gs=0.01:bs=-0.03:rh=0.03:bh=-0.02,eq=saturation=0.95:contrast=1.02,curves=all='0/0.03 0.5/0.52 1/0.97'", "sepia(0.1) saturate(0.95)"),
    "kodak_film": ("Kodak Gold", "Film", "curves=preset=vintage,eq=contrast=1.03:saturation=1.05", "sepia(0.25) saturate(1.1) contrast(1.05)"),
    "fuji_velvia": ("Fuji Velvia", "Film", "eq=saturation=1.5:contrast=1.12,colorbalance=gs=0.03:gm=0.02", "saturate(1.55) contrast(1.12)"),
    "cross_process": ("Cross Process", "Film", "curves=preset=cross_process", "hue-rotate(-12deg) saturate(1.4) contrast(1.15)"),
    "vintage_70s": ("Vintage 70s", "Film", "curves=preset=vintage,colorbalance=rs=0.06:bs=-0.05,eq=saturation=0.9:contrast=0.95", "sepia(0.35) saturate(0.95) contrast(0.95)"),
    "faded_matte": ("Faded Matte", "Film", "curves=all='0/0.08 1/0.92',eq=saturation=0.85", "contrast(0.85) saturate(0.85) brightness(1.05)"),
    "lomo": ("Lomo", "Film", "eq=saturation=1.4:contrast=1.2,vignette=PI/3,colorbalance=rs=0.05:bs=0.05", "saturate(1.4) contrast(1.2)"),
    # --- mono & tint
    "noir_bw": ("Noir B&W", "Mono & tint", "hue=s=0,curves=preset=strong_contrast", "grayscale(1) contrast(1.35)"),
    "silent_film": ("Silent Film", "Mono & tint", "hue=s=0,eq=contrast=1.15:brightness=0.03,colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131", "grayscale(1) sepia(0.7) contrast(1.15)"),
    "sepia": ("Sepia", "Mono & tint", "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131", "sepia(1)"),
    "blue_mono": ("Cyanotype", "Mono & tint", "hue=s=0,colorbalance=rs=-0.2:bs=0.25:rm=-0.15:bm=0.2:rh=-0.1:bh=0.15", "grayscale(1) sepia(1) hue-rotate(160deg)"),
    # --- mood
    "golden_hour": ("Golden Hour", "Mood", "colorbalance=rs=0.08:gs=0.03:bs=-0.10:rm=0.06:gm=0.02:bm=-0.06:rh=0.10:gh=0.05:bh=-0.04,eq=saturation=1.12:brightness=0.02", "sepia(0.3) saturate(1.25) brightness(1.04)"),
    "cold_blue": ("Cold Blue", "Mood", "colorbalance=rs=-0.08:bs=0.14:rm=-0.05:bm=0.10:rh=-0.04:bh=0.06,eq=saturation=0.85", "hue-rotate(185deg) sepia(0.2) saturate(0.9)"),
    "day_for_night": ("Day for Night", "Mood", "eq=brightness=-0.18:contrast=1.1:saturation=0.6,colorbalance=rs=-0.10:bs=0.20:rm=-0.08:bm=0.16:rh=-0.06:bh=0.10", "brightness(0.65) saturate(0.6) hue-rotate(190deg)"),
    "cyberpunk": ("Cyberpunk Neon", "Mood", "colorbalance=rs=0.15:gs=-0.10:bs=0.20:rm=0.10:gm=-0.10:bm=0.20:rh=0.05:bh=0.08,eq=saturation=1.5:contrast=1.12", "saturate(1.6) contrast(1.15) hue-rotate(-20deg)"),
    "cool_teal_horror": ("Cool Teal Horror", "Mood", "colorbalance=rs=-0.08:gs=0.02:bs=0.10:rm=-0.04:bm=0.05,eq=saturation=0.72:contrast=1.08:brightness=-0.02,curves=preset=darker,vignette=PI/4", "saturate(0.7) contrast(1.1) brightness(0.9) hue-rotate(170deg) sepia(0.15)"),
    "horror_green": ("Sickly Green", "Mood", "colorbalance=rs=-0.05:gs=0.08:bs=-0.06:rm=-0.04:gm=0.07:bm=-0.05,eq=saturation=0.6:contrast=1.15:brightness=-0.04", "saturate(0.65) contrast(1.15) hue-rotate(60deg) sepia(0.2)"),
    "blood_red": ("Blood Red", "Mood", "colorbalance=rs=0.15:bs=-0.12:rm=0.1:bm=-0.1,eq=saturation=0.8:contrast=1.2:brightness=-0.05", "sepia(0.5) saturate(1.8) hue-rotate(-30deg) contrast(1.2)"),
    # --- tech & found footage
    "found_footage": ("Found Footage", "Tech", "hue=s=0.45,eq=contrast=1.18:brightness=-0.04,colorbalance=gs=0.04", "saturate(0.5) contrast(1.15) brightness(0.95)"),
    "night_vision": ("Night Vision", "Tech", "colorchannelmixer=rr=0:rg=0:rb=0:gr=0.3:gg=0.6:gb=0.1:br=0:bg=0:bb=0,eq=brightness=0.08:contrast=1.3", "grayscale(1) sepia(1) hue-rotate(70deg) saturate(3) brightness(1.1)"),
    "vhs_tape": ("VHS Tape", "Tech", "eq=saturation=1.3:contrast=0.92,curves=all='0/0.04 1/0.95'", "saturate(1.3) contrast(0.92)"),
    "security_cam": ("Security Cam", "Tech", "hue=s=0.2,eq=contrast=1.2:brightness=-0.02,colorbalance=gs=0.05", "saturate(0.3) contrast(1.2) sepia(0.2) hue-rotate(60deg)"),
}

# ----------------------------------------------------------------------------- effects
# id: (label, group, css hint for the preview, default amount)
FX: dict[str, tuple[str, str, str, float]] = {
    "blur": ("Blur", "Focus", "blur", 0.4),
    "dream": ("Dreamy Glow", "Focus", "glow", 0.5),
    "glow": ("Bloom", "Focus", "glow", 0.5),
    "sharpen": ("Sharpen", "Focus", "", 0.5),
    "tilt_shift": ("Tilt-Shift", "Focus", "", 0.5),
    "grain": ("Film Grain", "Texture", "grain", 0.4),
    "vignette": ("Vignette", "Texture", "vignette", 0.5),
    "scanlines": ("Scanlines", "Texture", "scan", 0.5),
    "vhs": ("VHS Wear", "Texture", "scan", 0.6),
    "halftone": ("Posterize", "Texture", "", 0.5),
    "chroma": ("Chromatic Aberration", "Lens", "chroma", 0.4),
    "glitch": ("Glitch", "Lens", "", 0.6),
    "flicker": ("Flicker", "Lens", "flicker", 0.4),
    "pixelate": ("Pixelate", "Lens", "", 0.4),
    "letterbox": ("Cinema Bars 2.39:1", "Frame", "bars", 1.0),
    "mirror": ("Mirror", "Frame", "", 1.0),
    "negative": ("Negative", "Frame", "invert", 1.0),
    "sketch": ("Edge Sketch", "Frame", "", 0.5),
}

# ----------------------------------------------------------------------------- camera moves
# id: (label, group)
CAMS: dict[str, tuple[str, str]] = {
    "push_in": ("Push In", "Dolly"),
    "pull_out": ("Pull Out", "Dolly"),
    "slow_push": ("Slow Creep In", "Dolly"),
    "pan_left": ("Pan Left", "Pan & tilt"),
    "pan_right": ("Pan Right", "Pan & tilt"),
    "tilt_up": ("Tilt Up", "Pan & tilt"),
    "tilt_down": ("Tilt Down", "Pan & tilt"),
    "drift": ("Floating Drift", "Pan & tilt"),
    "ken_burns": ("Ken Burns", "Photo"),
    "ken_burns_out": ("Ken Burns Out", "Photo"),
    "handheld": ("Handheld", "Shake"),
    "handheld_heavy": ("Handheld Heavy", "Shake"),
    "impact": ("Impact Shake", "Shake"),
    "earthquake": ("Earthquake", "Shake"),
    "roll": ("Slow Roll", "Roll"),
    "dutch": ("Dutch Angle", "Roll"),
}


def catalog() -> dict:
    return {
        "grades": [{"id": k, "label": v[0], "group": v[1], "css": v[3]} for k, v in GRADES.items()],
        "fx": [{"id": k, "label": v[0], "group": v[1], "css": v[2], "amt": v[3]} for k, v in FX.items()],
        "cams": [{"id": k, "label": v[0], "group": v[1]} for k, v in CAMS.items()],
        "luts": list_luts(),
    }


# ----------------------------------------------------------------------------- LUT files (.cube)
def list_luts() -> list[str]:
    try:
        return sorted(p.name for p in LUT_DIR.glob("*.cube"))
    except OSError:
        return []


def _lut_path(name: str) -> str | None:
    p = LUT_DIR / Path(name).name
    if not p.exists():
        return None
    s = str(p).replace("\\", "/")
    return re.sub(r"^([A-Za-z]):", r"\1\\:", s).replace("'", "\\'")


def grade_filter(grade: str) -> str:
    """The ffmpeg filter chain for a grade id (built-in) or 'lut:<file.cube>'. '' when unknown / none."""
    if not grade or grade == "none":
        return ""
    if grade.startswith("lut:"):
        p = _lut_path(grade[4:])
        return f"lut3d=file='{p}':interp=tetrahedral" if p else ""
    g = GRADES.get(grade)
    return g[2] if g else ""


# ----------------------------------------------------------------------------- camera
def camera_filter(cam: dict | None, W: int, H: int, dur: float) -> str:
    """A virtual camera move: scale up with a margin, then crop a W x H window whose position/size follows an expression of
    the clip-local time t. Returns '' for no move. `amt` 0..1 scales how far it travels."""
    if not cam or cam.get("id") not in CAMS:
        return ""
    a = max(0.0, min(1.0, float(cam.get("amt", 0.5))))
    cid = cam["id"]
    T = max(0.2, float(dur))
    w, h = W, H
    even = lambda e: f"trunc(({e})/2)*2"  # noqa: E731

    def zoom(z0: float, z1: float) -> str:     # scale per frame (eval=frame) from z0 to z1, then centre-crop
        z = f"({z0}+({z1}-{z0})*min(1,t/{T:.3f}))"
        return (f"scale=w='{even(f'{w}*{z}')}':h='{even(f'{h}*{z}')}':eval=frame:flags=bicubic,crop={w}:{h}")

    def pan(z: float, fx: str, fy: str) -> str:   # fixed margin; fx/fy are 0..1 positions across the margin
        return (f"scale={even(f'{w}*{z}')}:{even(f'{h}*{z}')}:flags=bicubic,"
                f"crop={w}:{h}:x='(in_w-out_w)*({fx})':y='(in_h-out_h)*({fy})'")

    prog = f"min(1,t/{T:.3f})"
    if cid == "push_in":
        return zoom(1.0, 1 + 0.30 * a)
    if cid == "pull_out":
        return zoom(1 + 0.30 * a, 1.0)
    if cid == "slow_push":
        return zoom(1.0, 1 + 0.10 * a)
    if cid == "pan_left":
        return pan(1 + 0.20 * a, f"1-{prog}", "0.5")
    if cid == "pan_right":
        return pan(1 + 0.20 * a, prog, "0.5")
    if cid == "tilt_up":
        return pan(1 + 0.20 * a, "0.5", f"1-{prog}")
    if cid == "tilt_down":
        return pan(1 + 0.20 * a, "0.5", prog)
    if cid == "drift":
        return pan(1 + 0.14 * a, f"0.5+0.5*sin(t*0.45)", f"0.5+0.5*sin(t*0.31+1)")
    if cid == "ken_burns":
        z = 1.0 + 0.28 * a
        return (f"scale=w='{even(f'{w}*({1.0}+({z}-1)*{prog})')}':h='{even(f'{h}*({1.0}+({z}-1)*{prog})')}':eval=frame:flags=bicubic,"
                f"crop={w}:{h}:x='(in_w-out_w)*(0.35+0.3*{prog})':y='(in_h-out_h)*(0.6-0.2*{prog})'")
    if cid == "ken_burns_out":
        z = 1.0 + 0.28 * a
        return (f"scale=w='{even(f'{w}*({z}-({z}-1)*{prog})')}':h='{even(f'{h}*({z}-({z}-1)*{prog})')}':eval=frame:flags=bicubic,"
                f"crop={w}:{h}:x='(in_w-out_w)*(0.65-0.3*{prog})':y='(in_h-out_h)*(0.4+0.2*{prog})'")
    if cid in ("handheld", "handheld_heavy", "earthquake"):
        k = {"handheld": 0.35, "handheld_heavy": 0.8, "earthquake": 1.0}[cid]
        z = 1.0 + (0.05 + 0.07 * k) * (0.4 + a)
        s1, s2, s3 = (6.1, 11.3, 2.3) if cid != "earthquake" else (23.0, 31.0, 9.0)
        amp = min(1.0, k * (0.35 + 0.9 * a))
        fx = f"0.5+{amp * 0.5:.3f}*(0.6*sin(t*{s1})+0.3*sin(t*{s2}+1.3)+0.5*sin(t*{s3}+0.4))/1.4"
        fy = f"0.5+{amp * 0.5:.3f}*(0.6*sin(t*{s1 * 1.13}+2.1)+0.3*sin(t*{s2 * 0.9}+0.7)+0.5*sin(t*{s3 * 1.2}+1.9))/1.4"
        return pan(z, fx, fy)
    if cid == "impact":
        z = 1.0 + 0.10 * (0.5 + a)
        decay = f"exp(-t*{3.0 + 3 * (1 - a):.2f})"
        return pan(z, f"0.5+0.5*{decay}*sin(t*38)", f"0.5+0.5*{decay}*sin(t*31+1)")
    if cid == "roll":
        ang = 0.06 * a
        return (f"scale={even(f'{w}*1.12')}:{even(f'{h}*1.12')}:flags=bicubic,rotate=a='{ang:.4f}*sin(t*0.5)':ow={w * 1.12:.0f}:oh={h * 1.12:.0f}:c=black,"
                f"crop={w}:{h}")
    if cid == "dutch":
        ang = 0.09 + 0.13 * a
        return (f"scale={even(f'{w}*1.5')}:{even(f'{h}*1.5')}:flags=bicubic,rotate=a={ang:.4f}:ow={w * 1.5:.0f}:oh={h * 1.5:.0f}:c=black,"
                f"crop={w}:{h}")
    return ""


# ----------------------------------------------------------------------------- effects
def fx_filters(fx_list: list[dict] | None, uid: str, W: int = 1280) -> list[str]:
    """Each effect -> one filtergraph fragment 'IN_LABEL ... OUT_LABEL' written with placeholders {i}/{o} (input/output pad)."""
    out: list[str] = []
    k = max(0.3, W / 1280.0)          # pixel amounts below are written for a 1280-wide frame
    for n, e in enumerate((fx_list or [])[:4]):
        fid = e.get("id")
        if fid not in FX:
            continue
        a = max(0.0, min(1.0, float(e.get("amt", FX[fid][3]))))
        lab = f"{uid}f{n}"
        simple = None
        if fid == "blur":
            simple = f"gblur=sigma={k * (0.6 + 9 * a):.2f}"
        elif fid == "sharpen":
            simple = f"unsharp=5:5:{0.5 + 1.6 * a:.2f}:5:5:0"
        elif fid == "grain":
            simple = f"noise=alls={int(8 + 40 * a)}:allf=t+u"
        elif fid == "vignette":
            simple = f"vignette=angle=PI/{2 + 4 * a:.2f}"
        elif fid == "scanlines":
            simple = f"drawgrid=y=0:h={max(2, round(4 * k))}:t=1:c=black@{0.18 + 0.4 * a:.2f}"
        elif fid == "vhs":
            sh = max(1, round(k * (1 + 4 * a)))
            simple = (f"gblur=sigma={0.4 + 0.8 * a:.2f}:steps=1,rgbashift=rh={sh}:bh=-{sh},noise=alls={int(10 + 22 * a)}:allf=t,"
                      f"eq=saturation={1.1 + 0.3 * a:.2f}:contrast=0.94,drawgrid=y=0:h=3:t=1:c=black@{0.12 + 0.2 * a:.2f}")
        elif fid == "chroma":
            sh = max(1, round(k * (2 + 10 * a)))
            simple = f"rgbashift=rh={sh}:bh=-{sh}"
        elif fid == "glitch":
            sh = max(2, round(k * (6 + 26 * a)))
            simple = (f"rgbashift=rh={sh}:bh=-{sh}:gv={max(1, sh // 4)}:enable='lt(mod(t,1.7),0.14)',"
                      f"noise=alls={int(40 + 60 * a)}:allf=t:enable='lt(mod(t+0.6,2.3),0.09)'")
        elif fid == "flicker":
            simple = f"eq=brightness='{0.18 * a:.3f}*sin(t*47)*sin(t*13)':eval=frame"
        elif fid == "pixelate":
            px = max(3, round(k * (6 + 44 * a)))
            simple = f"pixelize=w={px}:h={px}"
        elif fid == "halftone":
            lv = max(3, int(14 - 11 * a))
            st = max(1, 256 // lv)
            simple = f"lutrgb=r='trunc(val/{st})*{st}':g='trunc(val/{st})*{st}':b='trunc(val/{st})*{st}'"
        elif fid == "negative":
            simple = "negate"
        elif fid == "sketch":
            simple = "edgedetect=mode=colormix:high=0.18,eq=contrast=1.3"
        elif fid == "letterbox":
            simple = ("drawbox=x=0:y=0:w=iw:h='max(0,(ih-iw/2.39)/2)':color=black:t=fill,"
                      "drawbox=x=0:y='ih-max(0,(ih-iw/2.39)/2)':w=iw:h='max(0,(ih-iw/2.39)/2)':color=black:t=fill")
        if simple:
            out.append(f"{{i}}{simple}{{o}}")
            continue
        # fragments that need two branches
        if fid in ("glow", "dream"):
            sig = k * (14 + 22 * a if fid == "dream" else 18 + 14 * a)
            op = 0.30 + 0.45 * a
            out.append(f"{{i}}format=gbrp,split[{lab}a][{lab}b];[{lab}b]gblur=sigma={sig:.1f},eq=brightness=0.04:contrast=1.1[{lab}c];"
                       f"[{lab}a][{lab}c]blend=all_mode=screen:all_opacity={op:.2f},format=yuv420p{{o}}")
        elif fid == "tilt_shift":
            sig = k * (3 + 10 * a)
            out.append(f"{{i}}split[{lab}a][{lab}b];[{lab}b]gblur=sigma={sig:.1f}[{lab}c];"
                       f"[{lab}a][{lab}c]blend=all_expr='A*(1-min(1,max(0,abs(Y/H-0.5)*3.2-0.25)))+B*min(1,max(0,abs(Y/H-0.5)*3.2-0.25))'{{o}}")
        elif fid == "mirror":
            out.append(f"{{i}}split[{lab}a][{lab}b];[{lab}a]crop=iw/2:ih:0:0[{lab}l];[{lab}b]crop=iw/2:ih:0:0,hflip[{lab}r];[{lab}l][{lab}r]hstack{{o}}")
    return out


def mix_grade(grade: str, amt: float, uid: str) -> str | None:
    """A grade as a fragment with {i}/{o} pads, blended over the original when amt < 1."""
    f = grade_filter(grade)
    if not f:
        return None
    amt = max(0.0, min(1.0, amt))
    if amt >= 0.995:
        return f"{{i}}{f}{{o}}"
    return (f"{{i}}split[{uid}ga][{uid}gb];[{uid}gb]{f}[{uid}gc];"
            f"[{uid}ga][{uid}gc]blend=all_expr='A*{1 - amt:.3f}+B*{amt:.3f}'{{o}}")


def match_filter(m, amt: float = 1.0) -> str | None:
    """Per-channel gain + offset (0..1 values) from the colour-match tool, eased by `amt`, as one lutrgb filter."""
    try:
        g, o = [float(x) for x in m["g"]], [float(x) for x in m["o"]]
        if len(g) != 3 or len(o) != 3:
            return None
    except Exception:
        return None
    amt = max(0.0, min(1.0, amt))
    g = [max(0.3, min(2.5, 1 + (x - 1) * amt)) for x in g]
    o = [max(-0.6, min(0.6, x * amt)) for x in o]
    if all(abs(x - 1) < 0.004 for x in g) and all(abs(x) < 0.004 for x in o):
        return None
    ch = ":".join(f"{n}='clip(val*{a:.4f}+{b * 255:.2f},0,255)'" for n, a, b in zip("rgb", g, o))
    return f"lutrgb={ch}"
