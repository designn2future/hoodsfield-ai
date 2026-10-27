"""
Timeline renderer (the export half of Hoodsfield's editor).

POST /api/timeline/render   multipart: `timeline` (JSON) + one file part per source asset (field name = asset key)
                            -> composite job (progress over /api/events, result via /api/video/{id})

Timeline JSON
{
  "width": 1920, "height": 1080, "fps": 30, "look": "none",
  "v1":   [clip],     main track; clips may overlap: the later clip dissolves in over the earlier one
  "v2":   [clip],     overlay track (picture-in-picture, logos, stickers) with x/y/scale/opacity
  "text": [{text, start, dur, size, color, x, y, box}],      size = fraction of canvas height, x/y = 0..1 centre
  "audio":[clip]      music / voice / sfx (both audio tracks are sent here)
}
clip = {key, kind: "video"|"image"|"audio", start, in, out, speed, volume, mute, fadeIn, fadeOut,
        x, y, scale, opacity}                                  (all times in seconds)
Every clip's own audio is mixed in unless `mute`. Output: H.264 + AAC mp4 with faststart.
"""

import asyncio
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from fastapi import File, Form, HTTPException, Request

from audio_analysis import ffmpeg_exe
from render import LOOKS, probe
import timeline_fx

FONT = Path(os.getenv("WINDIR", r"C:\Windows")) / "Fonts" / "segoeuib.ttf"


