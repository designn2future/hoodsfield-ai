"""Layered loops: a perfectly still background picture plus animated overlay layers composited with blend modes, like an After Effects comp.

Every layer is generated on an exact cycle of T seconds (positions wrap, phases are whole numbers of turns, noise textures are periodic and scrolled by a
whole texture width), so the result is seamless BY CONSTRUCTION: frame T is exactly frame 0. The background never moves, so nothing can drift or dissolve.

Layer types: rain, snow, petals, fireflies, stars, mist, aurora (overlay layers, blended with screen / add / normal / soft light / overlay / multiply),
flow (water streaming down waterfalls: found automatically as the bright, white-ish parts of the picture), shimmer (glitter on a lake or sea),
flicker (breathing light on the highlights), breathing (a slow, tiny camera push on the background), grain (film grain) and vignette.
Pure numpy; frames are streamed to ffmpeg.
"""
import math
import subprocess
from pathlib import Path

import numpy as np

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
BLENDS = ("screen", "add", "normal", "soft_light", "overlay", "multiply")
DEFAULTS = {
    "rain": dict(opacity=0.35, amount=0.5, speed=1.0, blend="screen", color="#c8d7ff"),
    "snow": dict(opacity=0.8, amount=0.5, speed=1.0, blend="normal", color="#ffffff"),
    "petals": dict(opacity=0.9, amount=0.4, speed=1.0, blend="normal", color="#ffb7d5"),
    "fireflies": dict(opacity=0.9, amount=0.5, speed=1.0, blend="screen", color="#ffe49a"),
    "stars": dict(opacity=0.9, amount=0.5, speed=1.0, blend="screen", color="#ffffff", region=0.5),
    "mist": dict(opacity=0.22, amount=0.5, speed=1.0, blend="screen", color="#cfe0ff", region=0.4),
    "aurora": dict(opacity=0.28, amount=0.5, speed=1.0, blend="screen", color="#52ffb8", region=0.45),
    "flow": dict(opacity=0.5, amount=0.5, speed=1.0, blend="normal", color="#ffffff"),
    "shimmer": dict(opacity=0.5, amount=0.5, speed=1.0, blend="normal", color="#ffffff", region=0.4),
    "flicker": dict(opacity=0.5, amount=0.5, speed=1.0, blend="normal", color="#ffffff"),
    "breathing": dict(opacity=1.0, amount=0.5, speed=1.0, blend="normal", color="#ffffff"),
    "grain": dict(opacity=1.0, amount=0.4, speed=1.0, blend="normal", color="#ffffff"),
    "vignette": dict(opacity=1.0, amount=0.4, speed=1.0, blend="normal", color="#000000"),
}


def hex_rgb(h: str):
    h = (h or "#ffffff").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], np.float32)
    except ValueError:
        return np.ones(3, np.float32)


# ---------------------------------------------------------------- helpers
def periodic_noise(h, w, rng, fx=1.0, fy=1.0):
    """Smooth noise (0..1) that tiles in both directions. fx/fy: spatial frequency falloff (bigger = finer detail)."""
    kx = np.fft.fftfreq(w)[None, :] * w
    ky = np.fft.fftfreq(h)[:, None] * h
    r = np.sqrt((kx / fx) ** 2 + (ky / fy) ** 2) + 1.0
    spec = (rng.standard_normal((h, w)) + 1j * rng.standard_normal((h, w))) / (r ** 2.2)
    n = np.real(np.fft.ifft2(spec))
    n = (n - n.min()) / (n.max() - n.min() + 1e-9)
    return n.astype(np.float32)


def scroll_x(tex, shift):
    """Horizontally scroll a tiling texture by a (fractional) number of pixels, wrapping."""
    w = tex.shape[1]
    s = shift % w
    i = int(np.floor(s))
    f = s - i
    a = np.roll(tex, -i, axis=1)
    if f < 1e-6:
        return a
    b = np.roll(tex, -i - 1, axis=1)
    return a * (1 - f) + b * f


