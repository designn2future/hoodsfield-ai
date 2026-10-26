"""
Music-video "director": turns a song analysis + cast + concept into a shot
list via a local Ollama model, with a deterministic template fallback so the
pipeline still works when no LLM is running.

Real music videos are not one shot per moment — a small number of recurring
SETUPS (locations/looks) each get COVERAGE (several shots: wide, medium,
close-up, insert...) and the edit cross-cuts between setups throughout the
whole song, often returning to the same setup later for a different beat.
This module writes that structure explicitly (`setups[].shots[]`) instead of
a flat list of independent scenes, then flattens it to the flat `scenes`
list the rest of the app already consumes — each flattened scene keeps
`setupId`/`setupName`/`shotSize`/`continuity` and `sections` as a LIST (a
setup can recur in more than one section), so the auto-cut editor
(`mvEdit.js`) can cross-cut across the whole timeline instead of confining
each setup to a single section.

Every shot carries two prompts:
  * still_prompt  — text-to-image (Krea 2) for the shot's key frame; this is
                    where on-screen text, signage, wardrobe detail must be
                    legible — the image model handles text far better than
                    the video model, and the clip inherits it. Continuity
                    details are folded into every shot of a setup (each still
                    is generated independently, with no memory of the
                    others — repetition in the prompt, the same character
                    face-swap references, and the same style/environment
                    reference images are what keep a setup's shots looking
                    like the same place).
  * motion_prompt — what happens during the clip (camera, performance,
                    action), written in the present tense for MiniMax H3.
plus soundscape / dialogue and a target duration on H3's frame grid.
"""

import json
import os
import random
import re

import httpx

from h3 import FRAME_GRID, FPS, compose_h3_prompt, seconds_to_frames

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_TEXT_MODEL = os.getenv("OLLAMA_TEXT_MODEL", "")

_TEXT_PREF = [
    re.compile(r"^qwen3(?!.*vl)", re.I), re.compile(r"qwen2\.5(?!.*vl)", re.I), re.compile(r"llama3", re.I),
    re.compile(r"gemma3(?!.*vision)", re.I), re.compile(r"mistral", re.I), re.compile(r"phi", re.I),
    re.compile(r"deepseek", re.I), re.compile(r"qwen", re.I),
]

SHOT_SIZES = ["wide", "medium", "close-up", "insert", "over-the-shoulder", "pov"]


import genres


async def ollama_models(client: httpx.AsyncClient) -> list[str]:
    r = await client.get(f"{OLLAMA_URL}/api/tags")
    r.raise_for_status()
    return [m.get("name", "") for m in r.json().get("models", []) if m.get("name")]


def pick_text_model(models: list[str]) -> str:
    if OLLAMA_TEXT_MODEL and OLLAMA_TEXT_MODEL in models:
        return OLLAMA_TEXT_MODEL
    if OLLAMA_TEXT_MODEL:
        return OLLAMA_TEXT_MODEL  # let Ollama complain if it's not pulled
    for p in _TEXT_PREF:
        for m in models:
            if p.search(m):
                return m
    return models[0] if models else ""


# ------------------------------------------------------------------ prompting

