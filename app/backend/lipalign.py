"""Lip-sync alignment: finds how much later (seconds) the lips start moving than the voice starts, so the clip can be cut to line them up.

The talking-head model animates a still, so the mouth stays closed for a moment (up to about a second) before it follows the speech.
The mouth opening is read with MediaPipe's face landmarker (mouth_worker.py, run in .venv-pose); the voice start comes from the sound itself.
The start is the anchor; the waveform match only fine-tunes it (the mouth's open-close rhythm repeats every half second, so matching the
whole waveform alone can lock onto the wrong repeat)."""
import json
import subprocess
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
PY = HERE / ".venv-pose" / "Scripts" / "python.exe"
WORKER = HERE / "mouth_worker.py"
MODEL = HERE / "models" / "face_landmarker.task"


def available() -> bool:
    return PY.is_file() and MODEL.is_file()


def _smooth(x: np.ndarray) -> np.ndarray:
    return np.convolve(x, np.ones(3) / 3, "same")


def measure(video: Path, voice: Path, ffmpeg: str, nowin: int = 0) -> dict | None:
    """{lag, voice_start, lips_start, corr} (seconds; lag = lips_start - voice_start), or None when there is no usable face or mouth movement."""
    if not available():
        return None
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "jaw.json"
        r = subprocess.run([str(PY), str(WORKER), str(video), str(out), str(MODEL)], capture_output=True, timeout=300, creationflags=nowin)
        if r.returncode or not out.exists():
            return None
        j = json.loads(out.read_text())
    jaw = np.array(j["jaw"], np.float32)
    fps = float(j["fps"])
    if len(jaw) < 12 or sum(j["found"]) < 0.6 * len(jaw):
        return None
    open_max = float(np.percentile(jaw, 95))             # how far the jaw really opens (a typical talking mouth reaches 0.3 to 0.6)
    if open_max < 0.12:                                   # the mouth hardly moved: nothing to line up, and the caller may want another take
        return {"lag": 0.0, "voice_start": 0.0, "lips_start": 0.0, "corr": 0.0, "open": round(open_max, 2)}
    raw = subprocess.run([ffmpeg, "-v", "error", "-i", str(voice), "-vn", "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], capture_output=True, creationflags=nowin).stdout
    a = np.frombuffer(raw, np.int16).astype(np.float32)
    hop = int(16000 / fps)
    env = np.array([np.sqrt((a[i * hop:(i + 1) * hop] ** 2).mean() + 1e-9) for i in range(len(a) // hop)], np.float32)
    if len(env) < 12 or float(env.max()) < 50:
        return None
    jaw_s, env_s = _smooth(jaw), _smooth(env)
    on_v = int(np.argmax(env_s > 0.2 * env_s.max()))
    on_l = int(np.argmax(jaw_s > 0.4 * jaw_s.max()))
    lag0 = on_l - on_v
    best, bc = lag0, -2.0
    for lag in range(lag0 - 6, lag0 + 7):                 # fine-tune within about a quarter second of the start-to-start gap
        if lag >= 0:
            x, y = jaw_s[lag:], env_s[:len(jaw_s) - lag]
        else:
            x, y = jaw_s[:len(jaw_s) + lag], env_s[-lag:]
        k = min(len(x), len(y))
        if k < 15:
            continue
        cc = float(np.corrcoef(x[:k], y[:k])[0, 1])
        if cc > bc:
            best, bc = lag, cc
    lag = max(-0.5, min(2.0, best / fps))
    return {"lag": round(lag, 3), "voice_start": round(on_v / fps, 2), "lips_start": round(on_l / fps, 2), "corr": round(bc, 2), "open": round(open_max, 2)}
