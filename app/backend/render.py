"""
Final-cut renderer: an edit decision list of clip pieces + a music track ->
one mp4, via the ffmpeg bundled with imageio-ffmpeg. Hard cuts only (that's
what beat-cut music videos want); every piece is scaled/padded to a common
canvas at 24 fps, the clips' own audio can be mixed under the music.
"""

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from audio_analysis import ffmpeg_exe

# Post-process color grades applied once to the whole finished cut, so every
# scene shares one consistent look regardless of per-generation drift between
# seeds/prompts — the same "grade once, in one place" approach a real colorist
# uses, rather than relying on the still/video models to match each other.
# id -> (label, ffmpeg video-filter chain; empty chain = pass-through).
LOOKS: dict[str, tuple[str, str]] = {
    "none": ("None (native)", ""),
    "clean_realistic": ("Clean Realistic", "eq=contrast=1.04:saturation=1.03,noise=alls=6:allf=t+u"),
    "cinematic_warm": ("Cinematic Warm", "curves=preset=medium_contrast,colorbalance=rs=0.05:gs=0.0:bs=-0.06:rm=0.03:gm=0.0:bm=-0.03:rh=0.02:gh=0.0:bh=-0.01,eq=saturation=1.08"),
    "cool_teal_horror": ("Cool Teal Horror", "colorbalance=rs=-0.08:gs=0.02:bs=0.10:rm=-0.04:gm=0.0:bm=0.05,eq=saturation=0.72:contrast=1.08:brightness=-0.02,curves=preset=darker,noise=alls=5:allf=t+u,vignette=PI/4"),
    "kodak_film": ("Kodak Film", "curves=preset=vintage,eq=contrast=1.03:saturation=1.05,noise=alls=4:allf=t+u"),
    "moody_contrast": ("Moody Contrast", "curves=preset=strong_contrast,eq=saturation=0.85"),
}


def probe(path: str) -> dict:
    """Minimal stream probe using `ffmpeg -i` (no ffprobe in the bundle)."""
    out = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", path], capture_output=True, text=True, check=False)
    txt = out.stderr
    dur = 0.0
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", txt)
    if m:
        dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    has_audio = bool(re.search(r"Stream #\d+:\d+.*Audio:", txt))
    size = None
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", txt)
    if m:
        size = (int(m.group(1)), int(m.group(2)))
    return {"duration": dur, "has_audio": has_audio, "size": size}


