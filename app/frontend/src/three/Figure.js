import * as THREE from 'three';

/**
 * Figure — a posable human mannequin (think Poser): a real bone hierarchy with fingers and a face, 2-bone IK for hands and
 * feet, a pose library and body proportions. Figure space: metres, feet on y=0, the figure faces +Z, its LEFT side is +X.
 * Every limb bone hangs along -Y at rest and rotates about its own joint, so FK is "rotate the joint ring".
 *
 * Angle conventions (degrees, per bone [x, y, z]):
 *   knee flexion = +x on shin          elbow flexion = -x on foreArm        hip flexion (thigh forward) = -x on thigh
 *   arm raise forward = -x on arm      arm out to the side: left +z, right -z      lean forward = +x on spine/chest
 */

const REF_H = 1.8;

export const BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'armL', 'foreL', 'handL', 'armR', 'foreR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR',
];
const NICE = {
  hips: 'pelvis', spine: 'lower spine', chest: 'chest', neck: 'neck', head: 'head',
  armL: 'left shoulder', foreL: 'left elbow', handL: 'left wrist', armR: 'right shoulder', foreR: 'right elbow', handR: 'right wrist',
  thighL: 'left hip', shinL: 'left knee', footL: 'left ankle', thighR: 'right hip', shinR: 'right knee', footR: 'right ankle',
};
export const jointName = (b) => NICE[b] || b;
export const IK_BONES = ['handL', 'handR', 'footL', 'footR'];
export const HINGE_END = { foreL: 'handL', foreR: 'handR', shinL: 'footL', shinR: 'footR' };   // elbow / knee -> the hand / foot it keeps in place     // wrists and ankles are drag-to-move handles

const FINGER = {            // curl per finger [thumb, index, middle, ring, pinky], 0 open … 1 closed
  open: [0, 0, 0, 0, 0],
  relaxed: [0.25, 0.3, 0.35, 0.4, 0.45],
  fist: [0.8, 1, 1, 1, 1],
  point: [0.9, 0, 1, 1, 1],
  grip: [0.5, 0.7, 0.7, 0.7, 0.7],
  peace: [0.9, 0, 0, 1, 1],
  thumbs: [0, 1, 1, 1, 1],
};
export const HAND_POSES = Object.keys(FINGER);

const mirrorKey = (k) => (k.endsWith('L') ? `${k.slice(0, -1)}R` : k.endsWith('R') ? `${k.slice(0, -1)}L` : k);

/** Pose library. `r` = FK degrees, `drop` = pelvis lowered (m), `ik` = hand/foot targets in figure space, `hands` = finger poses. */
export const POSES = {
  stand: { label: 'Stand', r: { armL: [0, 0, 5], armR: [0, 0, -5] } },
  relaxed: { label: 'Relaxed', r: { armL: [-4, 0, 9], armR: [-4, 0, -9], foreL: [-14, 0, 0], foreR: [-14, 0, 0], thighL: [0, 0, 2], thighR: [0, 0, -2], head: [0, 0, 0] }, hands: ['relaxed', 'relaxed'] },
  sit: { label: 'Sit', drop: -0.44, r: { thighL: [-90, 0, 2], thighR: [-90, 0, -2], shinL: [90, 0, 0], shinR: [90, 0, 0], armL: [-28, 0, 6], armR: [-28, 0, -6], foreL: [-62, 0, 0], foreR: [-62, 0, 0] }, hands: ['relaxed', 'relaxed'] },
  walk: { label: 'Walk', r: { thighL: [-26, 0, 0], shinL: [12, 0, 0], thighR: [18, 0, 0], shinR: [8, 0, 0], armL: [22, 0, 5], armR: [-22, 0, -5], foreL: [-14, 0, 0], foreR: [-26, 0, 0], spine: [2, -6, 0], chest: [0, 8, 0] }, hands: ['relaxed', 'relaxed'] },
  run: { label: 'Run', r: { thighL: [-72, 0, 0], shinL: [100, 0, 0], thighR: [28, 0, 0], shinR: [55, 0, 0], armL: [42, 0, 6], armR: [-52, 0, -6], foreL: [-95, 0, 0], foreR: [-95, 0, 0], spine: [10, -8, 0], chest: [6, 10, 0], head: [-8, 0, 0] }, hands: ['fist', 'fist'] },
  hips: { label: 'Hands on hips', ik: { handL: [0.27, 1.0, -0.02], handR: [-0.27, 1.0, -0.02] }, poles: { handL: [1, 0.05, -0.35], handR: [-1, 0.05, -0.35] }, r: { thighL: [0, 0, 5], thighR: [0, 0, -5] }, hands: ['relaxed', 'relaxed'] },
  crossed: { label: 'Arms crossed', ik: { handL: [-0.04, 1.17, 0.2], handR: [0.04, 1.11, 0.25] }, poles: { handL: [0.55, -1, 0.3], handR: [-0.55, -1, 0.3] }, hands: ['relaxed', 'relaxed'] },
  point: { label: 'Point', ik: { handL: [0.22, 1.42, 0.52] }, r: { armR: [0, 0, -6], chest: [0, -10, 0] }, hands: ['point', 'relaxed'] },
  handsup: { label: 'Hands up', ik: { handL: [0.3, 1.95, 0.12], handR: [-0.3, 1.95, 0.12] }, poles: { handL: [0.6, -1, -0.1], handR: [-0.6, -1, -0.1] }, hands: ['open', 'open'] },
  reach: { label: 'Reach out', ik: { handL: [0.15, 1.35, 0.5] }, r: { spine: [8, 0, 0] }, hands: ['open', 'relaxed'] },
  guard: { label: 'Fight stance', poles: { handL: [0.25, -1, 0.1], handR: [-0.25, -1, 0.1] }, r: { thighL: [-18, 0, 12], thighR: [14, 0, -12], shinL: [26, 0, 0], shinR: [18, 0, 0], spine: [8, 25, 0], head: [6, -10, 0] }, ik: { handL: [0.12, 1.45, 0.38], handR: [-0.14, 1.4, 0.32] }, hands: ['fist', 'fist'] },
  crouch: { label: 'Crouch', drop: -0.5, ik: { footL: [0.13, 0.08, 0.1], footR: [-0.13, 0.08, 0.1] }, r: { spine: [28, 0, 0], chest: [14, 0, 0], armL: [-40, 0, 10], armR: [-40, 0, -10], foreL: [-40, 0, 0], foreR: [-40, 0, 0], head: [-35, 0, 0] }, hands: ['relaxed', 'relaxed'] },
  kneel: { label: 'Kneel', drop: -0.43, r: { thighL: [0, 0, 3], thighR: [0, 0, -3], shinL: [88, 0, 0], shinR: [88, 0, 0], footL: [10, 0, 0], footR: [10, 0, 0], armL: [-25, 0, 6], armR: [-25, 0, -6], foreL: [-30, 0, 0], foreR: [-30, 0, 0], head: [10, 0, 0] }, hands: ['relaxed', 'relaxed'] },
  phone: { label: 'On the phone', ik: { handL: [0.13, 1.64, 0.06] }, poles: { handL: [0.35, -1, 0.3] }, r: { armR: [0, 0, -7], head: [0, -10, 0] }, hands: ['grip', 'relaxed'] },
};

