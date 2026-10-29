"""Hoodsfield settings: one JSON file the Settings page edits, applied to the environment BEFORE any other module reads it.

Import this first (main.py does). Priority, lowest to highest: built-in defaults < OS environment < backend/.env < hoodsfield_settings.json.
Nothing here is required: with no settings file the app behaves exactly as before. A saved empty value removes the key (back to default).

    from app_settings import S         # S.get("comfy_url"), S.saved("claude_model"), S.schema()
"""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILE = Path(os.getenv("HOODSFIELD_SETTINGS") or HERE / "hoodsfield_settings.json")

# key, env var(s), kind, default, group, label, help, restart-needed, secret
# kinds: str | path | int | float | bool | select:a|b|c | lines
F = [
    # --- Claude (optional extras, off unless switched on here or with HF_CLAUDE_ENABLED=1)
    ("claude_enabled", "HF_CLAUDE_ENABLED", "bool", False, "claude", "Claude extras (Assistant, Story Room, picture-reading loops)",
     "Off by default. Everything else in Hoodsfield works without it. Switch on to use your own Claude account for the Assistant.", False, False),
    ("claude_auth", "HF_CLAUDE_AUTH", "select:login|api_key", "login", "claude", "How Hoodsfield signs in to Claude",
     "'login' uses your own Claude account through the Claude Code app (recommended). 'api_key' uses an Anthropic API key instead.", False, False),
    ("claude_model", "HF_CLAUDE_MODEL", "select:opus|sonnet|haiku", "opus", "claude", "Claude model for the Assistant",
     "Opus is the most capable; Sonnet is faster and uses less of your plan.", False, False),
    ("claude_api_key", "HF_CLAUDE_API_KEY", "str", "", "claude", "Anthropic API key (only for 'api_key' sign-in)",
     "Stored in this PC's settings file only and never sent anywhere except to Anthropic by the Claude Code app.", False, True),
    ("claude_bin", "HF_CLAUDE_BIN", "path", "", "claude", "Claude Code program (optional)",
     "Leave empty to find it automatically. Set it only if the check below cannot find an installed Claude Code.", False, False),
    # --- ComfyUI
    ("comfy_url", "COMFY_URL", "str", "http://127.0.0.1:8188", "comfy", "ComfyUI address", "Where your ComfyUI server listens.", True, False),
    ("comfy_root", "COMFY_ROOT", "path", "", "comfy", "ComfyUI folder",
     "The folder that contains ComfyUI's main.py, models and custom_nodes. Leave empty to auto-detect.", True, False),
    ("extra_model_dirs", "EXTRA_MODEL_DIRS", "lines", "", "comfy", "Extra model folders",
     "One folder per line. Hoodsfield also looks here for model files (for example a second drive).", False, False),
    ("comfy_launch_args", "COMFY_LAUNCH_ARGS", "str", "", "comfy", "ComfyUI start-up options",
     "Used only when the watchdog has to restart ComfyUI. Example: --use-sage-attention --reserve-vram 2.5. The address and port are added for you.", False, False),
    ("comfy_watchdog", "HOODSFIELD_COMFY_WATCHDOG", "bool", True, "comfy", "Restart ComfyUI automatically if it stops answering",
     "It never starts ComfyUI when it is not running, and it never touches ComfyUI's files.", True, False),
    ("work_dir", "VSA_WORK_DIR", "path", "", "storage", "Work folder (projects, jobs, outputs)",
     "Leave empty for the system temp folder. Pick a drive with plenty of space.", True, False),
    # --- local LLM
    ("output_dir", "HOODSFIELD_OUTPUT", "path", "", "storage", "Finished-video folder (Assistant)",
     "Where the Assistant puts finished videos. Leave empty for Desktop/Hoodsfield_Output.", True, False),
    ("ollama_url", "OLLAMA_URL", "str", "http://127.0.0.1:11434", "llm", "Ollama address", "Local language model server used by Lite mode, the director and image descriptions.", True, False),
    ("ollama_text_model", "OLLAMA_TEXT_MODEL", "str", "", "llm", "Ollama text model", "Empty = pick the best installed (Qwen, Llama...).", True, False),
    ("ollama_vision_model", "OLLAMA_VISION_MODEL", "str", "", "llm", "Ollama vision model", "Empty = pick an installed Qwen-VL.", True, False),
    ("lite_model", "ASSISTANT_LITE_MODEL", "str", "", "llm", "Lite-mode Assistant model", "The Ollama model the no-account Lite Assistant uses.", True, False),
    # --- GPU
    ("gpu_profile", "HF_GPU_PROFILE", "select:auto|8|12|16|24", "auto", "gpu", "GPU memory profile",
     "Sets the default MiniMax H3 quality, picture size and clip length for your card. 'auto' reads it from ComfyUI.", False, False),
    ("h3_max_frames", "H3_MAX_FRAMES", "int", 0, "gpu", "Longest H3 clip (frames)", "0 = use the profile. 175 frames = 7.3 s at 24 fps.", True, False),
    # --- H3 coach
    ("h3_coach", "H3_COACH", "bool", True, "coach", "H3 prompt coach", "Adds camera, physics, audio and constraint lines to every MiniMax H3 prompt.", True, False),
    ("h3_coach_llm", "H3_COACH_LLM", "bool", False, "coach", "Let a local model rewrite the prompt too (experimental)",
     "Small models can invent details; leave off unless you like the result.", True, False),
    # --- guard
    ("guard", "HOODSFIELD_GUARD", "bool", True, "safety", "Memory guard",
     "Pauses new jobs and interrupts a running one if the PC is nearly out of RAM, so Windows never freezes.", True, False),
    ("guard_soft_gb", "HF_GUARD_SOFT_GB", "float", 6, "safety", "Free RAM that starts cache clean-up (GB)", "", True, False),
    ("guard_gate_gb", "HF_GUARD_GATE_GB", "float", 4, "safety", "Free RAM below which new jobs wait (GB)", "", True, False),
    ("guard_hard_gb", "HF_GUARD_HARD_GB", "float", 2, "safety", "Free RAM that interrupts a running job (GB)", "", True, False),
]
FIELDS = [dict(key=a, env=b, kind=c, default=d, group=e, label=f, help=g, restart=h, secret=i) for a, b, c, d, e, f, g, h, i in F]
BY_KEY = {f["key"]: f for f in FIELDS}

