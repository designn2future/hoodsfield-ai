"""Found-footage sound design: the soundtrack a cheap microphone in a frightening place would record.

Everything is synthesised (numpy) or generated locally (Stable Audio Open for natural ambience), then mixed with the clip's own audio
and squeezed through a cheap-mic chain. The part that makes it feel real is that the sound reacts to the picture: the camera's actual
jolts are measured from the video (phase correlation between frames) and every jolt gets a mic bump / cloth rustle.
"""
import re
import subprocess
import wave

import numpy as np

SR = 44100


# ------------------------------------------------------------------ helpers
def probe(ff: str, path: str) -> dict:
    t = subprocess.run([ff, "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", t)
    dur = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]) if m else 0.0
    v = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", t)
    return {"duration": dur, "width": int(v[1]) if v else 0, "height": int(v[2]) if v else 0, "audio": "Audio:" in t}


def decode_audio(ff: str, path: str, dur: float) -> np.ndarray:
    """Any audio/video file -> float32 stereo array at 44.1 kHz (zeros if there is no audio)."""
    r = subprocess.run([ff, "-v", "error", "-i", path, "-vn", "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"], capture_output=True)
    a = np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, 2) if r.stdout else np.zeros((0, 2), np.float32)
    n = int(dur * SR)
    out = np.zeros((n, 2), np.float32)
    out[: min(n, len(a))] = a[:n]
    return out


def write_wav(path: str, x: np.ndarray) -> None:
    x = np.clip(x, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())


def fft_band(x: np.ndarray, lo: float | None, hi: float | None) -> np.ndarray:
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    m = np.ones_like(f)
    if lo: m *= 1 / (1 + (lo / np.maximum(f, 1e-6)) ** 4)
    if hi: m *= 1 / (1 + (f / hi) ** 4)
    return np.fft.irfft(X * m, len(x))


def noise(n: int, rng, kind: str = "white") -> np.ndarray:
    x = rng.standard_normal(n)
    if kind == "white":
        return x
    X = np.fft.rfft(x)
    f = np.maximum(np.fft.rfftfreq(n, 1 / SR), 20)
    X *= 1 / np.sqrt(f) if kind == "pink" else 1 / f      # brown = 1/f amplitude
    y = np.fft.irfft(X, n)
    return y / (np.std(y) + 1e-9)


def decay(n: int, tau: float) -> np.ndarray:
    return np.exp(-np.arange(n) / (tau * SR))


