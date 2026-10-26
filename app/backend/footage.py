"""Found-footage / camera-format look: an ffmpeg filter graph that makes clean AI video read as real recorded footage.

What sells "real" is not a filter but the *imperfections a real camera and a real operator have*, so each is modelled:
  handheld shake   body-sway + footstep bob + occasional jolts + slow roll, via a scaled-up frame cropped along moving offsets
  focus hunting    the autofocus losing and re-finding the subject (a blend between sharp and blurred, driven by time)
  exposure hunting auto-exposure breathing and brief blow-outs when a light changes
  sensor + format  low resolution, soft lens, colour cast, grain, vignette, lens distortion, tape/CCTV scan lines, chroma bleed
  tape glitches    short tracking/noise bursts
  camera overlays  REC dot, timecode, date, camera name
  audio            cheap-mic band-limiting, compression and clipping, room tone, wind
Used by POST /api/tools/ffmpeg (op=footage) and by the timeline looks.
"""
import math
import os
import random
import time

WIN_FONT = "C\\:/Windows/Fonts/consola.ttf"
FONT = f"fontfile='{WIN_FONT}':" if os.path.exists("C:/Windows/Fonts/consola.ttf") else ""

PRESETS = {
    "camcorder": {"label": "Found-footage camcorder", "blurb": "Handheld consumer camcorder: shaky, soft, warm-green cast, REC dot and timecode.",
                  "scale": 0.62, "sat": 0.80, "contrast": 1.07, "curves": "r='0/0.03 0.5/0.52 1/0.97':g='0/0.03 0.5/0.51 1/0.97':b='0/0.06 0.5/0.46 1/0.88'",
                  "vignette": 0.9, "grain": 11, "stamp": "camcorder", "fps": None, "barrel": 0.0, "chroma": 1, "scan": 0.0},
    "vhs": {"label": "VHS tape", "blurb": "Analog tape: smeared colour, scan lines, noise bands and tracking glitches.",
            "scale": 0.5, "sat": 1.15, "contrast": 1.05, "curves": "r='0/0.04 1/0.96':b='0/0.05 1/0.92'", "vignette": 0.6, "grain": 16,
            "stamp": "vhs", "fps": None, "barrel": 0.0, "chroma": 5, "scan": 0.22},
    "cctv": {"label": "Security camera", "blurb": "Fixed CCTV: desaturated, low frame rate, cold cast, camera name and date stamp.",
             "scale": 0.5, "sat": 0.3, "contrast": 1.12, "curves": "r='0/0 1/0.88':g='0/0.02 1/0.97':b='0/0.04 1/1'", "vignette": 0.7, "grain": 14,
             "stamp": "cctv", "fps": 8, "barrel": 0.1, "chroma": 1, "scan": 0.12},
    "nightvision": {"label": "Night vision", "blurb": "Infrared green night-vision with heavy noise and bloom.",
                    "scale": 0.58, "sat": 0.0, "contrast": 1.35, "curves": "", "vignette": 1.2, "grain": 24, "stamp": "night", "fps": None, "barrel": 0.0,
                    "chroma": 0, "scan": 0.06, "night": True},
    "bodycam": {"label": "Body cam", "blurb": "Chest-mounted wide-angle body camera: barrel distortion, bobbing, timestamp.",
                "scale": 0.7, "sat": 0.88, "contrast": 1.05, "curves": "b='0/0.02 1/0.96'", "vignette": 0.6, "grain": 9, "stamp": "bodycam", "fps": None,
                "barrel": 0.3, "chroma": 1, "scan": 0.0},
    "doorbell": {"label": "Doorbell cam", "blurb": "Ultra-wide doorbell camera: fisheye edges, cool cast, low frame rate, motion label.",
                 "scale": 0.6, "sat": 0.82, "contrast": 1.08, "curves": "r='0/0 1/0.93':b='0/0.03 1/1'", "vignette": 0.8, "grain": 10, "stamp": "doorbell",
                 "fps": 12, "barrel": 0.38, "chroma": 1, "scan": 0.0},
    "tiktok": {"label": "TikTok repost (phone, dark, compressed)", "blurb": "A phone video that has been re-uploaded a few times: underexposed, soft, muddy colours, blocky compression, no overlay.",
               "scale": 0.5, "sat": 0.82, "contrast": 1.14, "curves": "r='0/0 0.5/0.41 1/0.97':g='0/0 0.5/0.41 1/0.97':b='0/0.01 0.5/0.43 1/1'",
               "vignette": 0.35, "grain": 8, "stamp": "none", "fps": None, "barrel": 0.0, "chroma": 0, "scan": 0.0},
    "ugc": {"label": "Phone vlog (ordinary, re-uploaded)", "blurb": "Everyday phone video: normal daylight colour, slightly soft, mild compression, no overlay.",
            "scale": 0.72, "sat": 0.96, "contrast": 1.04, "curves": "", "vignette": 0.2, "grain": 5, "stamp": "none", "fps": None, "barrel": 0.0, "chroma": 0, "scan": 0.0},
    "doorbellcam": {"label": "Doorbell / fixed camera (clean)", "blurb": "A fixed doorbell or security camera whose picture is already wide-angle: cool cast, lower resolution, 15 fps, mild compression. No extra lens distortion, no zoom.",
                    "scale": 0.7, "sat": 0.9, "contrast": 1.04, "curves": "r='0/0 1/0.96':b='0/0.015 1/1'", "vignette": 0.2, "grain": 7, "stamp": "none", "fps": 15, "barrel": 0.0, "chroma": 1, "scan": 0.0},
    "babycam": {"label": "Baby monitor (infrared, black and white)", "blurb": "A fixed baby-monitor night camera: black-and-white infrared, bright hotspot, grain, 15 fps, mild compression. No extra distortion or zoom.",
                "scale": 0.66, "sat": 0.0, "contrast": 1.22, "curves": "all='0/0.03 0.5/0.5 1/0.97'", "vignette": 0.55, "grain": 14, "stamp": "none", "fps": 15, "barrel": 0.0, "chroma": 0, "scan": 0.0},
    "trailcam": {"label": "Trail / game camera (infrared flash)", "blurb": "A hunting trail camera strapped to a tree: black-and-white infrared night frames, harsh flash bloom, low frame rate, grain, mild compression. The data bar is added as text.",
                 "scale": 0.62, "sat": 0.0, "contrast": 1.3, "curves": "all='0/0.02 0.5/0.55 1/1'", "vignette": 0.5, "grain": 16, "stamp": "none", "fps": 10, "barrel": 0.0, "chroma": 0, "scan": 0.0},
    "phone": {"label": "Phone footage", "blurb": "A person filming on a phone: crisp but wobbly, hunting focus, no overlay.",
              "scale": 0.9, "sat": 0.95, "contrast": 1.04, "curves": "", "vignette": 0.25, "grain": 5, "stamp": "none", "fps": None, "barrel": 0.0,
              "chroma": 0, "scan": 0.0},
}

