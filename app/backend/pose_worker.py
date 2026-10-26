"""Runs in the separate .venv-pose environment (MediaPipe lives only there, so it can never disturb the app's packages).
Usage: pose_worker.py <image> <out.json> <model.task> [max_people]
Writes {width, height, poses:[{image:[[x,y,z,vis,presence]*33], world:[[x,y,z,vis]*33], box:[x0,y0,x1,y1]}]}: 33 body landmarks per
person, `image` normalised to the picture, `world` in metres with the origin between the hips.

MediaPipe is weak at several people at once, so people are found one at a time: detect the most confident person, grey out their
area, look again, until nobody new turns up.
"""
import json
import sys

import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mpp
from mediapipe.tasks.python import vision
from PIL import Image

img_path, out_path, model = sys.argv[1:4]
max_people = int(sys.argv[4]) if len(sys.argv) > 4 else 6
opts = vision.PoseLandmarkerOptions(
    base_options=mpp.BaseOptions(model_asset_path=model),
    running_mode=vision.RunningMode.IMAGE,
    num_poses=2,
    min_pose_detection_confidence=0.3,
    min_pose_presence_confidence=0.3,
    min_tracking_confidence=0.3,
)
det = vision.PoseLandmarker.create_from_options(opts)
rgb = np.array(Image.open(img_path).convert("RGB"))
H, W = rgb.shape[:2]
work = rgb.copy()
grey = np.uint8(rgb.reshape(-1, 3).mean(axis=0))
poses = []


def box_of(lm):
    pts = [(l.x, l.y) for l in lm if l.visibility > 0.3] or [(l.x, l.y) for l in lm]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return [max(0.0, min(xs)), max(0.0, min(ys)), min(1.0, max(xs)), min(1.0, max(ys))]


for _ in range(max_people):
    res = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=work))
    new = 0
    for lm, wl in zip(res.pose_landmarks, res.pose_world_landmarks):
        if len(poses) >= max_people:
            break
        b = box_of(lm)
        bw, bh = b[2] - b[0], b[3] - b[1]
        if bw < 0.03 or bh < 0.06:
            continue
        # skip a "new" person that overlaps a known one almost completely (the same body found twice)
        dup = False
        for p in poses:
            ix = max(0, min(b[2], p["box"][2]) - max(b[0], p["box"][0])) * max(0, min(b[3], p["box"][3]) - max(b[1], p["box"][1]))
            if ix > 0.6 * min(bw * bh, (p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1])):
                dup = True
        if dup:
            continue
        poses.append({"image": [[l.x, l.y, l.z, l.visibility, l.presence] for l in lm], "world": [[w.x, w.y, w.z, w.visibility] for w in wl], "box": b})
        new += 1
        mx, my = bw * 0.12, bh * 0.08                                   # grey the person out so the next pass sees someone else
        x0, x1 = int(max(0, (b[0] - mx) * W)), int(min(W, (b[2] + mx) * W))
        y0, y1 = int(max(0, (b[1] - my) * H)), int(min(H, (b[3] + my) * H))
        work[y0:y1, x0:x1] = grey
    if not new:
        break
poses.sort(key=lambda p: (p["box"][0] + p["box"][2]) / 2)               # left to right in the picture
json.dump({"width": W, "height": H, "poses": poses}, open(out_path, "w"))
print(f"{len(poses)} pose(s)")