_SYSTEM = (
    "You are the director AND editor of an AI-generated music video, planning coverage the way a real "
    "music video is shot and cut. You do NOT write one shot per moment. Instead you design a small "
    "number of recurring SETUPS (distinct locations/looks — e.g. a narrative location, a performance "
    "space, an abstract/texture setup) and give each setup several SHOTS of genuine coverage (wide "
    "establishing, medium, close-up, insert/detail, over-the-shoulder, POV — vary it, don't repeat the "
    "same size twice in one setup, and keep a healthy mix of wide/long, medium, and close-up shots across "
    "the ENTIRE video, not just within one setup). The edit will cross-cut between setups throughout the whole song — "
    "the same setup's shots can and should reappear in more than one section (a narrative setup in "
    "verse 1 and verse 2, a performance setup across every chorus), the classic music-video pattern. "
    "Assign each setup to the sections it appears in — most setups should appear in 2 or more sections. "
    "A text-to-image model (for each shot's key frame) and an image-to-video model with native audio "
    "(MiniMax H3) will execute your shots literally, and a separate hard-cut editor will intercut them "
    "on the beat, so within a setup repeat the continuity details (wardrobe, props, lighting, exact "
    "environment) in every shot's still prompt — nothing else carries them over. Be concrete and "
    "visual: name the location, time of day, light, lens, wardrobe, colour palette, camera move, "
    "performance. Present tense. One location per setup.\n\n"
    "CRITICAL — every still_prompt is rendered as exactly ONE photographic frame, one single moment, "
    "one composition. NEVER describe a sequence, a montage, a before/after, split-screen, multiple "
    "camera angles, or more than one distinct framing inside a single still_prompt — that produces a "
    "collage/contact-sheet image instead of one clean shot, which is unusable. If an idea needs more "
    "than one moment, that is more than one SHOT (add another shot to the setup), never more content "
    "packed into one still_prompt.\n\n"
    "GRAMMAR MATTERS HERE: the image model reads a PLURAL shot-type word as a literal instruction to "
    "render more than one image. Confirmed by direct testing — 'Close-ups of both X and Y' (plural) "
    "renders X and Y each in their own stacked panel, one shot per person; 'A single close-up shot of "
    "X and Y together' (singular) renders exactly one clean frame with both of them in it, which is "
    "what's actually wanted. So for a shot with 2+ characters, ALWAYS phrase the opening as singular — "
    "'A close-up of X and Y', 'A wide shot showing X and Y', 'A medium shot of X and Y together' — "
    "never 'Close-ups of', 'Shots of', 'Wide shots of', or any other plural framing word, even when "
    "multiple people are in frame. One shot, one image, always singular.\n\n"
    "When a shot's \"characters\" list has 2 or more names, a face-swap step pastes each person's real "
    "face onto the generated figures by their LEFT-TO-RIGHT ORDER ON SCREEN, in the same order the "
    "names are listed — it has no other way to tell them apart. So whenever a shot has 2+ characters, "
    "the still_prompt MUST explicitly place them left to right in that exact listed order (e.g. "
    "\"<first name> on the left, <second name> on the right\" for two; add \"in the middle\" for a "
    "third) — every time, without exception, or the wrong face lands on the wrong person.\n\n"
    "That same face-swap step also needs a clearly visible face to work with. NEVER write that smoke, "
    "fog, hair, a hand, shadow, or anything else obscures, hides, or half-hides a named character's "
    "face — atmosphere belongs in the background and the air around them, never drifting across their "
    "face. Say the opposite instead: their face stays clearly visible and in focus even inside a hazy "
    "or smoky scene. Also don't cast more named characters into a shot than its framing can actually "
    "hold — a close-up, insert, or POV isolates ONE character (at most two if they're framed close "
    "together, e.g. an over-the-shoulder); save the rest of the cast for wider shots.\n\n"
    "DIALOGUE DRIVES LIP-SYNC: MiniMax H3 renders whatever text is in a shot's \"dialogue\" field as that "
    "shot's named character(s) actually speaking/singing it on camera, lips moving to match — an empty "
    "dialogue field means no lip-sync, just performance/reaction with no words. If the pasted lyrics mark "
    "who sings which part (a header like \"[Verse 1: Artist Name]\", a speaker prefix like \"Artist Name:\", "
    "or the concept text otherwise makes it unambiguous) AND that name is a real cast member, give that "
    "performer at least one close-up or medium performance shot inside a setup scheduled for the matching "
    "section, with \"dialogue\" set to their actual lyric line(s) for that moment (verbatim, trimmed to fit "
    "the shot's length — a few words per second is a natural pace) — this is how a named singer actually "
    "appears to sing their part instead of just posing while the track plays. Only ONE character's dialogue "
    "per shot (whoever is singing that line); if the lyrics don't attribute a section to a specific cast "
    "member, leave \"dialogue\" empty rather than guessing who's singing.\n\n"
    "WEAVE THE WHOLE CAST THROUGH THE WHOLE SONG: never let a section read as one performer's solo block "
    "just because they're singing it. Even inside a section led by one cast member's vocals/dialogue, "
    "include at least one shot elsewhere in that section — a reaction, cutaway, duo, or over-the-shoulder "
    "shot — featuring another main cast member (whoever else is central to the concept, e.g. a lead "
    "character alongside a featured rapper), so every named character keeps recurring across the whole "
    "video instead of disappearing until 'their' section comes back around. When two named characters "
    "share a scene, follow the left-to-right ordering rule above for both the still_prompt and dialogue "
    "(only one of them speaks per shot).\n\n"
    "ABSTRACT / SYMBOLIC INSERTS: include a small number of setups with NO named characters at all — "
    "pure environment or object detail shots that carry mood and theme rather than performance (e.g. a "
    "cigarette burning down in an ashtray, ash and scattered magazines on a table, rain on a window, "
    "graffiti texture in close-up, smoke curling through light, a broken mirror shard). Leave \"characters\" "
    "empty for these — no face-swap, no continuity restatement needed, just the object/environment detail. "
    "These are cutaway texture shots the editor can drop in anywhere for rhythm, not tied to any one "
    "performer's section. A couple across the whole video is enough — don't let them crowd out the cast.\n\n"
    "Reply with ONLY a JSON object, no markdown."
)