def render_edl(
    edl: list[dict],
    clip_paths: dict[str, str],
    music_path: str | None,
    out_path: str,
    width: int,
    height: int,
    fps: int = 24,
    music_gain: float = 1.0,
    clip_gain: float = 0.0,
    music_offset: float = 0.0,
    crf: int = 18,
    fade_out: float = 0.0,
    look: str = "",
) -> dict:
    """`edl` = ordered [{"clip": id, "in": s, "out": s}]; `clip_paths` maps
    id -> file. Music starts at `music_offset` seconds into the track and is
    trimmed to the edit length. Returns {"duration": s}."""
    if not edl:
        raise ValueError("Empty edit list")
    infos = {cid: probe(p) for cid, p in clip_paths.items()}
    inputs: list[str] = []
    idx_of: dict[str, int] = {}
    for cid, p in clip_paths.items():
        idx_of[cid] = len(idx_of)
        inputs += ["-i", p]
    music_idx = None
    if music_path:
        music_idx = len(idx_of)
        inputs += ["-i", music_path]

    filters = []
    vlabels, alabels = [], []
    total = 0.0
    mix_clip_audio = clip_gain > 0.001
    for n, piece in enumerate(edl):
        cid = piece["clip"]
        if cid not in idx_of:
            raise ValueError(f"EDL references unknown clip {cid}")
        i = idx_of[cid]
        info = infos[cid]
        a, b = float(piece["in"]), float(piece["out"])
        if info["duration"]:
            b = min(b, info["duration"])
        if b - a < 0.05:
            continue
        dur = b - a
        total += dur
        filters.append(
            f"[{i}:v]trim=start={a:.4f}:end={b:.4f},setpts=PTS-STARTPTS,"
            f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps},"
            # sources at other frame rates lose their last partial frame in the
            # fps conversion; clone-pad then re-trim so every piece is exactly
            # `dur` long and the beat grid never drifts
            f"tpad=stop_mode=clone:stop_duration=1,trim=duration={dur:.4f},setpts=PTS-STARTPTS,format=yuv420p[v{n}]"
        )
        vlabels.append(f"[v{n}]")
        if mix_clip_audio:
            if info["has_audio"]:
                filters.append(f"[{i}:a]atrim=start={a:.4f}:end={b:.4f},asetpts=PTS-STARTPTS,"
                               f"aresample=48000,aformat=channel_layouts=stereo,apad=pad_dur=1,atrim=duration={dur:.4f},"
                               f"afade=t=in:st=0:d=0.05,afade=t=out:st={max(0.0, dur - 0.05):.4f}:d=0.05[a{n}]")
            else:
                filters.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{dur:.4f},asetpts=PTS-STARTPTS[a{n}]")
            alabels.append(f"[a{n}]")
    if not vlabels:
        raise ValueError("No usable pieces in the edit list")
    n = len(vlabels)
    filters.append(f"{''.join(vlabels)}concat=n={n}:v=1:a=0[vcat]")
    vout = "[vcat]"
    grade = LOOKS.get(look, ("", ""))[1]
    if grade:
        filters.append(f"{vout}{grade}[vgraded]")
        vout = "[vgraded]"
    if fade_out > 0 and total > fade_out:
        filters.append(f"{vout}fade=t=out:st={total - fade_out:.3f}:d={fade_out:.3f}[vfade]")
        vout = "[vfade]"

    audio_out = None
    if mix_clip_audio:
        filters.append(f"{''.join(alabels)}concat=n={n}:v=0:a=1,volume={clip_gain:.3f}[aclips]")
        audio_out = "[aclips]"
    if music_idx is not None:
        filters.append(
            f"[{music_idx}:a]atrim=start={music_offset:.4f}:end={music_offset + total:.4f},asetpts=PTS-STARTPTS,"
            f"aresample=48000,aformat=channel_layouts=stereo,volume={music_gain:.3f}"
            + (f",afade=t=out:st={max(0.0, total - fade_out):.3f}:d={fade_out:.3f}" if fade_out > 0 else "")
            + "[amusic]"
        )
        if audio_out:
            filters.append(f"[amusic]{audio_out}amix=inputs=2:duration=first:normalize=0[aout]")
            audio_out = "[aout]"
        else:
            audio_out = "[amusic]"

    # A long EDL (a full-song render vs. a ~30s preview) can build a
    # filter_complex string well past Windows's ~32K command-line limit —
    # CreateProcess then fails with WinError 206 ("filename or extension too
    # long"), a red herring that has nothing to do with any actual filename.
    # Writing the graph to a script file and using -filter_complex_script
    # keeps the huge content off the command line entirely (works fine on
    # every platform, not just Windows).
    script_fd, script_path = tempfile.mkstemp(suffix=".txt", text=True)
    try:
        with os.fdopen(script_fd, "w", encoding="utf-8") as f:
            f.write(";".join(filters))
        cmd = [ffmpeg_exe(), "-y", "-v", "error", *inputs,
               "-filter_complex_script", script_path,
               "-map", vout]
        if audio_out:
            cmd += ["-map", audio_out, "-c:a", "aac", "-b:a", "192k"]
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", "-t", f"{total:.4f}", out_path]
        res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    finally:
        os.unlink(script_path)
    if res.returncode != 0 or not Path(out_path).exists():
        raise ValueError(f"ffmpeg render failed: {res.stderr[-800:]}")
    return {"duration": round(total, 3), "pieces": n}


def edl_from_json(text: str) -> list[dict]:
    data = json.loads(text)
    if not isinstance(data, list):
        raise ValueError("edl must be a JSON array")
    out = []
    for p in data:
        out.append({"clip": str(p["clip"]), "in": float(p.get("in", 0)), "out": float(p["out"])})
    return out
