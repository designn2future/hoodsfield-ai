"""
Short-form (TikTok-style) vertical-video "director": turns a transcribed +
vision-described reference story (or just a typed concept) into a flat,
ordered scene list via a local Ollama model, with a deterministic template
fallback so the pipeline still works when no LLM is running.

Unlike the music-video director (`director.py`), a short vertical video has
no song timeline to cross-cut against — it's one linear narrative told in a
handful of continuous shots, hook-first (the classic TikTok/short-form
structure: hook, build, payoff, call-to-action). So this module writes a
flat `scenes` list directly instead of `director.py`'s nested
`setups[].shots[]` — no setup/coverage/section-recurrence concepts apply
here. It reuses `director.py`'s hard-won per-shot safety nets (plural
framing, left-to-right face-swap ordering, face-visibility, continuity
restatement) rather than re-deriving them, since those constraints come from
the same underlying image/video models and node graph.
"""

import os
import re

import httpx

from director import (
    _character_gender,
    _clean_json,
    _fix_plural_framing,
    _fix_repetition_cues,
    _position_blocking,
    _uid,
    ollama_models,
    pick_text_model,
)
from h3 import FRAME_GRID, FPS, seconds_to_frames

import genres

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")

BEATS = ["hook", "build", "payoff", "cta"]

_SYSTEM = (
    "You are the writer AND director of a short vertical (TikTok/Reels-style) video, adapted from a "
    "reference story the user has already told once (as a video and/or photos) and wants retold as a "
    "new AI-generated short. You write a HOOK-FIRST structure: the first shot must grab attention in "
    "the first couple seconds (no slow build-up), then a handful of shots develop the story, then a "
    "clear payoff/reveal, then (if it fits the concept) a short closing beat. This is ONE continuous "
    "narrative told in a straight line, NOT a music video — there are no recurring setups, no "
    "cross-cutting, no sections to cover. Write the scenes in the exact order they will play.\n\n"
    "A text-to-image model (for each shot's key frame) and an image-to-video model with native audio "
    "(MiniMax H3) will execute your shots literally, so be concrete and visual: name the location, time "
    "of day, light, lens, wardrobe, colour palette, camera move, action. Present tense.\n\n"
    "CRITICAL — every still_prompt is rendered as exactly ONE photographic frame, one single moment, "
    "one composition. NEVER describe a sequence, a montage, a before/after, split-screen, multiple "
    "camera angles, or more than one distinct framing inside a single still_prompt — that produces a "
    "collage/contact-sheet image instead of one clean shot, which is unusable. If an idea needs more "
    "than one moment, that is more than one SCENE, never more content packed into one still_prompt.\n\n"
    "GRAMMAR MATTERS HERE: the image model reads a PLURAL shot-type word as a literal instruction to "
    "render more than one image — always phrase a still_prompt's opening as singular ('A close-up of "
    "X', 'A wide shot of X and Y together'), never plural ('Close-ups of', 'Shots of').\n\n"
    "When a shot's \"characters\" list has 2 or more names, a face-swap step pastes each person's real "
    "face onto the generated figures by their LEFT-TO-RIGHT ORDER ON SCREEN, in the same order the "
    "names are listed. So whenever a shot has 2+ characters, the still_prompt MUST explicitly place "
    "them left to right in that exact listed order (e.g. \"<first name> on the left, <second name> on "
    "the right\") — every time, without exception.\n\n"
    "That same face-swap step needs a clearly visible face to work with. NEVER write that smoke, fog, "
    "hair, a hand, shadow, or anything else obscures a named character's face. Say the opposite instead "
    "— their face stays clearly visible and in focus.\n\n"
    "DIALOGUE DRIVES LIP-SYNC: MiniMax H3 renders whatever text is in a shot's \"dialogue\" field as that "
    "shot's first-listed named character actually speaking it on camera, lips moving to match — an empty "
    "dialogue field means no lip-sync, just performance/action with no words. If the story material (the "
    "transcript and/or your own narrative sense) gives a character an actual line at a given moment, put "
    "it verbatim (trimmed to fit the shot's length — a few words per second is a natural pace) in that "
    "shot's \"dialogue\". Only ONE character's dialogue per shot.\n\n"
    "NEVER add a caption overlay, subtitle, watermark, logo, or emoji as part of a still_prompt or "
    "motion_prompt — these are things a real editor adds afterward in a separate app, not something the "
    "image/video model should render, and an image model asked to render text like this produces garbled, "
    "fake-looking nonsense that instantly reads as AI-generated. This is different from DIEGETIC on-screen "
    "text that is physically part of the scene — a phone screen the character is looking at, a sign, a "
    "note, a book page — which is fine and should be spelled out in quotes as usual.\n\n"
    "Every shot needs a \"beat\" tag: hook, build, payoff, or cta — exactly one hook (always shot 1), "
    "exactly one payoff, cta only if the concept calls for a closing button/call-to-action, and the rest "
    "build. Reply with ONLY a JSON object, no markdown."
)

