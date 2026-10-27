"""Story Room: an in-app writing partner (producer + screenwriter) for short vertical videos.

  GET    /api/storyroom/status        which engines are usable (local Ollama / Claude)
  POST   /api/storyroom/key           save an Anthropic API key (stored only in backend/settings.local.json, never sent back)
  DELETE /api/storyroom/key           forget it
  POST   /api/storyroom/chat          one turn of the conversation -> the assistant's reply
  POST   /api/storyroom/script        the whole conversation -> a finished shot list in the studio's paste format

Engines: "local" (Ollama, free and private, a small model) or "claude" (Anthropic API with the user's own key; only the story chat is sent).
"""
import asyncio
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

import httpx
from fastapi import Body, HTTPException

import claude_cli
import director
import genres

SETTINGS = Path(__file__).resolve().parent / "settings.local.json"
CLAUDE_MODELS = {"sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5"}

FORMAT_SPEC = """Write the shot list in EXACTLY this format (markdown), nothing before or after it:

# <Title of the video>

> **[COLOR GRADE]**
> Color grade: <one line about colour/mood>

## SHOT 1 — <Short Title> (0:00–0:04)

**[STILL]** <ONE frozen moment, one composition, singular opening like "A close-up of..." / "A wide shot of...". Describe who, where, light, what is VISIBLE, including any unsettling detail and exactly where it is in the frame (background, edge, half hidden). No camera-movement words here.>

**[MOTION]** <What moves and what the camera does during these seconds. Present tense. Starts from the still.>

**[CHARACTERS]** <comma-separated names, or leave out if nobody is on screen>

**[DIALOGUE]** <only the spoken words of one short line, in quotes, with NO speaker name before it; or leave this tag out>

**[SFX]** <the sounds of this shot: diegetic only, no music>

**[BEAT]** <hook | build | payoff | cta>

(repeat for every shot)"""


def _settings() -> dict:
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(d: dict) -> None:
    SETTINGS.write_text(json.dumps(d), encoding="utf-8")


def _producer_system(gid: str, scare: str, seconds: int) -> str:
    g = genres.get(gid)
    return (
        "You are an award-winning horror producer and screenwriter, co-writing a short vertical video with the user inside their AI video studio. "
        f"The genre is: {g['label']} ({g['blurb']}).\n\n"
        "HOW TO BEHAVE: you are a collaborator, not a lecturer. Replies are short (under ~130 words) unless asked for more. Ask at most ONE question at a time. When the user is stuck, offer 2-3 concrete, "
        "numbered options. When they give an idea, build on it: sharpen the hook, name the rule of the haunting, the escalation, the one image people will remember, and the last frame. "
        "Give practical scare craft as you go (what to show and what to withhold, silence before a hit, where the threat sits in the frame, why a detail is creepy).\n\n"
        "WHAT THE STUDIO CAN MAKE (stay inside this): a video of about "
        f"{seconds} seconds made of clips of 3-5 seconds, so roughly {max(4, round(seconds / 4.2))} shots; each shot is ONE frozen picture then a few seconds of movement; 1-2 characters at most; "
        "locations a photo-realistic image model can draw; the threat is glimpsed, partly hidden, never a clear monster close-up; sound is diegetic only. "
        "Spoken lines are short and real. No gore needed; dread and implication work better.\n\n"
        "When the story feels ready (premise, the rule of the haunting, escalation, ending), say so in one line and tell the user to press the 'Write the shot list' button."
        + genres.rules_for(gid, scare)
    )


def _script_system(gid: str, scare: str, seconds: int) -> str:
    g = genres.get(gid)
    n = max(4, round(seconds / 4.2))
    return (
        "You are a screenwriter turning a story conversation into a shot list for an AI video studio. "
        f"Genre: {g['label']}. Target length about {seconds} seconds = {n} shots of 3-5 seconds (use the 0:00-style time ranges to sum to about {seconds}).\n"
        "RULES: every [STILL] is one single frozen moment (a model draws it; it only draws what you name). From shot 2 on, every [STILL] must show something specific and unsettling that is VISIBLE "
        "(a figure far behind, a face in a window, a door ajar), and it must be stronger or closer than in the previous shot, never fully lit. The final shot ends abruptly. "
        "Never use cinematic vocabulary (bokeh, anamorphic, cinematic lighting, color grade inside a STILL). Do not describe the camera brand or lens in [STILL]; the studio adds the camcorder look. "
        "Dialogue is short, real, breathless. SFX are diegetic only. Keep character names consistent and mention their look the first time. "
        "Make it genuinely scary and tell a story that makes sense from first shot to last: set-up, the rule, escalation, the turn, the ending.\n\n"
        + FORMAT_SPEC + genres.rules_for(gid, scare)
    )