def _sections_text(analysis: dict) -> str:
    lines = []
    for i, s in enumerate(analysis.get("sections", []), start=1):
        lines.append(f"  {i}. {s.get('label', 'section')}  {s['start']:.1f}s–{s['end']:.1f}s  energy {s.get('energy', 0):.2f}")
    return "\n".join(lines) or "  (no section data)"


def build_director_prompt(analysis: dict, cast: list[dict], concept: str, style: str,
                          n_scenes: int, max_seconds: float, aspect: str, lyrics: str = "") -> str:
    style = _fix_repetition_cues(style)
    cast_txt = "\n".join(
        f"  - {c.get('name', 'Character')}: {c.get('description', '').strip() or 'no description'}"
        for c in cast
    ) or "  (no named characters — invent a performer or keep setups about places/objects)"
    grid = ", ".join(f"{f / FPS:.1f}" for f in FRAME_GRID if f / FPS <= max_seconds + 1e-6)
    n_sections = len(analysis.get("sections", [])) or 1
    # capped at 6 originally; a full-length song (vs. a ~30s preview) needs more
    # than 6 recurring locations or it cross-cuts the same handful of places for
    # 3-4 minutes straight and starts reading as repetitive
    n_setups = max(3, min(12, round(n_scenes / 3)))
    return f"""Song: {analysis.get('duration', 0):.0f} seconds, {analysis.get('bpm', 0):.0f} BPM.
Sections (from audio analysis):
{_sections_text(analysis)}

Cast (use their exact names; they will be face-matched from reference photos):
{cast_txt}

Concept / story: {concept.strip() or 'a performance-driven music video with strong locations'}
Visual style: {style.strip() or 'cinematic, filmic colour grade, shallow depth of field'}
Aspect ratio: {aspect}
{('Lyrics / themes:' + chr(10) + lyrics.strip()) if lyrics.strip() else ''}

Design about {n_setups} setups with roughly {n_scenes} shots total (2–4 shots per setup — don't split
evenly, give the most important setups more coverage). Every one of the {n_sections} sections must be
covered by at least one setup's shots. Give choruses the setups with the most striking, high-energy
imagery (they get cut fastest). Vary shot sizes within a setup; vary locations and time-of-day across
setups. A setup's "sections" list is which sections its shots are drawn into — most setups should list
2 or more sections (that's the cross-cutting: the same place/look returning later in the song).

Across the WHOLE shot list, not just within each setup, keep a healthy mix of wide/long shots, medium
shots, and close-ups/inserts — roughly a third each is a good target. Don't let the video lean almost
entirely on one shot size; a wall of close-ups (or of wide shots) reads as monotonous when cut together,
however good any single image looks.

Each shot's "seconds" must be one of: {grid} (clip length; the editor cuts shorter pieces from it).

Return JSON exactly of this shape:
{{
  "title": "video title",
  "style": "one-line shared visual style appended to every still prompt",
  "setups": [
    {{
      "name": "short setup name, e.g. 'Neon diner — booth'",
      "location": "where",
      "time_of_day": "when / light",
      "characters": ["Name"],
      "continuity": "wardrobe, props, exact lighting/environment details to repeat in every shot below so independently generated stills still match",
      "sections": [1, 3],
      "shots": [
        {{
          "size": "wide|medium|close-up|insert|over-the-shoulder|pov",
          "still_prompt": "one paragraph for the image model: subject, wardrobe, location, light, lens, composition, any on-screen text spelled out in quotes — repeat this setup's continuity details",
          "motion_prompt": "one paragraph for the video model: what moves, camera motion, performance, expression — present tense, starts from the still",
          "dialogue": "",
          "soundscape": "diegetic ambience and foley for this clip (no music)",
          "seconds": 5.2,
          "energy": "low|mid|high"
        }}
      ]
    }}
  ]
}}"""