const D2R = Math.PI / 180;

/** Poser-style anatomy: every value is a multiplier (1 = average) except bust/belly/muscle (0..1) and the labels. */
export const DEFAULT_BUILD = {
  male: { gender: 'male', height: 1.78, shoulders: 1.1, chest: 1.08, bust: 0, waist: 1.0, hips: 0.92, glutes: 0.95, belly: 0.08, thighs: 1.0, calves: 1.02, arms: 1.1, neck: 1.18, head: 1.0, muscle: 0.55, hair: 'short' },
  female: { gender: 'female', height: 1.66, shoulders: 0.88, chest: 0.93, bust: 0.6, waist: 0.76, hips: 1.16, glutes: 1.14, belly: 0.04, thighs: 1.08, calves: 0.9, arms: 0.84, neck: 0.8, head: 0.97, muscle: 0.15, hair: 'long' },
};
export const HAIR_STYLES = ['none', 'short', 'bob', 'long', 'ponytail', 'bun'];
export const BODY_SLIDERS = [   // [key, label, min, max, step]
  ['shoulders', 'Shoulders', 0.75, 1.35, 0.01], ['chest', 'Chest / ribcage', 0.8, 1.4, 0.01], ['bust', 'Bust', 0, 1, 0.01],
  ['waist', 'Waist', 0.65, 1.45, 0.01], ['belly', 'Belly', 0, 1, 0.01], ['hips', 'Hips', 0.8, 1.5, 0.01], ['glutes', 'Glutes', 0.8, 1.5, 0.01],
  ['thighs', 'Thighs', 0.7, 1.6, 0.01], ['calves', 'Calves', 0.7, 1.5, 0.01], ['arms', 'Arms', 0.7, 1.6, 0.01],
  ['neck', 'Neck', 0.7, 1.4, 0.01], ['head', 'Head size', 0.9, 1.15, 0.01], ['muscle', 'Muscle definition', 0, 1, 0.01],
];

/** Words for the image model: the depth map already carries the silhouette, this adds what a silhouette cannot say. */
export function describeBuild(b) {
  const f = b.gender === 'female';
  const d = DEFAULT_BUILD[b.gender] || DEFAULT_BUILD.male;
  const out = [f ? 'woman' : 'man'];
  const h = b.height;
  if (h > (f ? 1.76 : 1.88)) out.push('tall'); else if (h < (f ? 1.56 : 1.68)) out.push('short');
  const lean = (b.arms + b.thighs + b.waist) / 3;
  if (b.muscle > 0.7) out.push('muscular, athletic build');
  else if (lean < 0.86) out.push('slim, slender build');
  else if (lean > 1.22) out.push('heavyset, full-figured build');
  if (b.shoulders - d.shoulders > 0.14) out.push('broad shoulders'); else if (d.shoulders - b.shoulders > 0.14) out.push('narrow shoulders');
  if (b.waist < d.waist - 0.14) out.push('narrow waist'); else if (b.waist > d.waist + 0.2) out.push('wide waist');
  if (b.belly > 0.55) out.push('soft belly');
  if (b.hips > d.hips + 0.15) out.push('wide hips'); else if (b.hips < d.hips - 0.12) out.push('narrow hips');
  if (f) { if (b.bust > 0.75) out.push('full bust'); else if (b.bust < 0.25) out.push('small bust'); }
  if (b.thighs > d.thighs + 0.22) out.push('thick thighs'); else if (b.thighs < d.thighs - 0.18) out.push('slender legs');
  if (b.hair === 'none') out.push('bald'); else if (b.hair) out.push(`${b.hair} hair`);
  return out.join(', ');
}


