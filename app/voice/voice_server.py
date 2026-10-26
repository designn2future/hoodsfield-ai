"""Hoodsfield voice server: Chatterbox TTS (MIT, local) behind a tiny HTTP API.

Runs in its own Python environment (D:\\vsa_voice\\cb) because Chatterbox pins torch 2.6 / transformers 5 and would
clash with ComfyUI's. The Hoodsfield backend starts it on demand (see backend/tts_routes.py) and talks to it on 127.0.0.1:8189.

  GET  /health                         -> {loaded, device, vram_free_gb, idle_s}
  POST /speak  {text, ref, exaggeration, cfg_weight, seed, device} -> audio/wav (24 kHz mono)
  POST /unload                         -> frees the model (and its VRAM)

The model auto-unloads after IDLE_UNLOAD seconds so it never holds VRAM that ComfyUI wants.
"""
import io
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch

PORT = int(os.environ.get("VOICE_PORT", "8189"))
IDLE_UNLOAD = int(os.environ.get("VOICE_IDLE_UNLOAD", "300"))
MIN_FREE_GB = float(os.environ.get("VOICE_MIN_FREE_GB", "5.5"))

_lock = threading.Lock()
_model = None
_device = None
_last_used = time.time()

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def num_words(n: int) -> str:
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + (f" {ONES[n % 10]}" if n % 10 else "")
    if n < 1000:
        return f"{ONES[n // 100]} hundred" + (f" {num_words(n % 100)}" if n % 100 else "")
    if 1100 <= n <= 2099 and n % 100 and n % 1000 >= 100:      # years: nineteen eighty four, twenty twenty six
        return f"{num_words(n // 100)} {num_words(n % 100)}"
    if n < 1_000_000:
        return f"{num_words(n // 1000)} thousand" + (f" {num_words(n % 1000)}" if n % 1000 else "")
    return str(n)


def normalise(text: str) -> str:
    """Spell out the things TTS models stumble on: clock times, years, plain integers, a few symbols."""
    def clock(m):
        h, mi = int(m.group(1)), int(m.group(2))
        ap = (m.group(3) or "").lower().replace(".", "")
        hw = num_words(h)
        if mi == 0:
            mw = "o'clock" if not ap else ""
        elif mi < 10:
            mw = f"oh {num_words(mi)}"
        else:
            mw = num_words(mi)
        return " ".join(x for x in (hw, mw, {"am": "A M", "pm": "P M"}.get(ap, "")) if x)
    text = re.sub(r"\b(\d{1,2}):(\d{2})\s*([AaPp]\.?[Mm]\.?)?", clock, text)
    text = re.sub(r"\b\d{1,6}\b", lambda m: num_words(int(m.group(0))), text)
    text = text.replace("&", " and ").replace("%", " percent").replace("#", "number ")
    return re.sub(r"\s+", " ", text).strip()


def chunks(text: str, limit: int = 240):
    """Sentence-aware chunks so long scripts keep prosody and never hit the model's length ceiling."""
    sents = re.split(r"(?<=[.!?…])\s+", text.strip())
    cur, out = "", []
    for s in sents:
        if len(cur) + len(s) + 1 <= limit or not cur:
            cur = f"{cur} {s}".strip()
        else:
            out.append(cur)
            cur = s
    if cur:
        out.append(cur)
    return out


def free_vram_gb():
    if not torch.cuda.is_available():
        return 0.0
    free, _ = torch.cuda.mem_get_info()
    return free / 1e9


def pick_device(want: str) -> str:
    if want in ("cpu", "cuda"):
        return want if (want == "cpu" or torch.cuda.is_available()) else "cpu"
    return "cuda" if free_vram_gb() >= MIN_FREE_GB else "cpu"


def get_model(want="auto"):
    global _model, _device
    dev = pick_device(want)
    if _model is not None and _device != dev and want != "auto":
        unload()
    if _model is None:
        from chatterbox.tts import ChatterboxTTS
        _model = ChatterboxTTS.from_pretrained(device=dev)
        _device = dev
    return _model


def unload():
    global _model, _device
    _model, _device = None, None
    import gc
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def speak(text, ref, exaggeration=0.5, cfg_weight=0.5, seed=0, device="auto"):
    global _last_used
    with _lock:
        m = get_model(device)
        if seed:
            torch.manual_seed(int(seed))
            np.random.seed(int(seed) % (2**32))
        m.prepare_conditionals(ref, exaggeration=float(exaggeration))
        parts = []
        gap = np.zeros(int(m.sr * 0.16), dtype=np.float32)
        for c in chunks(normalise(text)):
            w = m.generate(c, audio_prompt_path=None, exaggeration=float(exaggeration), cfg_weight=float(cfg_weight))
            parts += [w.squeeze().cpu().numpy().astype(np.float32), gap]
        audio = np.concatenate(parts[:-1]) if parts else np.zeros(1, np.float32)
        peak = float(np.max(np.abs(audio))) or 1.0
        audio = audio * min(1.0, 0.95 / peak)
        _last_used = time.time()
        import soundfile as sf
        buf = io.BytesIO()
        sf.write(buf, audio, m.sr, format="WAV", subtype="PCM_16")
        return buf.getvalue(), _device


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, json.dumps({"ok": True, "loaded": _model is not None, "device": _device,
                                        "vram_free_gb": round(free_vram_gb(), 1), "idle_s": int(time.time() - _last_used)}).encode())
        else:
            self._send(404, b"{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        try:
            if self.path == "/speak":
                if not os.path.isfile(body.get("ref", "")):
                    return self._send(400, json.dumps({"error": "reference voice file not found"}).encode())
                wav, dev = speak(body["text"], body["ref"], body.get("exaggeration", 0.5), body.get("cfg_weight", 0.5),
                                 body.get("seed", 0), body.get("device", "auto"))
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("X-Device", dev or "")
                self.send_header("Content-Length", str(len(wav)))
                self.end_headers()
                self.wfile.write(wav)
            elif self.path == "/unload":
                with _lock:
                    unload()
                self._send(200, b'{"ok":true}')
            else:
                self._send(404, b"{}")
        except Exception as e:  # report instead of dropping the connection
            self._send(500, json.dumps({"error": f"{type(e).__name__}: {e}"}).encode())


def reaper():
    while True:
        time.sleep(20)
        if _model is not None and time.time() - _last_used > IDLE_UNLOAD and _lock.acquire(blocking=False):
            try:
                unload()
            finally:
                _lock.release()


if __name__ == "__main__":
    threading.Thread(target=reaper, daemon=True).start()
    print(f"voice server on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
