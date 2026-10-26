import * as THREE from 'three';

/**
 * Props for blocking a shot. Real-world sizes in metres; origin on the floor at the centre, the front faces +Z.
 * They are built from simple solids on purpose: the image model reads the depth map, so what matters is a believable
 * silhouette and scale (a door that is 2 m tall, a car that is 4.5 m long), not surface detail.
 * `h` = overall height (used to place the name tag), `cat` = group in the Add menu.
 */
export const PROPS = {
  door: { label: 'door', icon: '🚪', cat: 'Rooms', h: 2.05 },
  window: { label: 'window', icon: '🪟', cat: 'Rooms', h: 2.1 },
  wall: { label: 'wall', icon: '🧱', cat: 'Rooms', h: 2.6 },
  column: { label: 'pillar', icon: '🏛', cat: 'Rooms', h: 3 },
  archway: { label: 'archway', icon: '⛩', cat: 'Rooms', h: 2.6 },
  stairs: { label: 'staircase', icon: '🪜', cat: 'Rooms', h: 2.7 },
  fence: { label: 'fence', icon: '🚧', cat: 'Rooms', h: 1.2 },
  mirror: { label: 'mirror', icon: '🪞', cat: 'Rooms', h: 1.7 },
  desk: { label: 'desk', icon: '🖥', cat: 'Furniture', h: 0.75 },
  bookshelf: { label: 'bookshelf', icon: '📚', cat: 'Furniture', h: 1.9 },
  wardrobe: { label: 'wardrobe', icon: '🗄', cat: 'Furniture', h: 2.0 },
  dresser: { label: 'dresser', icon: '🗄', cat: 'Furniture', h: 0.9 },
  nightstand: { label: 'nightstand', icon: '🛏', cat: 'Furniture', h: 0.55 },
  coffeetable: { label: 'coffee table', icon: '☕', cat: 'Furniture', h: 0.45 },
  tv: { label: 'TV on a stand', icon: '📺', cat: 'Furniture', h: 1.3 },
  lamp: { label: 'floor lamp', icon: '💡', cat: 'Furniture', h: 1.6 },
  fridge: { label: 'fridge', icon: '🧊', cat: 'Kitchen & bath', h: 1.8 },
  counter: { label: 'kitchen counter', icon: '🍳', cat: 'Kitchen & bath', h: 0.92 },
  bathtub: { label: 'bathtub', icon: '🛁', cat: 'Kitchen & bath', h: 0.58 },
  tree: { label: 'tree', icon: '🌳', cat: 'Outdoors', h: 6 },
  bush: { label: 'bush', icon: '🌿', cat: 'Outdoors', h: 1.1 },
  rock: { label: 'boulder', icon: '🪨', cat: 'Outdoors', h: 1.0 },
  car: { label: 'car', icon: '🚗', cat: 'Outdoors', h: 1.5 },
  streetlamp: { label: 'street lamp', icon: '🏮', cat: 'Outdoors', h: 5 },
  crate: { label: 'crate', icon: '📦', cat: 'Objects', h: 0.6 },
  barrel: { label: 'barrel', icon: '🛢', cat: 'Objects', h: 0.9 },
  dumpster: { label: 'dumpster', icon: '🗑', cat: 'Objects', h: 1.4 },
  suitcase: { label: 'suitcase', icon: '🧳', cat: 'Objects', h: 0.65 },
};
export const PROP_TYPES = Object.keys(PROPS);
export const PROP_CATS = [...new Set(PROP_TYPES.map((k) => PROPS[k].cat))];