const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** A sculpted human head: a lofted skull from a real facial profile (chin, lips, nose base, brow, forehead, crown), then soft features. */
export function headGeometry(female) {
  const rows = 64, cols = 72;
  const K = [   // y, half-width, front depth, back depth
    [0.000, 0.022, 0.030, -0.030],
    [0.008, 0.036, 0.062, -0.038],
    [0.020, 0.047, 0.080, -0.052],
    [0.038, 0.056, 0.085, -0.068],
    [0.058, 0.063, 0.080, -0.082],
    [0.082, 0.069, 0.079, -0.093],
    [0.108, 0.073, 0.074, -0.099],
    [0.134, 0.077, 0.086, -0.101],
    [0.160, 0.077, 0.084, -0.100],
    [0.186, 0.069, 0.072, -0.091],
    [0.208, 0.052, 0.052, -0.071],
    [0.224, 0.026, 0.026, -0.036],
    [0.231, 0.000, 0.000, 0.000],
  ];
  const W = female ? 0.94 : 1;
  const jawW = (y) => (female ? 0.9 + 0.1 * smooth(0.0, 0.09, y) : 1) * W;
  const cr = (i, t, ch) => {   // Catmull-Rom through channel ch of the key rows
    const g = (k) => K[Math.min(K.length - 1, Math.max(0, k))][ch];
    const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  };
  const sample = (y, ch) => {
    let i = 0;
    while (i < K.length - 2 && y > K[i + 1][0]) i++;
    const t = Math.min(1, Math.max(0, (y - K[i][0]) / (K[i + 1][0] - K[i][0])));
    return cr(i, t, ch);
  };
  const pos = [], idx = [];
  const sp = (v, e) => Math.sign(v) * Math.abs(v) ** e;
  const E = 2 / 2.35;                                    // slightly squared cross-section
  for (let r = 0; r <= rows; r++) {
    const y = (r / rows) * 0.231;
    const w = Math.max(0, sample(y, 1)) * jawW(y), zf = Math.max(0, sample(y, 2)), zb = sample(y, 3);
    for (let c = 0; c < cols; c++) {
      const a = (c / cols) * Math.PI * 2;
      const sn = Math.sin(a), cs = Math.cos(a);
      pos.push(w * sp(sn, E), y, (cs >= 0 ? zf : zb) * Math.abs(cs) ** E);   // zb is negative: the back of the skull
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a0 = r * cols + c, b0 = r * cols + ((c + 1) % cols), c0 = (r + 1) * cols + c, d0 = (r + 1) * cols + ((c + 1) % cols);
      idx.push(a0, b0, c0, b0, d0, c0);
    }
  }
  const bot = pos.length / 3; pos.push(0, 0, 0);          // chin-bottom cap
  for (let c = 0; c < cols; c++) idx.push(bot, (c + 1) % cols, c);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();

  // soft facial features, pushed along the surface normal; front of the face only
  const F = female ? 0.8 : 1;
  const feats = [   // x, y, sigma x, sigma y, amplitude
    [0, 0.097, 0.0058, 0.017, 0.0095],                      // nose bridge
    [0, 0.076, 0.0098, 0.0098, 0.022 * (female ? 0.86 : 1)],   // nose tip
    [0.0118, 0.071, 0.0068, 0.0078, 0.0058], [-0.0118, 0.071, 0.0068, 0.0078, 0.0058],   // nostril wings
    [0, 0.0505, 0.016, 0.0062, 0.0085], [0, 0.0385, 0.0155, 0.0072, female ? 0.0105 : 0.0082],   // lips (subtle)
    [0, 0.0445, 0.014, 0.0022, -0.0042],                     // mouth line
    [0, 0.016, 0.016, 0.012, female ? 0.0075 : 0.0105],                        // chin
    [0.052, 0.088, 0.018, 0.014, 0.0035], [-0.052, 0.088, 0.018, 0.014, 0.0035],       // cheekbones
    [0.031, 0.111, 0.0135, 0.0085, -0.0085], [-0.031, 0.111, 0.0135, 0.0085, -0.0085],   // eye sockets
    [0, 0.1285, 0.046, 0.0075, female ? 0.0035 : 0.0075],                                   // brow ridge
  ];
  const pa = g.attributes.position, na = g.attributes.normal;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
    if (z < 0.01) continue;
    const front = smooth(0.01, 0.05, z);
    let d = 0;
    for (const [fx, fy, sx, sy, amp] of feats) d += amp * Math.exp(-(((x - fx) / sx) ** 2 + ((y - fy) / sy) ** 2) / 2);
    d *= front;
    pa.setXYZ(i, x + na.getX(i) * d, y + na.getY(i) * d, z + na.getZ(i) * d);
  }
  g.computeVertexNormals();
  return g;
}