_REALISM_INSTRUCTION = (
    "Write every still_prompt and motion_prompt for a photorealistic result — real camera photography, "
    "natural skin texture and imperfections, true-to-life lighting. Never write anime, cartoon, "
    "illustration, 3D-render, CGI, or painterly language, and avoid describing the smooth, glossy, "
    "overly-symmetrical look typical of AI-generated images — describe it like a real photo or real "
    "footage instead."
)


_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002B00-\U00002BFF\U0000FE0F\U0000200D]+"
)

_OVERLAY_PHRASE_FIX = [
    (re.compile(r"\btext overlay\b.*?(?=[.,;]|$)", re.I), ""),
    (re.compile(r"\bcaption(?:s)? (?:reading|that says|saying)\b.*?(?=[.,;]|$)", re.I), ""),
    (re.compile(r"\bTikTok caption(?:s)?\b.*?(?=[.,;]|$)", re.I), ""),
    (re.compile(r"\bon-screen caption(?:s)?\b.*?(?=[.,;]|$)", re.I), ""),
    (re.compile(r"\bsubtitle(?:s)?\b.*?(?=[.,;]|$)", re.I), ""),
    (re.compile(r"\bwatermark(?:ed)?\b.*?(?=[.,;]|$)", re.I), ""),
]

_NO_OVERLAY_CLAUSE = (
    "No caption text, subtitles, watermark, logo, or emoji anywhere in frame — only diegetic on-screen "
    "text that is physically part of the scene (a sign, screen, or document) may appear."
)

_REALISM_CLAUSE = (
    "Photographed realistically as if with a real camera — natural skin texture, pores, and imperfections, "
    "true-to-life lighting and color, candid and unposed. Not a 3D render, not a digital illustration, not "
    "anime, not a cartoon, and not the smooth over-processed look typical of AI-generated images."
)


def _strip_overlay_language(text: str) -> str:
    """Caption/overlay/watermark phrasing describes something a real editor
    adds afterward, not something the image model should render — an image
    model asked to render text like this produces garbled nonsense that
    instantly reads as AI-generated (confirmed pattern across this whole
    pipeline: on-screen text only works when it's a real diegetic prop, e.g.
    a phone screen). Strip the phrase unconditionally rather than trust the
    model always remembers the rule."""
    out = text
    for pattern, replacement in _OVERLAY_PHRASE_FIX:
        out = pattern.sub(replacement, out)
    return re.sub(r"\s{2,}", " ", out).strip()


def _strip_emoji(text: str) -> str:
    return _EMOJI_RE.sub("", text).strip()


def _source_text(source: dict) -> str:
    transcript = str((source or {}).get("transcript") or "").strip()
    visual_notes = str((source or {}).get("visual_notes") or "").strip()
    parts = []
    if transcript:
        parts.append(f"Transcribed narration from the reference video:\n{transcript}")
    if visual_notes:
        parts.append(f"Visual content notes from the reference video/images:\n{visual_notes}")
    return "\n\n".join(parts) or "(no reference material provided — invent a story from the concept alone)"


