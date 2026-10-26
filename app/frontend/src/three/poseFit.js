import * as THREE from 'three';

/**
 * Photo pose -> Figure pose.
 *
 * Input: one person's 33 MediaPipe world landmarks [[x, y, z, visibility]...] (metres, origin between the hips; x to the image's right,
 * y DOWN, z AWAY from the camera - a person's left side appears on the image's right when they face the camera).
 *
 * The body is put in its own upright frame (+X = its left, +Y up, +Z = the way the hips face); every limb is then aimed along the
 * direction the photo shows, from the torso outward, so each joint rotates relative to its parent exactly like the Figure's FK.
 * Twist along a limb cannot be seen in a single photo and is left at zero.
 * Returns { pose, yaw, scale, confidence }. `pose` goes straight into Figure.setPose.
 */
const L = { nose: 0, lear: 7, rear: 8, lsh: 11, rsh: 12, lel: 13, rel: 14, lwr: 15, rwr: 16, lpi: 17, rpi: 18, lin: 19, rin: 20, lhip: 23, rhip: 24, lkn: 25, rkn: 26, lan: 27, ran: 28, lft: 31, rft: 32 };
const SWAP = [[7, 8], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32], [1, 4], [2, 5], [3, 6], [9, 10]];
const D2R = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const FOOT_REST = new THREE.Vector3(0, -0.3, 0.95).normalize();   // from the ankle toward the toes in the Figure's rest pose

const q = (a, b) => new THREE.Quaternion().setFromUnitVectors(a, b);
const norm = (v) => (v.lengthSq() > 1e-10 ? v.clone().normalize() : null);

/** Quaternion of a frame given its left-pointing axis and forward-pointing axis (right-handed: x = left, y = up, z = forward). */
function frameQuat(left, fwd) {
  const x = left.clone().normalize();
  const z = fwd.clone().sub(x.clone().multiplyScalar(fwd.dot(x))).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

export function fitPose(world, { mirror = false } = {}) {
  let pts = world.map(([x, y, z, v]) => ({ p: new THREE.Vector3(x, -y, -z), v: v ?? 1 }));   // camera frame: +X right, +Y up, +Z toward the viewer
  if (mirror) {
    pts = pts.map((o) => ({ p: new THREE.Vector3(-o.p.x, o.p.y, o.p.z), v: o.v }));
    SWAP.forEach(([a, b]) => { [pts[a], pts[b]] = [pts[b], pts[a]]; });
  }
  const P = (i) => pts[i].p;
  const vis = (...ids) => ids.reduce((s, i) => s + pts[i].v, 0) / ids.length;
  const mid = (a, b) => P(a).clone().add(P(b)).multiplyScalar(0.5);

  // ---- body frame from the hip line (flat on the ground plane) and world-up
  const hipMid = mid(L.lhip, L.rhip);
  const hipLine = P(L.lhip).clone().sub(P(L.rhip)); hipLine.y = 0;
  const Lb = norm(hipLine) || new THREE.Vector3(1, 0, 0);
  const Zb = new THREE.Vector3().crossVectors(Lb, UP);
  const yaw = Math.atan2(Zb.x, Zb.z);                       // 0 = facing the camera, +90 deg = turned toward the image's right
  const B = (i) => { const d = P(i).clone().sub(hipMid); return new THREE.Vector3(d.dot(Lb), d.y, d.dot(Zb)); };
  const Bmid = (a, b) => B(a).add(B(b)).multiplyScalar(0.5);

  // ---- size: leg length against the Figure's (thigh 0.44 + shin 0.40)
  const leg = (h, k, a) => B(h).distanceTo(B(k)) + B(k).distanceTo(B(a));
  const scale = Math.max(0.3, Math.min(3, ((leg(L.lhip, L.lkn, L.lan) + leg(L.rhip, L.rkn, L.ran)) / 2) / 0.84));

  const rot = {};                                            // bone -> local quaternion
  const wq = { hips: new THREE.Quaternion() };               // bone -> world (body-frame) quaternion
  const place = (bone, parent, localQ) => { rot[bone] = localQ; wq[bone] = wq[parent].clone().multiply(localQ); };
  const aim = (parent, dirBody, rest) => {                   // rotate `rest` onto `dirBody`, expressed in the parent's frame
    const d = norm(dirBody);
    if (!d) return new THREE.Quaternion();
    return q(rest, d.applyQuaternion(wq[parent].clone().invert()));
  };

  // ---- torso: lean from the hip-to-shoulder direction (split over spine and chest), twist from the shoulder line
  const shMid = Bmid(L.lsh, L.rsh);
  const torso = norm(shMid) || UP.clone();
  const bend = q(UP, torso);
  const half = new THREE.Quaternion().slerp(bend, 0.5);
  place('spine', 'hips', half);
  const ls = B(L.lsh).sub(B(L.rsh));
  const lsFlat = ls.clone().sub(torso.clone().multiplyScalar(ls.dot(torso)));
  const lRef = new THREE.Vector3(1, 0, 0).applyQuaternion(bend);
  let twist = 0;
  if (lsFlat.lengthSq() > 1e-8) twist = Math.atan2(new THREE.Vector3().crossVectors(lRef, lsFlat).dot(torso), lRef.dot(lsFlat));
  place('chest', 'spine', half.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, twist)));

  // ---- neck and head
  const earMid = Bmid(L.lear, L.rear);
  place('neck', 'chest', aim('chest', earMid.clone().sub(shMid), UP));
  const headQ = frameQuat(B(L.lear).sub(B(L.rear)), B(L.nose).sub(earMid));
  place('head', 'neck', wq.neck.clone().invert().multiply(headQ));

  // ---- arms
  for (const [s, sh, el, wr, pi, ind] of [['L', L.lsh, L.lel, L.lwr, L.lpi, L.lin], ['R', L.rsh, L.rel, L.rwr, L.rpi, L.rin]]) {
    place('arm' + s, 'chest', aim('chest', B(el).sub(B(sh)), DOWN));
    place('fore' + s, 'arm' + s, aim('arm' + s, B(wr).sub(B(el)), DOWN));
    const hand = Bmid(pi, ind).sub(B(wr));
    place('hand' + s, 'fore' + s, vis(pi, ind) > 0.4 ? aim('fore' + s, hand, DOWN) : new THREE.Quaternion());
  }

  // ---- legs
  for (const [s, hp, kn, an, ft] of [['L', L.lhip, L.lkn, L.lan, L.lft], ['R', L.rhip, L.rkn, L.ran, L.rft]]) {
    place('thigh' + s, 'hips', aim('hips', B(kn).sub(B(hp)), DOWN));
    place('shin' + s, 'thigh' + s, aim('thigh' + s, B(an).sub(B(kn)), DOWN));
    place('foot' + s, 'shin' + s, vis(ft) > 0.4 ? aim('shin' + s, B(ft).sub(B(an)), FOOT_REST) : new THREE.Quaternion());
  }

  // ---- pelvis height: how far the hips sit above the lower ankle, against a straight standing leg (0.87 m at reference size)
  const lowAnkle = Math.min(B(L.lan).y, B(L.ran).y);
  const drop = Math.max(-0.9, Math.min(0.1, -lowAnkle / scale - 0.87));

  const r = { hips: [0, 0, 0] };
  for (const [bone, quat] of Object.entries(rot)) {
    const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
    r[bone] = [e.x / D2R, e.y / D2R, e.z / D2R].map((v) => Math.round(v * 10) / 10);
  }
  const confidence = vis(L.lsh, L.rsh, L.lhip, L.rhip, L.lel, L.rel, L.lkn, L.rkn);
  return { pose: { r, drop, hands: ['relaxed', 'relaxed'], clamp: false, name: 'photo' }, yaw, scale, confidence };
}

