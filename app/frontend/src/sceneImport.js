// Photo analysis (Depth Anything 3 + MoGe field of view + Florence-2 detections) -> a blocked-out 3D scene.
// Distances come from three cues, best first: where an object's feet meet the ground (needs a known camera height),
// a person's apparent height, and the relative depth map. The user fixes whatever is off in the 3D view.

const PERSON = /\b(person|people|man|woman|men|women|boy|girl|child|kid|lady|guy|human|baby|player|driver|rider)\b/;
const FACE = /\b(face|head)\b/;
const SKIP = /\b(coat|jacket|shirt|dress|hat|glasses|tie|scarf|necklace|watch|pants|shoes|clothing|sunglasses|sleeve|arm|leg|body|sky|wall|floor|ground|ceiling|road|grass|sea|water|window|door|face|hair|head|hand|eye|nose|mouth|ear|cloud|mountain|building|tree|house|sidewalk|field)\b/;
const CAM_H = 1.5;

const rad = (d) => (d * Math.PI) / 180;

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

/** Rebuild `stage` from an analysis result of an image that is `aspect` (w/h). Returns a short summary string. */
export function buildFromAnalysis(stage, res, aspect) {
  stage.clear();
  const hfov = rad(Math.min(140, Math.max(20, res.fov_x || 62)));
  const mm = 18 / Math.tan(hfov / 2);
  stage.setAspect(aspect);
  stage.setLens(Math.round(Math.min(135, Math.max(14, mm))));
  stage.shot.position.set(0, CAM_H, 0);
  stage.shot.quaternion.identity();
  stage.setFloor(true);
  stage.setWall(false);
  const th = Math.tan(hfov / 2);                         // half-width at unit distance
  const tv = th / aspect;                                // half-height at unit distance
  const near2z = (n) => 1 / (n * (1 / 1.6 - 1 / 18) + 1 / 18);   // DA3 near=1 -> ~1.6 m, far=0 -> ~18 m

  const all = (res.objects || []).filter((o) => o.box && o.label);
  const faces = all.filter((o) => FACE.test(o.label) && /human|person|man|woman/.test(o.label) && !/eye|mouth|nose|ear/.test(o.label));
  // each detected face becomes a person; their body is implied (a person box that contains a face is dropped)
  const contains = (b, f) => { const cx = (f.box[0] + f.box[2]) / 2, cy = (f.box[1] + f.box[3]) / 2; return cx > b[0] && cx < b[2] && cy > b[1] && cy < b[3]; };
  let objs = all.filter((o) => !SKIP.test(o.label) && !FACE.test(o.label) && !(PERSON.test(o.label) && faces.some((f) => contains(o.box, f))));
  objs.sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]));
  const kept = [];
  for (const o of objs) if (!kept.some((k) => iou(k.box, o.box) > 0.55)) kept.push(o);
  objs = kept.slice(0, 8);

  let people = 0;
  // people from faces: a face is ~0.24 m tall, which fixes the distance; its position in frame fixes the head height
  faces.sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]));
  faces.slice(0, 5).forEach((f, n) => {
    const [fx0, fy0, fx1, fy1] = f.box;
    const fh = Math.max(0.02, fy1 - fy0);
    const z = Math.min(40, Math.max(0.6, 0.24 / (2 * fh * tv)));
    const x = ((fx0 + fx1) / 2 - 0.5) * 2 * th * z;
    const headY = CAM_H + (0.5 - (fy0 + fy1) / 2) * 2 * tv * z;
    const height = Math.min(2.1, Math.max(1.0, headY / 0.93));
    people += 1;
    stage.add('person', { label: faces.length > 1 ? `person ${n + 1}` : 'person', gender: 'male', position: [x, 0, -z], rotationY: Math.atan2(-x, z), height, silent: true });
  });
  for (const o of objs) {
    const [x0, y0, x1, y1] = o.box;
    const cx = (x0 + x1) / 2, bh = y1 - y0, bw = x1 - x0;
    const person = PERSON.test(o.label);
    // distance along the view axis
    let z = null;
    const dy = (y1 - 0.5) * 2 * tv;                      // tan of the angle below the horizon at the feet
    const cut = y1 > 0.97 || y0 < 0.02;
    if (dy > 0.03 && !cut) z = CAM_H / dy;
    if (person && (cut || z == null || z > 40)) z = 1.7 / Math.max(0.05, bh * 2 * tv);
    if (z == null && o.near != null) z = near2z(o.near);
    if (z == null) z = 5;
    z = Math.min(40, Math.max(0.8, z));
    const x = (cx - 0.5) * 2 * th * z;
    if (person) {
      people += 1;
      const item = stage.add('person', { label: o.label, position: [x, 0, -z], rotationY: Math.atan2(-x, z), height: 1.7, silent: true });
    } else {
      const w = Math.max(0.15, bw * 2 * th * z), h = Math.max(0.15, bh * 2 * tv * z);
      const item = stage.add('box', { label: o.label, silent: true, position: [x, h / 2, -z], scale: [w, h, Math.min(w, h) * 0.9] });
      item.note = '';
    }
  }
  stage.orbit.target.set(0, 1, -6);
  stage.cam.position.set(7, 5, 3);
  stage.orbit.update();
  stage.select(null);
  const props = objs.filter((o) => !PERSON.test(o.label)).length;
  return `${people} ${people === 1 ? 'person' : 'people'} and ${props} object${props === 1 ? '' : 's'} found · lens ${Math.round(mm)} mm`;
}