/** Hair as a scalp shell that follows the skull above a natural hairline (high at the forehead, low at the nape). */
export function scalpGeometry(female, lift = 0.008) {
  const base = headGeometry(female);
  const pa = base.attributes.position, na = base.attributes.normal, ia = base.index;
  const hairline = (x, z) => { const t = Math.abs(Math.atan2(x, z)) / Math.PI; return 0.178 - 0.13 * smooth(0.12, 1.0, t); };
  const pos = [], idx = [];
  for (let i = 0; i < pa.count; i++) pos.push(pa.getX(i) + na.getX(i) * lift, pa.getY(i) + na.getY(i) * lift, pa.getZ(i) + na.getZ(i) * lift);
  for (let t = 0; t < ia.count; t += 3) {
    const [a, b, c] = [ia.getX(t), ia.getX(t + 1), ia.getX(t + 2)];
    const cx = (pa.getX(a) + pa.getX(b) + pa.getX(c)) / 3, cy = (pa.getY(a) + pa.getY(b) + pa.getY(c)) / 3, cz = (pa.getZ(a) + pa.getZ(b) + pa.getZ(c)) / 3;
    if (cy > hairline(cx, cz)) idx.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** Loft a smooth closed surface through stacked elliptical rings [{y, rx, rz, zc}] (bottom to top). */
function loft(rings, seg = 32) {
  const pos = [], idx = [];
  rings.forEach((r) => { for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; pos.push(Math.sin(a) * r.rx, r.y, r.zc + Math.cos(a) * r.rz); } });
  for (let j = 0; j < rings.length - 1; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * seg + i, b = j * seg + ((i + 1) % seg), c = (j + 1) * seg + i, d = (j + 1) * seg + ((i + 1) % seg);
      idx.push(a, b, c, b, d, c);
    }
  }
  [[0, 0], [rings.length - 1, 1]].forEach(([j, top]) => {
    const r = rings[j]; const ci = pos.length / 3; pos.push(0, r.y, r.zc);
    for (let i = 0; i < seg; i++) { const a = j * seg + i, b = j * seg + ((i + 1) % seg); idx.push(...(top ? [ci, b, a] : [ci, a, b])); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// Joint limits in degrees [min, max] per axis, written for the LEFT side; the right side mirrors y and z.
const LIMITS = {
  hips: [[-35, 35], [-45, 45], [-25, 25]],
  spine: [[-25, 50], [-40, 40], [-25, 25]],
  chest: [[-20, 35], [-45, 45], [-20, 20]],
  neck: [[-35, 45], [-60, 60], [-30, 30]],
  head: [[-40, 45], [-70, 70], [-35, 35]],
  arm: [[-180, 70], [-90, 90], [-50, 175]],       // shoulder: forward raise is -x, out to the side is +z (left)
  fore: [[-150, 3], [-85, 85], [-3, 3]],          // elbow only folds one way
  hand: [[-75, 75], [-25, 25], [-25, 30]],
  thigh: [[-125, 30], [-45, 45], [-20, 45]],      // hip: knee up is -x
  shin: [[0, 150], [-4, 4], [-3, 3]],             // knee only folds backward
  foot: [[-45, 50], [-25, 25], [-20, 20]],
};
const limitFor = (bone) => {
  const side = bone.endsWith('R') ? -1 : 1;
  const key = /[LR]$/.test(bone) ? bone.slice(0, -1) : bone;
  const L = LIMITS[key];
  if (!L) return null;
  if (side === 1) return L;
  const flip = ([a, b]) => [-b, -a];
  return [L[0], flip(L[1]), flip(L[2])];
};

function bodyMat(color) {
  // soft-matte sculpt look: a little sheen at grazing angles reads as skin/clay instead of hard plastic
  return new THREE.MeshPhysicalMaterial({ color, roughness: 0.62, metalness: 0, sheen: 0.8, sheenRoughness: 0.55, sheenColor: new THREE.Color(0xffe8dc) });
}

/** Build a figure. `build` = { height, width (shoulders/hips), mass (limb thickness) } */
export class Figure {
  constructor(color = 0x4fd1ff, build = {}) {
    this.color = color;
    this.build = { ...DEFAULT_BUILD[build.gender || 'male'], ...build };
    this.mat = bodyMat(color);
    this.hairMat = new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.9 });
    this.hands = ['relaxed', 'relaxed'];
    this.poseName = 'stand';
    this.pose = { r: {}, drop: 0 };
    this.limitsOn = true;
    this._make();
  }

  _make() {
    const b = this.build;
    const female = b.gender === 'female';
    const mat = this.mat;
    mat.side = THREE.DoubleSide;
    const hairMat = this.hairMat;
    const root = new THREE.Group();
    this.root = root;
    this.bones = {};
    this.handles = [];
    this.ikTargets = {};
    this.poleTargets = {};

    const bone = (name, parent, x, y, z) => {
      const g = new THREE.Group(); g.name = name; g.position.set(x, y, z);
      parent.add(g); this.bones[name] = g; return g;
    };
    const add = (parent, mesh, x = 0, y = 0, z = 0) => { mesh.position.set(x, y, z); parent.add(mesh); return mesh; };
    const ell = (rx, ry, rz, m = mat) => { const s = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), m); s.scale.set(rx, ry, rz); return s; };

    // ---- trunk: lofted from stacked elliptical rings so waist, hips, belly and chest are real shape, not blobs
    const P = {
      sh: b.shoulders, ch: b.chest, wa: b.waist, hi: b.hips, gl: b.glutes, be: b.belly, ne: b.neck,
    };
    const keys = [   // y (absolute), half-width, half-depth, centre z
      [0.79, 0.058 * Math.sqrt(P.hi), 0.07, -0.004],
      [0.83, 0.118 * P.hi, 0.09 + 0.014 * P.gl, -0.016 * P.gl],
      [0.89, 0.15 * P.hi, 0.098 + 0.026 * P.gl, -0.026 * P.gl],
      [0.96, 0.146 * P.hi, 0.098 + 0.016 * P.gl + 0.02 * P.be, -0.014 * P.gl + 0.008 * P.be],
      [1.06, 0.13 * (0.55 * P.wa + 0.45 * P.hi), 0.09 + 0.04 * P.be, 0.004 + 0.014 * P.be],
      [1.16, 0.122 * P.wa, 0.087 + 0.045 * P.be, 0.008 + 0.02 * P.be],
      [1.27, 0.14 * P.ch * (0.9 + 0.1 * P.wa), 0.098 + 0.02 * P.be, 0.004],
      [1.37, 0.162 * P.ch, 0.108 + (female ? 0.012 : 0.006) * b.chest, 0.004],
      [1.44, 0.172 * P.sh, 0.098, 0],
      [1.475, 0.15 * P.sh, 0.086, -0.002],
      [1.505, 0.1 * P.sh, 0.07, -0.004],
      [1.535, 0.066 * P.ne, 0.06, -0.004],
    ];
    const prof = (y) => {
      if (y <= keys[0][0]) return keys[0].slice(1);
      for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i], c = keys[i + 1];
        if (y <= c[0]) {
          const t = (y - a[0]) / (c[0] - a[0]); const s = t * t * (3 - 2 * t);
          return [a[1] + (c[1] - a[1]) * s, a[2] + (c[2] - a[2]) * s, a[3] + (c[3] - a[3]) * s];
        }
      }
      return keys[keys.length - 1].slice(1);
    };
    const trunk = (y0, y1, originY, n) => {
      const rings = [];
      for (let i = 0; i <= n; i++) { const y = y0 + ((y1 - y0) * i) / n; const [rx, rz, zc] = prof(y); rings.push({ y: y - originY, rx, rz, zc }); }
      const geo = loft(rings, 32);
      // analytic normals from the body profile, so neighbouring segments shade identically at their shared ring (no seam lines)
      const na = geo.attributes.normal, seg = 32;
      for (let j = 0; j < rings.length; j++) {
        const y = rings[j].y + originY;
        const [rx0, rz0] = prof(y - 0.006), [rx1, rz1] = prof(y + 0.006);
        const slope = ((rx1 + rz1) / 2 - (rx0 + rz0) / 2) / 0.012;
        for (let i = 0; i < seg; i++) {
          const ang = (i / seg) * Math.PI * 2;
          const nx = Math.sin(ang) * rings[j].rz, nz = Math.cos(ang) * rings[j].rx;
          const l = Math.hypot(nx, nz) || 1;
          const v = new THREE.Vector3(nx / l, -slope, nz / l).normalize();
          na.setXYZ(j * seg + i, v.x, v.y, v.z);
        }
      }
      na.needsUpdate = true;
      return new THREE.Mesh(geo, mat);
    };

    const hips = bone('hips', root, 0, 0.95, 0);
    add(hips, trunk(0.79, 1.05, 0.95, 10));
    const spine = bone('spine', hips, 0, 0.1, 0);
    add(spine, trunk(1.05, 1.25, 1.05, 6));
    const chest = bone('chest', spine, 0, 0.2, 0);
    add(chest, trunk(1.25, 1.535, 1.25, 9));
    // glutes and bust as separate rounded forms (a neutral mannequin: smooth volumes, no surface detail)
    [1, -1].forEach((sd) => {
      if (b.bust > 0.04) {
        const r = 0.038 + 0.032 * b.bust;
        add(chest, ell(r, r * 1.02, r * 0.95), sd * 0.083 * P.ch, 0.112, 0.082 + 0.018 * b.bust);
      } else {                                   // pectorals: a flat, wide plate that reads as chest muscle in side light
        add(chest, ell(0.082 * P.ch, 0.05 + 0.01 * b.muscle, 0.018 + 0.012 * b.muscle), sd * 0.08 * P.ch, 0.118, 0.082);
      }
    });

    const neck = bone('neck', chest, 0, 0.24, 0);
    add(neck, new THREE.Mesh(new THREE.CylinderGeometry(0.047 * P.ne, 0.062 * P.ne, 0.14, 28), mat), 0, 0.045, -0.006);
    const head = bone('head', neck, 0, 0.09, 0);
    const hs = b.head;
    const hd = new THREE.Group(); hd.scale.setScalar(hs); head.add(hd);
    hd.add(new THREE.Mesh(headGeometry(female), mat));
    [1, -1].forEach((sd) => {
      add(hd, ell(0.0105, 0.032, 0.019), sd * 0.079, 0.1, -0.012);                       // ears
    });
    const hair = b.hair;
    if (hair !== 'none') {
      hd.add(new THREE.Mesh(scalpGeometry(female, hair === 'short' ? 0.007 : 0.011), hairMat));   // scalp: leaves the face clear
      if (hair === 'long') add(hd, ell(0.098, 0.17, 0.05, hairMat), 0, -0.01, -0.082);
      if (hair === 'bob') add(hd, ell(0.106, 0.07, 0.074, hairMat), 0, 0.045, -0.04);
      if (hair === 'ponytail') { add(hd, ell(0.03, 0.12, 0.03, hairMat), 0, 0.02, -0.12).rotation.x = -0.35; }
      if (hair === 'bun') add(hd, ell(0.05, 0.05, 0.05, hairMat), 0, 0.225, -0.07);
    }

    // ---- limbs: lathe profiles with real muscle shaping, joined by spheres so bends stay smooth
    const mu = b.muscle;
    const limb = (len, r, keysLimb) => {
      const pts = [];
      for (let i = 0; i <= 14; i++) {
        const t = i / 14; let k = 0;
        while (k < keysLimb.length - 2 && t > keysLimb[k + 1][0]) k++;
        const [t0, r0] = keysLimb[k], [t1, r1] = keysLimb[k + 1];
        const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0))); const s = u * u * (3 - 2 * u);
        pts.push(new THREE.Vector2(Math.max(0.004, r * (r0 + (r1 - r0) * s)), -t * len));
      }
      return new THREE.Mesh(new THREE.LatheGeometry(pts, 20), mat);
    };
    const sphere = (r) => new THREE.Mesh(new THREE.SphereGeometry(r, 18, 12), mat);

    const arm = (side, tag) => {
      const sx = side * (0.168 * P.sh + 0.006);
      const a = bone(`arm${tag}`, chest, sx, 0.225, 0);
      const ra = 0.044 * b.arms;
      // deltoid: a long rounded cap that runs down the upper arm instead of a ball stuck on the shoulder
      add(a, ell(ra * (1.12 + 0.18 * mu), 0.072, ra * (1.08 + 0.14 * mu)), 0, -0.052, 0);
      add(a, limb(0.29, ra, [[0, 1.0], [0.3, 1 + 0.2 * mu], [0.72, 0.88], [1, 0.74]]));
      const f = bone(`fore${tag}`, a, 0, -0.29, 0);
      add(f, sphere(ra * 0.74));                                                                // elbow cap == radius at the joint
      add(f, limb(0.26, ra, [[0, 0.74], [0.2, 0.86 + 0.14 * mu], [0.6, 0.7], [1, 0.5]]));
      const h = bone(`hand${tag}`, f, 0, -0.26, 0);
      const hg = new THREE.Group(); const hsz = female ? 0.92 : 1.0; hg.scale.setScalar(hsz); h.add(hg);
      add(hg, ell(0.043, 0.054, 0.019), 0, -0.05, 0);
      this._fingers(h, side, tag, hg);
    };
    arm(1, 'L'); arm(-1, 'R');

    const leg = (side, tag) => {
      const t = bone(`thigh${tag}`, hips, side * 0.088 * P.hi, -0.03, 0);
      const rt = 0.074 * b.thighs;
      add(t, sphere(rt * 1.06), 0, 0.0, 0);                                      // hip cap blends the thigh into the pelvis
      add(t, limb(0.44, rt, [[0, 1.06], [0.28, 1 + 0.1 * mu], [0.74, 0.74], [1, 0.62]]));
      const s = bone(`shin${tag}`, t, 0, -0.44, 0);
      const rc = 0.052 * b.calves;
      const kneeR = rt * 0.62;
      add(s, sphere(kneeR));                                                      // knee cap == radius at the joint
      add(s, limb(0.4, rc, [[0, kneeR / rc], [0.22, 1.0 + 0.18 * mu], [0.66, 0.64], [1, 0.46]]));
      const f = bone(`foot${tag}`, s, 0, -0.4, 0);
      add(f, sphere(rc * 0.46));
      add(f, ell(0.04, 0.034, 0.078), 0, -0.04, 0.03);                            // mid-foot / arch, toes point +z
      add(f, ell(0.037, 0.022, 0.05), 0, -0.052, 0.088);                          // toe box
      add(f, sphere(0.032), 0, -0.04, -0.04);                                      // heel
    };
    leg(1, 'L'); leg(-1, 'R');

    // ---- selection handles: cyan = bend this joint, orange = drag this hand/foot (arm/leg follow)
    BONES.forEach((name) => {
      const ik = IK_BONES.includes(name);
      const hdl = new THREE.Mesh(new THREE.SphereGeometry(0.034, 14, 10),
        new THREE.MeshBasicMaterial({ color: ik ? 0xffa23a : 0x00e5ff, depthTest: false, transparent: true, opacity: 0.9 }));
      hdl.renderOrder = 20; hdl.visible = false;
      hdl.userData.helper = true; hdl.userData.joint = name; hdl.userData.ik = ik;
      this.bones[name].add(hdl);
      this.handles.push(hdl);
      if (ik) {
        const tgt = new THREE.Object3D(); tgt.name = `ik_${name}`; root.add(tgt); this.ikTargets[name] = tgt;
      }
    });
    ['foreL', 'foreR', 'shinL', 'shinR'].forEach((n) => { const t = new THREE.Object3D(); t.name = `pole_${n}`; root.add(t); this.poleTargets[n] = t; });
    this.pelvisTarget = new THREE.Object3D(); root.add(this.pelvisTarget);
    // a ground arrow shows which way the figure faces (layout view only)
    const arrow = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    shaft.rotation.x = Math.PI / 2; shaft.position.z = 0.45;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    tip.rotation.x = Math.PI / 2; tip.position.z = 0.78;
    arrow.add(shaft, tip); arrow.position.y = 0.012;
    arrow.userData.helper = true; shaft.userData.helper = true; tip.userData.helper = true;
    root.add(arrow); this.arrow = arrow;

    root.scale.setScalar(b.height / REF_H);
    this.applyHands(this.hands);
  }

  _fingers(hand, side, tag, parent = hand) {
    const mat = this.mat;
    const fingers = [];
    const defs = [   // [x offset on the palm, length1, length2, radius, base y, thumb?]
      [side * 0.052, 0.034, 0.03, 0.0095, -0.02, true],
      [side * 0.03, 0.04, 0.033, 0.0085, -0.095, false],
      [side * 0.01, 0.045, 0.036, 0.0088, -0.098, false],
      [side * -0.01, 0.041, 0.033, 0.0082, -0.096, false],
      [side * -0.029, 0.033, 0.028, 0.0075, -0.092, false],
    ];
    defs.forEach(([x, l1, l2, r, y, thumb]) => {
      const seg = (len) => new THREE.Mesh(new THREE.CapsuleGeometry(r * 1.2, Math.max(0.001, len - 2.4 * r), 4, 10), mat);
      const g1 = new THREE.Group(); g1.position.set(x, y, 0); parent.add(g1);
      const m1 = seg(l1); m1.position.y = -l1 / 2; g1.add(m1);
      const g2 = new THREE.Group(); g2.position.y = -l1; g1.add(g2);
      const m2 = seg(l2); m2.position.y = -l2 / 2; g2.add(m2);
      if (thumb) g1.rotation.z = side * 0.55;        // thumb angled away from the palm
      fingers.push({ g1, g2, thumb, rest: g1.rotation.z });
    });
    hand.userData.fingers = fingers;
    hand.userData.side = side;
  }

  /** hands = ['fist','open'] (left, right) or arrays of 5 curls. */
  applyHands(hands) {
    this.hands = hands;
    ['L', 'R'].forEach((tag, i) => {
      const h = this.bones[`hand${tag}`];
      const spec = hands[i];
      const curls = Array.isArray(spec) ? spec : FINGER[spec] || FINGER.relaxed;
      const side = h.userData.side;
      h.userData.fingers.forEach((f, n) => {
        const c = curls[n] ?? 0;
        const bend = -side * c * (f.thumb ? 0.9 : 1.25);          // toward the palm
        f.g1.rotation.z = f.rest + bend;
        f.g2.rotation.z = -side * c * (f.thumb ? 0.7 : 1.35);
      });
    });
  }

  // ---------------------------------------------------------------- joint limits
  /** Clamp one bone into its range. Returns true if it had to be pulled back. */
  clampBone(name) {
    if (!this.limitsOn) return false;
    const lim = limitFor(name); const b = this.bones[name];
    if (!lim || !b) return false;
    const e = new THREE.Euler().setFromQuaternion(b.quaternion, 'XYZ');
    const v = [e.x / D2R, e.y / D2R, e.z / D2R];
    let hit = false;
    const out = v.map((x, i) => { const c = Math.min(lim[i][1], Math.max(lim[i][0], x)); if (Math.abs(c - x) > 0.05) hit = true; return c; });
    if (hit) b.rotation.set(out[0] * D2R, out[1] * D2R, out[2] * D2R);
    return hit;
  }

  clampAll() { let any = false; BONES.forEach((n) => { if (this.clampBone(n)) any = true; }); return any; }

  setLimits(on) { this.limitsOn = on; if (on) { this.clampAll(); this.root.updateMatrixWorld(true); } }

  // ---------------------------------------------------------------- pose
  getPose() {
    const r = {};
    BONES.forEach((b) => {
      const e = this.bones[b].rotation;
      r[b] = [e.x / D2R, e.y / D2R, e.z / D2R].map((v) => Math.round(v * 10) / 10);
    });
    return { r, drop: this.bones.hips.position.y - 0.95, hands: this.hands, name: this.poseName };
  }

  setPose(p) {
    BONES.forEach((b) => this.bones[b].rotation.set(0, 0, 0));
    Object.entries(p.r || {}).forEach(([b, v]) => { if (this.bones[b]) this.bones[b].rotation.set(v[0] * D2R, v[1] * D2R, v[2] * D2R); });
    this.bones.hips.position.y = 0.95 + (p.drop || 0);
    if (p.hands) this.applyHands(p.hands);
    if (p.clamp !== false) this.clampAll();      // saved scenes restore exactly (IK may legitimately exceed a hip/shoulder limit)
    this.root.updateMatrixWorld(true);
    Object.entries(p.ik || {}).forEach(([n, pos]) => this.solveIK(n, new THREE.Vector3(...pos), null, p.poles && p.poles[n] ? new THREE.Vector3(...p.poles[n]) : null));
    this.poseName = p.name || this.poseName;
  }

  applyPreset(key) {
    const pre = POSES[key]; if (!pre) return;
    this.setPose({ ...pre, name: key, r: { ...pre.r } });
    this.poseName = key;
  }

  mirror() {
    const cur = this.getPose();
    const out = {};
    Object.entries(cur.r).forEach(([b, v]) => {
      const k = mirrorKey(b);
      const sided = k !== b;
      out[k] = sided ? [v[0], -v[1], -v[2]] : [v[0], -v[1], -v[2]];
    });
    this.setPose({ r: out, drop: cur.drop, hands: [cur.hands[1], cur.hands[0]], name: cur.name });
  }

  setBuild(b) {
    const pose = this.getPose();
    const pos = this.root.position.clone(), rot = this.root.rotation.clone();
    const parent = this.root.parent;
    if (parent) parent.remove(this.root);
    this.build = { ...this.build, ...b };
    this._make();
    this.root.position.copy(pos); this.root.rotation.copy(rot);
    if (parent) parent.add(this.root);
    this.setPose({ ...pose, name: pose.name });
  }

  // ---------------------------------------------------------------- IK (wrist / ankle -> arm / leg)
  /** Move a wrist/ankle to `target` (figure space) and bend the elbow/knee to suit. */
  solveIK(name, target, poleFig = null, poleDir = null) {
    const isArm = name.startsWith('hand');
    const tag = name.slice(-1);
    const side = tag === 'L' ? 1 : -1;
    const upper = this.bones[isArm ? `arm${tag}` : `thigh${tag}`];
    const lower = this.bones[isArm ? `fore${tag}` : `shin${tag}`];
    const end = this.bones[name];
    const l1 = isArm ? 0.29 : 0.44, l2 = isArm ? 0.26 : 0.4;
    this.root.updateMatrixWorld(true);
    const toLocal = (b) => this.root.worldToLocal(b.getWorldPosition(new THREE.Vector3()));
    const P0 = toLocal(upper);
    const d = target.clone().sub(P0);
    const dist = Math.min(l1 + l2 - 0.002, Math.max(Math.abs(l1 - l2) + 0.01, d.length()));
    const dir = d.normalize();
    const pole = isArm ? new THREE.Vector3(side * 0.35, -0.3, -0.9) : new THREE.Vector3(side * 0.08, 0.1, 1);
    if (poleDir) pole.copy(poleDir);
    else if (poleFig) { const pd = poleFig.clone().sub(P0); if (pd.lengthSq() > 1e-6) pole.copy(pd); }   // dragging the elbow / knee sets which way it points
    pole.normalize();
    const perp = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir)));
    if (perp.lengthSq() < 1e-6) perp.set(0, 0, 1);
    perp.normalize();
    const cosA = Math.max(-1, Math.min(1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)));
    const A = Math.acos(cosA);
    const B = P0.clone().add(dir.clone().multiplyScalar(Math.cos(A) * l1)).add(perp.clone().multiplyScalar(Math.sin(A) * l1));
    const T = P0.clone().add(dir.clone().multiplyScalar(dist));
    const u = B.clone().sub(P0).normalize();
    const v = T.clone().sub(B).normalize();

    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
    const frameOf = (b) => rootQ.clone().invert().multiply(b.parent.getWorldQuaternion(new THREE.Quaternion()));
    const down = new THREE.Vector3(0, -1, 0);
    let qU = new THREE.Quaternion().setFromUnitVectors(down, u);
    const hinge = u.clone().cross(v);                       // the axis the elbow / knee folds about
    if (hinge.length() > 1e-4) {
      hinge.normalize().multiplyScalar(isArm ? -1 : 1);     // elbow flexion is -x, knee flexion +x
      const xA = new THREE.Vector3(1, 0, 0).applyQuaternion(qU);
      const phi = Math.atan2(u.dot(xA.clone().cross(hinge)), xA.dot(hinge));
      qU = new THREE.Quaternion().setFromAxisAngle(u, phi).multiply(qU);
    }
    upper.quaternion.copy(frameOf(upper).invert().multiply(qU));
    upper.updateMatrixWorld(true);
    // lower segment: its direction in the upper segment's frame -> a pure hinge rotation (no stray twist)
    const wLocal = v.clone().applyQuaternion(frameOf(lower).invert());
    lower.quaternion.setFromUnitVectors(down, wLocal);
    lower.updateMatrixWorld(true);
    if (!isArm) {   // keep the foot flat on the ground plane of the figure
      end.quaternion.copy(frameOf(end).invert());
    }
    [lower, end].forEach((b) => this.clampBone(b.name));   // the shoulder or hip follows the target; the hinge joints keep their limits
    this.root.updateMatrixWorld(true);
  }

  /** Wrist/ankle position in figure space (to seed a drag handle). */
  endPoint(name) {
    this.root.updateMatrixWorld(true);
    return this.root.worldToLocal(this.bones[name].getWorldPosition(new THREE.Vector3()));
  }

  showHandles(on) { this.handles.forEach((h) => { h.visible = on; }); }
  setHeight(h) { this.build.height = h; this.root.scale.setScalar(h / REF_H); }
  setColor(c) { this.color = c; this.mat.color.set(c); }
  setGender(g) { this.setBuild({ ...DEFAULT_BUILD[g], gender: g }); }
  get height() { return this.build.height; }
}