PROFILES = {   # H3 defaults by GPU memory; frames sit on H3's 17k+5 grid at 24 fps. draft_* = new-scene defaults, final_* = what to use for finished shots
    "8": dict(label="8 GB card", draft_preset="fast", draft_mp=0.3, final_preset="quality", final_mp=0.5, h3_max_frames=107, note="Short clips at small sizes. Expect offloading and slower renders."),
    "12": dict(label="12 GB card", draft_preset="fast", draft_mp=0.4, final_preset="quality", final_mp=0.7, h3_max_frames=141, note="Draft with Fast, finish with Quality at about 0.7 MP."),
    "16": dict(label="16 GB card", draft_preset="fast", draft_mp=0.4, final_preset="quality", final_mp=0.85, h3_max_frames=175, note="The reference setup: draft on Fast, finals on Quality at 0.85 MP, clips up to 7.3 s."),
    "24": dict(label="24 GB card or more", draft_preset="quality", draft_mp=0.7, final_preset="quality", final_mp=1.05, h3_max_frames=175, note="Quality all the way; finals at 1.05 MP."),
}


def output_dir() -> Path:
    """Where the Assistant and the cut-maker put finished videos (Settings -> Finished-video folder)."""
    v = os.environ.get("HOODSFIELD_OUTPUT")
    if v:
        return Path(v)
    od = Path.home() / "OneDrive" / "Desktop"
    return (od if od.is_dir() else Path.home() / "Desktop") / "Hoodsfield_Output"


def profile_for_vram_gb(gb: float) -> str:
    return "8" if gb < 10 else "12" if gb < 14 else "16" if gb < 20 else "24"