def _clean_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise ValueError("no JSON object in model reply")
    return json.loads(text[start:end + 1])


async def write_script(analysis: dict, cast: list[dict], concept: str, style: str,
                       n_scenes: int, max_seconds: float, aspect: str, lyrics: str = "",
                       model: str = "", genre: str = "") -> dict:
    """Ask Ollama for a setup/shot list. Raises httpx errors / ValueError; the
    caller decides whether to fall back to `template_script`."""
    async with httpx.AsyncClient(timeout=900, trust_env=False) as client:
        models = await ollama_models(client)
        model = model or pick_text_model(models)
        if not model:
            raise ValueError("Ollama has no models pulled")
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": _SYSTEM + genres.rules_for(genre)},
                {"role": "user", "content": build_director_prompt(analysis, cast, concept, style, n_scenes, max_seconds, aspect, lyrics)},
            ],
            "stream": False,
            "format": "json",
            "think": False,
            "options": {"temperature": 0.85, "num_ctx": 8192, "num_predict": 7000},
        }
        r = await client.post(f"{OLLAMA_URL}/api/chat", json=body)
        if r.status_code != 200:
            # older Ollama builds reject unknown keys such as "think"
            body.pop("think", None)
            r = await client.post(f"{OLLAMA_URL}/api/chat", json=body)
        if r.status_code != 200:
            raise ValueError(f"Ollama error {r.status_code}: {r.text[:300]}")
        msg = r.json().get("message", {})
        content, thinking = msg.get("content", ""), msg.get("thinking", "")
        # Some "thinking" models (reasoning kept in a separate field) burn their
        # whole reply budget reasoning and never write an answer — content
        # comes back empty (or a trivial "{}") no matter the token budget. A
        # generic "no JSON found" error leaves no clue what happened, so name
        # the actual cause when it looks like this.
        thinking_starved = bool(thinking) and len(content.strip()) < 4
        try:
            data = _clean_json(content)
            data["model"] = model
            result = normalize_script(data, analysis, cast, n_scenes, max_seconds)
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

_ENERGY_WORDS = {"low": 0.2, "mid": 0.5, "medium": 0.5, "high": 0.9}
_uid_seq = [0]


def _uid(prefix: str) -> str:
    _uid_seq[0] += 1
    return f"{prefix}{_uid_seq[0]}"


def _clean_sections(raw, n_sections: int) -> list[int]:
    out = []
    vals = raw if isinstance(raw, list) else [raw]
    for v in vals:
        try:
            iv = int(v)
        except (TypeError, ValueError):
            continue
        if 1 <= iv <= n_sections and iv not in out:
            out.append(iv)
    return out


_PLURAL_FRAMING_FIX = [
    (re.compile(r"^close[- ]?ups?\s+of\b", re.I), "A close-up of"),
    (re.compile(r"^wide shots?\s+of\b", re.I), "A wide shot of"),
    (re.compile(r"^medium shots?\s+of\b", re.I), "A medium shot of"),
    (re.compile(r"^inserts?\s+of\b", re.I), "An insert of"),
    (re.compile(r"^over-the-shoulder shots?\s+of\b", re.I), "An over-the-shoulder shot of"),
    (re.compile(r"^pov shots?\s+of\b", re.I), "A POV shot of"),
    (re.compile(r"^shots?\s+of\b", re.I), "A shot of"),
]


