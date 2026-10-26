"""Deterministic face swap (run with the ComfyUI venv python: insightface + onnxruntime, CPU).

    python face_swap.py <target.png> <reference_face.png> <out.png> [all|largest|left|right|center] [mask.png]

Puts the biggest face of the reference onto the biggest face of the target (or onto every face with the 4th arg `all`) using
InSwapper 128. Prints one JSON line. This is the part image-edit models cannot do reliably: carrying an exact identity across.
"""
import json
import os
import sys

import cv2

ROOT = os.environ.get("INSIGHTFACE_ROOT", r"D:\ComfyUI-LTX2\models\insightface")


def main():
    import insightface
    from insightface.app import FaceAnalysis
    target = cv2.imread(sys.argv[1])
    ref = cv2.imread(sys.argv[2])
    app = FaceAnalysis(name="buffalo_l", root=ROOT, providers=["CPUExecutionProvider"], allowed_modules=["detection", "recognition"])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    tf = app.get(target)
    rf = app.get(ref)
    if not tf or not rf:
        print(json.dumps({"ok": False, "reason": "no face in " + ("target" if not tf else "reference")}))
        return
    area = lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])
    src = max(rf, key=area)
    swapper = insightface.model_zoo.get_model(os.path.join(ROOT, "inswapper_128.onnx"), providers=["CPUExecutionProvider"])
    faces = sorted(tf, key=area, reverse=True)
    mode = sys.argv[4] if len(sys.argv) > 4 else "largest"
    if len(sys.argv) > 5 and os.path.isfile(sys.argv[5]):       # painted mask: the face most covered by the paint
        mk = cv2.imread(sys.argv[5], cv2.IMREAD_GRAYSCALE)
        def cover(f):
            x1, y1, x2, y2 = [max(0, int(v)) for v in f.bbox]
            reg = mk[y1:y2, x1:x2]
            return float((reg > 127).mean()) if reg.size else 0.0
        best = max(faces, key=cover)
        if cover(best) < 0.05:
            print(json.dumps({"ok": False, "reason": "the painted area does not cover a face; paint over the face you want to replace"}))
            return
        faces = [best]
    elif mode == "all":
        pass
    elif mode in ("left", "right", "center"):
        cx = lambda f: (f.bbox[0] + f.bbox[2]) / 2
        by_x = sorted(faces, key=cx)
        faces = [by_x[0] if mode == "left" else by_x[-1] if mode == "right" else by_x[len(by_x) // 2]]
    else:
        faces = faces[:1]
    out = target
    for f in faces:
        out = swapper.get(out, f, src, paste_back=True)
    cv2.imwrite(sys.argv[3], out)
    print(json.dumps({"ok": True, "swapped": len(faces)}))


if __name__ == "__main__":
    main()
