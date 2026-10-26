import * as THREE from 'three';
import { seatSpot } from './three/furniture.js';

// Arm and leg actions for a person, solved with the figure's IK. Works with or without furniture; where a seat or backrest
// exists the targets are taken from its real dimensions (so "arm along the back of the couch" lands on the couch back).

export const ARM_ACTIONS = {
  down: 'Down at the side', out: 'Out to the side', forward: 'Reaching forward', up: 'Raised', hip: 'On the hip', lap: 'In the lap',
  head: 'Behind the head', back: 'Along the back of the seat', rest: 'Resting on the armrest',
};
export const LEG_ACTIONS = {
  down: 'Foot on the floor', bent: 'Resting on the seat, slightly bent', extended: 'Stretched out in front', up: 'Foot up on the seat, knee raised', side: 'Stretched out sideways on the seat', cross: 'Ankle over the other knee',
};

const UP = new THREE.Vector3(0, 1, 0);
const frame = (it) => { const y = it.root.rotation.y; return { f: new THREE.Vector3(Math.sin(y), 0, Math.cos(y)), lat: new THREE.Vector3(Math.cos(y), 0, -Math.sin(y)) }; };
const boneWorld = (it, bone) => it.fig.root.localToWorld(it.fig.endPoint(bone).clone());
const sideOf = (limb) => (limb.endsWith('L') ? 1 : -1);
const SIDE_WORD = { L: 'left', R: 'right' };

/** World-space target for a limb action, plus which IK bone to move. */
export function limbTarget(it, limb, action, furn) {
  const tag = limb.slice(-1), s = sideOf(limb);
  const { f, lat } = frame(it);
  const d = furn?.root.userData.furn;
  const yf = furn ? furn.root.rotation.y : 0;
  const furnX = new THREE.Vector3(Math.cos(yf), 0, -Math.sin(yf));
  if (limb.startsWith('arm')) {
    const sh = boneWorld(it, `arm${tag}`);
    const off = (ox, oy, oz) => sh.clone().addScaledVector(lat, s * ox).addScaledVector(UP, oy).addScaledVector(f, oz);
    const xs = furn ? (Math.sign(lat.clone().multiplyScalar(s).dot(furnX)) || s) : s;
    switch (action) {
      case 'down': return { bone: `hand${tag}`, world: off(0.06, -0.55, 0.02) };
      case 'out': return { bone: `hand${tag}`, world: off(0.56, 0, 0) };
      case 'forward': return { bone: `hand${tag}`, world: off(0.1, -0.12, 0.54) };
      case 'up': return { bone: `hand${tag}`, world: off(0.14, 0.54, 0.02) };
      case 'hip': return { bone: `hand${tag}`, world: off(0.08, -0.475, -0.02) };
      case 'lap': return { bone: `hand${tag}`, world: off(0.07, -0.42, 0.3) };
      case 'head': return { bone: `hand${tag}`, world: off(-0.09, 0.14, -0.1) };
      case 'back':
        if (d && d.back) return { bone: `hand${tag}`, world: furn.root.localToWorld(new THREE.Vector3(xs * Math.min(d.w / 2 - 0.12, 0.78), d.back + 0.045, -d.d / 2 + d.backT / 2)) };
        return { bone: `hand${tag}`, world: off(0.6, -0.1, -0.35) };
      case 'rest':
        if (d && d.arm) return { bone: `hand${tag}`, world: furn.root.localToWorld(new THREE.Vector3(xs * (d.w / 2 - d.armT / 2), d.arm + 0.03, 0.02)) };
        return { bone: `hand${tag}`, world: off(0.07, -0.42, 0.3) };
      default: return null;
    }
  }
  const hp = boneWorld(it, `thigh${tag}`);
  const seatTop = d ? d.seat : hp.y - 0.06;
  const at = (lx, lz, y) => { const w = hp.clone().addScaledVector(lat, s * lx).addScaledVector(f, lz); w.y = y; return w; };
  switch (action) {
    case 'down': return { bone: `foot${tag}`, world: at(0.02, 0.0, 0.08) };
    case 'extended': return { bone: `foot${tag}`, world: at(0.06, 0.8, Math.max(0.08, hp.y - 0.12)) };
    case 'bent': {   // foot rests on the seat further forward, knee only slightly bent; limited by how far the cushion reaches
      let fwd = 0.7;
      if (furn && d) {
        const lp = furn.root.worldToLocal(hp.clone());
        const onChaise = d.chaise && lp.x > d.chaise.x - d.chaise.w / 2 && lp.x < d.chaise.x + d.chaise.w / 2;
        fwd = Math.max(0.35, Math.min(0.7, (onChaise ? d.chaise.front : d.d / 2) - 0.12 - lp.z));
      }
      return { bone: `foot${tag}`, world: at(0.12, fwd, seatTop + 0.05) };
    }
    case 'up': return { bone: `foot${tag}`, world: at(0.16, 0.3, seatTop + 0.05) };
    case 'side': return { bone: `foot${tag}`, world: at(0.74, 0.2, seatTop + 0.06) };
    case 'cross': return { bone: `foot${tag}`, world: at(-0.12, 0.4, hp.y + 0.03) };
    default: return null;
  }
}

