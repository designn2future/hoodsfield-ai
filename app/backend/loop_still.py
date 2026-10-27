"""Hold-still processing for seamless loops.

AI video models cannot keep a picture perfectly still: the whole frame drifts a few pixels while the model "settles" and keeps creeping
afterwards, and every surface shimmers a little. A cross-fade between the end and the start of such a clip shows up as a slow dissolve.
This module removes the cause instead of hiding it:

  1. stabilise: measure each frame's drift against the clip's steady state (phase correlation on a grid of blocks, a robust affine fit) and
     warp it back; frames from the settling period are skipped.
  2. find the still plate: the per-pixel temporal median of the loop (a clean, noise-free picture).
  3. find what really moves (rain, steam, leaves, flames, twinkling lights): the per-pixel activity around that plate.
  4. everything that does not really move is replaced by the plate (perfectly still, so it cannot dissolve); only the moving parts keep
     their motion, and only they take part in the cross-fade at the seam.

Pure numpy (no scipy / OpenCV), memory-light: frames live in a memmap on disk and are processed in bands.
"""
import subprocess
import tempfile
from pathlib import Path

import numpy as np

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


# ------------------------------------------------------------------ small image filters (separable box blurs, max filter)
def _box1(x, r, axis):
    if r <= 0:
        return x
    n = x.shape[axis]
    pad = [(0, 0)] * x.ndim
    pad[axis] = (r + 1, r)
    c = np.cumsum(np.pad(x, pad, mode="edge"), axis=axis, dtype=np.float64)
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def blur(x, r, passes=3):
    x = x.astype(np.float32)
    for _ in range(passes):
        x = _box1(_box1(x, r, 0), r, 1)
    return x


def dilate(x, r):
    out = x
    for axis in (0, 1):
        acc = out.copy()
        for s in range(1, r + 1):
            acc = np.maximum(acc, np.maximum(np.roll(out, s, axis=axis), np.roll(out, -s, axis=axis)))
        out = acc
    return out


# ------------------------------------------------------------------ reading frames
def read_raw(ffmpeg: str, src: Path, fps_arg: str, W: int, H: int, dst: Path) -> int:
    """Decode every frame (rgb24, constant frame rate) into a raw file; returns the frame count."""
    with open(dst, "wb") as f:
        p = subprocess.Popen([ffmpeg, "-v", "error", "-i", str(src), "-an", "-vf", f"fps={fps_arg},scale=in_color_matrix=auto:out_color_matrix=bt709,format=rgb24", "-f", "rawvideo", "-"],
                             stdout=f, stderr=subprocess.DEVNULL, creationflags=NOWIN)
        p.wait()
    return dst.stat().st_size // (W * H * 3)


def open_frames(path: Path, n: int, H: int, W: int):
    return np.memmap(path, dtype=np.uint8, mode="r", shape=(n, H, W, 3))


def gray_of(frame: np.ndarray) -> np.ndarray:
    return (frame[..., 0] * 0.299 + frame[..., 1] * 0.587 + frame[..., 2] * 0.114).astype(np.float32)


# ------------------------------------------------------------------ stabilisation
def _win(h, w):
    return np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)


def _peak(a, b, wn):
    """Shift of block a relative to block b: a(x) = b(x - s). Returns (dx, dy, peak height 0..1)."""
    A = np.fft.rfft2((a - a.mean()) * wn)
    B = np.fft.rfft2((b - b.mean()) * wn)
    R = A * np.conj(B)
    R /= np.abs(R) + 1e-9
    r = np.fft.irfft2(R, s=a.shape)
    y, x = np.unravel_index(int(np.argmax(r)), r.shape)
    h, w = r.shape
    pk = float(r[y, x])

    def sub(c, n, f):
        l, m, p = f(c - 1), f(c), f(c + 1)
        d = l - 2 * m + p
        return c + (0.5 * (l - p) / d if abs(d) > 1e-12 else 0.0)

    ys = sub(y, h, lambda i: r[i % h, x])
    xs = sub(x, w, lambda i: r[y, i % w])
    ys = ys - h if ys > h / 2 else ys
    xs = xs - w if xs > w / 2 else xs
    return xs, ys, pk