/** Bones joined for drawing the detected skeleton over the photo. */
export const SKELETON = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [0, 7], [0, 8], [7, 8]];

/** The people on stage ordered left to right as the shot camera sees them. */
export function figuresLeftToRight(stage) {
  stage.shot.updateMatrixWorld(); stage.shot.updateProjectionMatrix();
  const v = new THREE.Vector3();
  return stage.items.filter((i) => i.kind === 'person').map((it) => ({ it, x: v.copy(it.root.position).project(stage.shot).x })).sort((a, b) => a.x - b.x).map((o) => o.it);
}

/**
 * Where the person in a photo would stand on the floor under the current shot camera.
 * Distance does not come from how tall their box is (a crouching person is short but not far away): it comes from how big their
 * limbs look. MediaPipe's world landmarks are in metres, so (limb length in the picture) / (limb length in metres) gives the
 * picture's scale, and a limb of 1 m fills 1 / (2 d tan(vfov/2)) of the image height at distance d.
 */
export function placeFromPhoto(stage, pose, aspect) {
  const cam = stage.shot;
  cam.updateMatrixWorld();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion); fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
  const vt = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2), ht = vt * (aspect || stage.aspect);
  const segs = [[11, 23], [12, 24], [23, 25], [24, 26], [25, 27], [26, 28], [11, 13], [12, 14], [13, 15], [14, 16]];
  const ratios = [];
  for (const [a, b] of segs) {
    const A = pose.image[a], B = pose.image[b], WA = pose.world[a], WB = pose.world[b];
    if (A[3] < 0.5 || B[3] < 0.5) continue;
    const wl = Math.hypot(WB[0] - WA[0], WB[1] - WA[1]);                   // metres, in the picture plane
    if (wl < 0.1) continue;
    ratios.push(Math.hypot((B[0] - A[0]) * (aspect || stage.aspect), B[1] - A[1]) / wl);
  }
  ratios.sort((x, y) => x - y);
  const r = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0.55;   // image heights per metre
  const dist = Math.min(16, Math.max(1.3, 1 / (r * 2 * vt)));
  const hipX = (pose.image[23][0] + pose.image[24][0]) / 2;
  const p = cam.position.clone().add(fwd.clone().multiplyScalar(dist)).add(right.multiplyScalar((hipX * 2 - 1) * dist * ht));
  return { position: [p.x, 0, p.z], toCamera: Math.atan2(cam.position.x - p.x, cam.position.z - p.z), distance: dist };
}