def _esc_text(s: str) -> str:
    """drawtext text escaping. The filtergraph is parsed twice: single quotes protect the value from the graph parser
    (and everything inside stays literal there), but drawtext then re-splits its own options on ':' and honours
    backslash escapes, so ':' and '\\' must be escaped for that second pass. A quote cannot appear inside quotes ->
    typographic apostrophe. expansion=none (set on the filter) disables %-expansion."""
    return (s.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\u2019").replace("\r", " ").replace("\n", " "))


def _fontpath() -> str:
    p = str(FONT).replace("\\", "/")
    return re.sub(r"^([A-Za-z]):", r"\1\\:", p)       # C:/Windows -> C\:/Windows for ffmpeg


_FONT_FILES = {"impact": "impact.ttf", "black": "ariblk.ttf", "bahn": "bahnschrift.ttf", "bold": "segoeuib.ttf", "heavy": "seguibl.ttf"}


def _font_for(name: str) -> Path:
    f = Path(os.getenv("WINDIR", r"C:\Windows")) / "Fonts" / _FONT_FILES.get(str(name or ""), "")
    return f if _FONT_FILES.get(str(name or "")) and f.exists() else FONT


def _fp(path: Path) -> str:
    return re.sub(r"^([A-Za-z]):", r"\1\\:", str(path).replace("\\", "/"))


def _text_width(font: Path, size: int, text: str) -> float:
    try:
        from PIL import ImageFont
        return float(ImageFont.truetype(str(font), size).getlength(text))
    except Exception:
        return 0.55 * size * len(text)


def title_filters(filters: list, cur: str, t: dict, k: int, W: int, H: int) -> str:
    """One title as animated drawtext layers. t.anim: none | fade | rise | pop | words (each word pops in, one after another);
    t.font: default | impact | black | bahn | bold | heavy; t.look: plain | box | shadow | outline | glow (t.accent = the glow colour).
    The in/out animation lasts `t.animDur` seconds (default 0.45)."""
    size = max(8, int(float(t.get("size", 0.06)) * H))
    x, y = float(t.get("x", 0.5)), float(t.get("y", 0.85))
    col = str(t.get("color", "#ffffff")).lstrip("#")
    acc = str(t.get("accent", "#00e5ff")).lstrip("#")
    s0, dur = float(t["start"]), float(t["dur"])
    s1 = s0 + dur
    anim = str(t.get("anim") or "none")
    look = str(t.get("look") or ("box" if t.get("box", True) else "outline"))
    font = _font_for(t.get("font"))
    ad = max(0.08, min(1.2, float(t.get("animDur", 0.45))))
    text = str(t.get("text", ""))

    def style(layer_glow: bool = False) -> str:
        if layer_glow:
            return f":borderw={max(6, size // 5)}:bordercolor=0x{acc}@0.22"
        if look == "box":
            return ":box=1:boxcolor=black@0.55:boxborderw=14"
        if look == "shadow":
            return ":shadowx=3:shadowy=4:shadowcolor=black@0.65"
        if look == "glow":
            return ":borderw=2:bordercolor=black@0.5:shadowx=0:shadowy=0"
        return ":borderw=3:bordercolor=black@0.8"

    def one(txt: str, xexpr: str, ts: float, te: float, glow: bool = False) -> str:
        u_in = f"clip((t-{ts:.3f})/{ad:.3f},0,1)"
        u_out = f"clip(({te:.3f}-t)/{ad:.3f},0,1)"
        alpha = "1" if anim == "none" else f"{u_in}*{u_out}"
        ypos = f"h*{y:.4f}-text_h/2"
        if anim in ("rise", "words"):
            ypos += f"+(1-{u_in})*(1-{u_in})*(1-{u_in})*{0.05 * H:.1f}"           # eases up into place
        fsz = f"{size}"
        if anim in ("pop", "words"):
            e = f"(1+2.70158*pow({u_in}-1,3)+1.70158*pow({u_in}-1,2))"            # ease-out-back: overshoots then settles
            fsz = f"{size}*(0.45+0.55*{e})"
        fc = f"0x{col}@0.0" if glow else f"0x{col}"
        return (f"drawtext=fontfile='{_fp(font)}':text='{_esc_text(txt)}':fontsize='{fsz}':fontcolor={fc}:expansion=none:"
                f"x={xexpr}:y='{ypos}':alpha='{alpha}'{style(glow)}:enable='between(t,{ts:.3f},{te:.3f})'")

    layers: list[str] = []
    if anim == "words":
        words = text.split()
        space = _text_width(font, size, " ")
        widths = [_text_width(font, size, w) for w in words]
        total_w = sum(widths) + space * max(0, len(words) - 1)
        left = x * W - total_w / 2
        step = max(0.08, min(0.35, (dur * 0.5) / max(1, len(words))))
        run = 0.0
        for i, w in enumerate(words):
            ts = s0 + i * step
            xe = f"{left + run:.1f}"
            if look == "glow":
                layers.append(one(w, xe, ts, s1, glow=True))
            layers.append(one(w, xe, ts, s1))
            run += widths[i] + space
    else:
        xe = f"w*{x:.4f}-text_w/2"
        if look == "glow":
            layers.append(one(text, xe, s0, s1, glow=True))
        layers.append(one(text, xe, s0, s1))
    for ly in layers:
        nxt = f"ti{k}_{len(filters)}"
        filters.append(f"[{cur}]{ly}[{nxt}]")
        cur = nxt
    return cur



def kf_expr(points, var="t"):
    """Keyframes [{t, v, e}] (t in seconds from the clip's start; e = 'smooth' | 'linear' | 'hold') -> an ffmpeg expression of `var`.
    The value is held before the first key and after the last one. Expressions are always written inside single quotes by the callers,
    so commas need no escaping."""
    pts = sorted(({"t": float(p["t"]), "v": float(p["v"]), "e": p.get("e", "smooth")} for p in (points or [])), key=lambda p: p["t"])
    if not pts:
        return None
    if len(pts) == 1:
        return f"{pts[0]['v']:.4f}"

    def seg(a, b):
        if a["e"] == "hold":
            return f"{a['v']:.4f}"
        d = max(1e-3, b["t"] - a["t"])
        u = f"clip(({var}-{a['t']:.4f})/{d:.4f},0,1)"
        if a["e"] == "smooth":
            u = f"({u}*{u}*(3-2*{u}))"
        return f"({a['v']:.4f}+({b['v'] - a['v']:.4f})*{u})"

    expr = f"{pts[-1]['v']:.4f}"
    for i in range(len(pts) - 2, -1, -1):
        expr = f"if(lt({var},{pts[i + 1]['t']:.4f}),{seg(pts[i], pts[i + 1])},{expr})"
    return f"if(lt({var},{pts[0]['t']:.4f}),{pts[0]['v']:.4f},{expr})"


def build(tl: dict, paths: dict[str, str]) -> tuple[list[str], str, float]:
    """-> (ffmpeg input args, filter_complex script, total duration)."""
    W, H, fps = int(tl.get("width", 1920)) // 2 * 2, int(tl.get("height", 1080)) // 2 * 2, int(tl.get("fps", 30))
    inputs: list[str] = []
    n_in = [0]
    filters: list[str] = []
    audio_labels: list[str] = []

    def add_input(c: dict) -> int:
        p = paths.get(c["key"])
        if not p:
            raise ValueError(f"Missing source file for clip {c.get('key')}")
        idx = n_in[0]
        n_in[0] += 1
        if c.get("kind") == "image":
            span = max(0.1, float(c["out"]) - float(c["in"])) / max(0.05, float(c.get("speed", 1)))
            inputs.extend(["-loop", "1", "-framerate", str(fps), "-t", f"{span + 1:.3f}", "-i", p])
        else:
            try:
                with open(p, "rb") as fh:
                    webm = fh.read(4) == bytes([0x1A, 0x45, 0xDF, 0xA3])
            except OSError:
                webm = False
            if webm:
                inputs.extend(["-c:v", "libvpx-vp9"])      # the libvpx decoder keeps the alpha channel of a cut-out clip; the native VP9 one drops it
            inputs.extend(["-i", p])
        return idx

    clips = [("v1", c) for c in tl.get("v1", [])] + [("v2", c) for c in tl.get("v2", [])]
    total = 0.0
    for track, c in clips:
        sp = max(0.1, float(c.get("speed", 1)))
        total = max(total, float(c["start"]) + (float(c["out"]) - float(c["in"])) / sp)
    for c in tl.get("audio", []):
        sp = max(0.1, float(c.get("speed", 1)))
        total = max(total, float(c["start"]) + (float(c["out"]) - float(c["in"])) / sp)
    for t in tl.get("text", []):
        total = max(total, float(t["start"]) + float(t["dur"]))
    if total <= 0:
        raise ValueError("The timeline is empty")

    filters.append(f"color=c=black:s={W}x{H}:r={fps}:d={total:.4f},format=yuv420p[base]")
    cur = "base"
    nclip = 0
    for track, c in clips:
        if c.get("kind") == "audio":
            continue
        idx = add_input(c)
        a, b = float(c["in"]), float(c["out"])
        sp = max(0.1, float(c.get("speed", 1)))
        start = float(c["start"])
        dur = (b - a) / sp
        fi, fo = max(0.0, float(c.get("fadeIn", 0))), max(0.0, float(c.get("fadeOut", 0)))
        lab = f"v{nclip}"
        if track == "v1":
            geo = f"scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos"
            pad = f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
        else:
            sc = max(0.02, min(1.0, float(c.get("scale", 0.3))))
            ks = kf_expr((c.get("kf") or {}).get("scale"))
            geo = (f"scale=w='trunc({W}*({ks})/2)*2':h=-2:eval=frame:flags=lanczos,setsar=1" if ks else f"scale=trunc({W}*{sc}/2)*2:-2:flags=lanczos,setsar=1")
            pad = ""
        uid = f"x{nclip}"
        pre = f"[{idx}:v]trim=start={a:.4f}:end={b:.4f},setpts=(PTS-STARTPTS)/{sp:.4f},{geo},fps={fps},format={'yuva420p' if track == 'v2' else 'yuv420p'}"
        # per-clip camera move, colour grade and effects, each a small filtergraph fragment chained pad to pad
        frags: list[str] = []
        mf = timeline_fx.match_filter(c.get("match"), float(c.get("matchAmt", 1)))
        if mf:
            frags.append(f"{{i}}{mf}{{o}}")      # shot-matching colour comes first, so a look is graded on top of the matched picture
        g = timeline_fx.mix_grade(str(c.get("grade") or ""), float(c.get("gradeAmt", 1)), uid)
        if g:
            frags.append(g)                       # the grade sees the picture only (before the black pillar/letter-box bars are added)
        if pad:
            frags.append(f"{{i}}{pad}{{o}}")
        if track == "v1":
            cam = timeline_fx.camera_filter(c.get("cam"), W, H, dur)
            if cam:
                frags.append(f"{{i}}{cam},setsar=1{{o}}")
        frags += timeline_fx.fx_filters(c.get("fx"), uid, W)
        kfs = c.get("kf") or {}
        kz = kf_expr(kfs.get("zoom")) if track == "v1" else None
        if kz:                                                   # animated zoom (1 = as is), centred
            frags.append(f"{{i}}scale=w='trunc({W}*({kz})/2)*2':h='trunc({H}*({kz})/2)*2':eval=frame:flags=bicubic,crop={W}:{H}{{o}}")
        ko = kf_expr(kfs.get("opacity"), "T")
        if ko:                                                   # animated opacity (alpha plane, so it fades into whatever is below)
            frags.append(f"{{i}}format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*({ko})'{{o}}")
        tail = ""
        if track == "v1" and not c.get("fadeOut"):
            tail += "tpad=stop_mode=clone:stop_duration=0.15,"   # hold the last frame a few frames: a hairline gap before the next clip can never show black (the next clip is overlaid on top)
        tail += "format=yuva420p"
        if track == "v2" and float(c.get("opacity", 1)) < 0.999:
            tail += f",colorchannelmixer=aa={max(0.0, min(1.0, float(c['opacity']))):.3f}"
        if fi > 0:
            tail += f",fade=t=in:st=0:d={fi:.3f}:alpha=1"
        if fo > 0:
            tail += f",fade=t=out:st={max(0.0, dur - fo):.3f}:d={fo:.3f}:alpha=1"
        tail += f",setpts=PTS+{start:.4f}/TB"
        cur_pad = f"[{uid}p0]"
        filters.append(f"{pre}{cur_pad}")
        for k_f, fr in enumerate(frags):
            nxt_pad = f"[{uid}p{k_f + 1}]"
            filters.append(fr.replace("{i}", cur_pad).replace("{o}", nxt_pad))
            cur_pad = nxt_pad
        filters.append(f"{cur_pad}{tail}[{lab}]")
        if track == "v1":
            pos = "0:0"
        else:
            x, y = float(c.get("x", 0.5)), float(c.get("y", 0.5))
            kx = kf_expr((c.get("kf") or {}).get("x"), f"(t-{start:.4f})")
            ky = kf_expr((c.get("kf") or {}).get("y"), f"(t-{start:.4f})")
            pos = f"x='(W*({kx or f'{x:.4f}'})-w/2)':y='(H*({ky or f'{y:.4f}'})-h/2)'"
        nxt = f"o{nclip}"
        filters.append(f"[{cur}][{lab}]overlay={pos}:eof_action=pass:format=auto[{nxt}]")
        cur = nxt
        # the clip's own audio
        if c.get("kind") == "video" and not c.get("mute") and probe(paths[c["key"]]).get("has_audio"):
            vol = float(c.get("volume", 1))
            af = f"[{idx}:a]atrim=start={a:.4f}:end={b:.4f},asetpts=PTS-STARTPTS"
            r = sp
            while r > 2.0:
                af += ",atempo=2.0"; r /= 2.0
            while r < 0.5:
                af += ",atempo=0.5"; r /= 0.5
            if abs(r - 1.0) > 1e-3:
                af += f",atempo={r:.4f}"
            af += f",aresample=48000,aformat=channel_layouts=stereo,volume={vol:.3f}"
            kv = kf_expr((c.get("kf") or {}).get("volume"), "t")
            if kv:
                af += f",volume='{kv}':eval=frame"             # volume curve (a multiplier on top of the clip volume)
            if fi > 0:
                af += f",afade=t=in:st=0:d={fi:.3f}"
            if fo > 0:
                af += f",afade=t=out:st={max(0.0, dur - fo):.3f}:d={fo:.3f}"
            af += f",adelay={int(start * 1000)}|{int(start * 1000)}[ca{nclip}]"
            filters.append(af)
            audio_labels.append(f"[ca{nclip}]")
        nclip += 1

    for k, t in enumerate(tl.get("text", [])):
        cur = title_filters(filters, cur, t, k, W, H)

    look_id = tl.get("look", "none")
    grade = timeline_fx.grade_filter(look_id) or LOOKS.get(look_id, ("", ""))[1]
    if grade:
        filters.append(f"[{cur}]{grade}[graded]")
        cur = "graded"
    filters.append(f"[{cur}]format=yuv420p[vout]")

    for k, c in enumerate(tl.get("audio", [])):
        idx = add_input({**c, "kind": "audio"})
        a, b = float(c["in"]), float(c["out"])
        sp = max(0.1, float(c.get("speed", 1)))
        start, dur = float(c["start"]), (b - a) / sp
        fi, fo = max(0.0, float(c.get("fadeIn", 0))), max(0.0, float(c.get("fadeOut", 0)))
        af = f"[{idx}:a]atrim=start={a:.4f}:end={b:.4f},asetpts=PTS-STARTPTS"
        r = sp
        while r > 2.0:
            af += ",atempo=2.0"; r /= 2.0
        if abs(r - 1.0) > 1e-3:
            af += f",atempo={r:.4f}"
        af += f",aresample=48000,aformat=channel_layouts=stereo,volume={float(c.get('volume', 1)):.3f}"
        kv = kf_expr((c.get("kf") or {}).get("volume"), "t")
        if kv:
            af += f",volume='{kv}':eval=frame"
        if fi > 0:
            af += f",afade=t=in:st=0:d={fi:.3f}"
        if fo > 0:
            af += f",afade=t=out:st={max(0.0, dur - fo):.3f}:d={fo:.3f}"
        af += f",adelay={int(start * 1000)}|{int(start * 1000)}[ma{k}]"
        filters.append(af)
        audio_labels.append(f"[ma{k}]")

    if audio_labels:
        filters.append(f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:duration=longest:normalize=0,"
                       f"apad=whole_dur={total:.3f},atrim=duration={total:.3f},alimiter=limit=0.95[aout]")
    return inputs, ";".join(filters), total


def register(app, m):
    @app.post("/api/timeline/beats")
    async def beats(request: Request):
        """Beat grid of a music file: {bpm, beats[], downbeats[], duration, energy[]} (seconds from the start of the file)."""
        form = await request.form()
        up = form.get("file")
        if up is None or not hasattr(up, "read"):
            raise HTTPException(400, "send the audio as 'file'")
        import audio_analysis
        fd, p = tempfile.mkstemp(suffix=Path(up.filename or "a.wav").suffix or ".wav")
        with os.fdopen(fd, "wb") as f:
            f.write(await up.read())
        try:
            r = await asyncio.to_thread(audio_analysis.analyze, p)
        except ValueError as e:
            raise HTTPException(400, str(e))
        finally:
            try:
                os.unlink(p)
            except OSError:
                pass
        return {k: r[k] for k in ("duration", "bpm", "beats", "downbeats", "beat_seconds", "bar_seconds", "energy", "energy_hz")}

    @app.post("/api/timeline/captions")
    async def captions(request: Request):
        """Speech in a clip -> [{w, start, end}] word timings (local faster-whisper, CPU)."""
        form = await request.form()
        up = form.get("file")
        if up is None or not hasattr(up, "read"):
            raise HTTPException(400, "send the clip as 'file'")
        import whisper_stt
        fd, p = tempfile.mkstemp(suffix=Path(up.filename or "a.mp4").suffix or ".mp4")
        with os.fdopen(fd, "wb") as f:
            f.write(await up.read())
        try:
            return await asyncio.to_thread(whisper_stt.transcribe_words, p)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"Could not transcribe: {e}")
        finally:
            try:
                os.unlink(p)
            except OSError:
                pass

    @app.get("/api/timeline/fx")
    async def fx_catalog():
        return timeline_fx.catalog()

    @app.post("/api/timeline/luts")
    async def upload_lut(request: Request):
        form = await request.form()
        up = form.get("file")
        if up is None or not hasattr(up, "read"):
            raise HTTPException(400, "send a .cube file as 'file'")
        name = re.sub(r"[^A-Za-z0-9._ -]", "_", Path(up.filename or "look.cube").name)
        if not name.lower().endswith(".cube"):
            raise HTTPException(400, "only .cube LUT files are supported")
        data = await up.read()
        if len(data) > 40_000_000 or b"LUT_3D_SIZE" not in data[:4000]:
            raise HTTPException(400, "not a 3D .cube LUT (needs a LUT_3D_SIZE line)")
        timeline_fx.LUT_DIR.mkdir(parents=True, exist_ok=True)
        (timeline_fx.LUT_DIR / name).write_bytes(data)
        return {"ok": True, "name": name, "luts": timeline_fx.list_luts()}

    @app.post("/api/timeline/render")
    async def render(request: Request):
        form = await request.form()
        try:
            tl = json.loads(form.get("timeline", "{}"))
        except json.JSONDecodeError:
            raise HTTPException(400, "timeline must be JSON")
        if m.MOCK:
            raise HTTPException(400, "Timeline export needs the real backend")
        from jobs import OUT_DIR
        uploads = {k: v for k, v in form.items() if k != "timeline" and hasattr(v, "read")}
        n_clips = len(tl.get("v1", [])) + len(tl.get("v2", [])) + len(tl.get("audio", []))
        cj = m.CompositeJob("timeline", f"Timeline export · {n_clips} clips", steps=1,
                            params={"clips": n_clips, "size": f"{tl.get('width')}x{tl.get('height')}"}, family="cpu")
        # persist uploads now (the request body is gone once we return)
        wdir = OUT_DIR / f"{cj.id}_src"
        wdir.mkdir(exist_ok=True)
        paths: dict[str, str] = {}
        for key, up in uploads.items():
            data = await up.read()
            p = wdir / f"{re.sub(r'[^A-Za-z0-9_-]', '_', key)}{Path(up.filename or '').suffix or '.bin'}"
            p.write_bytes(data)
            paths[key] = str(p)

        async def work(cj):
            await cj.status("Building the edit…")
            inputs, script, total = await asyncio.to_thread(build, tl, paths)
            out = OUT_DIR / f"{cj.id}.mp4"
            fd, sp = tempfile.mkstemp(suffix=".txt", text=True)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(script)
            has_audio = "[aout]" in script
            cmd = [ffmpeg_exe(), "-y", "-v", "error", "-progress", "pipe:1", "-nostats", *inputs, "-filter_complex_script", sp,
                   "-map", "[vout]", *(["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"] if has_audio else []),
                   "-c:v", "libx264", "-preset", "medium", "-crf", str(int(tl.get("crf", 18))), "-pix_fmt", "yuv420p",
                   "-movflags", "+faststart", "-t", f"{total:.4f}", str(out)]
            await cj.status(f"Rendering {total:.1f} s…")
            proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            err_task = asyncio.create_task(proc.stderr.read())
            while True:
                if cj.job.get("cancelled"):
                    proc.kill()
                    raise RuntimeError("Cancelled")
                line = await proc.stdout.readline()
                if not line:
                    break
                mm = re.match(rb"out_time_ms=(\d+)", line)
                if mm:
                    frac = min(1.0, int(mm.group(1)) / 1e6 / total)
                    cj.job["progress"] = frac
                    await cj.job["queue"].put({"type": "progress", "value": int(frac * 1000), "max": 1000})
            await proc.wait()
            err = (await err_task).decode("utf-8", "replace")
            try:
                os.unlink(sp)
            except OSError:
                pass
            if proc.returncode != 0 or not out.exists():
                raise RuntimeError(f"ffmpeg failed: {err[-600:]}")
            cj.finish(out)

        cj.start(work)
        return {"job_id": cj.id, "duration": None}