def estimate_affine(g: np.ndarray, ref: np.ndarray, grid=(6, 4), wn_cache={}) -> np.ndarray:
    """Displacement field u(x, y) of frame g relative to ref as an affine model: ux = a0 + a1 X + a2 Y, uy = b0 + b1 X + b2 Y (X, Y in -0.5..0.5)."""
    H, W = g.shape
    gx, gy = grid
    bh, bw = H // gy, W // gx
    key = (bh, bw)
    if key not in wn_cache:
        wn_cache[key] = _win(bh, bw)
    pts, dx, dy, wt = [], [], [], []
    for j in range(gy):
        for i in range(gx):
            a = g[j * bh:(j + 1) * bh, i * bw:(i + 1) * bw]
            b = ref[j * bh:(j + 1) * bh, i * bw:(i + 1) * bw]
            if a.std() < 2.0 or b.std() < 2.0:
                continue
            sx, sy, pk = _peak(a, b, wn_cache[key])
            if abs(sx) > 12 or abs(sy) > 12 or pk < 0.04:
                continue
            pts.append(((i + 0.5) * bw / W - 0.5, (j + 0.5) * bh / H - 0.5)); dx.append(sx); dy.append(sy); wt.append(pk)
    if len(pts) < 4:
        return np.zeros(6, np.float32)
    P = np.array(pts); Aeq = np.column_stack([np.ones(len(P)), P[:, 0], P[:, 1]])
    w = np.array(wt)
    out = []
    for target in (np.array(dx), np.array(dy)):
        keep = np.ones(len(P), bool)
        for _ in range(3):
            if keep.sum() < 4:
                break
            sol, *_ = np.linalg.lstsq(Aeq[keep] * w[keep, None], target[keep] * w[keep], rcond=None)
            res = np.abs(Aeq @ sol - target)
            keep = res < max(0.6, 2.5 * float(np.median(res)))
        out.append(sol)
    return np.concatenate(out).astype(np.float32)


def shift_at_corners(p: np.ndarray) -> float:
    """Largest displacement (pixels in the model's own units: it is expressed in pixels of the frame it was measured on) over the four corners."""
    m = 0.0
    for X, Y in ((-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5), (0, 0)):
        ux = p[0] + p[1] * X + p[2] * Y
        uy = p[3] + p[4] * X + p[5] * Y
        m = max(m, float(np.hypot(ux, uy)))
    return m


def warp(frame: np.ndarray, p: np.ndarray) -> np.ndarray:
    """aligned(x) = frame(x + u(x)) with bilinear sampling; returns float32 (H, W, 3)."""
    H, W, _ = frame.shape
    X = (np.arange(W, dtype=np.float32) / W - 0.5)[None, :]
    Y = (np.arange(H, dtype=np.float32) / H - 0.5)[:, None]
    ux = p[0] + p[1] * X + p[2] * Y
    uy = p[3] + p[4] * X + p[5] * Y
    xs = np.clip(np.arange(W, dtype=np.float32)[None, :] + ux, 0, W - 1.001)
    ys = np.clip(np.arange(H, dtype=np.float32)[:, None] + uy, 0, H - 1.001)
    x0 = xs.astype(np.int32); y0 = ys.astype(np.int32)
    fx = (xs - x0)[..., None]; fy = (ys - y0)[..., None]
    f = frame
    top = f[y0, x0] * (1 - fx) + f[y0, x0 + 1] * fx
    bot = f[y0 + 1, x0] * (1 - fx) + f[y0 + 1, x0 + 1] * fx
    return (top * (1 - fy) + bot * fy).astype(np.float32)


def stabilise_params(frames, H, W, progress=None):
    """Per-frame affine drift against the clip's steady state, and the first frame from which the picture has settled."""
    n = len(frames)
    mid = np.arange(int(n * 0.45), n)
    sel = mid[:: max(1, len(mid) // 24)]
    ref = np.median(np.stack([gray_of(np.asarray(frames[i])) for i in sel]), axis=0)
    params = []
    for i in range(n):
        params.append(estimate_affine(gray_of(np.asarray(frames[i])), ref))
        if progress and i % 20 == 0:
            progress(i / n)
    params = np.array(params)
    mags = np.array([shift_at_corners(p) for p in params])
    ok = mags <= 0.7                                          # within 0.7 px of the steady state
    settle = n
    for i in range(n - 1, -1, -1):
        if ok[i]:
            settle = i
        else:
            break
    return params, mags, int(settle if settle < n else 0)
