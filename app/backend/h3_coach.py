"""H3 prompt coach — applies the `minimax-h3-prompting` skill to every MiniMax H3 request.

H3 renders picture and sound in one pass, so the prompt works best as a short production brief:
timed beats, one camera move, a physics line for anything that falls or crashes, layered audio and
an explicit constraints list.  `coach()` takes whatever the user typed (a plain sentence, a
storyboard line, a half-finished brief) and returns a `description` / `soundscape` pair ready for
`h3.compose_h3_prompt`.  Two layers:

  1. rules   — deterministic, instant, never changes the user's meaning: adds the missing camera,
               physics, audio and constraint lines.
  2. rewrite — OPT-IN local-LLM pass (Ollama, CPU only so it never competes with ComfyUI for
               VRAM) that turns a short sentence into concrete visual beats.  Skipped for long or
               already-structured prompts, and silently falls back to the rules on any problem.

Disable everything with H3_COACH=0; turn the (experimental) rewrite on with H3_COACH_LLM=1.
"""

from __future__ import annotations

import json
import os
import re

import httpx

ENABLED = os.getenv("H3_COACH", "1") != "0"
LLM_ENABLED = os.getenv("H3_COACH_LLM", "0") == "1"      # opt-in: a 7B local model tends to invent details
LLM_MAX_INPUT = 420          # characters; longer prompts are assumed to be written deliberately
LLM_TIMEOUT = float(os.getenv("H3_COACH_TIMEOUT", "75"))

CAMERA_RE = re.compile(r"\b(camera|dolly|pan|tilt|track(?:s|ing)?|push|pull|handheld|crane|zoom|locked[- ]off|static shot|whip|orbit|rack focus|pov|point of view|drone|steadicam)\b", re.I)
MOTION_RE = re.compile(r"\b(fall|falls|falling|drop|drops|crash|crashes|collapse|explod|explosion|jump|jumps|launch|launches|fly|flies|flying|throw|thrown|spill|splash|wave|tsunami|debris|rubble|shatter|smash|tumble|plummet|slide|slides|skid|burst|topple|avalanche|rain|waterfall)\w*", re.I)
PHYSICS_RE = re.compile(r"\b(gravity|momentum|inertia|physics)\b", re.I)
CONSTRAINT_RE = re.compile(r"\b(constraints?|no subtitles|no watermark|do not add|don't add)\b", re.I)
AUDIO_WORDS_RE = re.compile(r"\b(sound|roar|rumble|wind|engine|voice|dialogue|ambience|ambient|music|sfx|hum|whoosh|crash(?:ing)? sound)\b", re.I)
STRUCTURED_RE = re.compile(r"integrated_multimodal_description|overall_soundscape|\[Shot \d+", re.I)
TEXT_REQUEST_RE = re.compile(r"(title|caption|subtitle|logo|text reads|on-screen text|\"[^\"]{2,}\")", re.I)

CONTINUE_RE = re.compile(r"\b(continue[sd]? (?:directly )?from|starts? (?:from|with) the (?:first )?frame|from the (?:first|starting) frame)\b", re.I)
CONTINUE_LINE = "Start: the first beat continues directly from the position, pose and distance shown in the first frame; do not rewind, restart or replay earlier action."
PHYSICS_LINE = ("Physics: realistic gravity, inertia and momentum; loose objects fall and accelerate naturally, "
                "nothing floats or hovers; natural motion blur on fast movement.")
CAMERA_LINE = "Camera: one continuous take with a single smooth, motivated camera movement that follows the action; no cuts."
CONSTRAINTS = ("Constraints: no on-screen text, subtitles or watermark; no morphing, warping or melting of objects; "
               "no extra or duplicated people or limbs; hands and faces stay natural; no unrequested hard cuts or scene changes.")
CONSTRAINTS_WITH_TEXT = ("Constraints: spell any requested text exactly as written and add no other text, subtitles or watermark; "
                         "no morphing, warping or melting of objects; no extra or duplicated people or limbs; hands and faces stay natural; "
                         "no unrequested hard cuts or scene changes.")
DEFAULT_SOUND = ("Layered natural ambience with physical sound effects matched to each action in time order; "
                 "no voice-over and no dialogue unless requested.")

SYSTEM = """You rewrite short video ideas into precise shot descriptions for the MiniMax H3 video model.
Rules:
- Keep EVERY fact the user gave (subject, place, action, objects, camera words). Never add new characters, text, or story.
- Replace vague words (cinematic, epic, beautiful, dynamic, amazing) with concrete visible detail: materials, lighting direction, weather, scale cues, motion blur, spray, dust, debris.
- Describe motion as a trajectory: starting state, movement, ending state, with speed. Keep ONE primary action and ONE camera move.
- If the clip is 6 seconds or longer and has several beats, put them in order as [0s-3s], [3s-6s] ... slices that fit the length.
- Foreground particles that physically belong in the scene (dirt, water drops, embers, dust) may be requested inside the shot.
- Do NOT write audio, music, constraints or camera boilerplate: those are added separately. Camera movement belongs in the description only if the user implied one.
- Do NOT invent events: no extra flips, spins, explosions, rescues, people or story beats beyond what the idea implies. Add detail to what is there, not new action.
- Output 2-5 sentences of plain prose, no lists of adjectives, no markdown, no bracketed timecodes.
Return JSON only: {"description": "..."}"""


