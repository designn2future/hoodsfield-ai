import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * Realistic body skins for the posable Figure. The Figure's own invisible skeleton keeps doing the posing (IK, joint limits,
 * stage directions, sitting...); a skinned human mesh follows it every frame. Only the depth map reaches the image model,
 * so the mesh is drawn in plain clay grey.
 *
 * Retargeting: each mapped body part is first aimed along the same direction as the Figure's limb at the neutral stand pose
 * (that fixes the A-pose vs. T-pose difference), then it copies how far the Figure's bone has turned from neutral.
 */
const FILES = {   // every file shares the same 53-bone skeleton; 'casual' is the default
  male: { casual: 'human_male.glb', elegant: 'human_male_elegant.glb', work: 'human_male_work.glb', bare: 'human_male_bare.glb' },
  female: { casual: 'human_female.glb', elegant: 'human_female_elegant.glb', sport: 'human_female_sport.glb', bare: 'human_female_bare.glb' },
};
/** What the picker shows, and the clothes the prompt should name for each (a bare body gets a default so the image model never paints skin). */
export const OUTFITS = {
  male: [['casual', 'Casual: t-shirt and trousers', 'a plain crew-neck t-shirt and trousers'], ['elegant', 'Business suit and tie', 'a dark business suit, white shirt and tie'],
    ['work', 'Work overalls', 'work overalls over a t-shirt'], ['bare', 'No clothes (mannequin)', 'a dark crew-neck t-shirt, jeans and sneakers']],
  female: [['casual', 'Casual: t-shirt and shorts', 'a t-shirt and denim shorts'], ['elegant', 'Blouse and skirt', 'a blouse and a knee-length pencil skirt'],
    ['sport', 'Sports top and leggings', 'a sports crop top and leggings'], ['bare', 'No clothes (mannequin)', 'a fitted long-sleeve top, jeans and sneakers']],
};
export const outfitText = (gender, outfit) => (OUTFITS[gender] || OUTFITS.male).find((o) => o[0] === (outfit || 'casual'))?.[2] || '';
const cache = {};   // 'male:casual' -> loaded scene
const pending = {};
const listeners = new Set();

export const onSkinsLoaded = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const keyOf = (g, o) => `${g}:${FILES[g]?.[o] ? o : 'casual'}`;

/** Load one body+outfit (once); everyone wearing it is upgraded when it arrives. */
export function loadSkin(gender, outfit = 'casual') {
  const k = keyOf(gender, outfit);
  if (cache[k]) return Promise.resolve();
  if (!pending[k]) {
    const [g, o] = k.split(':');
    pending[k] = new GLTFLoader().loadAsync(`/models/${FILES[g][o]}`).then((gltf) => { cache[k] = gltf.scene; listeners.forEach((f) => f()); })
      .catch((e) => { console.warn('[skin] could not load', k, e); });
  }
  return pending[k];
}
export function loadSkins() { return Promise.all([loadSkin('male', 'casual'), loadSkin('female', 'casual')]); }

export const hasSkin = (gender) => !!cache[keyOf(gender, 'casual')];
export const skinsEnabled = () => {
  try { return localStorage.getItem('hfMannequin') !== '1' && !/[?&]mannequin=1/.test(location.hash + location.search); } catch { return true; }
};

/** glb bone name -> how the Figure drives it. d = Figure bone name or [hand side, finger index, segment]. aim = [child glb bone, Figure child node] */
const side = (t) => (t === 'l' ? 'L' : 'R');
function mapping(t) {
  const S = side(t);
  const fing = (nm, i) => ({ [`${nm}_01_${t}`]: { d: ['hand' + S, i, 1] }, [`${nm}_02_${t}`]: { d: ['hand' + S, i, 2] }, [`${nm}_03_${t}`]: { d: ['hand' + S, i, 2] } });
  return {
    [`upperarm_${t}`]: { d: 'arm' + S, aim: [`lowerarm_${t}`, 'fore' + S] },
    [`lowerarm_${t}`]: { d: 'fore' + S, aim: [`hand_${t}`, 'hand' + S] },
    [`hand_${t}`]: { d: 'hand' + S },
    [`thigh_${t}`]: { d: 'thigh' + S, aim: [`calf_${t}`, 'shin' + S] },
    [`calf_${t}`]: { d: 'shin' + S, aim: [`foot_${t}`, 'foot' + S] },
    [`foot_${t}`]: { d: 'foot' + S },
    ...fing('thumb', 0), ...fing('index', 1), ...fing('middle', 2), ...fing('ring', 3), ...fing('pinky', 4),
  };
}
const MAP = {
  pelvis: { d: 'hips' }, spine_01: { d: 'spine' }, spine_03: { d: 'chest' }, neck_01: { d: 'neck' }, head: { d: 'head' },
  ...mapping('l'), ...mapping('r'),
};

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

