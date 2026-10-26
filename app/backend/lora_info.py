"""Which model family each installed LoRA was trained for, read from the .safetensors header (no weights loaded).
Cached per file by size+mtime. Families: flux3, krea2, qwen, zimage, ltx, wan, minimax_h3, sdxl, unknown."""
import json
import os
import re
import struct
from pathlib import Path

_CACHE: dict[str, tuple] = {}   # path -> (size, mtime, family)

_META = [  # metadata text -> family (checked first; the trainer wrote it)
    ("flux3", "flux3"), ("krea", "krea2"), ("qwen", "qwen"), ("zimage", "zimage"), ("ltx", "ltx"),
    ("wan", "wan"), ("minimax", "minimax_h3"), ("sdxl", "sdxl"),
]


def _from_keys(keys: list[str]) -> str:
    j = "\n".join(keys[:400])
    if "content_mode_blocks" in j:
        return "flux3"
    if re.search(r"text_fusion|blocks\.\d+\.attn\.gate", j):
        return "krea2"
    if re.search(r"gate_logits|adaln_single|audio_scale_shift|attn[12]\.to_[kqv]", j):
        return "ltx"
    if "add_k_proj" in j or "img_in.lora" in j:
        return "qwen"
    if "adaLN_modulation" in j:
        return "zimage"
    if re.search(r"cross_attn", j):
        return "wan"
    if re.search(r"attn[._]out_proj|mlp[._]fc\d", j):
        return "minimax_h3"
    if re.search(r"lora_te|down_blocks", j):
        return "sdxl"
    return "unknown"


def classify(path: Path, rel: str) -> str:
    try:
        with open(path, "rb") as fh:
            n = struct.unpack("<Q", fh.read(8))[0]
            h = json.loads(fh.read(min(n, 30_000_000)))
    except Exception:
        return "unknown"
    meta = " ".join(str(v) for v in (h.get("__metadata__") or {}).values() if isinstance(v, str) and len(v) < 120).lower()
    base = " ".join(str((h.get("__metadata__") or {}).get(k, "")) for k in ("ss_base_model_version", "modelspec.architecture")).lower()
    for needle, fam in _META:
        if needle in base:
            return fam
    fam = _from_keys([k for k in h if k != "__metadata__"])
    if fam == "unknown":                                  # last resort: the folder or file name
        low = rel.lower().replace("\\", "/")
        for needle, f in (("krea", "krea2"), ("qwen", "qwen"), ("minimax", "minimax_h3"), ("wan", "wan"), ("ltx", "ltx"), ("flux", "flux3")):
            if needle in low:
                return f
    return fam


def families(root: Path, names: list[str]) -> dict[str, str]:
    out = {}
    for name in names:
        p = root / name
        try:
            st = p.stat()
        except OSError:
            out[name] = "unknown"
            continue
        c = _CACHE.get(str(p))
        if not c or c[0] != st.st_size or c[1] != st.st_mtime:
            c = (st.st_size, st.st_mtime, classify(p, name))
            _CACHE[str(p)] = c
        out[name] = c[2]
    return out