def is_structured(text: str) -> bool:
    return bool(STRUCTURED_RE.search(text or ""))


def rules(description: str, soundscape: str = "", music: str = "", *, seconds: float = 5.0, has_image: bool = False) -> tuple[str, str, list[str]]:
    """Deterministic pass. Returns (description, soundscape, notes)."""
    d = (description or "").strip()
    s = (soundscape or "").strip()
    notes: list[str] = []
    if d and not d.endswith((".", "!", "?", '"', ")")):
        d += "."
    if d and not CAMERA_RE.search(d):
        d += "\n" + CAMERA_LINE; notes.append("added a camera line")
    if d and has_image and not CONTINUE_RE.search(d):
        d += "\n" + CONTINUE_LINE; notes.append("anchored the first beat to the still")
    if d and MOTION_RE.search(d) and not PHYSICS_RE.search(d):
        d += "\n" + PHYSICS_LINE; notes.append("added a physics line")
    if d and not CONSTRAINT_RE.search(d):
        d += "\n" + (CONSTRAINTS_WITH_TEXT if TEXT_REQUEST_RE.search(d) else CONSTRAINTS); notes.append("added constraints")
    if not s:
        s = DEFAULT_SOUND; notes.append("added a soundscape")
    elif not AUDIO_WORDS_RE.search(s):
        s = s + " Layered ambience and effects matched to the action."
    return d, s, notes


async def _pick_model(client: httpx.AsyncClient, url: str) -> str:
    try:
        r = await client.get(f"{url}/api/tags", timeout=4)
        models = [m["name"] for m in r.json().get("models", [])]
    except Exception:
        return ""
    for pref in ("qwen2.5", "qwen3", "llama3", "mistral", "gemma"):
        for m in models:
            if pref in m.lower() and "vl" not in m.lower() and "embed" not in m.lower():
                return m
    return ""


async def _rewrite(description: str, seconds: float, has_image: bool, lock_still: bool) -> str | None:
    url = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
    try:
        async with httpx.AsyncClient(trust_env=False) as client:
            model = await _pick_model(client, url)
            if not model:
                return None
            user = json.dumps({
                "clip_seconds": round(seconds, 1),
                "mode": "image-to-video: the supplied image is the exact first frame, so describe only what MOVES and changes; do not re-describe the look of the frame" if has_image else "text-to-video: describe the full scene",
                "idea": description,
            })
            req = {"model": model, "stream": False, "format": "json", "keep_alive": 0,
                   "options": {"temperature": 0.3, "num_gpu": 0, "num_predict": 420},
                   "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]}
            r = await client.post(f"{url}/api/chat", json=req, timeout=LLM_TIMEOUT)
            out = json.loads(r.json()["message"]["content"]).get("description", "").strip()
    except Exception:
        return None
    out = re.sub(r"\[[0-9s.\- ]+\][}.]*", "", out).replace("}", "").replace("{", "").strip()
    if not out or len(out) < len(description) * 0.6 or len(out) > 1500:
        return None
    # the rewrite must keep the idea: most of the user's meaningful words (by 5-letter stem) have to survive
    words = {w[:5] for w in re.findall(r"[a-z]{5,}", description.lower())}
    if words and sum(1 for w in words if w in out.lower()) < max(1, int(len(words) * 0.5)):
        return None
    return out


async def coach(description: str, soundscape: str = "", music: str = "No music.", *, seconds: float = 5.0,
                has_image: bool = False, lock_still: bool = False, use_llm: bool | None = None) -> dict:
    """Returns {description, soundscape, music, notes, changed}. Never raises."""
    original = (description or "").strip()
    if not ENABLED or not original or is_structured(original):
        return {"description": original, "soundscape": soundscape, "music": music, "notes": [], "changed": False}
    notes: list[str] = []
    d = original
    want_llm = LLM_ENABLED if use_llm is None else use_llm
    if want_llm and len(original) <= LLM_MAX_INPUT and "\n" not in original and "|" not in original:
        rewritten = await _rewrite(original, seconds, has_image, lock_still)
        if rewritten:
            d = rewritten; notes.append("expanded the idea into concrete visual beats")
    d, s, rule_notes = rules(d, soundscape, music, seconds=seconds, has_image=has_image)
    notes += rule_notes
    return {"description": d, "soundscape": s, "music": music or "No music.", "notes": notes, "changed": d != original or s != (soundscape or "")}