def _read() -> dict:
    try:
        d = json.loads(FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _fmt(f: dict, v) -> str:
    if f["kind"] == "bool":
        return "1" if v in (True, 1, "1", "true", "True") else "0"
    if f["kind"] == "lines":
        return os.pathsep.join(x.strip() for x in str(v).splitlines() if x.strip())
    return str(v)


def detect_comfy_root() -> str:
    """First folder that looks like a ComfyUI install, else ''."""
    cands = []
    home = Path.home()
    for base in (os.environ.get("COMFY_ROOT"), os.environ.get("COMFY_DIR")):
        if base:
            cands.append(Path(base))
    cands += [HERE.parent.parent / "ComfyUI", HERE.parent.parent.parent / "ComfyUI", home / "ComfyUI", home / "Documents" / "ComfyUI",
              home / "Desktop" / "ComfyUI", Path(r"C:\ComfyUI"), Path(r"C:\ComfyUI_windows_portable\ComfyUI"), Path(r"D:\ComfyUI"),
              Path(r"D:\ComfyUI_windows_portable\ComfyUI")]
    for drv in ("C:\\", "D:\\", "E:\\"):
        try:
            cands += [p for p in Path(drv).glob("ComfyUI*") if p.is_dir()]
            cands += [p / "ComfyUI" for p in Path(drv).glob("ComfyUI*") if p.is_dir()]
        except OSError:
            pass
    for c in cands:
        try:
            if (c / "main.py").exists() and (c / "models").is_dir():
                return str(c)
        except OSError:
            pass
    return ""


class _Settings:
    def __init__(self):
        self.applied: dict = {}
        self.reload()

    def reload(self):
        # backend/.env (does not override real environment variables)
        env_file = HERE / ".env"
        if env_file.exists():
            for line in env_file.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())
        data = _read()
        for k, v in data.items():
            f = BY_KEY.get(k)
            if f and v not in (None, ""):
                os.environ[f["env"]] = _fmt(f, v)
                if k == "comfy_root":
                    os.environ["COMFY_DIR"] = str(v)
        if data.get("lite_model"):
            os.environ["LITE_MODEL"] = str(data["lite_model"])
        prof = str(data.get("gpu_profile") or "")
        if prof in PROFILES and not data.get("h3_max_frames") and not os.environ.get("H3_MAX_FRAMES"):
            os.environ["H3_MAX_FRAMES"] = str(PROFILES[prof]["h3_max_frames"])
        if not os.environ.get("COMFY_ROOT"):
            d = detect_comfy_root()
            if d:
                os.environ["COMFY_ROOT"] = d
        if not os.environ.get("COMFY_DIR") and os.environ.get("COMFY_ROOT"):
            os.environ["COMFY_DIR"] = os.environ["COMFY_ROOT"]
        if not os.environ.get("COMFY_ROOT"):
            os.environ["COMFY_ROOT"] = r"D:\ComfyUI-LTX2"      # historic default; the health check tells the user to set it
        self.applied = dict(data)
        self.data = data

    # ---- reading
    def saved(self, key):
        return self.data.get(key)

    def get(self, key):
        """Effective value: saved, else the current environment, else the default."""
        f = BY_KEY[key]
        v = self.data.get(key)
        if v not in (None, ""):
            return v
        e = os.environ.get(f["env"])
        if e not in (None, ""):
            if f["kind"] == "bool":
                return e not in ("0", "false", "False")
            if f["kind"] == "int":
                try: return int(float(e))
                except ValueError: return f["default"]
            if f["kind"] == "float":
                try: return float(e)
                except ValueError: return f["default"]
            if f["kind"] == "lines":
                return "\n".join(x for x in e.split(os.pathsep) if x)
            return e
        return f["default"]

    def schema(self, with_secrets=False) -> list[dict]:
        out = []
        for f in FIELDS:
            v = self.get(f["key"])
            row = {k: f[k] for k in ("key", "kind", "default", "group", "label", "help", "restart", "secret")}
            row["value"] = ("" if f["secret"] and not with_secrets else v)
            row["secret_set"] = bool(f["secret"] and v)
            row["saved"] = f["key"] in self.data and self.data[f["key"]] not in (None, "")
            out.append(row)
        return out

    # ---- writing
    def save(self, updates: dict) -> dict:
        """Merge updates into the file. Returns {changed:[keys], restart:bool}. A secret sent as '' keeps the stored one; '__clear__' removes it."""
        data = dict(_read())
        changed, restart = [], False
        for k, v in updates.items():
            f = BY_KEY.get(k)
            if not f:
                continue
            if f["secret"]:
                if v == "":
                    continue
                if v == "__clear__":
                    v = ""
            if f["kind"] == "bool":
                v = bool(v)
            elif f["kind"] == "int":
                v = int(float(v)) if str(v).strip() != "" else ""
            elif f["kind"] == "float":
                v = float(v) if str(v).strip() != "" else ""
            elif f["kind"].startswith("select:"):
                if v not in f["kind"][7:].split("|"):
                    v = ""
            else:
                v = str(v).strip() if v is not None else ""
                if k == "claude_bin" or f["kind"] == "path":
                    v = v.strip('"')
            old = data.get(k)
            if v == "" or v is None or (f["kind"] not in ("bool",) and v == f["default"] and k not in ("comfy_url",)):
                data.pop(k, None)
            else:
                data[k] = v
            if data.get(k) != old:
                changed.append(k)
                if f["restart"]:
                    restart = True
        tmp = FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(FILE)
        self.data = data
        # live-apply the ones that are read at call time
        for k in changed:
            f = BY_KEY[k]
            if not f["restart"]:
                val = data.get(k)
                if val in (None, ""):
                    os.environ.pop(f["env"], None)
                else:
                    os.environ[f["env"]] = _fmt(f, val)
        return {"changed": changed, "restart": restart}

    def restart_needed(self) -> list[str]:
        """Settings whose saved value differs from what the running process started with and that only apply at start-up."""
        return [f["key"] for f in FIELDS if f["restart"] and self.data.get(f["key"]) != self.applied.get(f["key"])]


S = _Settings()