def build_story_prompt(source: dict, cast: list[dict], concept: str, style: str,
                       n_scenes: int, max_seconds: float, aspect: str, realistic: bool = True) -> str:
    style = _fix_repetition_cues(style)
    cast_txt = "\n".join(
        f"  - {c.get('name', 'Character')}: {c.get('description', '').strip() or 'no description'}"
        for c in cast
    ) or "  (no named characters — invent one if the story needs a person, or keep it about places/objects)"
    grid = ", ".join(f"{f / FPS:.1f}" for f in FRAME_GRID if f / FPS <= max_seconds + 1e-6)
    return f"""Reference story material:
{_source_text(source)}

Cast (use their exact names; they will be face-matched from reference photos):
{cast_txt}

Concept / how to adapt it: {concept.strip() or 'retell the reference story as a punchy short-form video'}
Visual style: {style.strip() or 'cinematic, filmic colour grade, shallow depth of field'}
Aspect ratio: {aspect}
{_REALISM_INSTRUCTION if realistic else ''}

Write about {n_scenes} scenes, in play order, telling one linear story. Each scene's "seconds" must be
one of: {grid}.

Return JSON exactly of this shape:
{{
  "title": "video title",
  "style": "one-line shared visual style appended to every still prompt",
  "scenes": [
    {{
      "beat": "hook|build|payoff|cta",
      "title": "short scene name",
      "characters": ["Name"],
      "continuity": "wardrobe, props, exact lighting/environment details to repeat if this location/character recurs",
      "still_prompt": "one paragraph for the image model: subject, wardrobe, location, light, lens, composition, any on-screen text spelled out in quotes",
      "motion_prompt": "one paragraph for the video model: what moves, camera motion, performance, action — present tense, starts from the still",
      "dialogue": "",
      "soundscape": "diegetic ambience and foley for this clip (no music)",
      "seconds": 5.2
    }}
  ]
}}"""


async def write_script(source: dict, cast: list[dict], concept: str, style: str,
                       n_scenes: int, max_seconds: float, aspect: str, model: str = "",
                       realistic: bool = True, genre: str = "", scare: str = "creepy") -> dict:
    """Ask Ollama for a flat scene list. Raises httpx errors / ValueError; the
    caller decides whether to fall back to `template_script`."""
    async with httpx.AsyncClient(timeout=900, trust_env=False) as client:
        models = await ollama_models(client)
        model = model or pick_text_model(models)
        if not model:
            raise ValueError("Ollama has no models pulled")
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": _SYSTEM + genres.rules_for(genre, scare)},
                {"role": "user", "content": build_story_prompt(source, cast, concept, style, n_scenes, max_seconds, aspect, realistic)},
            ],
            "stream": False,
            "format": "json",
            "think": False,
            "options": {"temperature": 0.85, "num_ctx": 8192, "num_predict": 4000},
        }
        r = await client.post(f"{OLLAMA_URL}/api/chat", json=body)
        if r.status_code != 200:
            body.pop("think", None)
            r = await client.post(f"{OLLAMA_URL}/api/chat", json=body)
        if r.status_code != 200:
            raise ValueError(f"Ollama error {r.status_code}: {r.text[:300]}")
        msg = r.json().get("message", {})
        content, thinking = msg.get("content", ""), msg.get("thinking", "")
        thinking_starved = bool(thinking) and len(content.strip()) < 4
        try:
            data = _clean_json(content)
            data["model"] = model
            result = normalize_script(data, cast, n_scenes, max_seconds, realistic)
        except ValueError as e:
            if thinking_starved:
                raise ValueError(
                    f"{model} spent its whole reply reasoning internally and never wrote an answer "
                    f"(thinking) — it isn't a good fit for this structured JSON task. Pull a plain "
                    f"instruct model instead, e.g. `ollama pull qwen2.5:7b-instruct`, and pick it as "
                    f"the director model."
                ) from e
            raise
        return result


# ------------------------------------------------------------------ normalisation

_VALID_BEATS = set(BEATS)