_REPETITION_CUE_FIX = [
    (re.compile(r"\brecurring\s+visual\s+motifs?\s+of\b", re.I), "set-dressing details including"),
    (re.compile(r"\brecurring\s+motifs?\s+of\b", re.I), "set-dressing details including"),
    (re.compile(r"\brecurring\s+(?=\w)", re.I), ""),
    (re.compile(r"\brepeated\s+(?=\w)", re.I), ""),
    (re.compile(r"\bmultiple\s+shots?\s+of\b", re.I), "a shot of"),
    (re.compile(r"\bseries\s+of\s+shots?\s+of\b", re.I), "a shot of"),
    (re.compile(r"\bvarious\s+shots?\s+of\b", re.I), "a shot of"),
]


def _fix_repetition_cues(text: str) -> str:
    """A style description written for the whole video (e.g. 'recurring
    motifs of balloons, mannequins...') reads, once folded into a SINGLE
    shot's still_prompt, as a literal instruction to depict that thing more
    than once — confirmed live: a still_prompt carrying 'recurring motifs of
    balloons, mannequins, cigarette debris, and graffiti' rendered as three
    near-identical takes of the same shot stacked in one image, each with the
    props reshuffled, like a contact sheet. Whole-video language like
    'recurring'/'repeated'/'various shots of' must never reach a per-shot
    prompt — strip it unconditionally."""
    out = text
    for pattern, replacement in _REPETITION_CUE_FIX:
        out = pattern.sub(replacement, out)
    return out


def _fix_plural_framing(text: str) -> str:
    """A plural shot-type word at the start of a still_prompt ('Close-ups of
    X and Y') is a literal instruction to a diffusion model to render more
    than one image — confirmed by direct A/B test on this exact model: the
    plural phrasing renders each person in their own stacked panel, the
    singular phrasing ('A close-up of X and Y') renders one clean frame with
    both in it. Fix it unconditionally rather than trust the model always
    remembers the grammar rule."""
    stripped = text.strip()
    for pattern, replacement in _PLURAL_FRAMING_FIX:
        if pattern.match(stripped):
            return pattern.sub(replacement, stripped, count=1)
    return text


_GENDER_WORDS_F = re.compile(r"\b(she|her|hers|woman|female|girl)\b", re.I)
_GENDER_WORDS_M = re.compile(r"\b(he|him|his|man|male|boy)\b", re.I)


def _character_gender(description: str) -> str:
    """Guess a character's gender from their cast description, for tagging
    into shot prompts. A real celebrity's name alone carries a strong gender
    prior for the image model (it has seen countless training images of
    them); an original character has none — the model has nothing to go on
    but this shot's own text, and in a crowded multi-character composition
    with small faces (a wide shot especially), attributes measurably leak
    between adjacent subjects. Confirmed live: an original female character
    standing next to two real male artists in a 3-up wide shot is exactly
    the scenario where this shows up. Returns 'woman', 'man', or '' if the
    description doesn't clearly say (or contradicts itself)."""
    text = description or ""
    f, m = bool(_GENDER_WORDS_F.search(text)), bool(_GENDER_WORDS_M.search(text))
    return "woman" if f and not m else "man" if m and not f else ""


def _position_blocking(chars: list[str], genders: dict[str, str] | None = None) -> str:
    """Left-to-right blocking clause matching the order ReActor's face-swap
    step assigns faces by screen position — keeps the generated composition
    and the face-swap step agreeing on who is where. Each name is tagged
    with its known gender (from the cast description) so an original
    character sharing a frame with real, name-recognized people doesn't
    inherit their attributes."""
    genders = genders or {}
    tagged = [f"{c} (a {genders[c]})" if genders.get(c) else c for c in chars]
    if len(tagged) == 2:
        return f"{tagged[0]} on the left, {tagged[1]} on the right"
    if len(tagged) == 3:
        return f"{tagged[0]} on the left, {tagged[1]} in the middle, {tagged[2]} on the right"
    return ", ".join(f"{c} (position {i + 1} from the left)" for i, c in enumerate(tagged))


