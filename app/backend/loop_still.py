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

Pure numpy by default; with the optional opencv-python-headless the stabiliser is refined to sub-pixel accuracy (ECC affine against the
median plate, one Lanczos resample) and the freeze threshold adapts to the clip. Memory-light: frames live in a memmap on disk and are processed in bands.
"""
import subprocess
import tempfile
from pathlib import Path

import numpy as np

try:                                  # optional: without OpenCV the pipeline keeps the phase-correlation stabiliser and bilinear warp
    import cv2
except Exception:
    cv2 = None

last_refined = False
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


def params_to_matrix(p: np.ndarray, W: int, H: int) -> np.ndarray:
    """The displacement model as a 3x3 pixel matrix mapping output coordinates to frame coordinates."""
    return np.array([[1 + p[1] / W, p[2] / H, p[0] - 0.5 * p[1] - 0.5 * p[2]],
                     [p[4] / W, 1 + p[5] / H, p[3] - 0.5 * p[4] - 0.5 * p[5]],
                     [0, 0, 1]], np.float64)


def matrix_to_params(A: np.ndarray, W: int, H: int) -> np.ndarray:
    p1, p2 = (A[0, 0] - 1) * W, A[0, 1] * H
    p4, p5 = A[1, 0] * W, (A[1, 1] - 1) * H
    return np.array([A[0, 2] + 0.5 * p1 + 0.5 * p2, p1, p2, A[1, 2] + 0.5 * p4 + 0.5 * p5, p4, p5], np.float32)


def warp(frame: np.ndarray, p: np.ndarray) -> np.ndarray:
    """aligned(x) = frame(x + u(x)); returns float32 (H, W, 3). Lanczos with OpenCV, bilinear without."""
    H, W, _ = frame.shape
    if cv2 is not None:
        A = params_to_matrix(p, W, H)[:2]
        return cv2.warpAffine(np.ascontiguousarray(frame, np.float32), A, (W, H), flags=cv2.INTER_LANCZOS4 | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
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


def refine_ecc(frames, params: np.ndarray, H: int, W: int, width: int = 960, iters: int = 4, progress=None) -> np.ndarray:
    """Sub-pixel refinement of the drift model: ECC affine at `width` px against the per-pixel median plate, started from the coarse estimate.
    Pixels that deviate from the plate in many frames (sparkles, water, flames) are masked out of the fit. Takes 0.5 px of jitter to about 0.06 px.
    Frames where ECC fails or strays far from the coarse estimate keep the coarse one."""
    n = len(frames)
    w, h = width, int(round(H * width / W))
    sc = w / W
    g = np.empty((n, h, w), np.float16)               # blurred grey at analysis size (8-bit rounding makes ECC fail to converge)
    for i in range(n):
        g[i] = cv2.GaussianBlur(cv2.cvtColor(cv2.resize(np.asarray(frames[i]), (w, h), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY).astype(np.float32), (0, 0), 1.2)
    Sm = np.diag([sc, sc, 1.0])
    Ms = np.stack([(Sm @ params_to_matrix(p, W, H) @ np.linalg.inv(Sm))[:2] for p in params]).astype(np.float32)   # plate -> frame, analysis scale
    coarse = Ms.copy()
    sel = np.arange(int(n * 0.45), n)
    sel = sel[:: max(1, len(sel) // 48)]
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 100, 1e-5)   # tighter eps raises "do not converge" on newer OpenCV
    crit_loose = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-3)
    for it in range(iters):
        al = np.stack([cv2.warpAffine(g[i].astype(np.float32), Ms[i], (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE) for i in sel])
        plate = np.median(al, 0).astype(np.float32)
        dev = np.abs(al - plate).mean(0)
        mask = cv2.erode((dev < np.percentile(dev, 60)).astype(np.uint8), np.ones((5, 5), np.uint8))
        for i in range(n):
            Mi = None
            for c in (crit, crit_loose):                  # a fit that does not converge to the tight tolerance gets one more go with a looser one
                try:
                    _, Mi = cv2.findTransformECC(plate, g[i].astype(np.float32), Ms[i].copy(), cv2.MOTION_AFFINE, c, mask, 5)
                    break
                except cv2.error:
                    Mi = None
            if Mi is None:
                continue
            if np.abs(Mi - coarse[i])[:, :2].max() > 0.004 or np.abs(Mi - coarse[i])[:, 2].max() > 4 * sc:
                continue                              # strayed from the coarse fit: not trustworthy
            Ms[i] = Mi
        if progress:
            progress((it + 1) / iters)
    Ps = Ms.reshape(n, 6)                             # no temporal smoothing: it would leave part of any frame-to-frame jitter uncorrected
    Si = np.linalg.inv(Sm)
    return np.stack([matrix_to_params(Si @ np.vstack([m.reshape(2, 3), [0, 0, 1]]) @ Sm, W, H) for m in Ps]).astype(np.float32)


def freeze_mask(act: np.ndarray, stillness: float, r_blur: int, r_dilate: int, r_soft: int) -> np.ndarray:
    """1 where the picture really moves, 0 where it should be the still plate. Thresholds are percentiles of the clip's own activity (after
    stabilisation the remaining shimmer is the floor), smoothstepped, dilated and softened."""
    s = min(max(stillness, 0.0), 1.0)
    a_s = blur(act, r_blur)
    lo, hi = np.percentile(a_s, 20 + 35 * s), np.percentile(a_s, 50 + 43 * s)
    lo, hi = float(np.clip(lo, 1.0, 6.0)), float(np.clip(hi, 3.0, 14.0))     # absolute limits: a clip where everything moves must not get its calmest pixels frozen, nor a static one its grain kept
    hi = max(hi, lo + 2.0)
    m = np.clip((a_s - lo) / (hi - lo), 0, 1)
    m = m * m * (3 - 2 * m)
    return np.clip(blur(dilate(m, r_dilate), r_soft), 0, 1)


def measure_jitter(frames, width: int = 960) -> dict:
    """Translation of each frame against the median plate (ECC), in pixels of the full-size frame: range of the drift and frame-to-frame rms jitter."""
    n = len(frames)
    H, W = frames[0].shape[:2]
    h = int(round(H * width / W))
    g = [cv2.GaussianBlur(cv2.cvtColor(cv2.resize(np.asarray(f), (width, h), interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY), (0, 0), 1.2).astype(np.float32) for f in frames]
    plate = np.median(g, 0).astype(np.float32)
    dev = np.abs(np.array(g) - plate).mean(0)
    mask = (dev < np.percentile(dev, 60)).astype(np.uint8)
    t = []
    for x in g:
        M = np.eye(2, 3, dtype=np.float32)
        try:
            _, M = cv2.findTransformECC(plate, x, M, cv2.MOTION_TRANSLATION, (3, 100, 1e-5), mask, 5)
        except cv2.error:
            pass
        t.append(M[:, 2].copy())
    t = np.array(t) * (W / width)
    d = np.diff(t, axis=0)
    return {"range_x": float(np.ptp(t[:, 0])), "range_y": float(np.ptp(t[:, 1])), "jitter_rms": float(np.sqrt((d ** 2).sum(1).mean())), "max_step": float(np.abs(d).max())}


def stabilise_params(frames, H, W, progress=None, refine=True):
    """Per-frame affine drift against the clip's steady state, and the first frame from which the picture has settled.
    With OpenCV available the estimate is refined to sub-pixel (see refine_ecc); `refined` is reported through the module flag `last_refined`."""
    global last_refined
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
    last_refined = False
    if refine and cv2 is not None:
        try:
            params = refine_ecc(frames, params, H, W)
            last_refined = True
        except Exception as e:                        # keep the coarse estimate
            print("loop: sub-pixel refinement failed, using the coarse stabiliser:", repr(e), flush=True)
    mags = np.array([shift_at_corners(p) for p in params])
    ok = mags <= 0.7                                          # within 0.7 px of the steady state
    settle = n
    for i in range(n - 1, -1, -1):
        if ok[i]:
            settle = i
        else:
            break
    return params, mags, int(settle if settle < n else 0)