def normalize_script(data: dict, cast: list[dict], n_scenes: int, max_seconds: float,
                     realistic: bool = True) -> dict:
    """Flat, ordered scene list — no setups nesting (there's no song/section
    structure to cross-cut against here). Applies the same per-shot safety
    nets `director.normalize_script` applies, via the imported helpers, plus
    this module's own no-overlay/emoji and realism safety nets."""
    names = [c.get("name", "") for c in cast if c.get("name")]
    genders = {c.get("name"): _character_gender(str(c.get("description") or "")) for c in cast if c.get("name")}
    appearances = {c.get("name"): str(c.get("description") or "").strip() for c in cast if c.get("name")}

    raw_scenes = data.get("scenes") if isinstance(data.get("scenes"), list) else []
    out_scenes = []
    for i, sc in enumerate(raw_scenes):
        if not isinstance(sc, dict):
            continue
        try:
            seconds = float(sc.get("seconds", max_seconds))
        except (TypeError, ValueError):
            seconds = max_seconds
        frames = seconds_to_frames(min(max(seconds, 1.0), max_seconds))
        beat = str(sc.get("beat") or "").strip().lower()
        if beat not in _VALID_BEATS:
            beat = "hook" if i == 0 else ("payoff" if i == len(raw_scenes) - 1 else "build")
        chars = sc.get("characters") if isinstance(sc.get("characters"), list) else []
        chars = [c for c in chars if isinstance(c, str) and (not names or c in names)]
        continuity = str(sc.get("continuity") or "").strip()
        still = _strip_emoji(_strip_overlay_language(_fix_repetition_cues(_fix_plural_framing(str(sc.get("still_prompt") or "").strip()))))
        motion = _strip_emoji(_strip_overlay_language(str(sc.get("motion_prompt") or "").strip()))
        if continuity and continuity.lower()[:20] not in still.lower():
            still = f"{still} {continuity}".strip() if still else continuity
        for name in chars:
            desc = appearances.get(name, "")
            if desc and desc.lower()[:20] not in still.lower():
                still = f"{still} {name}: {desc}.".strip()
        if len(chars) >= 2 and not re.search(r"\b(on the left|on the right|in the middle|far left|far right)\b", still, re.I):
            still = f"{still} ({_position_blocking(chars, genders)}, left to right)."
        if chars:
            face_clause = (
                f"{chars[0]}'s face is" if len(chars) == 1 else "Their faces are"
            ) + " fully visible, unobscured, and in sharp focus — no smoke, fog, hair, hand, or shadow crosses it."
            still = f"{still} {face_clause}".strip()
        still = f"{still} {_NO_OVERLAY_CLAUSE}".strip()
        if realistic:
            still = f"{still} {_REALISM_CLAUSE}".strip()
        scene_id = _uid("scene")
        out_scenes.append({
            "id": scene_id,
            "order": i,
            "beat": beat,
            "title": str(sc.get("title") or f"Scene {i + 1}")[:80],
            "characters": chars,
            "continuity": continuity,
            "stillPrompt": still,
            "motionPrompt": motion,
            "dialogue": str(sc.get("dialogue") or "").strip(),
            "soundscape": str(sc.get("soundscape") or "").strip(),
            "narration": str(sc.get("narration") or "").strip(),
            "caption": str(sc.get("caption") or "").strip(),
            "frames": frames,
            "seconds": round(frames / FPS, 2),
        })

    if not out_scenes:
        raise ValueError("the model returned no usable scenes")
    return {
        "title": str(data.get("title") or "Untitled")[:120],
        "style": str(data.get("style") or "").strip(),
        "model": data.get("model", ""),
        "scenes": out_scenes,
    }


# ------------------------------------------------------------------ pasted-script import

_SHOT_HEADER_RE = re.compile(r"^##\s*SHOT\s+\d+\s*[—-]\s*(.+?)\s*$", re.M)
_TAG_RE = re.compile(r"\*\*\[([A-Za-z ]+)\]\*\*\s*(.*?)(?=\n\*\*\[|\n-{3,}\s*\n|\n#{1,6}\s|\Z)", re.S)
_COLOR_GRADE_RE = re.compile(r"\[COLOR GRADE\][^\n]*\n+>\s*(?:Color grade:\s*)?([^\n]+)", re.I)
_TIME_RANGE_RE = re.compile(r"\((\d+):(\d+)\s*[–-]\s*(\d+):(\d+)\)")

# A pasted [VISUAL] block written for direct screenplay/H3 use often joins
# more than one distinct moment with a "cut to" style transition inside a
# single shot ("...she checks the lock. Cut to: the phone rings upstairs.").
# A still-image model asked to render that renders a multi-panel contact
# sheet instead of one clean frame — confirmed root cause, real occurrence:
# a haunted-house script's shots 3 & 4. There's no reliable way to represent
# "more than one moment" inside a single still_prompt in this still-first
# pipeline, so such a shot must become two (or more) consecutive shots.
_CUT_MARKER_RE = re.compile(
    r"\b(?:then\s+|we\s+|now\s+|smash\s+|match\s+)?cuts?\s+to\b:?\s*", re.I
)