def normalize_script(data: dict, analysis: dict, cast: list[dict], n_scenes: int, max_seconds: float) -> dict:
    """Accepts either the current `setups[].shots[]` shape or, for backward
    compatibility with an older/oddly-behaving model reply, a flat `scenes`
    list (each treated as its own one-shot setup). Always returns both
    `setups` (nested, for a coverage-aware review UI) and a flattened
    `scenes` list (for the board/editor, which only cares about individual
    clips) — every scene carries `setupId`/`setupName`/`shotSize`/`sections`
    (a list — a setup can recur across sections) and `continuity`."""
    sections = analysis.get("sections", []) or [{"start": 0, "end": analysis.get("duration", 60), "energy": 0.5, "label": "song"}]
    n_sections = len(sections)
    names = [c.get("name", "") for c in cast if c.get("name")]
    genders = {c.get("name"): _character_gender(str(c.get("description") or "")) for c in cast if c.get("name")}
    appearances = {c.get("name"): str(c.get("description") or "").strip() for c in cast if c.get("name")}

    raw_setups = data.get("setups") if isinstance(data.get("setups"), list) else None
    if raw_setups is None:
        # tolerate a flat `scenes` reply (older prompt shape, or a model that
        # ignored the setup structure) — treat each scene as a 1-shot setup
        raw_scenes = data.get("scenes") if isinstance(data.get("scenes"), list) else []
        raw_setups = [
            {**sc, "shots": [sc], "sections": [sc.get("section")]}
            for sc in raw_scenes if isinstance(sc, dict)
        ]

    out_setups, out_scenes = [], []
    for si, setup in enumerate(raw_setups):
        if not isinstance(setup, dict):
            continue
        shots = setup.get("shots") if isinstance(setup.get("shots"), list) else []
        if not shots:
            continue
        setup_id = _uid("setup")
        setup_sections = _clean_sections(setup.get("sections"), n_sections)
        if not setup_sections:
            # spread unset setups evenly rather than dumping everything in section 1
            setup_sections = [1 + (si % n_sections)]
        chars = setup.get("characters") if isinstance(setup.get("characters"), list) else []
        chars = [c for c in chars if isinstance(c, str) and (not names or c in names)]
        continuity = str(setup.get("continuity") or "").strip()
        setup_out = {
            "id": setup_id,
            "name": str(setup.get("name") or f"Setup {si + 1}")[:80],
            "location": str(setup.get("location") or "")[:200],
            "timeOfDay": str(setup.get("time_of_day") or "")[:120],
            "characters": chars,
            "continuity": continuity,
            "sections": setup_sections,
            "sectionLabels": [sections[i - 1].get("label", "") for i in setup_sections],
            "shotIds": [],
        }
        for shi, sh in enumerate(shots):
            if not isinstance(sh, dict):
                continue
            try:
                seconds = float(sh.get("seconds", max_seconds))
            except (TypeError, ValueError):
                seconds = max_seconds
            frames = seconds_to_frames(min(max(seconds, 1.0), max_seconds))
            energy_raw = sh.get("energy", "")
            avg_energy = sum(sections[i - 1].get("energy", 0.5) for i in setup_sections) / len(setup_sections)
            energy_v = _ENERGY_WORDS.get(str(energy_raw).lower(), avg_energy)
            size = str(sh.get("size") or "").strip().lower()
            if size not in SHOT_SIZES:
                size = SHOT_SIZES[shi % len(SHOT_SIZES)]
            still = _fix_repetition_cues(_fix_plural_framing(str(sh.get("still_prompt") or "").strip()))
            if continuity and continuity.lower()[:20] not in still.lower():
                still = f"{still} {continuity}".strip() if still else continuity
            for name in chars:
                desc = appearances.get(name, "")
                # deterministic safety net: each still is generated independently with
                # no memory of other shots, so a character's hair/face/build only stays
                # consistent if their cast description is restated every time — the LLM
                # writes it into the first shot it appears in and often drops it after
                # (confirmed live: a character's long hair rendered short in later shots
                # of the same setup once the model stopped repeating the description)
                if desc and desc.lower()[:20] not in still.lower():
                    still = f"{still} {name}: {desc}.".strip()
            if len(chars) >= 2 and not re.search(r"\b(on the left|on the right|in the middle|far left|far right)\b", still, re.I):
                # deterministic safety net: face-swap pastes each reference face by
                # left-to-right screen position in this same character order, so an
                # LLM that forgot the blocking instruction would silently mix up
                # whose face lands on whom — state it explicitly ourselves
                still = f"{still} ({_position_blocking(chars, genders)}, left to right)."
            if chars:
                # second safety net: face-swap needs a clean, detectable face for
                # every named character, so unconditionally restate that they're
                # visible — appended last, it reads as the final word over any
                # "obscured by smoke/fog" language the model wrote earlier
                face_clause = (
                    f"{chars[0]}'s face is" if len(chars) == 1 else "Their faces are"
                ) + " fully visible, unobscured, and in sharp focus — no smoke, fog, hair, hand, or shadow crosses it."
                still = f"{still} {face_clause}".strip()
            shot_id = _uid("shot")
            setup_out["shotIds"].append(shot_id)
            out_scenes.append({
                "id": shot_id,
                "title": f"{setup_out['name']} — {size}"[:80],
                "setupId": setup_id,
                "setupName": setup_out["name"],
                "shotSize": size,
                "sections": setup_sections,
                "section": setup_sections[0],  # first section, for older single-value display
                "sectionLabel": setup_out["sectionLabels"][0] if setup_out["sectionLabels"] else "",
                "location": setup_out["location"],
                "timeOfDay": setup_out["timeOfDay"],
                "characters": chars,
                "continuity": continuity,
                "stillPrompt": still,
                "motionPrompt": str(sh.get("motion_prompt") or "").strip(),
                "dialogue": str(sh.get("dialogue") or "").strip(),
                "soundscape": str(sh.get("soundscape") or "").strip(),
                "frames": frames,
                "seconds": round(frames / FPS, 2),
                "energy": round(float(energy_v), 2),
            })
        if setup_out["shotIds"]:
            out_setups.append(setup_out)

    if not out_scenes:
        raise ValueError("the model returned no usable shots")
    return {
        "title": str(data.get("title") or "Untitled")[:120],
        "style": str(data.get("style") or "").strip(),
        "model": data.get("model", ""),
        "setups": out_setups,
        "scenes": out_scenes,
    }


