"""Login gate for internet access.

Devices on this PC / home Wi-Fi / Tailscale are trusted and never see a login. Anything that arrives through a public
tunnel (it carries proxy headers such as CF-Connecting-IP / X-Forwarded-For, and reaches us from 127.0.0.1) must sign in.
Fails closed: if no password has been set, tunnelled requests are refused.

Set or change the login:   python remote_auth.py set      (prompts; changing it signs every remote device out)
"""
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import time
from html import escape
from pathlib import Path
from urllib.parse import parse_qs, quote

AUTH_FILE = Path(os.getenv("HF_AUTH_FILE", str(Path(__file__).with_name("hf_auth.json"))))
COOKIE = "hf_auth"
LOGIN_PATH = "/hf-login"
SESSION_DAYS = 30
MAX_FAILS, LOCK_SECS = 5, 600
PROXY_HEADERS = (b"cf-connecting-ip", b"cf-ray", b"x-forwarded-for", b"x-forwarded-host", b"forwarded", b"x-real-ip")
_fails: dict[str, list] = {}  # ip -> [count, locked_until]


def _load() -> dict | None:
    try:
        return json.loads(AUTH_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def _hash(pw: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 300_000).hex()


def set_credentials(user: str, pw: str) -> None:
    salt = secrets.token_bytes(16)
    AUTH_FILE.write_text(json.dumps({
        "user": user, "salt": salt.hex(), "hash": _hash(pw, salt), "secret": secrets.token_hex(32),
    }), encoding="utf-8")


def _token(secret: str) -> str:
    exp = str(int(time.time()) + SESSION_DAYS * 86400)
    sig = hmac.new(secret.encode(), exp.encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def _token_ok(tok: str, secret: str) -> bool:
    try:
        exp, sig = tok.split(".", 1)
        good = hmac.new(secret.encode(), exp.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, good) and int(exp) > time.time()
    except Exception:
        return False


def _trusted_ip(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return a.is_loopback or a.is_private or a in ipaddress.ip_network("100.64.0.0/10")  # LAN, or Tailscale


def _page(msg: str = "", nxt: str = "/") -> bytes:
    note = f'<p class="e">{escape(msg)}</p>' if msg else ""
    return f"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hoodsfield · sign in</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b10;color:#e8e8ee;font:16px system-ui,sans-serif}}
form{{width:min(320px,86vw);display:grid;gap:12px}}h1{{font-size:20px;margin:0 0 4px;letter-spacing:.04em}}
input,button{{font:inherit;padding:12px;border-radius:8px;border:1px solid #333;background:#16161e;color:inherit}}
button{{background:#7c5cff;border-color:#7c5cff;font-weight:600}}.e{{color:#ff7a7a;margin:0}}</style>
<form method="post" action="{LOGIN_PATH}"><h1>HOODSFIELD</h1>{note}
<input name="user" placeholder="Username" autocomplete="username" autocapitalize="none" required>
<input name="pw" type="password" placeholder="Password" autocomplete="current-password" required>
<input type="hidden" name="next" value="{escape(nxt)}"><button>Sign in</button></form>""".encode()


class RemoteAuth:
    """Pure-ASGI middleware (so streams, SSE and websockets pass through untouched)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        hdrs = {k.lower(): v for k, v in scope["headers"]}
        peer = (scope.get("client") or ("", 0))[0]
        proxied = any(h in hdrs for h in PROXY_HEADERS)
        if not proxied and _trusted_ip(peer):
            return await self.app(scope, receive, send)

        cfg = _load()
        ip = (hdrs.get(b"cf-connecting-ip") or hdrs.get(b"x-forwarded-for", b"").split(b",")[0] or peer.encode()).decode().strip()
        cookies = {}
        for part in hdrs.get(b"cookie", b"").decode(errors="ignore").split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                cookies[k] = v
        if cfg and _token_ok(cookies.get(COOKIE, ""), cfg["secret"]):
            return await self.app(scope, receive, send)

        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 1008})

        path = scope["path"]
        if path == LOGIN_PATH and scope["method"] == "POST":
            return await self._login(scope, receive, send, cfg, ip, hdrs)
        if path == LOGIN_PATH:
            return await self._reply(send, 200, _page(), "text/html; charset=utf-8")
        if b"text/html" in hdrs.get(b"accept", b"") and scope["method"] == "GET":
            loc = f"{LOGIN_PATH}?next={quote(path)}".encode()
            return await send_redirect(send, loc)
        return await self._reply(send, 401, b'{"detail":"sign in required"}', "application/json")

    async def _login(self, scope, receive, send, cfg, ip, hdrs):
        body = b""
        while True:
            m = await receive()
            body += m.get("body", b"")
            if not m.get("more_body"):
                break
        f = {k: v[0] for k, v in parse_qs(body.decode(errors="ignore")).items()}
        now = time.time()
        rec = _fails.get(ip, [0, 0])
        if rec[1] > now:
            return await self._reply(send, 429, _page("Too many attempts. Try again in a few minutes."), "text/html; charset=utf-8")
        ok = False
        if cfg:
            u_ok = hmac.compare_digest(f.get("user", ""), cfg["user"])
            p_ok = hmac.compare_digest(_hash(f.get("pw", ""), bytes.fromhex(cfg["salt"])), cfg["hash"])
            ok = u_ok and p_ok
        if not ok:
            rec[0] += 1
            if rec[0] >= MAX_FAILS:
                rec = [0, now + LOCK_SECS]
            _fails[ip] = rec
            msg = "No password has been set on the PC yet." if not cfg else "Wrong username or password."
            return await self._reply(send, 401, _page(msg), "text/html; charset=utf-8")
        _fails.pop(ip, None)
        nxt = f.get("next", "/")
        if not nxt.startswith("/") or nxt.startswith("//"):
            nxt = "/"
        secure = "; Secure" if hdrs.get(b"x-forwarded-proto", b"") == b"https" or b"cf-visitor" in hdrs else ""
        cookie = f"{COOKIE}={_token(cfg['secret'])}; Path=/; Max-Age={SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax{secure}"
        await send_redirect(send, nxt.encode(), [(b"set-cookie", cookie.encode())])

    @staticmethod
    async def _reply(send, status, body, ctype):
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", ctype.encode()), (b"cache-control", b"no-store"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


async def send_redirect(send, loc: bytes, extra=()):
    await send({"type": "http.response.start", "status": 303,
                "headers": [(b"location", loc), (b"cache-control", b"no-store"), (b"content-length", b"0"), *extra]})
    await send({"type": "http.response.body", "body": b""})


if __name__ == "__main__":
    import getpass
    import sys
    if sys.argv[1:] != ["set"]:
        raise SystemExit(__doc__)
    user = input("Username: ").strip()
    pw = getpass.getpass("Password (min 10 chars): ")
    if len(user) < 1 or len(pw) < 10 or pw != getpass.getpass("Repeat password: "):
        raise SystemExit("Not saved: username required, password 10+ characters, and both entries must match.")
    set_credentials(user, pw)
    print("Saved. Remote devices must sign in again. (Restart not needed.)")