def _split_on_cut_markers(text: str) -> list[str]:
    matches = list(_CUT_MARKER_RE.finditer(text))
    if not matches:
        return [text]
    segments = []
    start = 0
    for m in matches:
        seg = text[start:m.start()].rstrip(" ,.;—-")
        if seg:
            segments.append(seg)
        start = m.end()
    tail = text[start:].strip()
    if tail:
        segments.append(tail)
    return segments if len(segments) > 1 else [text]


def _split_multi_moment_shots(raw_scenes: list[dict]) -> tuple[list[dict], list[str]]:
    """Split any raw pasted shot whose VISUAL text contains a 'cut to'
    transition into separate consecutive shots, dividing its duration evenly
    between them. Returns (possibly-longer scene list, human-readable
    warnings) — surfaced to the UI the same way the LLM-fallback warning is."""
    out, warnings = [], []
    for sc in raw_scenes:
        parts = _split_on_cut_markers(str(sc.get("still_prompt") or ""))
        if len(parts) <= 1:
            out.append(sc)
            continue
        n = len(parts)
        seconds = float(sc.get("seconds") or 0) or 5.2
        share = max(1.5, seconds / n)
        title = sc.get("title") or "Scene"
        for i, part in enumerate(parts):
            piece = dict(sc)
            piece["title"] = title if i == 0 else f"{title} (cont.{'' if n <= 2 else f' {i}'})"
            piece["still_prompt"] = part
            piece["motion_prompt"] = part
            piece["seconds"] = round(share, 2)
            out.append(piece)
        warnings.append(
            f"Split \"{title}\" into {n} shots — its [VISUAL] described more than one moment "
            f"(\"cut to…\"), which would otherwise render as a multi-panel still"
        )
    return out, warnings


def _parse_shot_header(raw: str) -> tuple[str, float | None]:
    """'THE HOOK (0:00–0:07)  SCROLL-STOPPER' -> ('THE HOOK', 7.0)."""
    m = _TIME_RANGE_RE.search(raw)
    if not m:
        return _strip_emoji(raw).strip(" -–—"), None
    s_min, s_sec, e_min, e_sec = (int(x) for x in m.groups())
    duration = max(1.0, (e_min * 60 + e_sec) - (s_min * 60 + s_sec))
    title = _strip_emoji(raw[:m.start()]).strip(" -–—")
    return title, duration


def parse_pasted_script(text: str, max_seconds: float, realistic: bool = True) -> dict:
    """Deterministic parser (no LLM call) for a script the user already wrote
    shot-by-shot, in the format a script written for direct MiniMax H3 use
    tends to take: `## SHOT N — Title (mm:ss–mm:ss)` headings, each with
    `**[VISUAL]**`/`**[VOICEOVER]**`/`**[SFX]**` blocks. Only VISUAL (used for
    both still_prompt and motion_prompt — there is no reliable automatic way
    to split a single freeform paragraph into "frozen moment" vs "what moves"
    without another LLM pass, so both start identical here and are meant to
    be hand-trimmed afterward), VOICEOVER (kept as `narration`, informational
    only — nothing here feeds a TTS/lip-sync path), and SFX (-> soundscape)
    are used. `**[TEXT ON SCREEN]**` blocks are intentionally dropped — those
    are caption overlays a real editor adds afterward, never something for
    the image/video model to render (see `_NO_OVERLAY_CLAUSE`, applied to
    every scene by `normalize_script` regardless of import path)."""
    headers = list(_SHOT_HEADER_RE.finditer(text))
    if not headers:
        raise ValueError("No '## SHOT N — Title' headings found — check the script is pasted in full, unedited")
    grade_m = _COLOR_GRADE_RE.search(text)
    style = grade_m.group(1).strip() if grade_m else ""

    raw_scenes = []
    for i, m in enumerate(headers):
        end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        block = text[m.end():end]
        title, duration = _parse_shot_header(m.group(1))
        tags = {tm.group(1).strip().upper(): tm.group(2).strip() for tm in _TAG_RE.finditer(block)}
        visual = tags.get("VISUAL", "")
        # richer scripts name the frozen picture and the movement separately (and who speaks, who is in shot, which beat)
        still = tags.get("STILL", "") or visual
        motion = tags.get("MOTION", "") or visual or still
        chars = [c.strip() for c in re.split(r"[,;]", tags.get("CHARACTERS", "")) if c.strip()]
        beat = tags.get("BEAT", "").strip().lower()
        raw_scenes.append({
            "title": title or f"Scene {i + 1}",
            "still_prompt": still,
            "motion_prompt": motion,
            "narration": tags.get("VOICEOVER", "").strip('"'),
            "caption": tags.get("TEXT ON SCREEN", "").strip().strip('"“”'),
            "dialogue": re.sub(r"^[A-Z][\w .'-]{0,24}:\s*", "", tags.get("DIALOGUE", "").strip()).strip('"\u201c\u201d '),
            "characters": chars,
            "beat": beat if beat in ("hook", "build", "payoff", "cta") else "",
            "continuity": tags.get("CONTINUITY", ""),
            "soundscape": tags.get("SFX", ""),
            "seconds": duration or max_seconds,
        })
    raw_scenes, split_warnings = _split_multi_moment_shots(raw_scenes)
    h1 = re.search(r"^#\s+(?!#)(.+?)\s*$", text, re.M)
    data = {"title": (h1.group(1).strip() if h1 else "Imported script"), "style": style, "model": "pasted", "scenes": raw_scenes}
    result = normalize_script(data, [], len(raw_scenes), max_seconds, realistic)
    if split_warnings:
        result["warning"] = "; ".join(split_warnings)
    return result


