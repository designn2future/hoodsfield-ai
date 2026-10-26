import * as THREE from 'three';

/**
 * Furniture with real dimensions (metres) so people can sit on it properly. Local frame: origin on the floor at the centre,
 * the front faces +Z. `seat` = top of the cushion, `back` = top of the backrest, `arm` = top of the armrests, `backT` = backrest depth.
 */
export const FURN = {
  couch: { label: 'couch', w: 1.9, d: 0.92, seat: 0.45, back: 0.88, arm: 0.62, backT: 0.18, armT: 0.16 },
  armchair: { label: 'armchair', w: 0.95, d: 0.9, seat: 0.44, back: 0.9, arm: 0.6, backT: 0.18, armT: 0.15 },
  sectional: { label: 'L-shaped couch', w: 2.6, d: 0.92, seat: 0.45, back: 0.88, arm: 0.62, backT: 0.18, armT: 0.16, chaise: { x: 0.825, w: 0.95, front: 1.44 } },
  chair: { label: 'chair', w: 0.5, d: 0.5, seat: 0.46, back: 0.92, arm: 0, backT: 0.05, armT: 0 },
  bench: { label: 'bench', w: 1.5, d: 0.42, seat: 0.45, back: 0, arm: 0, backT: 0, armT: 0 },
  stool: { label: 'stool', w: 0.4, d: 0.4, seat: 0.62, back: 0, arm: 0, backT: 0, armT: 0 },
  bed: { label: 'bed', w: 1.6, d: 2.0, seat: 0.52, back: 0, arm: 0, backT: 0, armT: 0 },
  table: { label: 'table', w: 1.4, d: 0.8, seat: 0, top: 0.75, back: 0, arm: 0, backT: 0, armT: 0 },
};
export const FURN_TYPES = Object.keys(FURN);

export function buildFurniture(type, color = 0x59647a) {
  const d = FURN[type] || FURN.chair;
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.7), roughness: 0.9 });
  const box = (w, h, dp, x, y, z, m = mat) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, dp), m);
    mesh.position.set(x, y + h / 2, z); g.add(mesh); return mesh;
  };
  if (type === 'table') {
    box(d.w, 0.05, d.d, 0, d.top - 0.05, 0);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => box(0.06, d.top - 0.05, 0.06, sx * (d.w / 2 - 0.06), 0, sz * (d.d / 2 - 0.06), dark));
  } else if (type === 'stool') {
    box(d.w, 0.06, d.d, 0, d.seat - 0.06, 0);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => box(0.04, d.seat - 0.06, 0.04, sx * 0.14, 0, sz * 0.14, dark));
  } else if (type === 'bed') {
    box(d.w, 0.28, d.d, 0, 0.1, 0, dark);                           // frame
    box(d.w - 0.04, d.seat - 0.38 + 0.1, d.d - 0.04, 0, 0.38, 0);   // mattress up to the seat height
    box(d.w, 0.9, 0.08, 0, 0.1, -d.d / 2 + 0.04, dark);             // headboard
    box(0.6, 0.12, 0.35, -0.35, d.seat, -d.d / 2 + 0.3, new THREE.MeshStandardMaterial({ color: 0xdfe6f2, roughness: 1 }));   // pillows
    box(0.6, 0.12, 0.35, 0.35, d.seat, -d.d / 2 + 0.3, new THREE.MeshStandardMaterial({ color: 0xdfe6f2, roughness: 1 }));
  } else if (type === 'bench') {
    box(d.w, 0.07, d.d, 0, d.seat - 0.07, 0);
    box(0.07, d.seat - 0.07, d.d - 0.06, -d.w / 2 + 0.1, 0, 0, dark);
    box(0.07, d.seat - 0.07, d.d - 0.06, d.w / 2 - 0.1, 0, 0, dark);
  } else if (type === 'chair') {
    box(d.w, 0.06, d.d, 0, d.seat - 0.06, 0);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => box(0.045, d.seat - 0.06, 0.045, sx * (d.w / 2 - 0.04), 0, sz * (d.d / 2 - 0.04), dark));
    box(d.w, d.back - d.seat, d.backT, 0, d.seat, -d.d / 2 + d.backT / 2);
  } else if (type === 'sectional') {   // long couch with a chaise return on the right end
    const armW = d.armT, c = d.chaise, cz = (c.front - d.d / 2) / 2 + 0;      // chaise runs from the back wall to `front`
    const chaiseDepth = c.front + d.d / 2;
    box(d.w, d.seat - 0.14 - 0.1, d.d, 0, 0.14, 0, dark);
    box(c.w, d.seat - 0.14 - 0.1, chaiseDepth, c.x, 0.14, -d.d / 2 + chaiseDepth / 2, dark);
    box(d.w - armW * 2 + 0.02 - (d.w / 2 - c.x + c.w / 2 - armW) , 0.1, d.d - d.backT + 0.02, -(d.w / 2 - c.x + c.w / 2 - armW) / 2 + 0, d.seat - 0.1, d.backT / 2);   // main cushions (left of the chaise)
    box(c.w - 0.02, 0.1, chaiseDepth - d.backT, c.x, d.seat - 0.1, -d.d / 2 + d.backT + (chaiseDepth - d.backT) / 2);                                                  // chaise cushion
    box(d.w, d.back - 0.14, d.backT, 0, 0.14, -d.d / 2 + d.backT / 2);                                                                                                  // backrest
    box(armW, d.arm - 0.14, d.d, -(d.w / 2 - armW / 2), 0.14, 0);                                                                                                       // left arm
    box(armW, d.arm - 0.14, chaiseDepth, d.w / 2 - armW / 2, 0.14, -d.d / 2 + chaiseDepth / 2);                                                                         // right arm runs the length of the chaise
  } else {   // couch / armchair: base, seat cushion, backrest, armrests
    const armW = d.armT;
    box(d.w, d.seat - 0.14 - 0.1, d.d, 0, 0.14, 0, dark);
    box(d.w - armW * 2 + 0.02, 0.1, d.d - d.backT + 0.02, 0, d.seat - 0.1, d.backT / 2);
    box(d.w, d.back - 0.14, d.backT, 0, 0.14, -d.d / 2 + d.backT / 2);
    [-1, 1].forEach((sx) => box(armW, d.arm - 0.14, d.d, sx * (d.w / 2 - armW / 2), 0.14, 0));
    [-1, 1].forEach((sx) => box(0.06, 0.14, 0.06, sx * (d.w / 2 - 0.08), 0, d.d / 2 - 0.08, dark));
  }
  g.userData.furn = { type, ...d };
  return g;
}

/** Where a seated person's pelvis goes, in the furniture's local frame (slot = lateral offset for shared seats). */
export const SEAT_SLOT_MAX = (type) => { const d = FURN[type] || FURN.chair; return Math.max(0, d.w / 2 - (d.armT || 0) - 0.5); };

export function seatSpot(type, slot = 0) {
  const d = FURN[type] || FURN.chair;
  const z = d.back ? -d.d / 2 + d.backT + 0.17 : 0;
  return new THREE.Vector3(slot, d.seat + 0.06, z);
}
