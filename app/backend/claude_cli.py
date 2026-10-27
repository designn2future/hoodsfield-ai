"""Everything Hoodsfield needs to know about the user's Claude Code installation and sign-in.

The Assistant is a headless `claude` session that signs in with the user's own Claude account (or, optionally, an API key).
This module finds the program, tells installed / signed-in / working apart, and builds the environment a session runs with.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from app_settings import S

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
INSTALL_CMD_NPM = "npm install -g @anthropic-ai/claude-code"
INSTALL_CMD_WIN = "irm https://claude.ai/install.ps1 | iex"
DOCS_URL = "https://docs.claude.com/en/docs/claude-code/setup"
_cache: dict = {"t": 0.0, "v": None}


def find_exe() -> str:
    """Path to the claude program, or ''."""
    explicit = str(S.get("claude_bin") or "").strip().strip('"')
    if explicit and Path(explicit).exists():
        return explicit
    for name in ("claude", "claude.cmd", "claude.exe"):
        p = shutil.which(name)
        if p:
            return p
    home = Path.home()
    cands = [home / ".local" / "bin" / "claude.exe", home / ".local" / "bin" / "claude", home / ".claude" / "local" / "claude.exe",
             home / ".claude" / "local" / "claude", Path(os.environ.get("APPDATA", "")) / "npm" / "claude.cmd",
             Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "claude" / "claude.exe"]
    for c in cands:
        try:
            if c.exists():
                return str(c)
        except OSError:
            pass
    return ""


def uses_api_key() -> bool:
    return S.get("claude_auth") == "api_key"


def run_env() -> dict:
    """Environment for a claude session: the user's login by default (a stray key in the environment is dropped), or the saved key."""
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    if uses_api_key():
        key = str(S.get("claude_api_key") or "")
        if key:
            env["ANTHROPIC_API_KEY"] = key
    return env


def _run(args: list[str], timeout: float, stdin: str | None = None, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(args, input=stdin, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                          env=env or run_env(), creationflags=NOWIN, cwd=tempfile.gettempdir())


def status(force: bool = False) -> dict:
    """{installed, path, version, mode, logged_in, ready, account, plan, message, install:{...}}"""
    if not force and _cache["v"] and time.time() - _cache["t"] < 15:
        return _cache["v"]
    exe = find_exe()
    out = {"installed": bool(exe), "path": exe, "version": "", "mode": "api_key" if uses_api_key() else "login", "logged_in": False,
           "ready": False, "account": "", "plan": "", "method": "", "message": "",
           "install": {"npm": INSTALL_CMD_NPM, "windows": INSTALL_CMD_WIN, "docs": DOCS_URL}}
    if not exe:
        out["message"] = "Claude Code is not installed on this PC (or Hoodsfield cannot find it)."
        _cache.update(t=time.time(), v=out)
        return out
    try:
        out["version"] = (_run([exe, "--version"], 15).stdout or "").strip().splitlines()[0][:80]
    except Exception as e:
        out["message"] = f"Found Claude Code but could not start it: {e}"
        _cache.update(t=time.time(), v=out)
        return out
    if uses_api_key():
        out["logged_in"] = bool(S.get("claude_api_key"))
        out["ready"] = out["logged_in"]
        out["method"] = "API key"
        out["message"] = "Using the saved API key." if out["ready"] else "No API key saved yet."
    else:
        try:
            r = _run([exe, "auth", "status"], 20)
            txt = (r.stdout or "").strip()
            j = json.loads(txt[txt.find("{"): txt.rfind("}") + 1]) if "{" in txt else {}
            out["logged_in"] = bool(j.get("loggedIn"))
            out["account"] = j.get("email") or ""
            out["plan"] = j.get("subscriptionType") or j.get("orgName") or ""
            out["method"] = j.get("authMethod") or ""
            out["ready"] = out["logged_in"]
            out["message"] = (f"Signed in as {out['account']}." if out["account"] else "Signed in.") if out["ready"] else "Claude Code is installed but you are not signed in."
        except Exception as e:
            out["message"] = f"Could not read the sign-in state: {e}"
    _cache.update(t=time.time(), v=out)
    return out


def test(model: str | None = None) -> dict:
    """One tiny real request, so the user knows the connection works (uses a little of their plan)."""
    exe = find_exe()
    if not exe:
        return {"ok": False, "error": "Claude Code is not installed."}
    model = model or S.get("claude_model") or "opus"
    t0 = time.time()
    try:
        r = _run([exe, "-p", "--output-format", "json", "--model", model, "--max-turns", "1"], 120, stdin="Reply with exactly the word: OK")
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Claude did not answer within 2 minutes."}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    txt = (r.stdout or "").strip()
    try:
        j = json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
    except Exception:
        return {"ok": False, "error": (r.stderr or txt or "No answer from Claude Code.")[:400]}
    if j.get("is_error"):
        return {"ok": False, "error": str(j.get("result") or "Claude reported an error")[:400]}
    return {"ok": True, "reply": str(j.get("result", ""))[:200], "model": model, "seconds": round(time.time() - t0, 1)}


def open_login() -> dict:
    """Open a console window running `claude auth login` (it opens the browser to sign in). Windows only."""
    exe = find_exe()
    if not exe:
        return {"ok": False, "error": "Claude Code is not installed."}
    if sys.platform != "win32":
        return {"ok": False, "error": f"Run this in a terminal: {exe} auth login"}
    subprocess.Popen(f'cmd.exe /k ""{exe}" auth login"', creationflags=subprocess.CREATE_NEW_CONSOLE, cwd=tempfile.gettempdir())
    _cache["t"] = 0
    return {"ok": True}


def logout() -> dict:
    exe = find_exe()
    if not exe:
        return {"ok": False, "error": "Claude Code is not installed."}
    try:
        _run([exe, "auth", "logout"], 30)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    _cache["t"] = 0
    return {"ok": True}