# ------------------------------------------------------------------ fallback

_LOCATIONS = [
    ("neon-lit downtown street", "night, wet asphalt reflecting signs"),
    ("empty rooftop above the city", "blue hour, city lights waking up"),
    ("sunlit desert highway", "golden hour, long shadows"),
    ("abandoned warehouse with tall windows", "shafts of afternoon light and dust"),
    ("dense pine forest", "morning fog, soft diffused light"),
    ("underground club with strobe lights", "night, hard flashing light"),
    ("diner booth by the window", "late night, warm tungsten"),
    ("beach at dusk", "pink sky, wind"),
    ("subway platform", "fluorescent light, motion blur of passing train"),
    ("small apartment kitchen", "morning light through blinds"),
    ("parking garage rooftop", "overcast daylight, concrete and sky"),
    ("motel room with neon sign glow through curtains", "night, magenta and cyan light"),
]
_MOVES = ["slow push-in", "handheld tracking shot", "slow orbit", "static tripod, subject moves", "whip pan into frame",
          "slow dolly out", "low-angle glide", "profile tracking, subject walks"]
_PERF = ["sings the line directly to camera", "looks away then turns to camera", "walks toward camera",
         "dances loosely, half-smile", "stands still while the world moves around them", "closes their eyes, breathes",
         "runs past camera", "leans on a wall, mouths the lyric"]
_SHOT_LANG = {
    "wide": "wide establishing shot", "medium": "medium shot", "close-up": "close-up",
    "insert": "insert shot of a small detail", "over-the-shoulder": "over-the-shoulder shot", "pov": "point-of-view shot",
}


