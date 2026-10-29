"""Runs in the separate .venv-pose environment (MediaPipe lives only there, like pose_worker.py).
Usage: mouth_worker.py <video> <out.json> <model.task>
Writes {fps, jaw:[...], found:[...]}: for every frame how far the mouth is open (MediaPipe's jawOpen blend-shape, 0 to 1), and whether a face
was found. Lip-sync uses it to line the voice up with the moment the lips really start moving.
"""
import json
import sys

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mpp
from mediapipe.tasks.python import vision

video, out_path, model = sys.argv[1:4]
det = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
    base_options=mpp.BaseOptions(model_asset_path=model),
    running_mode=vision.RunningMode.IMAGE,
    num_faces=1,
    output_face_blendshapes=True,
    min_face_detection_confidence=0.3,
    min_face_presence_confidence=0.3,
))
cap = cv2.VideoCapture(video)
fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
jaw, found = [], []
while True:
    ok, bgr = cap.read()
    if not ok:
        break
    res = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)))
    if res.face_blendshapes:
        d = {b.category_name: b.score for b in res.face_blendshapes[0]}
        jaw.append(float(d.get("jawOpen", 0.0)))
        found.append(True)
    else:
        jaw.append(jaw[-1] if jaw else 0.0)
        found.append(False)
with open(out_path, "w") as f:
    json.dump({"fps": fps, "jaw": jaw, "found": found}, f)
