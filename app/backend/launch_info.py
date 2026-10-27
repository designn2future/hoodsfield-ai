"""Small helper the .bat launchers call so folders and options come from Settings instead of being edited into the .bat files.

    launch_info.py root | args | python | port | check | claude
"""
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import app_settings  # noqa: F401  (loads hoodsfield_settings.json + .env into the environment)

what = sys.argv[1] if len(sys.argv) > 1 else "root"
root = Path(os.environ.get("COMFY_ROOT", ""))

if what == "root":
    print(root)
elif what == "args":
    print(os.environ.get("COMFY_LAUNCH_ARGS", ""))
elif what == "port":
    print(urlparse(os.environ.get("COMFY_URL", "http://127.0.0.1:8188")).port or 8188)
elif what == "python":
    cands = [root / "venv" / "Scripts" / "python.exe", root / ".venv" / "Scripts" / "python.exe", root.parent / "python_embeded" / "python.exe", root / "python_embeded" / "python.exe"]
    print(next((str(p) for p in cands if p.exists()), "python"))
elif what == "check":
    sys.exit(0 if (root / "main.py").exists() and (root / "models").is_dir() else 1)
elif what == "claude":
    import claude_cli
    s = claude_cli.status(True)
    if not s["installed"]:
        print("Claude Code: not installed. The Assistant needs it; everything else works without.")
        print("  Install:  " + s["install"]["npm"])
    elif not s["ready"]:
        print("Claude Code: installed but not signed in. Open Settings > Claude after starting Hoodsfield.")
    else:
        print("Claude Code: connected" + (f" as {s['account']}" if s["account"] else "") + ".")