def loop_xfade(x: np.ndarray, n: int, xf: float = 1.0) -> np.ndarray:
    """Repeat x to length n with equal-power crossfades so a looped ambience has no seam."""
    if len(x) >= n:
        return x[:n]
    k = int(min(xf * SR, len(x) // 3))
    if k < 100:
        return np.resize(x, n)
    out = x.copy(); fade = np.linspace(0, 1, k)
    while len(out) < n:
        out[-k:] = out[-k:] * np.cos(fade * np.pi / 2) + x[:k] * np.sin(fade * np.pi / 2)
        out = np.concatenate([out, x[k:]])
    return out[:n]


class Track:
    """A stereo mix buffer. add() drops a mono signal at time t with gain (dB) and pan (-1..1)."""
    def __init__(self, dur: float):
        self.n = int(dur * SR)
        self.buf = np.zeros((self.n, 2), np.float32)

    def add(self, sig: np.ndarray, t: float, db: float = 0.0, pan: float = 0.0):
        i = int(t * SR)
        if i >= self.n or i + len(sig) <= 0:
            return
        s0 = max(0, -i); sig = sig[s0: s0 + (self.n - max(i, 0))]
        i = max(i, 0)
        g = 10 ** (db / 20)
        l, r = g * (1 - max(0, pan)), g * (1 + min(0, pan))
        self.buf[i: i + len(sig), 0] += (sig * l).astype(np.float32)
        self.buf[i: i + len(sig), 1] += (sig * r).astype(np.float32)

    def add_stereo(self, sig: np.ndarray, t: float, db: float = 0.0):
        """Drop a stereo recording (n, 2) at time t."""
        i = int(t * SR)
        if i >= self.n or i + len(sig) <= 0:
            return
        s0 = max(0, -i); sig = sig[s0: s0 + (self.n - max(i, 0))]
        i = max(i, 0)
        self.buf[i: i + len(sig)] += (sig * 10 ** (db / 20)).astype(np.float32)

    def bed(self, sig: np.ndarray, db: float, fade_out: tuple | None = None):
        sig = loop_xfade(sig, self.n)
        if fade_out:        # (t0, t1): the bed fades away between these times and stays gone (e.g. the engine dies)
            t = np.arange(self.n) / SR
            sig = sig * (1 - 0.97 * np.clip((t - fade_out[0]) / max(0.05, fade_out[1] - fade_out[0]), 0, 1))
        g = 10 ** (db / 20)
        self.buf[:, 0] += (sig * g).astype(np.float32); self.buf[:, 1] += (np.roll(sig, 900) * g).astype(np.float32)   # tiny offset = a little width


# ------------------------------------------------------------------ measuring the picture
def motion_events(ff: str, path: str, dur: float, max_events: int | None = None) -> list[tuple[float, float]]:
    """Times where the camera visibly jolts: spikes in frame-to-frame global shift."""
    import cv2
    w = 96
    info = probe(ff, path)
    if not info["width"]:
        return []
    h = int(round(w * info["height"] / info["width"] / 2) * 2)
    r = subprocess.run([ff, "-v", "error", "-i", path, "-vf", f"fps=15,scale={w}:{h},format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True)
    raw = np.frombuffer(r.stdout, np.uint8)
    nf = len(raw) // (w * h)
    if nf < 6:
        return []
    frames = raw[: nf * w * h].reshape(nf, h, w).astype(np.float32)
    win = cv2.createHanningWindow((w, h), cv2.CV_32F)
    mag = np.zeros(nf)
    for i in range(1, nf):
        (dx, dy), _ = cv2.phaseCorrelate(frames[i - 1], frames[i], win)
        mag[i] = float(np.hypot(dx, dy))
    k = 7
    base = np.array([np.median(mag[max(0, i - k): i + k + 1]) for i in range(nf)])    # steady pans are not jolts
    spike = mag - base
    thr = max(0.55, 2.5 * np.median(np.abs(spike)))
    cand = [i for i in range(1, nf - 1) if spike[i] > thr and spike[i] >= spike[i - 1] and spike[i] >= spike[i + 1]]
    cand.sort(key=lambda i: -spike[i])
    max_events = max_events or max(3, int(dur / 1.5) + 2)
    chosen: list[int] = []
    for i in cand:
        if all(abs(i - j) > 6 for j in chosen):            # at least 0.4 s apart
            chosen.append(i)
        if len(chosen) >= max_events:
            break
    return sorted((i / 15.0, float(spike[i])) for i in chosen)


# ------------------------------------------------------------------ sound sources
def thump(rng, strength: float = 1.0) -> np.ndarray:
    """A mic bump / camera knock: a low body thud with a little noise on top."""
    n = int(0.45 * SR); t = np.arange(n) / SR
    f = 95 * np.exp(-t * 7) + 40
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * decay(n, 0.09)
    click = fft_band(noise(n, rng), 300, 3500) * decay(n, 0.012) * 0.6
    return strength * (body + click)


def rustle(rng, dur: float = 0.35) -> np.ndarray:
    n = int(dur * SR)
    x = fft_band(noise(n, rng), 900, 6500)
    a = np.abs(fft_band(noise(n, rng), None, 28)); a = a / (a.max() + 1e-9)
    return x * a * np.sin(np.pi * np.linspace(0, 1, n)) ** 0.7


def footstep(rng, surface: str) -> np.ndarray:
    n = int(0.28 * SR)
    if surface == "leaves":
        x = fft_band(noise(n, rng), 1800, 7500) * decay(n, 0.05)
        clicks = (rng.random(n) > 0.9992) * rng.standard_normal(n) * 6 * decay(n, 0.08)
        return 0.7 * x + 0.4 * fft_band(clicks, 1200, 8000) + 0.25 * np.sin(2 * np.pi * 70 * np.arange(n) / SR) * decay(n, 0.04)
    if surface == "gravel":
        g = fft_band(noise(n, rng), 1500, 8000) * (0.4 + 0.6 * (rng.random(n) > 0.55)) * decay(n, 0.07)
        return 0.8 * g + 0.3 * np.sin(2 * np.pi * 80 * np.arange(n) / SR) * decay(n, 0.05)
    return (np.sin(2 * np.pi * (100 - 25 * np.arange(n) / n) * np.arange(n) / SR) * decay(n, 0.05) + 0.25 * fft_band(noise(n, rng), 250, 1800) * decay(n, 0.04))   # floorboards


def breath(rng, intensity: float, T: float) -> np.ndarray:
    """One breath cycle of the person holding the camera: inhale then exhale, close to the mic."""
    n = int(T * SR); out = np.zeros(n)
    inn = int(n * 0.42); ex = int(n * 0.45)
    x = fft_band(noise(n, rng), 350, 2600 + 900 * intensity)
    out[:inn] = x[:inn] * np.sin(np.linspace(0, np.pi, inn)) ** 1.5
    s = int(n * 0.5)
    out[s: s + ex] = x[s: s + ex] * 0.8 * np.sin(np.linspace(0, np.pi, ex)) ** 1.2
    return out * (0.5 + 0.8 * intensity)


def distant_knock(rng) -> np.ndarray:
    hits = rng.integers(2, 4); sp = rng.uniform(0.28, 0.5)
    n = int((hits * sp + 2.2) * SR); x = np.zeros(n)
    for k in range(hits):
        i = int(k * sp * SR); m = int(0.2 * SR)
        x[i: i + m] += (np.sin(2 * np.pi * 135 * np.arange(m) / SR) * decay(m, 0.05) + 0.3 * fft_band(noise(m, rng), 200, 1200) * decay(m, 0.03)) * (0.8 + 0.4 * rng.random())
    tail = noise(int(2.0 * SR), rng) * decay(int(2.0 * SR), 0.55)
    y = np.convolve(x, tail[:: 8], mode="full")[:n]            # cheap reverb: a decaying noise tail
    y = fft_band(y / (np.abs(y).max() + 1e-9), 60, 1100)
    return y


def creak(rng) -> np.ndarray:
    n = int(rng.uniform(0.9, 1.7) * SR); t = np.arange(n) / SR
    f = 170 + 130 * np.sin(np.pi * t / t[-1]) ** 2 + 14 * np.sin(2 * np.pi * 31 * t)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * t / t[-1]) ** 2
    return fft_band(x + 0.2 * noise(n, rng), 120, 2500)


def drone(rng, dur: float, rising: bool) -> np.ndarray:
    n = int(dur * SR); t = np.arange(n) / SR
    x = sum(np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28)) * a for f, a in ((55, 0.5), (55.7, 0.5), (82.4, 0.25), (110.9, 0.18), (164.8, 0.07)))
    x = x * (0.7 + 0.3 * np.sin(2 * np.pi * 0.11 * t)) + 0.25 * fft_band(noise(n, rng, "pink"), 80, 900)
    return x * (np.linspace(0.25, 1.0, n) ** 1.6 if rising else 1.0)


def jump_scare(rng) -> np.ndarray:
    """A swell, a held breath of near-silence, then the hit: distorted noise + boom + ringing."""
    sw = int(1.1 * SR); gap = int(0.16 * SR); hit = int(0.9 * SR)
    swell = fft_band(noise(sw, rng), 300, 5000) * np.linspace(0, 1, sw) ** 3 * 0.5
    t = np.arange(hit) / SR
    h = np.tanh(9 * (noise(hit, rng) * decay(hit, 0.18) + np.sin(2 * np.pi * 58 * t) * decay(hit, 0.3) * 1.4)) * 0.9
    h += 0.25 * np.sin(2 * np.pi * 3800 * t) * decay(hit, 0.5)
    return np.concatenate([swell, np.zeros(gap), h])


def mic_flaws(x: np.ndarray, rng, level: float = 0.5) -> np.ndarray:
    """The human errors of someone holding a recorder: a hand or finger covers the microphone for a moment (muffled and quieter, with a scrape as it
    lands and lifts), cloth and fingers brush it, wind buffets it, and loud sounds overload it into distortion. `x` is stereo (n, 2)."""
    n = len(x)
    dur = n / SR
    out = x.astype(np.float32).copy()
    ref = float(np.sqrt((out ** 2).mean()) + 1e-6)
    # 1) covered-mic moments
    muffled = np.stack([fft_band(out[:, c], None, 620) for c in range(2)], 1) * 0.5
    env = np.zeros(n, np.float32)
    spots = []
    for _ in range(max(1, int(round(level * dur / 5.5)))):
        L = rng.uniform(0.45, 1.5) * (0.7 + 0.6 * level)
        t0 = rng.uniform(0.5, max(0.6, dur - L - 0.3))
        i0, i1 = int(t0 * SR), min(n, int((t0 + L) * SR))
        if i1 - i0 < 200:
            continue
        w = np.clip(np.sin(np.pi * np.linspace(0, 1, i1 - i0)) * 2.4, 0, 1).astype(np.float32)
        env[i0:i1] = np.maximum(env[i0:i1], w)
        spots.append((t0, t0 + L))
    out = out * (1 - env[:, None]) + muffled * env[:, None]
    # 2) scrapes where the hand lands and lifts, and a few random cloth / finger brushes
    def put(sig, t, gain):
        i = int(t * SR)
        if 0 <= i < n:
            sig = sig[: n - i] / (np.abs(sig).max() + 1e-9) * gain * ref * 3.2
            out[i: i + len(sig), 0] += sig
            out[i: i + len(sig), 1] += sig * 0.9
    for a, b in spots:
        put(rustle(rng, rng.uniform(0.12, 0.3)), a - 0.03, 0.55)
        put(rustle(rng, rng.uniform(0.12, 0.3)), b - 0.05, 0.4)
    for _ in range(int(round(level * dur / 4))):
        put(rustle(rng, rng.uniform(0.15, 0.45)), rng.uniform(0.2, max(0.3, dur - 0.6)), rng.uniform(0.15, 0.4))
    # 3) wind buffeting the capsule
    for _ in range(int(round(level * dur / 9))):
        L = rng.uniform(0.5, 1.2)
        m = int(L * SR)
        w = fft_band(noise(m, rng, "brown"), 25, 380) * np.sin(np.pi * np.linspace(0, 1, m)) ** 1.5
        put(w, rng.uniform(0.2, max(0.3, dur - L - 0.2)), 0.5)
    # 4) overload: the louder it gets, the more the cheap preamp distorts
    mono = np.abs(out).mean(axis=1)
    k = np.ones(1324, np.float32) / 1324
    loud = np.convolve(mono, k, mode="same")
    drive = 1 + (1.5 + 4.0 * level) * np.clip((loud - 0.22 * ref * 4) / (0.5 * ref * 4 + 1e-6), 0, 1)
    out = np.tanh(out * drive[:, None]) / np.tanh(drive[:, None])
    return out


def ambience_proc(kind: str, dur: float, rng) -> np.ndarray:
    n = int(dur * SR); t = np.arange(n) / SR
    if kind == "wind":
        gust = np.clip(0.5 + 0.5 * np.sin(2 * np.pi * 0.07 * t + 1) * np.sin(2 * np.pi * 0.19 * t + 2), 0.05, 1) ** 1.5
        return fft_band(noise(n, rng, "brown"), 40, 900) * gust * 1.1 + 0.15 * fft_band(noise(n, rng), 600, 2600) * gust ** 2
    if kind == "car":    # inside a moving car: engine drone + road roar + tyre hiss, slowly breathing, no seams between cuts
        sway = 0.85 + 0.15 * np.sin(2 * np.pi * 0.13 * t + 0.7) * np.sin(2 * np.pi * 0.05 * t + 1.9)
        roar = fft_band(noise(n, rng, "brown"), 30, 420) * 1.3
        hiss = 0.18 * fft_band(noise(n, rng), 900, 3800)
        eng = (0.22 * np.sin(2 * np.pi * 47 * t) + 0.12 * np.sin(2 * np.pi * 94 * t + 0.4) + 0.07 * np.sin(2 * np.pi * 141 * t + 1.1)) * (0.9 + 0.1 * np.sin(2 * np.pi * 0.4 * t))
        return (roar + hiss + eng) * sway
    if kind == "room":
        return 0.5 * fft_band(noise(n, rng, "pink"), 60, 2500) + 0.12 * np.sin(2 * np.pi * 120 * t) + 0.05 * np.sin(2 * np.pi * 240 * t)
    if kind == "house":
        base = 0.35 * fft_band(noise(n, rng, "pink"), 50, 1800) + 0.09 * np.sin(2 * np.pi * 50 * t)
        for _ in range(int(dur / 9)):
            c = creak(rng); i = int(rng.uniform(0, max(0.1, dur - 2)) * SR); e = min(n, i + len(c))
            base[i:e] += 0.4 * c[: e - i]
        return base
    if kind == "hospital":
        return 0.3 * fft_band(noise(n, rng, "pink"), 80, 3000) + 0.18 * np.sin(2 * np.pi * 100 * t) * (0.8 + 0.2 * np.sin(2 * np.pi * 0.3 * t)) + 0.05 * np.sin(2 * np.pi * 1000 * t) * (np.sin(2 * np.pi * 0.4 * t) > 0.97)
    return np.zeros(n)


AI_AMBIENCE = {
    "forest night": "dark forest at night, crickets, distant owl hoots, rustling leaves, light wind in the trees, quiet field recording, no music",
    "city night": "distant city at night, faint traffic hum, far-off siren, wind between buildings, quiet field recording, no music",
    "lake night": "lakeside at night, water lapping on the shore, frogs and crickets, soft wind, quiet field recording, no music",
    "basement": "empty concrete basement, dripping water, low machinery hum, faint pipes clanking, reverberant, quiet field recording, no music",
}


# ------------------------------------------------------------------ the mix
def design(dur: float, events: list[tuple[float, float]], original: np.ndarray, *, ambience: str = "none", ai_bed: np.ndarray | None = None,
           unease: str = "medium", bumps: bool = True, footsteps: str = "none", pace: str = "walk", breathing: str = "none",
           scare: float = -1.0, keep_original: bool = True, seed: int = 7, flaws: float = 0.0, crowd: list | None = None, bed_fade: tuple | None = None) -> np.ndarray:
    rng = np.random.default_rng(seed)
    tr = Track(dur)
    # the clip's own sound (voices from the video model) stays in front
    if keep_original:
        tr.buf += original * 0.9
    # overlapping voices: other people talking, shouting and screaming over the main line (each is a stereo recording placed at a time, with a gain in dB)
    for sig, t0, db in (crowd or []):
        tr.add_stereo(sig, t0, db)
    # ambience bed
    bed = ai_bed if ai_bed is not None else (ambience_proc({"wind": "wind", "car interior": "car", "room tone": "room", "house at night": "house", "hospital hum": "hospital"}.get(ambience, "none"), dur, rng) if ambience != "none" else None)
    if bed is not None and len(bed):
        tr.bed(bed / (np.std(bed) + 1e-9) * 0.1, -4, bed_fade)
    # tension
    level = {"low": 0.35, "medium": 0.7, "high": 1.0, "rising": 1.0}.get(unease, 0.7)
    if unease != "none" and level > 0:
        tr.bed(drone(rng, dur, unease == "rising"), -27 + 6 * level)
        for _ in range(int(round(level * dur / 7))):
            t = rng.uniform(1.0, max(1.1, dur - 2.5))
            (tr.add(distant_knock(rng), t, -19 + 4 * level, rng.uniform(-0.7, 0.7)) if rng.random() < 0.6 else tr.add(creak(rng), t, -22 + 4 * level, rng.uniform(-0.7, 0.7)))
    # the operator
    if bumps:
        for t, s in events:
            tr.add(thump(rng, min(1.0, 0.45 + s / 6)), max(0, t - 0.02), -13 + min(5, s), rng.uniform(-0.2, 0.2))
            tr.add(rustle(rng, rng.uniform(0.25, 0.5)), t, -21, rng.uniform(-0.3, 0.3))
    if breathing != "none":
        inten = {"calm": 0.25, "scared": 0.65, "panicked": 1.0}.get(breathing, 0.5)
        t = rng.uniform(0.2, 1.2)
        while t < dur - 0.3:
            T = {"calm": 4.2, "scared": 2.6, "panicked": 1.4}.get(breathing, 3) * rng.uniform(0.85, 1.15) * (1 - 0.35 * t / dur if breathing != "calm" else 1)
            tr.add(breath(rng, inten, T), t, -23 + 6 * inten, 0.05)
            t += T
    if footsteps != "none":
        step = 0.56 if pace == "walk" else 0.31
        t = rng.uniform(0.2, 0.8); side = 1
        while t < dur - 0.3:
            tr.add(footstep(rng, footsteps), t, -17 + 3 * (pace == "run"), 0.35 * side)
            side = -side; t += step * rng.uniform(0.92, 1.08)
    # loudness: the everyday sound sits at a solid level (so the quiet parts are actually audible), the scare is added on top at full strength
    out = tr.buf
    if flaws > 0:
        out = mic_flaws(out, rng, flaws)
    rms = float(np.sqrt((out ** 2).mean()) + 1e-9)
    out = out * (0.075 / rms) if rms > 0 else out                  # about -22 dBFS RMS
    p = float(np.abs(out).max())
    if p > 0.7:
        out = np.tanh(out / 0.7) * 0.7                             # soft-limit the loudest bumps
    if scare >= 0:
        sc = Track(dur)
        sc.add(jump_scare(rng), max(0.0, scare - 1.26), 0, 0)
        out = out + sc.buf * (0.9 / (np.abs(sc.buf).max() + 1e-9))
    pk = float(np.abs(out).max())
    return out * (0.92 / pk) if pk > 0.92 else out


CHEAP_MIC = ("highpass=f=110,lowpass=f=7200,acompressor=threshold=0.05:ratio=7:attack=6:release=150,volume=1.5,"
             "acrusher=bits=11:mode=log:aa=1:mix=0.28,alimiter=limit=0.9")


async def ai_ambience(comfy_url: str, prompt: str, seconds: float, seed: int = 7,
                      negative: str = "music, melody, drums, vocals, speech, bright cheerful sounds, distortion") -> np.ndarray:
    """Stable Audio Open (local, via ComfyUI) -> mono float32 audio at 44.1 kHz (an ambience bed, or a score when `negative` allows music)."""
    import asyncio
    import os
    import tempfile
    import httpx
    from audio_analysis import ffmpeg_exe
    secs = float(min(46.0, max(8.0, seconds)))
    g = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "stable_audio_open_1.0.safetensors"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5_base_stable_audio.safetensors", "type": "stable_audio", "device": "default"}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["2", 0]}},
        "5": {"class_type": "ConditioningStableAudio", "inputs": {"positive": ["3", 0], "negative": ["4", 0], "seconds_start": 0.0, "seconds_total": secs}},
        "6": {"class_type": "EmptyLatentAudio", "inputs": {"seconds": secs, "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {"seed": int(seed), "steps": 50, "cfg": 5.0, "sampler_name": "dpmpp_3m_sde_gpu", "scheduler": "exponential", "denoise": 1.0,
                                                    "model": ["1", 0], "positive": ["5", 0], "negative": ["5", 1], "latent_image": ["6", 0]}},
        "8": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["7", 0], "vae": ["1", 2]}},
        "9": {"class_type": "SaveAudio", "inputs": {"audio": ["8", 0], "filename_prefix": "vsa/ambience"}},
    }
    async with httpx.AsyncClient(timeout=60, trust_env=False) as c:
        r = await c.post(f"{comfy_url}/prompt", json={"prompt": g, "client_id": "sounddesign"})
        r.raise_for_status()
        pid = r.json()["prompt_id"]
        for _ in range(240):
            await asyncio.sleep(1.5)
            h = (await c.get(f"{comfy_url}/history/{pid}")).json().get(pid)
            if h and h.get("outputs"):
                f = h["outputs"]["9"]["audio"][0]
                data = (await c.get(f"{comfy_url}/view", params={"filename": f["filename"], "subfolder": f["subfolder"], "type": f["type"]})).content
                with tempfile.NamedTemporaryFile(suffix=".flac", delete=False) as tmp:
                    tmp.write(data)
                try:
                    a = decode_audio(ffmpeg_exe(), tmp.name, secs)
                finally:
                    os.unlink(tmp.name)
                return a.mean(axis=1)
    raise RuntimeError("ambience generation timed out")