# ------------------------------------------------------------------ fallback

_LOCATIONS = [
    ("city sidewalk", "bright midday sun"), ("bedroom with fairy lights", "warm lamp glow, night"),
    ("kitchen counter", "soft morning window light"), ("rooftop with skyline behind", "golden hour"),
    ("car interior, parked", "afternoon light through the windshield"), ("park bench under a tree", "dappled shade"),
]
_MOVES = ["slow push-in", "handheld, subject reacts", "quick whip pan to reveal", "static, subject leans into frame",
          "slow pull-back to reveal more", "close tracking shot"]
_PERF = ["turns to camera, surprised", "laughs and shakes their head", "leans in close, whispers",
         "throws their hands up", "looks straight down the lens", "glances away then back, smiling"]


def template_script(source: dict, cast: list[dict], concept: str, style: str,
                    n_scenes: int, max_seconds: float, seed: int | None = None,
                    realistic: bool = True) -> dict:
    """No-LLM fallback: a fixed hook/build.../payoff/cta beat progression
    cycling through generic locations, so the pipeline still works with
    Ollama down."""
    import random

    rnd = random.Random(seed if seed is not None else 7)
    style = _fix_repetition_cues(style)
    names = [c.get("name", "") for c in cast if c.get("name")] or ["the subject"]
    frames = seconds_to_frames(max_seconds)
    n = max(3, min(n_scenes, 40))
    locs = _LOCATIONS[:]
    rnd.shuffle(locs)

    raw_scenes = []
    for i in range(n):
        loc, light = locs[i % len(locs)]
        who = names[i % len(names)]
        beat = "hook" if i == 0 else ("payoff" if i == n - 1 else "build")
        still = (f"A medium shot of {who} in a {loc}, {light}, "
                 f"{style.strip() or 'cinematic, filmic colour grade, shallow depth of field'}, 35mm, highly detailed.")
        motion = f"{rnd.choice(_MOVES)}; {who} {rnd.choice(_PERF)}; {light}; subtle natural motion in the background."
        raw_scenes.append({
            "beat": beat, "title": f"Scene {i + 1}", "characters": [who] if who != "the subject" else [],
            "continuity": f"{who}, {loc}, {light}", "still_prompt": still, "motion_prompt": motion,
            "dialogue": "", "soundscape": "quiet ambience matching the location, light foley, no music",
            "seconds": round(frames / FPS, 2),
        })
    data = {"title": (concept.strip()[:60] or "Untitled"), "style": style.strip(), "model": "template", "scenes": raw_scenes}
    return normalize_script(data, cast, n_scenes, max_seconds, realistic)