def gauss_stamp(r, sig=None):
    sig = sig or r / 2.2
    ax = np.arange(-r, r + 1, dtype=np.float32)
    g = np.exp(-(ax[None, :] ** 2 + ax[:, None] ** 2) / (2 * sig * sig))
    return g.astype(np.float32)


def add_stamp(buf, x, y, stamp, amp, color=None):
    r = stamp.shape[0] // 2
    xi, yi = int(round(x)), int(round(y))
    H, W = buf.shape[:2]
    x0, x1, y0, y1 = xi - r, xi + r + 1, yi - r, yi + r + 1
    sx0, sy0 = max(0, -x0), max(0, -y0)
    x0c, y0c, x1c, y1c = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    if x1c <= x0c or y1c <= y0c:
        return
    s = stamp[sy0:sy0 + (y1c - y0c), sx0:sx0 + (x1c - x0c)] * amp
    if buf.ndim == 3:
        buf[y0c:y1c, x0c:x1c] += s[..., None] * (color if color is not None else 1.0)
    else:
        buf[y0c:y1c, x0c:x1c] += s


# ---------------------------------------------------------------- layer generators: each returns f(frame_index) -> (rgb HxWx3 emission, alpha HxWx1 or None)
class Ctx:
    def __init__(self, W, H, N, fps):
        self.W, self.H, self.N, self.fps = W, H, N, fps
        self.T = N / fps
        self.sc = H / 1080.0                       # sizes are defined for 1080p and scale with the picture