SHAKE_LEVELS = {"none": 0.0, "light": 0.25, "medium": 0.5, "heavy": 0.8, "blair witch": 1.0}


def _phases(seed: int) -> list[float]:
    r = random.Random(seed)
    return [r.uniform(0, 6.283) for _ in range(12)]


def build(preset: str, W: int, H: int, fps: float, dur: float, shake: float = 0.5, focus: float = 0.3, grain: float = 0.5,
          wear: float = 0.5, glitch: float = 0.3, stamp: bool = True, seed: int = 7, has_audio: bool = True, audio: str = "degrade",
          cam_name: str = "CAM 03", date_text: str | None = None, epoch: int | None = None, maxside: int = 960,
          shake_env: list | None = None) -> dict:
    """Return {'fc': filter_complex, 'v': video label, 'a': audio label or None}."""
    P = PRESETS.get(preset, PRESETS["camcorder"])
    ph = _phases(seed)
    f0 = min(1.0, maxside / max(W, H))                # footage is low-res by nature; working small is also what makes this fast
    W, H = int(W * f0) // 2 * 2, int(H * f0) // 2 * 2
    dur = max(0.5, dur)
    tau = "2*PI"
    # ---- handheld shake: scale up a little, rotate, then crop along moving offsets
    axp, ayp = shake * 0.032 * W, shake * 0.032 * H
    ra = shake * 0.026 + 0.002                                   # roll amplitude in radians (~1.5 deg at full shake)
    rotm = ra * (W + H) / 2 * 0.9
    S = 1 + 2 * max((axp + rotm) / W, (ayp + rotm) / H) + 0.004
    SW, SH = int(math.ceil(W * S / 2) * 2), int(math.ceil(H * S / 2) * 2)
    def wob(a, f1, f2, f3, p):   # a few incommensurate sines = a body that never quite repeats
        return (f"{a:.2f}*(0.5*sin({tau}*{f1}*t+{ph[p]:.2f})+0.3*sin({tau}*{f2}*t+{ph[p + 1]:.2f})+0.2*sin({tau}*{f3}*t+{ph[p + 2]:.2f}))")
    jolt = lambda a, p, f: f"+{a:.2f}*pow(max(0,sin({tau}*{0.21 + 0.03 * (p % 3):.2f}*t+{ph[p]:.2f})),28)*sin({tau}*{f}*t)"
    xo = wob(axp, 1.3, 3.1, 7.7, 0) + (jolt(axp * 0.9, 3, 17) if shake > 0.3 else "")
    yo = wob(ayp, 1.9, 4.4, 8.9, 4) + (jolt(ayp * 0.9, 7, 15) if shake > 0.3 else "")
    roll = f"{ra:.5f}*(0.55*sin({tau}*0.8*t+{ph[8]:.2f})+0.3*sin({tau}*2.6*t+{ph[9]:.2f})+0.15*sin({tau}*6.1*t+{ph[10]:.2f}))"
    # chaos envelope: how much of the shake applies at each moment (0..1), piecewise-linear between (time, level) points
    E = "1"
    if shake_env:
        pts = sorted((float(t), max(0.0, min(1.0, float(m)))) for t, m in shake_env)
        E = f"{pts[-1][1]:.3f}"
        for (t0, m0), (t1, m1) in reversed(list(zip(pts[:-1], pts[1:]))):
            E = f"if(lt(t,{t1:.3f}),{m0:.3f}+({m1 - m0:.3f})*(t-{t0:.3f})/{max(0.001, t1 - t0):.3f},{E})"
        E = f"if(lt(t,{pts[0][0]:.3f}),{pts[0][1]:.3f},{E})"
    chain = []
    if P["fps"]:
        chain.append(f"fps={P['fps']}")            # low frame rate first; the final fps filter repeats frames back up
    chain.append("setsar=1")
    chain.append(f"scale={W}:{H}:flags=bicubic")
    k = max(0.25, P["scale"] - 0.25 * wear + 0.12)   # more wear = lower resolution
    chain.append(f"scale=trunc(iw*{k:.3f}/2)*2:trunc(ih*{k:.3f}/2)*2:flags=bilinear")
    chain.append(f"scale={W}:{H}:flags=bicubic")
    if P["barrel"]:
        chain.append(f"lenscorrection=k1=-{P['barrel']:.2f}:k2=-{P['barrel'] * 0.25:.2f}")
    if P.get("night"):
        chain.append("format=gray,eq=contrast=1.25:brightness=0.06:gamma=0.85,format=rgb24,colorchannelmixer=rr=0.15:rg=0:rb=0:gr=0.45:gg=1.0:gb=0.35:br=0.05:bg=0.15:bb=0.05")
    else:
        chain.append(f"eq=saturation={P['sat']}:contrast={P['contrast']}")
        if P["curves"]:
            chain.append(f"curves={P['curves']}")
    if shake > 0.01:
        chain.append(f"scale={SW}:{SH}")
        chain.append(f"rotate=a='({E})*({roll})':ow=iw:oh=ih:c=black")
        chain.append(f"crop={W}:{H}:x='(iw-{W})/2+({E})*({xo})':y='(ih-{H})/2+({E})*({yo})'")
    chain.append("unsharp=5:5:-0.7:5:5:0")        # soften: a cheap lens, not a sharp render
    head = ",".join(chain)
    fc = [f"[0:v]{head}[base]"]
    cur = "[base]"
    # ---- focus hunting: the autofocus drifts off and re-finds the subject (a few episodes; blur ramps up and back down)
    if focus > 0.02:
        rf = random.Random(seed + 5)
        eps = []
        for _ in range(max(1, int(round(focus * dur / 3.5)))):
            d = rf.uniform(0.9, 2.4); t0 = rf.uniform(0.3, max(0.4, dur - d - 0.2)); eps.append((t0, t0 + d))
        stages = []
        for t0, t1 in eps:
            d = t1 - t0
            for frac, sg in ((0.0, 2.0 + 2 * focus), (0.2, 4.0 + 4 * focus), (0.38, 7.0 + 7 * focus)):
                stages.append(f"gblur=sigma={sg:.1f}:enable='between(t,{t0 + frac * d:.2f},{t1 - frac * d:.2f})'")
        fc.append(f"{cur}{','.join(stages)}[foc]")
        cur = "[foc]"
    post = []
    # ---- exposure: auto-exposure breathing + the odd blow-out
    eb = 0.025 + 0.05 * shake
    post.append(f"eq=brightness='{eb:.3f}*sin({tau}*0.11*t+{ph[1]:.2f})+{0.05 + 0.12 * shake:.3f}*pow(max(0,sin({tau}*0.083*t+{ph[5]:.2f})),30)':"
                f"contrast='1+0.05*sin({tau}*0.15*t+{ph[6]:.2f})':eval=frame")
    if P["chroma"]:
        post.append(f"rgbashift=rh=-{P['chroma']}:bh={P['chroma']}:gv=0")
    if P["scan"]:
        post.append(f"drawgrid=width=iw:height=3:thickness=1:color=black@{P['scan']:.2f}")
    post.append(f"vignette=PI/{max(2.2, 6 - 2.2 * P['vignette']):.2f}")
    g = max(0, int(P["grain"] * (0.4 + 1.2 * grain) * (1 + wear * 0.6)))
    if g:
        post.append(f"noise=alls={g}:allf=t+u")
    # ---- tape / sensor glitches
    r = random.Random(seed + 99)
    n_gl = int(round(glitch * dur / 5.0)) if glitch > 0 else 0
    for _ in range(n_gl):
        t0 = r.uniform(0.6, max(0.7, dur - 0.5)); t1 = t0 + r.uniform(0.07, 0.22)
        en = f"enable='between(t,{t0:.2f},{t1:.2f})'"
        post.append(f"noise=alls=85:allf=t:{en}")
        post.append(f"rgbashift=rh={r.randint(5, 14)}:bh=-{r.randint(5, 14)}:rv={r.randint(-3, 3)}:{en}")
        post.append(f"eq=contrast=1.5:brightness=0.07:saturation=0.4:{en}")
    # ---- camera overlays
    if stamp and P["stamp"] != "none":
        size = max(14, int(min(H * 0.042, W * 0.05)))
        portrait = W < H
        date_text = date_text or time.strftime("%b %d %Y").upper()
        ep = epoch if epoch is not None else int(time.time())
        dt = f"%{{pts\\:gmtime\\:{ep}\\:%Y-%m-%d  %H\\\\\\:%M\\\\\\:%S}}"
        tc = "%{pts\\:gmtime\\:0\\:%H\\\\\\:%M\\\\\\:%S}"
        white = f"fontcolor=white:fontsize={size}:shadowcolor=black:shadowx=2:shadowy=2"
        def txt(text, x, y, extra=""):
            return f"drawtext={FONT}text='{text}':x={x}:y={y}:{white}{extra}"
        m = int(W * 0.035)
        dot = lambda x, y: f"drawbox=x={x}:y={y}:w={int(size * 0.7)}:h={int(size * 0.7)}:color=red@0.95:t=fill:enable='lt(mod(t,1.4),0.8)'"
        st = P["stamp"]
        dpos = (m, m + int(size * 1.4)) if portrait else (f"w-text_w-{m}", m)    # narrow frames: stack the date under the name
        if st == "camcorder":
            post += [dot(m, m), txt("REC", m + int(size), m - 2), txt(tc, m, f"h-{m + size}"), txt(date_text, f"w-text_w-{m}", f"h-{m + size}"),
                     txt("SP", f"w-text_w-{m}", m - 2)]
        elif st == "vhs":
            post += [txt("PLAY", m, m), txt("SP", f"w-text_w-{m}", m), txt(date_text, m, f"h-{m + size}"), txt(tc, f"w-text_w-{m}", f"h-{m + size}")]
        elif st == "cctv":
            post += [txt(cam_name, m, m), txt(dt, *dpos), dot(m, f"h-{m + size}"), txt("REC", m + int(size), f"h-{m + size}")]
        elif st == "night":
            post += [txt("NV", m, m), dot(f"w-{m + int(size)}", m), txt(tc, m, f"h-{m + size}"), txt("IR ON", f"w-text_w-{m}", f"h-{m + size}")]
        elif st == "bodycam":
            post += [txt("BODYCAM", m, m), txt(dt, *dpos), dot(m, f"h-{m + size}"), txt(tc, m + int(size), f"h-{m + size}")]
        elif st == "doorbell":
            post += [txt("FRONT DOOR", m, m), txt(dt, *dpos), txt("MOTION DETECTED", m, f"h-{m + size}")]
    if P["fps"]:
        post.append(f"fps={fps:.3f}")
    post.append("format=yuv420p")
    fc.append(f"{cur}{','.join(post)}[v]")

    # ---- audio: a cheap mic in a real place
    a_label = None
    if audio not in ("none", "passthrough"):
        wind = f"anoisesrc=c=brown:a=0.07:d={dur + 0.5:.2f}:r=44100,lowpass=f=260,tremolo=f=0.23:d=0.7[wind]"
        hiss = f"anoisesrc=c=pink:a={0.012 + 0.012 * wear:.3f}:d={dur + 0.5:.2f}:r=44100,highpass=f=400,lowpass=f=7000[hiss]"
        fc += [wind, hiss]
        if has_audio:
            if audio == "degrade":
                fc.append("[0:a]highpass=f=120,lowpass=f=6500,acompressor=threshold=0.04:ratio=9:attack=6:release=140,volume=1.6,"
                          "acrusher=bits=11:mode=log:aa=1:mix=0.3,alimiter=limit=0.85[am]")
            else:
                fc.append("[0:a]anull[am]")
            fc.append("[am][wind][hiss]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[a]")
        else:
            fc.append("[wind][hiss]amix=inputs=2:duration=first:normalize=0[a]")
        a_label = "[a]"
    return {"fc": ";".join(fc), "v": "[v]", "a": a_label}