def template_script(analysis: dict, cast: list[dict], concept: str, style: str,
                    n_scenes: int, max_seconds: float, seed: int | None = None) -> dict:
    """No-LLM shot list, built with the same setup/coverage/cross-cutting
    structure as the real director: a handful of setups, each with 2–3 shots
    of varying size, each setup assigned to 2+ sections so it recurs across
    the song — not clever writing, but the same production shape."""
    rnd = random.Random(seed if seed is not None else 7)
    style = _fix_repetition_cues(style)
    sections = analysis.get("sections", []) or [{"start": 0, "end": analysis.get("duration", 60), "energy": 0.5, "label": "song"}]
    n_sections = len(sections)
    names = [c.get("name", "") for c in cast if c.get("name")] or ["the performer"]
    frames = seconds_to_frames(max_seconds)
    n_setups = max(3, min(len(_LOCATIONS), round(n_scenes / 3)))
    locs = _LOCATIONS[:]
    rnd.shuffle(locs)

    raw_setups = []
    for si in range(n_setups):
        loc, light = locs[si % len(locs)]
        who = names[si % len(names)]
        # each setup recurs in 2 sections (spaced apart) when the song has enough, else 1
        start_sec = 1 + (si % n_sections)
        recur_sec = 1 + ((si + max(1, n_sections // 2)) % n_sections)
        setup_secs = sorted(set([start_sec] if n_sections < 2 else [start_sec, recur_sec]))
        avg_e = sum(sections[i - 1].get("energy", 0.5) for i in setup_secs) / len(setup_secs)
        continuity = f"{who} in {'wardrobe matching the mood' if who != 'the performer' else 'consistent styling'}, {loc}, {light}, same framing style throughout"
        n_shots = 2 if avg_e < 0.6 else 3
        shot_sizes = rnd.sample(SHOT_SIZES[:4], k=min(n_shots, 4))
        shots = []
        for size in shot_sizes:
            # NOT the full concept text — the template writer can't parse a rich,
            # multi-room concept into separate setups the way the real LLM
            # director does, so pasting it whole into every single shot just
            # describes several different rooms in one image (Krea 2 then
            # renders a collage/contact-sheet instead of one clean scene).
            still = (f"{_SHOT_LANG[size]} of {who} in a {loc}, {light}, "
                     f"{style.strip() or 'cinematic, filmic colour grade, shallow depth of field'}, 35mm, highly detailed, {continuity}")
            motion = f"{rnd.choice(_MOVES)}; {who} {rnd.choice(_PERF)}; {light}; subtle natural motion in the background."
            shots.append({
                "size": size, "still_prompt": still, "motion_prompt": motion, "dialogue": "",
                "soundscape": "quiet ambience matching the location, light foley, no music",
                "seconds": round(frames / FPS, 2), "energy": round(avg_e, 2),
            })
        raw_setups.append({
            "name": f"{loc.split(',')[0].title()}", "location": loc, "time_of_day": light,
            "characters": [who] if who != "the performer" else [],
            "continuity": continuity, "sections": setup_secs, "shots": shots,
        })
    data = {"title": (concept.strip()[:60] or "Untitled"), "style": style.strip(), "model": "template", "setups": raw_setups}
    return normalize_script(data, analysis, cast, n_scenes, max_seconds)


# ------------------------------------------------------------------ H3 prompt for a scene

LOCK_STILL = ("Use the provided image as the exact starting frame and keep its character design, wardrobe, "
              "location, composition and lighting.")


def scene_h3_prompt(scene: dict, cast_names: list[str] | None = None) -> str:
    """Compose the H3 prompt for a music-video scene: motion + dialogue as the
    description, its soundscape, and no non-diegetic music (the real track
    is laid over the edit)."""
    desc = scene.get("motionPrompt", "").strip()
    chars = scene.get("characters") or cast_names or []
    who = ", ".join(chars) or "the subject"
    if scene.get("dialogue", "").strip():
        # only the first-listed character sings/speaks the line — a shot can
        # feature a second character (in frame, reacting) without them also
        # lip-syncing words that are really only one performer's part
        speaker = chars[0] if chars else who
        line = scene["dialogue"].strip().strip('"')
        desc += f'\n\n{speaker} says clearly and naturally: "{line}"'
    desc = LOCK_STILL + "\n\n" + desc
    return compose_h3_prompt(desc, scene.get("soundscape", ""), "No music.")