async def _claude(system: str, messages: list[dict], key: str, model: str, max_tokens: int, temperature: float = 0.9) -> str:
    async with httpx.AsyncClient(timeout=240, trust_env=False) as c:
        r = await c.post("https://api.anthropic.com/v1/messages",
                         headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                         json={"model": model, "max_tokens": max_tokens, "temperature": temperature, "system": system, "messages": messages})
    if r.status_code == 401:
        raise HTTPException(401, "Claude rejected the API key. Check it in the Story Room settings.")
    if r.status_code != 200:
        raise HTTPException(502, f"Claude error {r.status_code}: {r.text[:200]}")
    return "".join(b.get("text", "") for b in r.json().get("content", []))


async def _claude_code(system: str, messages: list[dict], max_tokens: int, mode: str = "chat") -> str:
    """Ask the user's own Claude Code (headless `claude -p`), which runs on their Claude subscription. No API key; no tools; an empty working folder."""
    exe = claude_cli.find_exe()
    if not exe:
        raise HTTPException(503, "Claude Code isn't installed on this computer. Open Settings > Claude to set it up.")
    if not (await asyncio.to_thread(claude_cli.status)).get("ready"):
        raise HTTPException(401, "Claude isn't connected yet. Open Settings > Claude and sign in, then try again.")
    if mode == "chat":
        convo = "\n".join(f"{'USER' if x['role'] == 'user' else 'PRODUCER'}: {x['content']}" for x in messages)
        prompt = f"Conversation so far:\n\n{convo}\n\nWrite the PRODUCER's next reply only (no 'PRODUCER:' prefix)."
    else:
        prompt = messages[-1]["content"]
    alias = _settings().get("claude_model", "sonnet")
    cwd = Path(tempfile.gettempdir()) / "hoodsfield_claude_empty"
    cwd.mkdir(exist_ok=True)
    env = claude_cli.run_env()      # the signed-in account (or the key chosen in Settings), never a stray key
    proc = await asyncio.create_subprocess_exec(
        exe, "-p", "--tools", "", "--no-session-persistence", "--output-format", "text", "--system-prompt", system, "--model", alias,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=str(cwd), env=env,
        creationflags=getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0))
    try:
        out, err = await asyncio.wait_for(proc.communicate(prompt.encode("utf-8")), timeout=600)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(504, "Claude Code took too long to answer.")
    text = out.decode("utf-8", "replace").strip()
    if proc.returncode != 0 or not text:
        msg = (err.decode("utf-8", "replace") or text)[:300]
        if re.search(r"log ?in|auth|credential", msg, re.I):
            raise HTTPException(401, "Claude Code isn't signed in. Open a terminal, run `claude`, and log in with your Claude account, then try again.")
        raise HTTPException(502, f"Claude Code error: {msg or 'no output'}")
    return text


async def _local(system: str, messages: list[dict], max_tokens: int, temperature: float = 0.9) -> tuple[str, str]:
    async with httpx.AsyncClient(timeout=600, trust_env=False) as c:
        models = await director.ollama_models(c)
        model = director.pick_text_model(models)
        if not model:
            raise HTTPException(503, "The local AI (Ollama) isn't running or has no model. Start Ollama, or use Claude.")
        body = {"model": model, "stream": False, "think": False, "messages": [{"role": "system", "content": system}, *messages],
                "options": {"temperature": temperature, "num_ctx": 8192, "num_predict": max_tokens}}
        r = await c.post(f"{director.OLLAMA_URL}/api/chat", json=body)
        if r.status_code != 200:
            body.pop("think", None)
            r = await c.post(f"{director.OLLAMA_URL}/api/chat", json=body)
        if r.status_code != 200:
            raise HTTPException(502, f"Ollama error {r.status_code}")
        return r.json().get("message", {}).get("content", ""), model


