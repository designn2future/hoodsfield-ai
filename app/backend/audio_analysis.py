"""
Music track analysis for the music-video director: duration, tempo, beat
grid, downbeats, energy curve and coarse song sections. Pure numpy on top of
the ffmpeg binary bundled with imageio-ffmpeg (no librosa / no system
ffmpeg needed). Good enough to cut on beats and to tell the LLM where the
loud parts are — not a research beat tracker.
"""

import math
import subprocess

import numpy as np

SR = 22050
HOP = 256           # ~11.6 ms
WIN = 1024
FRAME_RATE = SR / HOP


def ffmpeg_exe() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def decode_mono(path: str, sr: int = SR) -> np.ndarray:
    """Decode any audio/video file to mono float32 PCM via ffmpeg."""
    cmd = [ffmpeg_exe(), "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True, check=False)
    if out.returncode != 0 or not out.stdout:
        raise ValueError(f"ffmpeg could not decode the audio: {out.stderr.decode('utf-8', 'replace')[-400:]}")
    return np.frombuffer(out.stdout, dtype=np.float32).copy()


def _stft_mag(y: np.ndarray) -> np.ndarray:
    n = 1 + max(0, (len(y) - WIN) // HOP)
    if n < 4:
        raise ValueError("Track is too short to analyze")
    idx = np.arange(WIN)[None, :] + HOP * np.arange(n)[:, None]
    window = np.hanning(WIN).astype(np.float32)
    frames = y[idx] * window
    return np.abs(np.fft.rfft(frames, axis=1))  # [n, WIN/2+1]


def _onset_envelope(mag: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Spectral-flux onset strength (full band) and a low-band (kick) flux."""
    logmag = np.log1p(mag * 10.0)
    flux = np.diff(logmag, axis=0, prepend=logmag[:1])
    flux = np.maximum(flux, 0.0)
    onset = flux.sum(axis=1)
    freqs = np.fft.rfftfreq(WIN, 1.0 / SR)
    low = flux[:, freqs < 180].sum(axis=1)
    # local-mean subtraction + normalisation makes tempo estimation robust
    onset = onset - _moving_average(onset, int(FRAME_RATE * 0.4))
    onset = np.maximum(onset, 0.0)
    onset /= (onset.max() + 1e-9)
    low /= (low.max() + 1e-9)
    return onset, low


def _moving_average(x: np.ndarray, n: int) -> np.ndarray:
    n = max(1, n)
    kernel = np.ones(n) / n
    return np.convolve(x, kernel, mode="same")


def _estimate_tempo(onset: np.ndarray) -> float:
    """Autocorrelation of the onset envelope over 50–200 BPM with a log-normal
    prior around 110 BPM (Ellis 2007). Returns BPM."""
    x = onset - onset.mean()
    n = len(x)
    max_lag = int(FRAME_RATE * 60 / 50)
    min_lag = int(FRAME_RATE * 60 / 200)
    ac = np.correlate(x, x, mode="full")[n - 1:n - 1 + max_lag + 1]
    ac /= (ac[0] + 1e-9)
    lags = np.arange(len(ac))
    bpm = np.where(lags > 0, 60.0 * FRAME_RATE / np.maximum(lags, 1), 1.0)
    prior = np.exp(-0.5 * ((np.log2(np.maximum(bpm, 1e-3) / 110.0)) / 0.9) ** 2)
    score = ac * prior
    score[:min_lag] = -1
    best = int(np.argmax(score[: max_lag + 1]))
    if best <= 0:
        return 120.0
    return float(60.0 * FRAME_RATE / best)


def _track_beats(onset: np.ndarray, bpm: float, tightness: float = 400.0) -> np.ndarray:
    """Dynamic-programming beat tracker (Ellis). Returns beat frame indices."""
    period = FRAME_RATE * 60.0 / bpm
    n = len(onset)
    lo, hi = int(round(period / 2)), int(round(period * 2))
    window = np.arange(-hi, -lo + 1)  # candidate previous beats
    txwt = -tightness * (np.log(-window / period) ** 2)
    score = np.zeros(n)
    backlink = -np.ones(n, dtype=int)
    for i in range(n):
        cand = i + window
        valid = cand >= 0
        if not valid.any():
            score[i] = onset[i]
            continue
        s = score[cand[valid]] + txwt[valid]
        k = int(np.argmax(s))
        score[i] = onset[i] + s[k]
        backlink[i] = cand[valid][k]
    # start backtracking from the best of the last period
    tail = score[max(0, n - int(period)):]
    best = int(np.argmax(tail)) + max(0, n - int(period))
    beats = [best]
    while backlink[beats[-1]] >= 0:
        beats.append(backlink[beats[-1]])
    return np.array(beats[::-1], dtype=int)


def _downbeat_phase(beats: np.ndarray, onset: np.ndarray, low: np.ndarray, meter: int = 4) -> int:
    if len(beats) < meter:
        return 0
    best, best_score = 0, -1.0
    for p in range(meter):
        idx = beats[p::meter]
        s = float((onset[idx] + 1.5 * low[idx]).mean())
        if s > best_score:
            best, best_score = p, s
    return best


def _sections(y: np.ndarray, mag: np.ndarray, downbeat_times: list[float], duration: float) -> list[dict]:
    """Bar-level loudness + brightness → coarse sections by change-points."""
    if len(downbeat_times) < 3:
        return [{"start": 0.0, "end": duration, "energy": 1.0, "label": "song"}]
    bars = list(downbeat_times) + [duration]
    rms_db, bright = [], []
    freqs = np.fft.rfftfreq(WIN, 1.0 / SR)
    for a, b in zip(bars[:-1], bars[1:]):
        fa, fb = int(a * FRAME_RATE), max(int(a * FRAME_RATE) + 1, int(b * FRAME_RATE))
        seg = y[int(a * SR):max(int(a * SR) + 1, int(b * SR))]
        rms_db.append(20 * math.log10(float(np.sqrt(np.mean(seg ** 2)) + 1e-6)))
        m = mag[fa:fb]
        bright.append(float((m * freqs[None, :]).sum() / (m.sum() + 1e-9)))
    rms_db = np.array(rms_db)
    bright = np.array(bright)
    feat = np.stack([(rms_db - rms_db.mean()) / (rms_db.std() + 1e-6),
                     0.6 * (bright - bright.mean()) / (bright.std() + 1e-6)], axis=1)
    nbars = len(feat)
    min_len = 4
    # greedy boundary detection: compare 4-bar means before/after each bar
    diffs = np.zeros(nbars)
    for i in range(min_len, nbars - min_len + 1):
        before = feat[max(0, i - 8):i].mean(axis=0)
        after = feat[i:i + 8].mean(axis=0)
        diffs[i] = float(np.abs(after - before).sum())
    bounds = [0]
    thresh = max(0.8, float(np.percentile(diffs[diffs > 0], 70)) if (diffs > 0).any() else 0.8)
    i = min_len
    while i <= nbars - min_len:
        if diffs[i] >= thresh and i - bounds[-1] >= min_len:
            # prefer boundaries on 4-bar phrase lines when close
            snapped = i
            for cand in (i - (i - bounds[-1]) % 4, i + (4 - (i - bounds[-1]) % 4) % 4):
                if abs(cand - i) <= 1 and cand - bounds[-1] >= min_len and cand <= nbars - min_len:
                    snapped = cand
            bounds.append(snapped)
            i = snapped + min_len
        else:
            i += 1
    bounds.append(nbars)
    secs = []
    e_all = rms_db
    lo_q, hi_q = float(np.percentile(e_all, 25)), float(np.percentile(e_all, 75))
    for a, b in zip(bounds[:-1], bounds[1:]):
        e = float(e_all[a:b].mean())
        energy = 0.0 if hi_q <= lo_q else max(0.0, min(1.0, (e - lo_q) / (hi_q - lo_q)))
        secs.append({"start": round(bars[a], 3), "end": round(bars[b], 3), "energy": round(energy, 3),
                     "bars": int(b - a)})
    # labels
    for k, s in enumerate(secs):
        if k == 0 and s["energy"] < 0.6 and len(secs) > 1:
            s["label"] = "intro"
        elif k == len(secs) - 1 and s["energy"] < 0.6 and len(secs) > 1:
            s["label"] = "outro"
        elif s["energy"] >= 0.75:
            s["label"] = "chorus"
        elif s["energy"] >= 0.45:
            nxt = secs[k + 1]["energy"] if k + 1 < len(secs) else 0
            s["label"] = "build" if nxt >= 0.75 and s["bars"] <= 8 else "verse"
        else:
            s["label"] = "bridge" if 0 < k < len(secs) - 1 and secs[k - 1]["energy"] >= 0.75 else "verse"
    return secs


def analyze(path: str) -> dict:
    y = decode_mono(path)
    duration = len(y) / SR
    if duration < 3:
        raise ValueError("Track shorter than 3 seconds")
    mag = _stft_mag(y)
    onset, low = _onset_envelope(mag)
    bpm = _estimate_tempo(onset)
    beat_frames = _track_beats(onset, bpm)
    beats = [round(float(f / FRAME_RATE), 3) for f in beat_frames]
    # refine BPM from the tracked beats (median interval)
    if len(beats) > 8:
        ivals = np.diff(beats)
        bpm = float(60.0 / np.median(ivals))
    phase = _downbeat_phase(beat_frames, onset, low)
    downbeats = beats[phase::4]
    sections = _sections(y, mag, downbeats, duration)
    # 10 Hz energy curve for the UI strip
    step = SR // 10
    n = len(y) // step
    env = np.sqrt((y[: n * step].reshape(n, step) ** 2).mean(axis=1))
    env = env / (env.max() + 1e-9)
    return {
        "duration": round(duration, 3),
        "bpm": round(bpm, 2),
        "beats": beats,
        "downbeats": [round(t, 3) for t in downbeats],
        "beat_seconds": round(60.0 / bpm, 4),
        "bar_seconds": round(240.0 / bpm, 4),
        "sections": sections,
        "energy": [round(float(v), 3) for v in env],
        "energy_hz": 10,
    }
