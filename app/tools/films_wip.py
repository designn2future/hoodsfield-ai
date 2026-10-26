"""Writes showcase/films_wip.json (titles, key art, shot progress) so Explore can show the films that are still rendering."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import make_films as mf  # noqa: E402
from PIL import Image  # noqa: E402

ms = mf.ms
out = []
for f in mf.FILMS:
    art = ms.OUT / f"film_{f['id']}_art.jpg"
    still = ms.WORK / f"film_{f['id']}_s0.png"
    if still.exists():
        im = Image.open(still).convert("RGB")
        im.thumbnail((900, 1600))
        im.save(art, quality=82)
    clips = sum(1 for i in range(len(f["shots"])) if (ms.WORK / f"film_{f['id']}_s{i}.mp4").exists())
    out.append({"id": f["id"], "title": f["title"], "tagline": f["tagline"], "genre": f["genre"], "aspect": f["aspect"],
                "art": art.name, "rendered": clips, "tips": f["tips"], "score": f["audio"],
                "shots": [{"n": i + 1, "prompt": x["still"], "motion": x["motion"], "caption": x["caption"]} for i, x in enumerate(f["shots"])]})
(ms.OUT / "films_wip.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
print(out)
