"""
Local speech-to-text (faster-whisper) for understanding the narration in a
user-uploaded reference video, so the TikTok story wizard can feed a real
transcript to the LLM director instead of guessing the story from vision
alone. CPU-only by default (this backend's venv has no torch/CUDA install);
faster-whisper's ctranslate2 backend runs fine on CPU for short clips.
"""

import os

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")

_MODELS: dict[tuple[str, str], object] = {}


def _get_model(model_size: str, compute_type: str):
    key = (model_size, compute_type)
    model = _MODELS.get(key)
    if model is None:
        from faster_whisper import WhisperModel

        model = WhisperModel(model_size, device="cpu", compute_type=compute_type)
        _MODELS[key] = model
    return model


def transcribe(path: str, model_size: str = "", compute_type: str = "") -> dict:
    """Transcribe the audio track of a video/audio file at `path`. faster-whisper
    decodes audio itself (via `av`), so a plain mp4 path works directly — no
    separate ffmpeg extraction step needed. Returns a text-only result (no
    error) for a silent file — a reference clip with no narration is a normal
    input here, not a failure."""
    model = _get_model(model_size or WHISPER_MODEL, compute_type or WHISPER_COMPUTE_TYPE)
    segments, info = model.transcribe(path, vad_filter=True, beam_size=1)
    out_segments = [
        {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
        for s in segments if s.text.strip()
    ]
    text = " ".join(s["text"] for s in out_segments).strip()
    return {
        "text": text,
        "segments": out_segments,
        "language": getattr(info, "language", None),
    }


def transcribe_words(path: str, model_size: str = "", compute_type: str = "") -> dict:
    """Like transcribe(), but with a start/end time for every spoken word (for captions). Silent input -> no words."""
    model = _get_model(model_size or WHISPER_MODEL, compute_type or WHISPER_COMPUTE_TYPE)
    segments, info = model.transcribe(path, vad_filter=True, beam_size=1, word_timestamps=True)
    words = []
    for s in segments:
        for w in (s.words or []):
            t = (w.word or "").strip()
            if t:
                words.append({"w": t, "start": round(float(w.start), 3), "end": round(float(w.end), 3)})
    return {"words": words, "language": getattr(info, "language", None)}