def make_rain(c: Ctx, p, rng):
    n = int(120 + 1300 * p["amount"] * (c.W * c.H) / (1920 * 1080))
    col = hex_rgb(p["color"])
    cycles = max(1, int(round(p["speed"] * c.T / 2.2)))
    L = (rng.uniform(40, 110, n) * c.sc).astype(np.float32)
    x0 = rng.uniform(-0.1, 1.1, n) * c.W
    y0 = rng.uniform(0, 1, n)
    ang = math.radians(-9)
    bright = rng.uniform(0.35, 1.0, n)
    stamps = {}

    def frame(i):
        t = i / c.N
        buf = np.zeros((c.H, c.W), np.float32)
        for k in range(n):
            span = c.H + L[k]
            y = ((y0[k] + t * max(1, int(round(cycles * (1 + 0.15 * (k % 5)))))) % 1.0) * span - L[k]      # a whole number of passes, so the loop closes
            x = x0[k] + math.tan(ang) * (y - c.H / 2)
            ln = int(L[k])
            steps = max(2, ln // 3)
            for s in range(steps):
                f = s / (steps - 1)
                yy = y - f * L[k]
                key = int(2 * c.sc) if c.sc > 0.6 else 1
                st = stamps.get(key)
                if st is None:
                    st = stamps[key] = gauss_stamp(max(1, key), max(0.6, key * 0.5))
                add_stamp(buf, x + math.tan(ang) * (-f * L[k]), yy, st, bright[k] * 0.55 * (1 - 0.7 * f))
        return np.clip(buf, 0, 1)[..., None] * col, None
    return frame


def make_snow(c: Ctx, p, rng):
    n = int(80 + 700 * p["amount"] * (c.W * c.H) / (1920 * 1080))
    col = hex_rgb(p["color"])
    cycles = max(1, int(round(p["speed"] * c.T / 7.0)))
    x0 = rng.uniform(0, 1, n) * c.W
    y0 = rng.uniform(0, 1, n)
    rad = rng.choice([1, 2, 3, 4], n, p=[0.35, 0.3, 0.2, 0.15])
    sway_a = rng.uniform(8, 30, n) * c.sc
    sway_m = rng.integers(1, 4, n)
    sway_p = rng.uniform(0, 1, n)
    spd = rng.uniform(0.8, 1.2, n)
    stamps = {r: gauss_stamp(int(max(2, r * c.sc * 1.8)), max(0.8, r * c.sc * 0.8)) for r in (1, 2, 3, 4)}

    def frame(i):
        t = i / c.N
        buf = np.zeros((c.H, c.W), np.float32)
        for k in range(n):
            cyc = max(1, int(round(cycles * spd[k])))
            y = ((y0[k] + t * cyc) % 1.0) * (c.H + 20) - 10
            x = x0[k] + sway_a[k] * math.sin(2 * math.pi * (sway_m[k] * t + sway_p[k]))
            add_stamp(buf, x % c.W, y, stamps[int(rad[k])], 0.9)
        a = np.clip(buf, 0, 1)[..., None]
        return a * col, a
    return frame


def make_petals(c: Ctx, p, rng):
    n = int(8 + 70 * p["amount"] * (c.W * c.H) / (1920 * 1080))
    cols = [hex_rgb(p["color"])]
    pal = [np.array(v, np.float32) / 255 for v in ((255, 183, 213), (255, 214, 232), (255, 236, 160), (190, 255, 220), (210, 190, 255))]
    base = hex_rgb(p["color"])
    cols = [np.clip(0.5 * base + 0.5 * q, 0, 1) for q in pal]
    cycles = max(1, int(round(p["speed"] * c.T / 9.0)))
    x0 = rng.uniform(0, 1, n) * c.W
    y0 = rng.uniform(0, 1, n)
    size = rng.uniform(6, 13, n) * c.sc
    sway_a = rng.uniform(30, 120, n) * c.sc
    sway_m = rng.integers(1, 3, n)
    sway_p = rng.uniform(0, 1, n)
    rot_m = rng.integers(1, 4, n) * rng.choice([-1, 1], n)
    rot_p = rng.uniform(0, 1, n)
    spd = rng.uniform(0.85, 1.15, n)
    ci = rng.integers(0, len(cols), n)
    yy, xx = np.mgrid[-24:25, -24:25].astype(np.float32)

    def stamp(ang, rx, ry):
        ca, sa = math.cos(ang), math.sin(ang)
        u = xx * ca + yy * sa
        v = -xx * sa + yy * ca
        d = (u / rx) ** 2 + (v / ry) ** 2
        return np.clip(1.0 - d, 0, 1) ** 0.6

    def frame(i):
        t = i / c.N
        rgb = np.zeros((c.H, c.W, 3), np.float32)
        al = np.zeros((c.H, c.W), np.float32)
        for k in range(n):
            cyc = max(1, int(round(cycles * spd[k])))
            y = ((y0[k] + t * cyc) % 1.0) * (c.H + 60) - 30
            x = x0[k] + sway_a[k] * math.sin(2 * math.pi * (sway_m[k] * t + sway_p[k]))
            ang = 2 * math.pi * (rot_m[k] * t + rot_p[k])
            s = stamp(ang, size[k] * (0.55 + 0.45 * abs(math.cos(ang))), size[k] * 0.45)
            shade = 0.75 + 0.25 * math.cos(ang)
            r = 24
            xi, yi = int(round(x % c.W)), int(round(y))
            x0c, x1c, y0c, y1c = xi - r, xi + r + 1, yi - r, yi + r + 1
            sx0, sy0 = max(0, -x0c), max(0, -y0c)
            a0, b0, a1, b1 = max(0, x0c), max(0, y0c), min(c.W, x1c), min(c.H, y1c)
            if a1 <= a0 or b1 <= b0:
                continue
            sm = s[sy0:sy0 + (b1 - b0), sx0:sx0 + (a1 - a0)]
            rgb[b0:b1, a0:a1] = np.maximum(rgb[b0:b1, a0:a1], sm[..., None] * cols[ci[k]] * shade)
            al[b0:b1, a0:a1] = np.maximum(al[b0:b1, a0:a1], sm)
        return rgb, al[..., None]
    return frame


def make_fireflies(c: Ctx, p, rng):
    n = int(14 + 150 * p["amount"] * (c.W * c.H) / (1920 * 1080))
    col = hex_rgb(p["color"])
    cx = rng.uniform(0.02, 0.98, n) * c.W
    cy = rng.uniform(0.1, 0.98, n) * c.H
    ax = rng.uniform(20, 140, n) * c.sc
    ay = rng.uniform(15, 90, n) * c.sc
    mx = rng.integers(1, 3, n)
    my = rng.integers(1, 4, n)
    px = rng.uniform(0, 1, n)
    py = rng.uniform(0, 1, n)
    pm = rng.integers(1, 4, n)
    pp = rng.uniform(0, 1, n)
    rad = rng.uniform(3, 9, n) * c.sc
    sp = max(1, int(round(p["speed"])))
    stamps = {}

    def frame(i):
        t = i / c.N
        buf = np.zeros((c.H, c.W), np.float32)
        for k in range(n):
            x = cx[k] + ax[k] * math.sin(2 * math.pi * (mx[k] * sp * t + px[k]))
            y = cy[k] + ay[k] * math.sin(2 * math.pi * (my[k] * sp * t + py[k]))
            pulse = (0.5 + 0.5 * math.sin(2 * math.pi * (pm[k] * t + pp[k]))) ** 2
            if pulse < 0.02:
                continue
            r = int(max(2, round(rad[k])))
            st = stamps.get(r)
            if st is None:
                st = stamps[r] = gauss_stamp(r * 2, r * 0.75)
            add_stamp(buf, x, y, st, 0.95 * pulse)
            add_stamp(buf, x, y, gauss_stamp(1, 0.8) if 1 not in stamps else stamps[1], 0.8 * pulse) if False else None
        buf = np.clip(buf, 0, 1.3)
        return buf[..., None] * (0.55 * col + 0.45) * (buf[..., None] > 0.6) * 0.0 + buf[..., None] * col, None
    return frame


def make_stars(c: Ctx, p, rng):
    n = int(40 + 420 * p["amount"] * (c.W * c.H) / (1920 * 1080))
    col = hex_rgb(p["color"])
    reg = float(p.get("region", 0.5))
    x = rng.uniform(0, c.W, n)
    y = rng.uniform(0, reg * c.H, n)
    ph = rng.uniform(0, 1, n)
    m = rng.integers(1, 5, n)
    big = rng.random(n) < 0.12
    s1 = gauss_stamp(2, 0.9)
    s2 = gauss_stamp(4, 1.6)

    def frame(i):
        t = i / c.N
        buf = np.zeros((c.H, c.W), np.float32)
        for k in range(n):
            tw = 0.25 + 0.75 * (0.5 + 0.5 * math.sin(2 * math.pi * (m[k] * t + ph[k]))) ** 2
            add_stamp(buf, x[k], y[k], s2 if big[k] else s1, tw * (0.9 if big[k] else 0.7))
            if big[k] and tw > 0.7:
                L = int(10 * c.sc * tw)
                xi, yi = int(x[k]), int(y[k])
                for d in range(-L, L + 1):
                    for (a, b) in ((xi + d, yi), (xi, yi + d)):
                        if 0 <= a < c.W and 0 <= b < c.H:
                            buf[b, a] += 0.5 * tw * (1 - abs(d) / (L + 1))
        return np.clip(buf, 0, 1)[..., None] * col, None
    return frame


def make_mist(c: Ctx, p, rng):
    """Organic mist: a smooth fog field whose Fourier modes each drift at their own whole-number speed (cycles per loop), so patches billow,
    merge and wander at different speeds and directions instead of sliding as one sheet. Every temporal frequency is an integer, so frame N == frame 0."""
    w2 = max(96, c.W // 8)
    h2 = max(54, c.H // 8)
    kx = (np.fft.fftfreq(w2) * w2)[None, :]
    ky = (np.fft.fftfreq(h2) * h2)[:, None]
    r = np.sqrt((kx / 2.5) ** 2 + (ky / 1.8) ** 2) + 1.0
    spec = (rng.standard_normal((h2, w2)) + 1j * rng.standard_normal((h2, w2))) / (r ** 2.0)
    spec[0, 0] = 0
    turns = max(1, int(round(p["speed"])))
    # integer cycles per loop for every mode: a gentle shared wind (a fraction of a picture width per loop) plus a random wander per mode;
    # finer detail wanders faster, and some modes move against the wind
    wind = 0.14 * turns * kx
    wander = rng.normal(0.0, 1.0, (h2, w2)) * (0.22 + 0.09 * np.sqrt(kx ** 2 + ky ** 2))
    vert = rng.normal(0.0, 0.5, (h2, w2)) * ky * 0.35
    m = np.rint(wind + wander + vert).astype(np.int32)
    std0 = float(np.real(np.fft.ifft2(spec)).std()) + 1e-9
    col = hex_rgb(p["color"])
    reg = float(p.get("region", 0.4))
    yv = np.linspace(0, 1, h2, dtype=np.float32)[:, None]
    xv = np.linspace(0, 1, w2, dtype=np.float32)[None, :]
    ph = rng.random(4) * 2 * np.pi

    def frame(i):
        t = i / c.N
        f = np.real(np.fft.ifft2(spec * np.exp(2j * np.pi * m * t))) / std0          # ~N(0,1), evolving
        d = np.clip((f + 0.25) / 1.7, 0, 1)
        d = d * d * (3 - 2 * d)
        # a lower edge that rolls: the band's centre sways with whole-number cycles in x and in time
        sway = 0.045 * np.sin(2 * np.pi * (2 * xv + t) + ph[0]) + 0.025 * np.sin(2 * np.pi * (5 * xv - 2 * t) + ph[1]) + 0.015 * np.sin(2 * np.pi * (9 * xv + 3 * t) + ph[2])
        band = np.clip(1 - np.abs(yv - (1 - reg / 2) - sway) / (reg / 2 + 1e-3), 0, 1) ** 1.2
        big = np.asarray(_resize(d * band, c.W, c.H), np.float32)
        return big[..., None] * col, None
    return frame


def make_aurora(c: Ctx, p, rng):
    w2 = max(64, c.W // 4)
    h2 = max(32, c.H // 6)
    tex = periodic_noise(h2, w2, rng, fx=2.0, fy=0.5)         # streaky: low vertical frequency
    tex2 = periodic_noise(h2, w2, rng, fx=3.5, fy=0.8)
    reg = float(p.get("region", 0.45))
    base = hex_rgb(p["color"])
    pal = [np.clip(base, 0, 1), np.clip(base * np.array([0.5, 1.0, 1.0]) + np.array([0.0, 0.1, 0.25]), 0, 1), np.array([0.75, 0.35, 1.0], np.float32)]
    yv = np.linspace(0, 1, h2)[:, None]
    fall = np.clip(1 - yv / (reg + 1e-3), 0, 1) ** 1.4
    turns = max(1, int(round(p["speed"])))

    def frame(i):
        t = i / c.N
        a = scroll_x(tex, t * w2 * turns)
        b = scroll_x(tex2, -t * w2 * turns)
        m = np.clip((a * 0.7 + b * 0.5 - 0.3) * 2.0, 0, 1) * fall
        m = np.asarray(_resize(m, c.W, c.H), np.float32)
        yy = np.linspace(0, 1, c.H, dtype=np.float32)[:, None]
        k = np.clip(yy / (reg + 1e-3), 0, 1)
        colimg = pal[0][None, None, :] * (1 - k[..., None]) + pal[2][None, None, :] * k[..., None]
        return m[..., None] * colimg, None
    return frame


def _resize(a, W, H):
    """Bilinear resize of a 2-D array."""
    h, w = a.shape
    ys = np.linspace(0, h - 1, H, dtype=np.float32)
    xs = np.linspace(0, w - 1, W, dtype=np.float32)
    y0 = np.floor(ys).astype(int); x0 = np.floor(xs).astype(int)
    y1 = np.minimum(y0 + 1, h - 1); x1 = np.minimum(x0 + 1, w - 1)
    fy = (ys - y0)[:, None]; fx = (xs - x0)[None, :]
    return (a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx) * (1 - fy) + (a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx) * fy


OVERLAYS = {"rain": make_rain, "snow": make_snow, "petals": make_petals, "fireflies": make_fireflies, "stars": make_stars, "mist": make_mist, "aurora": make_aurora}


def _smooth(x, lo, hi):
    t = np.clip((x - lo) / (hi - lo + 1e-9), 0, 1)
    return t * t * (3 - 2 * t)


def make_flow(c: Ctx, p, rng, base):
    """Waterfalls: streaky noise streaming downward, only where the picture is bright and nearly colourless (water, foam, mist)."""
    lum = base[..., 0] * 0.3 + base[..., 1] * 0.59 + base[..., 2] * 0.11
    mx, mn = base.max(2), base.min(2)
    sat = (mx - mn) / (mx + 1e-4)
    mask = (_smooth(lum, 0.50, 0.78) * (1 - _smooth(sat, 0.28, 0.55))).astype(np.float32)
    mask = _smooth_blur(mask, 2)
    w2 = max(64, c.W // 3)
    h2 = max(64, c.H // 2)
    tex = periodic_noise(h2, w2, rng, fx=9.0, fy=1.1)
    tex2 = periodic_noise(h2, w2, rng, fx=5.0, fy=0.8)
    turns = max(1, int(round(p["speed"] * 2)))
    amt = float(p["amount"])

    def frame(i, img):
        t = i / c.N
        a = np.roll(tex, int(round(-t * h2 * turns)) % h2, axis=0)
        b = np.roll(tex2, int(round(-t * h2 * turns * 2)) % h2, axis=0)
        n = _resize(a * 0.6 + b * 0.4, c.W, c.H) - 0.5
        return img + (mask * n * (0.9 * amt) * (0.6 + 0.8 * lum))[..., None] * np.array([0.9, 1.0, 1.05], np.float32)
    return frame


def make_shimmer(c: Ctx, p, rng, base):
    """Glitter on water: bright points on the lower part of the picture twinkle as slow horizontal ripples pass through."""
    lum = base[..., 0] * 0.3 + base[..., 1] * 0.59 + base[..., 2] * 0.11
    reg = float(p.get("region", 0.4))
    yv = np.linspace(0, 1, c.H, dtype=np.float32)[:, None]
    band = _smooth(yv, 1 - reg - 0.05, 1 - reg + 0.12) * np.ones((1, c.W), np.float32)
    mask = (band * _smooth(lum, 0.12, 0.55)).astype(np.float32)
    w2 = max(64, c.W // 3)
    h2 = max(32, c.H // 6)
    tex = periodic_noise(h2, w2, rng, fx=14.0, fy=3.0)
    turns = max(1, int(round(p["speed"])))
    amt = float(p["amount"])

    def frame(i, img):
        t = i / c.N
        n = _resize(scroll_x(tex, t * w2 * turns), c.W, c.H) - 0.5
        return img + (mask * n * amt * 0.9 * (0.4 + lum))[..., None]
    return frame


def _smooth_blur(a, r):
    """Cheap separable box blur for masks."""
    out = a.astype(np.float32)
    for axis in (0, 1):
        n = out.shape[axis]
        pad = [(0, 0)] * out.ndim
        pad[axis] = (r + 1, r)
        cs = np.cumsum(np.pad(out, pad, mode="edge"), axis=axis, dtype=np.float64)
        hi = np.take(cs, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
        lo = np.take(cs, np.arange(0, n), axis=axis)
        out = ((hi - lo) / (2 * r + 1)).astype(np.float32)
    return out


# ---------------------------------------------------------------- compositing
def blend(base, rgb, alpha, mode, op):
    if mode == "add":
        return base + rgb * op
    if mode == "normal":
        a = (alpha if alpha is not None else np.clip(rgb.max(2, keepdims=True), 0, 1)) * op
        return base * (1 - a) + rgb * a
    if mode == "multiply":
        return base * (1 - op + op * np.clip(rgb, 0, 1))
    if mode == "soft_light":
        l = np.clip(rgb, 0, 1)
        sl = (1 - 2 * l) * base * base + 2 * l * base
        return base * (1 - op) + sl * op + 0 * l
    if mode == "overlay":
        l = np.clip(rgb, 0, 1)
        ov = np.where(base < 0.5, 2 * base * l, 1 - 2 * (1 - base) * (1 - l))
        return base * (1 - op) + ov * op
    return 1 - (1 - base) * (1 - np.clip(rgb * op, 0, 1.5))          # screen


def _breathing_frame(img, i, N, amp, W, H):
    """A tiny, perfectly periodic push-in on the background: scale 1 -> 1+amp -> 1."""
    if amp <= 0:
        return img
    s = 1.0 + amp * (0.5 - 0.5 * math.cos(2 * math.pi * i / N))
    if s - 1.0 < 1e-5:
        return img
    cw, chh = W / s, H / s
    x0, y0 = (W - cw) / 2, (H - chh) / 2
    xs = np.clip(x0 + (np.arange(W, dtype=np.float32) + 0.5) * (cw / W) - 0.5, 0, W - 1.001)
    ys = np.clip(y0 + (np.arange(H, dtype=np.float32) + 0.5) * (chh / H) - 0.5, 0, H - 1.001)
    xi = xs.astype(np.int32); yi = ys.astype(np.int32)
    fx = (xs - xi)[None, :, None]; fy = (ys - yi)[:, None, None]
    top = img[yi][:, xi] * (1 - fx) + img[yi][:, np.minimum(xi + 1, W - 1)] * fx
    bot = img[np.minimum(yi + 1, H - 1)][:, xi] * (1 - fx) + img[np.minimum(yi + 1, H - 1)][:, np.minimum(xi + 1, W - 1)] * fx
    return top * (1 - fy) + bot * fy


def prepare(background, layers, seconds, fps, seed=7, base_frames=None):
    """Build the compositor. Returns (compose(i) -> float32 HxWx3 in 0..1, N, W, H)."""
    if base_frames is not None:
        N = len(base_frames)
        H, W = base_frames[0].shape[:2]
    else:
        N = max(2, int(round(seconds * fps)))
        H, W = background.shape[:2]
    c = Ctx(W, H, N, fps)
    rng = np.random.default_rng(seed)
    gens, post, mods = [], {}, []
    for L in layers:
        ty = L.get("type")
        prm = dict(DEFAULTS.get(ty, {}))
        prm.update({k: v for k, v in L.items() if v is not None})
        if ty in OVERLAYS:
            bm = None
            bx = prm.get("box")
            if isinstance(bx, (list, tuple)) and len(bx) == 4:
                x0, y0, x1, y1 = [float(v) for v in bx]
                xs = np.linspace(0, 1, W, dtype=np.float32)[None, :]
                ys = np.linspace(0, 1, H, dtype=np.float32)[:, None]
                f = 0.02
                bm = (_smooth(xs, x0 - f, x0 + f) * (1 - _smooth(xs, x1 - f, x1 + f)) * _smooth(ys, y0 - f, y0 + f) * (1 - _smooth(ys, y1 - f, y1 + f)))[..., None].astype(np.float32)
            pl = prm.get("poly")
            if isinstance(pl, (list, tuple)) and len(pl) >= 3:
                import cv2
                pm = np.zeros((H, W), np.uint8)
                cv2.fillPoly(pm, [np.array([[float(q[0]) * (W - 1), float(q[1]) * (H - 1)] for q in pl], np.int32)], 255)
                k = max(3, int(min(W, H) * 0.01) | 1)
                bm = (cv2.GaussianBlur(pm, (k, k), 0).astype(np.float32) / 255.0)[..., None]
            gens.append((OVERLAYS[ty](c, prm, np.random.default_rng(int(rng.integers(1 << 30)))), prm, bm))
        elif ty in ("flicker", "breathing", "grain", "vignette"):
            post[ty] = prm
        elif ty in ("flow", "shimmer"):
            ref = background if background is not None else (base_frames[0].astype(np.float32) / 255.0)
            mods.append((make_flow if ty == "flow" else make_shimmer)(c, prm, np.random.default_rng(int(rng.integers(1 << 30))), ref))
    vig = None
    if "vignette" in post:
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        d = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
        vig = (1 - post["vignette"]["amount"] * 0.9 * np.clip((d - 0.45) / 0.9, 0, 1) ** 1.5)[..., None].astype(np.float32)
    grain_rng = np.random.default_rng(seed + 99)

    def compose(i):
        base = (base_frames[i].astype(np.float32) / 255.0) if base_frames is not None else background
        if "breathing" in post:
            base = _breathing_frame(base, i, N, 0.035 * post["breathing"]["amount"], W, H)
        img = base.copy()
        for mod in mods:
            img = mod(i, img)
        if "flicker" in post:
            a = post["flicker"]["amount"] * 0.07
            m = 0.6 * math.sin(2 * math.pi * (2 * i / N) + 0.7) + 0.4 * math.sin(2 * math.pi * (5 * i / N) + 2.1)
            lum = (img[..., 0] * 0.3 + img[..., 1] * 0.59 + img[..., 2] * 0.11)[..., None]
            img = img * (1 + a * m * (0.25 + 0.75 * lum ** 2))
        for gen, prm, bm in gens:
            rgb, al = gen(i)
            if bm is not None:
                rgb = rgb * bm
                al = al * bm if al is not None else None
            img = blend(img, rgb, al, prm["blend"] if prm["blend"] in BLENDS else "screen", float(prm["opacity"]))
        if vig is not None:
            img = img * vig
        if "grain" in post:
            g = grain_rng.standard_normal((H, W, 1)).astype(np.float32) * (post["grain"]["amount"] * 0.05)
            img = img + g * (0.4 + 0.6 * (1 - np.abs(img - 0.5) * 2))
        return img
    return compose, N, W, H


def render(background, layers, seconds, fps, out_path, ffmpeg, seed=7, on_progress=None, crf=16, base_frames=None, target=None):
    """Render the loop to an mp4. background: float32 (H, W, 3) 0..1, or None when base_frames (list of uint8 frames) is given."""
    compose, N, W, H = prepare(background, layers, seconds, fps, seed, base_frames)
    enc = [ffmpeg, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
           "-vf", (f"scale={target[0]}:{target[1]}:force_original_aspect_ratio=increase:flags=lanczos,crop={target[0]}:{target[1]}," if target else "pad=ceil(iw/2)*2:ceil(ih/2)*2,") + "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
           "-c:v", "libx264", "-crf", str(crf), "-preset", "slow",
           "-x264-params", "bframes=0:keyint=240:min-keyint=24:scenecut=0", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
           "-movflags", "+faststart", str(out_path)]
    pr = subprocess.Popen(enc, stdin=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NOWIN)
    for i in range(N):
        pr.stdin.write(np.clip(compose(i) * 255 + 0.5, 0, 255).astype(np.uint8).tobytes())
        if on_progress and i % 10 == 0:
            on_progress(i / N)
    pr.stdin.close()
    err = pr.stderr.read().decode(errors="ignore")
    pr.wait()
    if pr.returncode or not Path(out_path).exists():
        raise RuntimeError("Could not encode the layered loop: " + err[-300:])
    return N