def register(app, m):
    @app.get("/api/storyroom/status")
    async def status():
        s = _settings()
        key = s.get("anthropic_key", "")
        local_ok, local_model = False, ""
        try:
            async with httpx.AsyncClient(timeout=4, trust_env=False) as c:
                models = await director.ollama_models(c)
                local_model = director.pick_text_model(models)
                local_ok = bool(local_model)
        except Exception:
            pass
        return {"local": {"ok": local_ok, "model": local_model}, "claude_code": {"available": bool((await asyncio.to_thread(claude_cli.status)).get("ready")), "installed": bool(claude_cli.find_exe()), "message": (await asyncio.to_thread(claude_cli.status)).get("message", ""), "choice": s.get("claude_model", "sonnet")},
                "claude": {"configured": bool(key), "last4": key[-4:] if key else "", "model": CLAUDE_MODELS.get(s.get("claude_model", "sonnet"), CLAUDE_MODELS["sonnet"]), "choice": s.get("claude_model", "sonnet")}}

    @app.post("/api/storyroom/key")
    async def set_key(body: dict = Body(...)):
        key = str(body.get("key") or "").strip()
        if not re.fullmatch(r"sk-ant-[A-Za-z0-9_\-]{20,}", key):
            raise HTTPException(400, "That doesn't look like an Anthropic API key (it starts with sk-ant-).")
        s = _settings(); s["anthropic_key"] = key
        if body.get("model") in CLAUDE_MODELS:
            s["claude_model"] = body["model"]
        _save(s)
        return {"ok": True, "last4": key[-4:]}

    @app.post("/api/storyroom/model")
    async def set_model(body: dict = Body(...)):
        s = _settings()
        if body.get("model") in CLAUDE_MODELS:
            s["claude_model"] = body["model"]
            _save(s)
        return {"ok": True}

    @app.delete("/api/storyroom/key")
    async def forget_key():
        s = _settings(); s.pop("anthropic_key", None); _save(s)
        return {"ok": True}

    async def _run(engine: str, system: str, messages: list[dict], max_tokens: int, temperature: float, mode: str = "chat") -> dict:
        if engine == "claude_code":
            return {"text": await _claude_code(system, messages, max_tokens, mode), "engine": "claude_code", "model": _settings().get("claude_model", "sonnet")}
        if engine == "claude":
            s = _settings()
            if not s.get("anthropic_key"):
                raise HTTPException(400, "Add your Anthropic API key first (Story Room settings).")
            model = CLAUDE_MODELS.get(s.get("claude_model", "sonnet"), CLAUDE_MODELS["sonnet"])
            return {"text": await _claude(system, messages, s["anthropic_key"], model, max_tokens, temperature), "engine": "claude", "model": model}
        text, model = await _local(system, messages, max_tokens, temperature)
        return {"text": text, "engine": "local", "model": model}

    def _clean(msgs) -> list[dict]:
        out = []
        for x in msgs or []:
            role = "assistant" if x.get("role") == "assistant" else "user"
            c = str(x.get("content") or "").strip()
            if c:
                out.append({"role": role, "content": c[:6000]})
        # the API wants the conversation to start with the user
        while out and out[0]["role"] != "user":
            out.pop(0)
        return out

    @app.post("/api/storyroom/chat")
    async def chat(body: dict = Body(...)):
        msgs = _clean(body.get("messages"))
        if not msgs or msgs[-1]["role"] != "user":
            raise HTTPException(400, "Say something first.")
        gid = str(body.get("genre") or "found_footage")
        seconds = int(body.get("seconds") or 30)
        return await _run(str(body.get("engine") or "local"), _producer_system(gid, str(body.get("scare") or "creepy"), seconds), msgs, 700, 0.95)

    @app.post("/api/storyroom/script")
    async def script(body: dict = Body(...)):
        msgs = _clean(body.get("messages"))
        idea = str(body.get("concept") or "").strip()
        gid = str(body.get("genre") or "found_footage")
        seconds = int(body.get("seconds") or 30)
        convo = "\n".join(f"{'USER' if x['role'] == 'user' else 'PRODUCER'}: {x['content']}" for x in msgs)
        ask = ("Here is the story conversation so far:\n\n" + (convo or f"USER: {idea}") + "\n\n"
               f"Now write the full shot list ({seconds} seconds) as the final script, in the exact format. Use the best story we developed; where something is unresolved, decide it yourself and make it good. "
               "Output ONLY the script.")
        r = await _run(str(body.get("engine") or "local"), _script_system(gid, str(body.get("scare") or "creepy"), seconds), [{"role": "user", "content": ask}], 4000, 0.8, "script")
        t = r["text"].strip()
        t = re.sub(r"^```(?:markdown|md)?\s*|\s*```$", "", t, flags=re.S)
        if not re.search(r"^##\s*SHOT\s+\d+", t, re.M):
            raise HTTPException(502, "The writer didn't return a shot list in the expected format. Try again.")
        r["text"] = t
        return r