/** Phrase for the prompt, e.g. "right arm stretched along the back of the couch". */
export function limbPhrase(limb, action, furn) {
  const side = SIDE_WORD[limb.slice(-1)];
  const fl = furn?.label || 'seat';
  const arm = limb.startsWith('arm');
  const map = arm ? {
    down: `${side} arm relaxed at the side`, out: `${side} arm stretched out to the side`, forward: `${side} arm reaching forward`, up: `${side} arm raised`,
    hip: `${side} hand on the hip`, lap: `${side} hand resting in the lap`, head: `${side} hand behind the head`,
    back: `${side} arm stretched out along the top of the ${fl}'s backrest`, rest: `${side} arm resting on the ${fl}'s armrest`,
  } : {
    down: '', bent: `${side} leg resting on the ${fl}, knee slightly bent`, extended: `${side} leg stretched out in front`, up: `${side} foot up on the ${fl} with the knee raised`,
    side: `${side} leg stretched out sideways along the ${fl}`, cross: `${side} ankle resting over the other knee`,
  };
  return map[action] || '';
}

export function applyLimb(it, limb, action, furn) {
  const t = limbTarget(it, limb, action, furn);
  if (!t) return false;
  it.fig.solveIK(t.bone, it.fig.root.worldToLocal(t.world.clone()));
  it.fig.poseName = 'custom';
  it.limbText = { ...(it.limbText || {}), [limb]: limbPhrase(limb, action, furn) };
  return true;
}

/** Lowest / rearmost contact: sink the pelvis into the cushion and bring the back against the backrest. */
function snapToSeat(it, furn) {
  const d = furn.root.userData.furn, fig = it.fig, sc = fig.root.scale.x;
  const meshes = (b) => b.children.filter((c) => c.isMesh && !c.userData.helper);
  const corners = () => {
    fig.root.updateMatrixWorld(true);
    const out = [];
    [fig.bones.hips, fig.bones.spine, fig.bones.chest, fig.bones.thighL, fig.bones.thighR].forEach((b) => meshes(b).forEach((m) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      for (let i = 0; i < 8; i++) out.push(new THREE.Vector3(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(m.matrixWorld));
    }));
    return out;
  };
  let c = corners();
  const lowest = Math.min(...c.map((v) => v.y));
  fig.bones.hips.position.y += ((d.seat - 0.015) - lowest) / sc;          // slightly into the cushion: seat compression
  if (d.back) {
    c = corners();
    const f = new THREE.Vector3(Math.sin(furn.root.rotation.y), 0, Math.cos(furn.root.rotation.y));
    const plane = furn.root.localToWorld(new THREE.Vector3(0, 0, -d.d / 2 + d.backT));
    const rear = Math.max(...c.map((v) => -v.clone().sub(plane).dot(f)));      // >0: pushing into the backrest, <0: a gap
    it.root.position.addScaledVector(f, rear - 0.004);
  }
  it.root.updateMatrixWorld(true);
}

/** Seat a person on a piece of furniture: pelvis on the cushion, back to the backrest, feet on the floor. */
export function sitOn(it, furn, slot = 0, opts = {}) {
  const d = furn.root.userData.furn;
  const spot = furn.root.localToWorld(seatSpot(d.type, slot));
  it.root.position.set(spot.x, 0, spot.z);
  it.root.rotation.y = furn.root.rotation.y;
  it.fig.applyPreset('sit');
  const sc = it.fig.root.scale.x;
  it.fig.bones.hips.position.y = spot.y / sc;
  if (d.back) { it.fig.bones.spine.rotation.x = opts.recline ? -0.3 : -0.09; it.fig.bones.chest.rotation.x = opts.recline ? -0.2 : -0.05; if (opts.recline) it.fig.bones.head.rotation.x = 0.26; }
  it.root.updateMatrixWorld(true);
  snapToSeat(it, furn);
  const { f, lat } = frame(it);
  ['L', 'R'].forEach((tag) => {
    const s = sideOf(tag);
    const hip = boneWorld(it, `thigh${tag}`);
    const foot = hip.clone().addScaledVector(f, 0.44).addScaledVector(lat, s * 0.02); foot.y = 0.08;
    it.fig.solveIK(`foot${tag}`, it.fig.root.worldToLocal(foot));
  });
  it.sitsOn = d.label;
  it.limbText = {};
  it.fig.poseName = 'sit';
}
