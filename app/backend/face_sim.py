"""Face identity check (run with the ComfyUI venv python: it has insightface + onnxruntime).

    python face_sim.py <reference.png> <candidate.png> [<source_frame.png>]

Prints one JSON line: cosine similarity (ArcFace, buffalo_l) between the biggest face in the reference and the best-matching
face in the candidate (and, if given, in the original source frame, as a baseline). CPU only so it never competes with ComfyUI.
"""
import json
import os
import sys

import cv2
import numpy as np

ROOT = os.environ.get("INSIGHTFACE_ROOT", r"D:\ComfyUI-LTX2\models\insightface")


def faces(app, path):
    img = cv2.imread(path)
    if img is None:
        return []
    return app.get(img)


def big(fs):
    return max(fs, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])) if fs else None


def best(ref, fs):
    if ref is None or not fs:
        return None
    return float(max(np.dot(ref.normed_embedding, f.normed_embedding) for f in fs))


def main():
    from insightface.app import FaceAnalysis
    app = FaceAnalysis(name="buffalo_l", root=ROOT, providers=["CPUExecutionProvider"], allowed_modules=["detection", "recognition"])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    ref = big(faces(app, sys.argv[1]))
    cand = faces(app, sys.argv[2])
    out = {"ref_face": ref is not None, "cand_faces": len(cand), "sim": best(ref, cand)}
    if len(sys.argv) > 3:
        out["src_sim"] = best(ref, faces(app, sys.argv[3]))
    print(json.dumps(out))


if __name__ == "__main__":
    main()