export function buildProp(type, color = 0x8a93a8) {
  const g = new THREE.Group();
  const base = new THREE.Color(color);
  const M = (c, rough = 0.8, extra = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: rough, ...extra });
  const main = M(base);
  const dark = M(base.clone().multiplyScalar(0.62), 0.85);
  const light = M(base.clone().lerp(new THREE.Color(0xffffff), 0.35), 0.8);
  const metal = M(0x9aa3b2, 0.35, { metalness: 0.7 });
  const glass = M(0x9ec7e6, 0.1, { transparent: true, opacity: 0.55 });
  const wood = M(0x7a5a3c, 0.75);
  const leaf = M(0x3f7a47, 0.9);
  const black = M(0x15171c, 0.6);

  const box = (w, h, d, x, y, z, m = main) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y + h / 2, z); g.add(o); return o; };
  const cyl = (rt, rb, h, x, y, z, m = main, seg = 24) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m); o.position.set(x, y + h / 2, z); g.add(o); return o; };
  const sph = (r, x, y, z, m = main, sx = 1, sy = 1, sz = 1) => { const o = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), m); o.position.set(x, y, z); o.scale.set(sx, sy, sz); g.add(o); return o; };
  const round = (w, h, d, r, x, y, z, m = main) => {   // box with softened edges
    const s = new THREE.Shape(); const hw = w / 2, hd = d / 2, rr = Math.min(r, hw, hd);
    s.moveTo(-hw + rr, -hd); s.lineTo(hw - rr, -hd); s.quadraticCurveTo(hw, -hd, hw, -hd + rr); s.lineTo(hw, hd - rr); s.quadraticCurveTo(hw, hd, hw - rr, hd);
    s.lineTo(-hw + rr, hd); s.quadraticCurveTo(-hw, hd, -hw, hd - rr); s.lineTo(-hw, -hd + rr); s.quadraticCurveTo(-hw, -hd, -hw + rr, -hd);
    const geo = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 6 });
    geo.rotateX(-Math.PI / 2);
    const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); g.add(o); return o;
  };
  const wheel = (x, y, z, r = 0.34, w = 0.22) => {
    const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 28), black); o.rotation.z = Math.PI / 2; o.position.set(x, y, z); g.add(o);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.01, 20), metal); hub.rotation.z = Math.PI / 2; hub.position.set(x, y, z); g.add(hub);
  };

  switch (type) {
    case 'door': {
      box(1.08, 0.07, 0.16, 0, 2.05, 0, dark);                         // header
      box(0.09, 2.05, 0.16, -0.495, 0, 0, dark); box(0.09, 2.05, 0.16, 0.495, 0, 0, dark);   // jambs
      box(0.9, 2.0, 0.05, 0, 0, 0.0, main);                            // leaf
      box(0.74, 0.8, 0.012, 0, 1.12, 0.03, light); box(0.74, 0.8, 0.012, 0, 0.2, 0.03, light);   // panels
      sph(0.032, 0.34, 1.0, 0.055, metal);                             // knob
      break;
    }
    case 'window': {
      box(1.3, 0.07, 0.14, 0, 2.1, 0, dark); box(1.4, 0.06, 0.2, 0, 0.9, 0.03, dark);   // head and sill
      box(0.07, 1.2, 0.14, -0.62, 0.93, 0, dark); box(0.07, 1.2, 0.14, 0.62, 0.93, 0, dark);
      box(1.18, 1.2, 0.012, 0, 0.93, 0, glass);
      box(0.04, 1.2, 0.04, 0, 0.93, 0, dark); box(1.18, 0.04, 0.04, 0, 1.5, 0, dark);  // mullion + transom
      break;
    }
    case 'wall': box(3, 2.6, 0.12, 0, 0, 0, main); box(3.02, 0.1, 0.14, 0, 0, 0.005, dark); break;
    case 'column': cyl(0.2, 0.22, 3, 0, 0.12, 0, main, 32); cyl(0.3, 0.3, 0.12, 0, 0, 0, dark, 32); cyl(0.3, 0.26, 0.14, 0, 2.98, 0, dark, 32); break;
    case 'archway': {
      const sh = new THREE.Shape(); sh.moveTo(-1.025, 0); sh.lineTo(1.025, 0); sh.lineTo(1.025, 2.9); sh.lineTo(-1.025, 2.9); sh.lineTo(-1.025, 0);
      const hole = new THREE.Path(); hole.moveTo(-0.675, 0); hole.lineTo(-0.675, 1.9); hole.absarc(0, 1.9, 0.675, Math.PI, 0, true); hole.lineTo(0.675, 0); hole.lineTo(-0.675, 0);
      sh.holes.push(hole);
      const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.3, bevelEnabled: false, curveSegments: 20 }); geo.translate(0, 0, -0.15);
      g.add(new THREE.Mesh(geo, main));
      break;
    }
    case 'stairs': {
      for (let i = 0; i < 12; i++) box(1.1, 0.18 * (i + 1), 0.28, 0, 0, -1.5 + i * 0.28, i % 2 ? main : light);   // 12 risers, 18 cm each
      box(0.05, 0.9, 3.4, -0.58, 0.18, -0.2, dark); box(0.05, 0.05, 3.4, -0.58, 1.08, -0.2, wood);
      break;
    }
    case 'fence': {
      for (let i = 0; i < 9; i++) box(0.12, 1.2, 0.03, -1.2 + i * 0.3, 0, 0, i % 2 ? main : light);
      box(2.8, 0.07, 0.05, 0, 0.25, -0.04, dark); box(2.8, 0.07, 0.05, 0, 0.85, -0.04, dark);
      break;
    }
    case 'mirror': box(0.85, 1.7, 0.04, 0, 0, 0, dark); box(0.75, 1.6, 0.012, 0, 0.05, 0.026, metal); box(0.06, 0.4, 0.3, 0, 0, -0.17, dark).rotation.x = 0.3; break;
    case 'desk': {
      box(1.4, 0.04, 0.7, 0, 0.71, 0, wood);
      box(0.04, 0.71, 0.66, -0.66, 0, 0, dark); box(0.4, 0.5, 0.64, 0.46, 0.21, 0, dark);   // side + drawer unit
      box(0.38, 0.12, 0.01, 0.46, 0.5, 0.325, light); box(0.38, 0.12, 0.01, 0.46, 0.34, 0.325, light);
      break;
    }
    case 'bookshelf': {
      box(1.0, 1.9, 0.3, 0, 0, -0.02, dark).scale.set(1, 1, 0.1);        // back panel
      box(0.04, 1.9, 0.32, -0.48, 0, 0, main); box(0.04, 1.9, 0.32, 0.48, 0, 0, main);
      [0, 0.38, 0.76, 1.14, 1.52, 1.86].forEach((y) => box(0.96, 0.04, 0.32, 0, y, 0, main));
      [0.04, 0.42, 0.8, 1.18, 1.56].forEach((y, r) => { for (let k = 0; k < 6; k++) box(0.05 + ((k + r) % 3) * 0.015, 0.26 + ((k * 3 + r) % 4) * 0.015, 0.2, -0.36 + k * 0.075 + (r % 2) * 0.1, y + 0.04, 0, k % 2 ? light : dark); });
      break;
    }
    case 'wardrobe': box(1.2, 2.0, 0.6, 0, 0, 0, main); box(0.58, 1.86, 0.02, -0.3, 0.07, 0.31, light); box(0.58, 1.86, 0.02, 0.3, 0.07, 0.31, light); box(0.02, 0.2, 0.03, -0.04, 1.0, 0.33, metal); box(0.02, 0.2, 0.03, 0.04, 1.0, 0.33, metal); break;
    case 'dresser': box(1.1, 0.9, 0.5, 0, 0, 0, main); [0.08, 0.34, 0.6].forEach((y) => { box(1.0, 0.22, 0.02, 0, y, 0.26, light); box(0.16, 0.025, 0.03, 0, y + 0.11, 0.285, metal); }); break;
    case 'nightstand': box(0.45, 0.55, 0.4, 0, 0, 0, main); box(0.4, 0.22, 0.02, 0, 0.26, 0.21, light); box(0.1, 0.02, 0.03, 0, 0.36, 0.23, metal); break;
    case 'coffeetable': box(1.1, 0.04, 0.6, 0, 0.41, 0, wood); [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => box(0.05, 0.41, 0.05, sx * 0.5, 0, sz * 0.25, dark)); box(1.0, 0.025, 0.5, 0, 0.12, 0, dark); break;
    case 'tv': {
      box(1.3, 0.5, 0.4, 0, 0, 0, main); box(1.2, 0.04, 0.34, 0, 0.5, 0, dark);
      box(1.15, 0.66, 0.05, 0, 0.64, -0.02, black); box(1.1, 0.6, 0.012, 0, 0.67, 0.012, M(0x0c1a2c, 0.2));
      box(0.2, 0.12, 0.05, 0, 0.54, -0.02, black);
      break;
    }
    case 'lamp': cyl(0.2, 0.22, 0.03, 0, 0, 0, dark); cyl(0.015, 0.015, 1.38, 0, 0.03, 0, metal); cyl(0.12, 0.2, 0.28, 0, 1.32, 0, M(0xf3e7c9, 0.9, { emissive: 0x2a2310 })); break;
    case 'fridge': box(0.78, 1.8, 0.72, 0, 0, 0, light); box(0.76, 0.012, 0.01, 0, 1.18, 0.365, dark); box(0.025, 0.4, 0.04, 0.3, 1.25, 0.38, metal); box(0.025, 0.7, 0.04, 0.3, 0.38, 0.38, metal); break;
    case 'counter': box(2.0, 0.88, 0.62, 0, 0, 0, main); box(2.06, 0.04, 0.66, 0, 0.88, 0.01, dark); [-0.66, 0, 0.66].forEach((x) => box(0.6, 0.7, 0.02, x, 0.1, 0.32, light)); box(0.5, 0.04, 0.4, 0.5, 0.9, 0.04, metal); cyl(0.015, 0.015, 0.25, 0.5, 0.92, -0.17, metal); break;
    case 'bathtub': {
      round(1.7, 0.58, 0.75, 0.3, 0, 0, 0, light);
      round(1.5, 0.05, 0.55, 0.22, 0, 0.53, 0, M(0x6e7e92, 0.6));          // dark interior hint
      cyl(0.02, 0.02, 0.3, -0.72, 0.5, -0.3, metal);
      break;
    }
    case 'tree': {
      cyl(0.16, 0.26, 2.4, 0, 0, 0, wood, 14);
      cyl(0.04, 0.1, 1.4, 0.35, 1.6, 0, wood, 8).rotation.z = -0.9; cyl(0.04, 0.1, 1.2, -0.3, 1.8, 0.1, wood, 8).rotation.z = 0.8;
      sph(1.4, 0, 3.7, 0, leaf, 1, 0.85, 1); sph(1.0, 1.0, 3.2, 0.3, leaf); sph(1.0, -1.0, 3.3, -0.2, leaf); sph(0.9, 0.2, 4.7, 0.2, leaf);
      break;
    }
    case 'bush': sph(0.5, 0, 0.42, 0, leaf, 1.2, 0.9, 1); sph(0.38, 0.45, 0.32, 0.15, leaf); sph(0.34, -0.45, 0.3, -0.1, leaf); break;
    case 'rock': {
      const r = sph(0.6, 0, 0.42, 0, M(0x6f7480, 0.95), 1.15, 0.8, 0.95); r.geometry = new THREE.IcosahedronGeometry(0.6, 1);
      sph(0.3, 0.55, 0.2, 0.2, M(0x6f7480, 0.95)).geometry = new THREE.IcosahedronGeometry(0.3, 1);
      break;
    }
    case 'car': {
      round(1.82, 0.62, 4.5, 0.4, 0, 0.3, 0, main);                             // body: width x, length z
      round(1.6, 0.56, 2.3, 0.34, 0, 0.9, -0.15, M(0x27303d, 0.25, { metalness: 0.3 }));   // greenhouse reads as dark glass
      [[1.4, 0.9], [-1.4, 0.9], [1.4, -0.9], [-1.4, -0.9]].forEach(([z, x]) => wheel(x, 0.34, z));
      box(1.5, 0.1, 0.06, 0, 0.5, 2.27, dark); box(1.5, 0.1, 0.06, 0, 0.5, -2.27, dark);   // bumpers
      break;
    }
    case 'streetlamp': cyl(0.05, 0.09, 4.8, 0, 0, 0, dark, 12); cyl(0.04, 0.04, 1.1, 0.5, 4.75, 0, dark, 10).rotation.z = Math.PI / 2; box(0.5, 0.12, 0.22, 1.0, 4.7, 0, M(0xfff4d2, 0.5, { emissive: 0x806a30 })); break;
    case 'crate': box(0.6, 0.6, 0.6, 0, 0, 0, wood); for (let i = 0; i < 3; i++) box(0.62, 0.06, 0.62, 0, 0.1 + i * 0.2, 0, dark); break;
    case 'barrel': cyl(0.3, 0.3, 0.9, 0, 0, 0, M(0x3a5f8a, 0.55), 28); cyl(0.32, 0.32, 0.04, 0, 0.25, 0, dark, 28); cyl(0.32, 0.32, 0.04, 0, 0.6, 0, dark, 28); break;
    case 'dumpster': box(1.8, 1.0, 0.95, 0, 0.35, 0, M(0x2f6b45, 0.7)); box(1.84, 0.06, 1.0, 0, 1.35, 0, dark).rotation.x = 0.04; [-0.8, 0.8].forEach((x) => { cyl(0.06, 0.06, 0.06, x, 0, 0.4, black, 12); cyl(0.06, 0.06, 0.06, x, 0, -0.4, black, 12); }); break;
    case 'suitcase': round(0.5, 0.65, 0.22, 0.04, 0, 0.04, 0, main); box(0.2, 0.04, 0.03, 0, 0.69, 0.0, metal); wheel(-0.18, 0.03, 0.0, 0.03, 0.03); wheel(0.18, 0.03, 0.0, 0.03, 0.03); break;
    default: box(0.6, 0.6, 0.6, 0, 0, 0);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; } });
  g.userData.prop = { type, ...PROPS[type] };
  return g;
}
