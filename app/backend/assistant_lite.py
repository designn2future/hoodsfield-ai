"""
Hoodsfield Assistant, LITE mode: the same project flow (script, stills, clips, cut, four approvals, live board) but driven
by a fixed pipeline in this file, with a local Ollama model (default qwen2.5:14b-instruct) used only for small, structured
steps: writing the shot plan and reading the user's change notes. Everything else (stills, clips, cut, checks) is done by the
same studio tools the Claude mode uses (assistant_mcp.py), plus simple automatic checks (a face detector, the clip glitch tail).

Needs no Claude account. Quality is lower than Claude mode: the plan is more generic and no model looks at the pictures,
the user's picks do that. Env: the same as assistant_mcp.py plus LITE_BRIEF (json file), LITE_MODEL, OLLAMA_URL.
"""
import json
import os
import random
import re
import sys
import time
from pathlib import Path

import httpx

import assistant_mcp as m

OLLAMA = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.getenv("LITE_MODEL", "qwen2.5:14b-instruct")
COMFY = os.getenv("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
LOOKS = {"babycam", "trailcam", "doorbellcam", "ugc", "tiktok"}

SYSTEM = """You write shot plans for very short vertical found-footage horror/paranormal/UFO videos that must look like real phone or security-camera clips.
Rules you must follow:
- Escalation: each shot is a little more wrong than the one before; the last two shots are the payoff. Never a calm ending.
- The camera is a fixed, locked-off camera unless the idea says otherwise. No one walks toward the lens. No phones in shot.
- A shot's "still" describes ONE frozen moment: what is visible and where in the frame (plain, concrete, no story). A shot's "motion" describes the tiny movement during 3-4 seconds and what is heard.
- Faces: only show a face for the main character (has_character true). Everyone else is turned away, far off, out of focus, or in shadow.
- Captions are 2-6 words, lowercase, ominous, optional (empty string is fine).
- If the idea contains a spoken line, put it in the "sound" of the shot where it is said, with the voice described.
Answer ONLY with JSON."""

PLAN_SCHEMA = {"type": "object", "required": ["title", "setting", "shots"], "properties": {
    "title": {"type": "string"}, "setting": {"type": "string"}, "look": {"type": "string"},
    "shots": {"type": "array", "items": {"type": "object", "required": ["n", "title", "still", "motion"], "properties": {
        "n": {"type": "integer"}, "title": {"type": "string"}, "still": {"type": "string"}, "motion": {"type": "string"},
        "sound": {"type": "string"}, "caption": {"type": "string"}, "has_character": {"type": "boolean"}}}}}}


def say(text, media=None):
    m._post_event("say", text, media)


def llm(system, user, schema=None, temperature=0.7):
    """One call to the local model. The GPU is cleared first (ComfyUI holds it) and the model is unloaded right after."""
    try:
        httpx.post(f"{COMFY}/free", json={"unload_models": True, "free_memory": True}, timeout=20, trust_env=False)
    except Exception:
        pass
    body = {"model": MODEL, "stream": False, "keep_alive": 0, "options": {"temperature": temperature, "num_ctx": 8192},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if schema:
        body["format"] = schema
    with httpx.Client(timeout=900, trust_env=False) as c:
        r = c.post(f"{OLLAMA}/api/chat", json=body)
        if r.status_code != 200:
            raise RuntimeError(f"Ollama said {r.status_code}: {r.text[:300]}")
        txt = r.json()["message"]["content"]
    return json.loads(txt) if schema else txt


def ask(title, message, media=None, options=None, picks=None, suggestions=None):
    out = m.t_ask_user({"title": title, "message": message, "media": media or [], "options": options or ["Approve", "Change something"],
                        "picks": picks or [], "suggestions": suggestions or []})[0]["text"]
    choice = re.search(r"USER ANSWERED: (.*)", out).group(1).strip()
    note = (out.split("NOTE:", 1)[1].strip() if "NOTE:" in out else "")
    return choice, note


def make_plan(brief, note="", prev=None):
    n = max(3, round(int(brief["seconds"]) / 3.5))
    refs = [r for r in brief.get("refs", []) if r["role"] == "character"]
    user = (f"Idea: {brief['idea']}\nExtra notes: {brief.get('notes') or 'none'}\nWrite exactly {n} shots (n = 1..{n}), about {brief['seconds']} seconds total.\n"
            + (f"There is a main character with a reference photo: {', '.join(r.get('label') or r['name'] for r in refs)}. Use has_character true in the shots where they are seen.\n" if refs else "")
            + (f"\nPrevious plan:\n{json.dumps(prev)[:3500]}\n\nThe user wants this changed: {note}\nReturn the full corrected plan.\n" if prev and note else ""))
    plan = llm(SYSTEM, user, PLAN_SCHEMA)
    shots = plan.get("shots") or []
    if len(shots) < 2:
        raise RuntimeError("The local model returned an unusable plan. Try again or use the Claude mode.")
    for i, s in enumerate(shots, 1):
        s["n"] = i
        if not (s.get("title") or "").strip():
            s["title"] = " ".join((s.get("still") or f"Shot {i}").replace(",", " ").split()[:4])
        s.setdefault("sound", "")
        s.setdefault("caption", "")
    plan["shots"] = shots[:12]
    return plan


def shot_text(plan, s):
    return f"{s['n']}. {s['title']}\n   Picture: {s['still']}\n   Movement: {s['motion']}" + (f"\n   Sound: {s['sound']}" if s.get("sound") else "") + (f"\n   Caption: {s['caption']}" if s.get("caption") else "")


def style_prefix(plan):
    return f"Found footage still frame, dim and grainy, realistic photograph, locked-off camera, {plan.get('setting', '')}. "


def still_prompt(plan, s, variant=""):
    char = " The man is the person in image 1: keep his face, hair, glasses and clothes identical to image 1." if s.get("has_character") and CHAR_REFS else ""
    return style_prefix(plan) + variant + s["still"].strip() + char


def faces_in(path) -> int:
    """Faces of a useful size in the picture (OpenCV's YuNet detector; OpenCV 5 no longer has the old Haar one)."""
    import cv2
    model = Path(__file__).resolve().parent / "face_models" / "face_detection_yunet_2023mar.onnx"
    im = cv2.imread(str(path))
    if im is None or not model.is_file() or not hasattr(cv2, "FaceDetectorYN"):      # no detector available: skip the check rather than stop the run
        return 0
    h, w = im.shape[:2]
    det = cv2.FaceDetectorYN.create(str(model), "", (w, h), 0.75, 0.3, 50)
    _, faces = det.detect(im)
    if faces is None:
        return 0
    return sum(1 for f in faces if f[2] >= max(36, w // 18))      # ignore specks: a face narrower than ~1/18 of the frame is background





def parse_path(res):
    return Path(res[0]["text"].split("  (seed")[0].split("\n")[0].strip())


def ensure_comfy():
    """Fail fast with a clear message instead of waiting forever for an image engine that has stopped answering."""
    for _ in range(3):
        try:
            if httpx.get(f"{COMFY}/system_stats", timeout=10, trust_env=False).status_code == 200:
                return
        except Exception:
            time.sleep(3)
    raise RuntimeError("ComfyUI (the image engine) is not responding. Restart it (Start_Hoodsfield.bat) and use 'Start again from this'.")


def make_stills(plan, only=None, variations=True, texts=None):
    """Returns {shot n: [(label, path), ...]}"""
    out = {}
    variants = [("main", "")] + ([("closer", "closer view, "), ("wider", "wider view showing more of the room, ")] if variations else [])
    for s in plan["shots"]:
        if only and s["n"] not in only:
            continue
        out[s["n"]] = []
        for label, pre in variants:
            for attempt in range(2):
                ensure_comfy()
                res = m.t_make_still({"prompt": still_prompt(plan, s, pre), "aspect": "9:16", "megapixels": 0.8, "seed": random.randint(1, 10**6), "shot": s["n"], "label": label,
                                      "reference_images": CHAR_REFS if s.get("has_character") else []})
                p = parse_path(res)
                if not s.get("has_character") and faces_in(p) and attempt == 0:      # automatic check: only the main character may show a face
                    m._board("mark", shot=s["n"], path=str(p), status="rejected", reason="a face is visible, re-rolling")
                    continue
                break
            out[s["n"]].append((label, p))
    return out


def make_clips(plan, stills, only=None, notes=None):
    clips = {}
    for s in plan["shots"]:
        if only and s["n"] not in only:
            continue
        for attempt in range(2):
            ensure_comfy()
            res = m.t_make_clip({"still_path": str(stills[s["n"]]), "description": (notes or {}).get(s["n"]) or s["motion"] + " The camera never moves. Nobody walks toward the camera. No new person appears.",
                                 "soundscape": s.get("sound") or "quiet room tone, faint hum, no music", "shot": s["n"], "seed": random.randint(1, 10**6)})
            text = res[0]["text"]
            p = Path(text.split("  (seed")[0].strip())
            an = {}
            mm = re.search(r"analysis: (\{.*\})", text)
            if mm:
                try:
                    an = json.loads(mm.group(1))
                except Exception:
                    pass
            sheet = (re.search(r"contact sheet: (.*)", text) or [None, ""])[1].strip()
            dur = float(an.get("duration") or 4.0)
            if dur < 2.0 and attempt == 0:
                m._board("mark", shot=s["n"], path=str(p), status="rejected", reason="the clip came out too short, re-rolling")
                continue
            break
        glitch = an.get("glitch_at")
        out_t = min(dur - 0.1, 3.8)
        if glitch is not None and 1.5 < float(glitch) < out_t:      # cut before the glitch tail
            out_t = float(glitch) - 0.15
        clips[s["n"]] = {"path": p, "out": round(max(1.5, out_t), 2), "sheet": sheet}
    return clips


def interpret(plan, note, stage):
    """Which shots does the user's note change, and what is the new text for them?"""
    sch = {"type": "object", "required": ["changes"], "properties": {"changes": {"type": "array", "items": {"type": "object", "required": ["n"], "properties": {
        "n": {"type": "integer"}, "new_picture": {"type": "string"}, "new_movement": {"type": "string"}}}}}}
    plan_txt = "\n".join(shot_text(plan, s) for s in plan["shots"])
    r = llm("You turn a user's change request into edits of a shot plan. Only list shots the request affects. new_picture is a full replacement for the frozen-moment description; new_movement for the movement. Answer ONLY with JSON.",
            f"Shot plan:\n{plan_txt}\n\nThe user's request (stage: {stage}): {note}", sch, 0.3)
    return {int(c["n"]): c for c in r.get("changes", []) if isinstance(c.get("n"), int)}


def main():
    brief = json.loads(Path(os.environ["LITE_BRIEF"]).read_text(encoding="utf-8"))
    global CHAR_REFS
    CHAR_REFS = [r["path"] for r in brief.get("refs", []) if r["role"] in ("character",) and r["kind"] == "image"]
    seconds = int(brief["seconds"])
    variations = brief.get("variations", True)

    say(f"Lite mode: I'm using the local model {MODEL} for the plan and fixed steps for the rest. It writes plainer scripts than the Claude mode and doesn't look at the pictures itself, so please check each stage carefully.")
    m._board("now", text="Writing the shot plan with the local model (loading it can take a minute)")
    plan = make_plan(brief)
    for _ in range(4):
        m._board("shots", shots=plan["shots"])
        m._board("stage", stage="script")
        m._board("now", text="")
        choice, note = ask("Approve the script", f"{plan.get('title', '')}\nSetting: {plan.get('setting', '')}\n\n" + "\n\n".join(shot_text(plan, s) for s in plan["shots"]),
                           suggestions=["Make the payoff scarier", "Make it slower and quieter", "Add a closer shot of the main character"])
        if choice.lower().startswith("approve"):
            break
        m._board("now", text="Rewriting the plan with your note")
        plan = make_plan(brief, note or choice, plan)

    texts = {s["n"]: s for s in plan["shots"]}
    stills = make_stills(plan, variations=variations)
    chosen = {n: lst[0][1] for n, lst in stills.items()}
    for _ in range(3):
        picks = [{"shot": n, "label": f"Shot {n}: {texts[n]['title']}", "options": [{"path": str(p), "label": l} for l, p in lst]} for n, lst in stills.items() if len(lst) > 1]
        choice, note = ask("Approve the stills", "Pick the version you like for each shot." if picks else "Here are the stills.", media=[] if picks else [str(lst[0][1]) for lst in stills.values()],
                           picks=picks, suggestions=["Make the room darker", "Make the main character easier to see"])
        for mm in re.finditer(r"shot (\d+): option (\d+)", note):
            n, k = int(mm.group(1)), int(mm.group(2)) - 1
            if n in stills and 0 <= k < len(stills[n]):
                chosen[n] = stills[n][k][1]
        for n, p in chosen.items():
            m._board("mark", shot=n, path=str(p), status="chosen")
        user_note = re.sub(r"USER PICKED:.*", "", note).strip()
        if choice.lower().startswith("approve") and not user_note:
            break
        if user_note:
            ch = interpret(plan, user_note, "stills")
            for n, c in ch.items():
                if n in texts and c.get("new_picture"):
                    texts[n]["still"] = c["new_picture"]
            if ch:
                stills.update(make_stills(plan, only=set(ch), variations=variations))
                for n in ch:
                    chosen[n] = stills[n][0][1]
                continue
        break

    clips = make_clips(plan, chosen)
    for _ in range(3):
        sheets = [c["sheet"] for c in clips.values() if c["sheet"]]
        choice, note = ask("Approve the clips", "Here is one contact sheet per shot (frames across the clip). Say which shot to redo and why if something is off.", media=sheets,
                           suggestions=["Make the movement subtler", "Redo the last shot"])
        if choice.lower().startswith("approve") and not note:
            break
        ch = interpret(plan, note or choice, "clips")
        if not ch:
            break
        for n, c in ch.items():
            if n in texts and c.get("new_movement"):
                texts[n]["motion"] = c["new_movement"]
        clips.update(make_clips(plan, chosen, only=set(ch)))

    shots = []
    t = 0.0
    starts = []
    for i, s in enumerate(plan["shots"]):
        c = clips[s["n"]]
        last = i >= len(plan["shots"]) - 2
        shots.append({"path": str(c["path"]), "in": 0.0, "out": c["out"], "gain": -5.0 if last else -10.0, "chaos": 0.0, "caption": s.get("caption", "")})
        starts.append(t)
        t += c["out"]
    look = plan.get("look") if plan.get("look") in LOOKS else (brief.get("genre") if brief.get("genre") in LOOKS else "tiktok")
    m._board("stage", stage="cut")
    res = m.t_build_cut({"shots": shots, "look": look, "profile": "cam", "scare_at": starts[-2] + 0.6 if len(starts) > 1 else -1, "name": plan.get("title") or "lite_video", "quality": "high"})
    out = re.search(r"saved (.*?) \(", res[0]["text"]).group(1)
    choice, note = ask("Your video is ready", f"Saved to {out}\nLite mode can't revise a finished video; to change something use 'Start again from this' and adjust the idea.",
                       media=[out], options=["Looks good", "Not good, I'll start again"])
    say("Done. " + ("Enjoy!" if choice.lower().startswith("looks") else "Use 'Start again from this' to adjust the idea and run it again."))


CHAR_REFS = []

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"{type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