/** Attach a realistic body to `fig` (Figure). Returns true when attached. */
export function attachSkin(fig) {
  if (!skinsEnabled()) return false;
  const want = keyOf(fig.build.gender, fig.build.outfit || 'casual');
  if (!cache[want]) loadSkin(fig.build.gender, fig.build.outfit || 'casual');     // arrives later; the stage upgrades the figure then
  const src = cache[want] || cache[keyOf(fig.build.gender, 'casual')];
  if (!src) return false;
  const haveKey = cache[want] ? want : keyOf(fig.build.gender, 'casual');
  if (fig.skinRt && fig.skinKey === haveKey && fig.skinRt.group.parent === fig.root) return true;     // already wearing it
  detachSkin(fig);
  const skin = cloneSkinned(src);
  const bones = {};
  skin.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  if (!bones.pelvis || !bones.head) return false;

  const group = new THREE.Group();
  group.name = 'realistic-skin';
  group.add(skin);
  skin.traverse((o) => {
    if (o.isMesh) { o.frustumCulled = false; o.material = new THREE.MeshStandardMaterial({ color: fig.color, roughness: 0.62, metalness: 0 }); o.userData.skinMesh = true; }
  });
  // hide the mannequin geometry (selection handles and the facing arrow stay)
  fig.root.traverse((o) => { if (o.isMesh && !o.userData.helper) { o.userData.hiddenByskin = true; o.visible = false; } });
  fig.root.add(group);

  // size: the body's pelvis height must equal the Figure's hip height at rest
  // size: models are authored with their origin at the feet, the hips, or anywhere else, so ignore origins and match the legs:
  // the pelvis-to-ankle distance must equal the Figure's (hips 0.95 m, ankles 0.08 m at reference height)
  group.updateMatrixWorld(true);
  const pl = skin.worldToLocal(bones.pelvis.getWorldPosition(new THREE.Vector3()));
  const fl = skin.worldToLocal((bones.foot_l || bones.foot_r).getWorldPosition(new THREE.Vector3()));
  group.scale.setScalar(0.87 / Math.max(0.2, pl.distanceTo(fl)));

  const rt = { group, skin, bones, pairs: [] };
  fig.skinRt = rt;
  fig.skinKey = haveKey;
  calibrate(fig, rt);
  fig.syncSkin = () => syncSkin(fig);
  fig.syncSkin();
  return true;
}

export function detachSkin(fig) {
  const rt = fig.skinRt; if (!rt) return;
  fig.root.remove(rt.group);
  fig.root.traverse((o) => { if (o.userData.hiddenByskin) { o.visible = true; delete o.userData.hiddenByskin; } });
  fig.skinRt = null; fig.syncSkin = null;
}

const driverNode = (fig, d) => (Array.isArray(d)
  ? (() => { const f = fig.bones[d[0]].userData.fingers?.[d[1]]; return f ? (d[2] === 1 ? f.g1 : f.g2) : null; })()
  : fig.bones[d]);

function calibrate(fig, rt) {
  // put the Figure in its neutral pose (all joints at zero) while measuring, then put every joint back
  const keep = Object.entries(fig.bones).map(([n, b]) => [b, b.quaternion.clone()]);
  const fingerKeep = [];
  ['handL', 'handR'].forEach((h) => (fig.bones[h].userData.fingers || []).forEach((f) => fingerKeep.push([f.g1, f.g1.quaternion.clone()], [f.g2, f.g2.quaternion.clone()])));
  Object.values(fig.bones).forEach((b) => b.quaternion.identity());
  fingerKeep.forEach(([g]) => g.rotation.set(0, 0, 0));
  fig.root.updateMatrixWorld(true);

  const ordered = [];
  rt.skin.traverse((o) => { if (o.isBone && MAP[o.name]) ordered.push(o); });   // parents come before children
  ordered.forEach((t) => {
    const spec = MAP[t.name];
    const D = driverNode(fig, spec.d);
    if (!D) return;
    t.parent.updateMatrixWorld(true);
    if (spec.aim && rt.bones[spec.aim[0]] && fig.bones[spec.aim[1]]) {
      const tDir = rt.bones[spec.aim[0]].getWorldPosition(_v).sub(t.getWorldPosition(_v2)).normalize();
      const dDir = fig.bones[spec.aim[1]].getWorldPosition(new THREE.Vector3()).sub(D.getWorldPosition(new THREE.Vector3())).normalize();
      const turn = new THREE.Quaternion().setFromUnitVectors(tDir, dDir);
      const world = t.getWorldQuaternion(new THREE.Quaternion());
      const parentW = t.parent.getWorldQuaternion(new THREE.Quaternion());
      t.quaternion.copy(parentW.invert().multiply(turn.multiply(world)));
      t.updateMatrixWorld(true);
    }
    rt.pairs.push({ t, D, tCal: t.getWorldQuaternion(new THREE.Quaternion()), dCalInv: D.getWorldQuaternion(new THREE.Quaternion()).invert() });
  });
  keep.forEach(([b, q]) => b.quaternion.copy(q));
  fingerKeep.forEach(([g, q]) => g.quaternion.copy(q));
  fig.root.updateMatrixWorld(true);
}

export function syncSkin(fig) {
  const rt = fig.skinRt; if (!rt) return;
  fig.root.updateMatrixWorld(true);
  const P = rt.bones.pelvis;
  const hips = fig.bones.hips.getWorldPosition(_v);
  P.parent.updateMatrixWorld(true);
  P.position.copy(P.parent.worldToLocal(hips));
  P.updateMatrixWorld(true);
  for (const m of rt.pairs) {
    const desired = _q.copy(m.D.getWorldQuaternion(_q2)).multiply(m.dCalInv).multiply(m.tCal);
    const parentW = m.t.parent.getWorldQuaternion(_q2);
    m.t.quaternion.copy(parentW.invert().multiply(desired));
    m.t.updateMatrixWorld(true);
  }
}
