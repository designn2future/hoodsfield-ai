import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { Figure, POSES, IK_BONES, HINGE_END, jointName, describeBuild, DEFAULT_BUILD } from './Figure.js';
import { buildFurniture, FURN, FURN_TYPES } from './furniture.js';
import { buildProp, PROPS, PROP_TYPES } from './props.js';
import { loadSkins, attachSkin, detachSkin, onSkinsLoaded, outfitText } from './skins.js';
import { applyLimb, sitOn } from '../limbs.js';

/**
 * SceneStage — a blocking tool for stills. People are mannequins, props are primitives, the shot camera has a real lens
 * (focal length on a 36 mm sensor) and everything is in metres. `renderDepth()` produces the depth map the image model
 * is conditioned on: white = near, black = far / empty, normalised per frame like Depth Anything's output.
 */

const PALETTE = [0x4fd1ff, 0xff7ab8, 0xffc857, 0x7ef0b0, 0xb69bff, 0xff8f6b];
const FLOOR_Y = 0;
const SKIN = [0xd8d5ce, 0xced3da, 0xdbd1c5, 0xcad3c9, 0xd3cad8, 0xd9cec9];   // neutral clay-mannequin tones (a skin-coloured body reads as nude); the name tag carries the identity colour

export const lensToFov = (mm, aspect) => {
  const hf = 2 * Math.atan(18 / mm);
  return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hf / 2) / aspect));
};
export const fovToLens = (vfovDeg, aspect) => {
  const hf = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(vfovDeg) / 2) * aspect);
  return 18 / Math.tan(hf / 2);
};

function labelSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '600 26px Space Grotesk, Arial, sans-serif';
  g.fillStyle = 'rgba(10,14,24,0.82)';
  g.beginPath(); g.roundRect(4, 8, 248, 48, 14); g.fill();
  g.strokeStyle = color; g.lineWidth = 3; g.stroke();
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text.length > 16 ? `${text.slice(0, 15)}…` : text, 128, 33);
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(1.0, 0.25, 1);
  s.userData.helper = true;
  s.renderOrder = 10;
  return s;
}

export class SceneStage {
  constructor(container, cb = {}) {
    this.container = container;
    this.cb = cb;            // onObjects(list), onSelect(meta|null), onShot(info), onRect({x,y,w,h})
    this.items = [];         // { id, kind, label, color, root }
    this.nextId = 1;
    this.view = 'layout';    // 'layout' | 'shot'
    this.aspect = 16 / 9;
    this.lens = 35;
    this.floorOn = true;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setScissorTest(true);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1320);
    this.scene.add(new THREE.HemisphereLight(0xdde4ff, 0x2a2e3a, 0.9));
    const dir = new THREE.DirectionalLight(0xfff1e6, 1.7);          // key: warm, high and to the front-right
    dir.position.set(4, 9, 6);
    this.scene.add(dir);
    const fill = new THREE.DirectionalLight(0xb8c8ff, 0.55);        // fill: cool, from the left
    fill.position.set(-6, 4, 5);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.9);          // rim: from behind, separates the body from the backdrop
    rim.position.set(-2, 6, -7);
    this.scene.add(rim);

    this.grid = new THREE.GridHelper(60, 60, 0x2c3a55, 0x1a2336);
    this.grid.userData.helper = true;
    this.scene.add(this.grid);

    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x20283a, roughness: 1 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = FLOOR_Y - 0.002;
    this.floor.userData.scenery = 'floor';
    this.scene.add(this.floor);

    // room shell: four walls and a ceiling around the cast and camera, so the depth map has real surfaces everywhere
    // (empty depth means "infinitely far" and the image model fills it with a blank white void)
    this.shell = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x2a3350, roughness: 1, side: THREE.BackSide }));
    this.shell.userData.scenery = 'shell';
    this.shell.visible = false;
    this.wallOn = false;
    this.scene.add(this.shell);

    // the shot camera (what the image is rendered from) with a visible body
    this.shot = new THREE.PerspectiveCamera(lensToFov(this.lens, this.aspect), this.aspect, 0.1, 400);
    this.shot.position.set(0, 1.5, 6);
    this.shot.userData.isShot = true;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.2, 0.34), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x00a9b4 }));
    const lensM = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.18, 20), new THREE.MeshStandardMaterial({ color: 0x111 }));
    lensM.rotation.x = Math.PI / 2; lensM.position.z = -0.24;
    body.add(lensM);
    body.userData.helper = true; lensM.userData.helper = true;
    this.shot.add(body);
    body.scale.setScalar(2.6);   // big enough to grab from the layout view
    this.camBody = body;
    this.scene.add(this.shot);
    this.helper = new THREE.CameraHelper(this.shot);
    this.helper.userData.helper = true;
    this.scene.add(this.helper);

    this.cam = new THREE.PerspectiveCamera(50, 1, 0.1, 600);
    this.cam.position.set(8, 6, 11);
    this.orbit = new OrbitControls(this.cam, this.renderer.domElement);
    this.orbit.target.set(0, 1, 0);
    this.orbit.update();

    this.gizmo = new TransformControls(this.cam, this.renderer.domElement);
    this.gizmo.addEventListener('dragging-changed', (e) => { this.orbit.enabled = !e.value && this.view === 'layout'; });
    this.gizmo.addEventListener('objectChange', () => {
      const it = this.selected;
      if (this.joint && it && it !== 'camera' && it.fig) {
        const f = it.fig; let hit = false;
        if (this.jointMode === 'translate') {
          if (IK_BONES.includes(this.joint)) f.solveIK(this.joint, f.ikTargets[this.joint].position);                                  // drag a hand / foot
          else if (HINGE_END[this.joint]) f.solveIK(this.pin.end, this.pin.pos, f.poleTargets[this.joint].position);                   // swing an elbow / knee, hand stays
          else if (this.joint === 'hips') { f.bones.hips.position.copy(f.pelvisTarget.position); Object.entries(this.pin.feet).forEach(([n, pp]) => f.solveIK(n, pp)); }  // shift the body, feet stay planted
        } else hit = f.clampBone(this.joint);
        f.poseName = 'custom';
        this.cb.onLimit?.(hit);
      }
      this._emit();
    });
    this.scene.add(this.gizmo);
    this.gizmo.userData.helper = true;

    this._pointer();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
    this._resize();
    this._running = true;
    loadSkins();                                   // realistic bodies stream in; existing figures upgrade when they arrive
    this._offSkins = onSkinsLoaded(() => { this.items.forEach((i) => { if (i.fig && attachSkin(i.fig)) i.root.traverse((o) => { o.userData.rootId = i.id; }); }); this._emit(); });
    this.active = true;
    const loop = () => { if (!this._running) return; if (this.active) this._draw(); this._raf = requestAnimationFrame(loop); };
    loop();
  }

  // ------------------------------------------------------------------ build
  _material(color) { return new THREE.MeshStandardMaterial({ color, roughness: 0.75 }); }

  add(kind, opts = {}) {
    const id = this.nextId++;
    const color = opts.color ?? PALETTE[(id - 1) % PALETTE.length];
    let root;
    let fig = null;
    let label = opts.label;
    if (kind === 'person') {
      const gender = opts.gender || (/\b(woman|girl|female|lady|she|her|mother|mom|actress)\b/i.test(label || '') ? 'female' : 'male');
      fig = new Figure(SKIN[(id - 1) % SKIN.length], { gender, ...(opts.height ? { height: opts.height } : {}), ...(opts.build || {}) });
      attachSkin(fig);                                   // realistic body (when its model has loaded); the Figure keeps doing the posing
      fig.limitsOn = this.limitsOn !== false;
      fig.applyPreset(POSES[opts.pose] ? opts.pose : 'stand');
      root = fig.root;
      label = label || (gender === 'female' ? 'woman' : 'man');
    } else if (FURN_TYPES.includes(kind)) {
      root = buildFurniture(kind, opts.color ?? 0x59647a);
      label = label || FURN[kind].label;
    } else if (PROP_TYPES.includes(kind)) {
      root = buildProp(kind, opts.color ?? 0x8a93a8);
      label = label || PROPS[kind].label;
    } else {
      const geos = {
        box: () => new THREE.BoxGeometry(1, 1, 1),
        cylinder: () => new THREE.CylinderGeometry(0.4, 0.4, 1, 32),
        sphere: () => new THREE.SphereGeometry(0.5, 32, 16),
        cone: () => new THREE.ConeGeometry(0.5, 1, 32),
      };
      root = new THREE.Mesh((geos[kind] || geos.box)(), this._material(color));
      root.position.y = 0.5;
      label = label || kind;
    }
    root.userData.sceneId = id;
    root.traverse((o) => { o.userData.rootId = id; });
    if (opts.position) root.position.fromArray(opts.position);
    else if (kind === 'person') root.position.set((id % 3 - 1) * 1.2, 0, 0);
    if (opts.rotationY != null) root.rotation.y = opts.rotationY;
    if (opts.scale) root.scale.fromArray(opts.scale);
    const tag = labelSprite(label, '#' + new THREE.Color(color).getHexString());
    root.add(tag);
    const item = { id, kind: FURN_TYPES.includes(kind) ? 'furniture' : PROP_TYPES.includes(kind) ? 'prop' : kind, label, color, root, tag, ref: null, note: opts.note || '', fig };
    this._placeTag(item);
    this.items.push(item);
    this.scene.add(root);
    this._emit();
    if (!opts.silent) this.select(item);
    return item;
  }

  setLabel(id, label) {
    const it = this.items.find((i) => i.id === id); if (!it) return;
    it.label = label;
    it.root.remove(it.tag);
    it.tag = labelSprite(label, '#' + new THREE.Color(it.color).getHexString());
    it.root.add(it.tag);
    this._placeTag(it);
    this._emit();
  }

  /** Keep the name tag above the object at a constant on-screen size, whatever the object's scale. */
  _placeTag(it) {
    const s = it.root.scale;
    if (it.kind === 'person') { it.tag.position.set(0, 2.05, 0); it.tag.scale.set(1 / s.x, 0.25 / s.y, 1); }
    else if (it.kind === 'prop') { it.tag.position.set(0, (it.root.userData.prop.h + 0.3) / s.y, 0); it.tag.scale.set(1 / s.x, 0.25 / s.y, 1); }
    else if (it.kind === 'furniture') { const d = it.root.userData.furn; it.tag.position.set(0, ((d.back || d.top || d.seat) + 0.3) / s.y, 0); it.tag.scale.set(1 / s.x, 0.25 / s.y, 1); }
    else { it.tag.position.set(0, 0.5 + 0.3 / s.y, 0); it.tag.scale.set(1 / s.x, 0.25 / s.y, 1); }
  }

  _person(id) { const it = this.items.find((i) => i.id === id); return it && it.fig ? it : null; }

  setPreset(id, key) { const it = this._person(id); if (!it) return; it.fig.applyPreset(key); it.sitsOn = null; it.limbText = {}; this.select(it); this._emit(); }

  nearestFurniture(it, maxD = 2.2) {
    let best = null, bd = maxD;
    this.items.filter((i) => i.kind === 'furniture' && FURN[i.root.userData.furn.type].seat).forEach((f) => {
      const d = Math.hypot(f.root.position.x - it.root.position.x, f.root.position.z - it.root.position.z);
      if (d < bd) { bd = d; best = f; }
    });
    return best;
  }
  /** Sit a person on the nearest seat (or the one given). */
  sitOnNearest(id, furn) {
    const it = this._person(id); if (!it) return false;
    const f = furn || this.nearestFurniture(it);
    if (!f) return false;
    sitOn(it, f); this.select(it); this._emit(); return true;
  }
  /** Arm / leg action for a person, using the furniture they are on (or near) for targets. */
  setLimb(id, limb, action) {
    const it = this._person(id); if (!it) return;
    const furn = this.nearestFurniture(it, 1.4);
    if (action === 'default') { it.fig.applyPreset(it.fig.poseName in POSES ? it.fig.poseName : 'relaxed'); return; }
    applyLimb(it, limb, action, furn); this._emit();
  }
  mirrorPose(id) { const it = this._person(id); if (!it) return; it.fig.mirror(); this._emit(); }
  setHands(id, side, name) {
    const it = this._person(id); if (!it) return;
    const h = [...it.fig.hands]; h[side] = name; it.fig.applyHands(h); this._emit();
  }
  setGender(id, g) {
    const it = this._person(id); if (!it) return;
    this.setBuild(id, { ...DEFAULT_BUILD[g], gender: g });
    if (/^(man|woman|person( \d+)?)$/i.test(it.label)) this.setLabel(id, g === 'female' ? 'woman' : 'man');
  }
  /** Realistic bodies on/off for everyone (remembered): off brings back the editable mannequin with its shape sliders. */
  setRealistic(on) {
    try { localStorage.setItem('hfMannequin', on ? '0' : '1'); } catch { /* private window */ }
    this.items.forEach((i) => { if (!i.fig) return; if (on) attachSkin(i.fig); else detachSkin(i.fig); i.root.traverse((o) => { o.userData.rootId = i.id; }); });
    this._emit();
  }
  setHeight(id, h) { const it = this._person(id); if (!it) return; it.fig.setHeight(h); this._placeTag(it); this._emit(); }
  setBuild(id, b) {
    const it = this._person(id); if (!it) return;
    const wasSel = this.selected === it;
    it.fig.setBuild(b);
    attachSkin(it.fig);
    it.root = it.fig.root;
    it.root.userData.sceneId = id;
    it.root.traverse((o) => { o.userData.rootId = id; });
    it.root.add(it.tag);
    this._placeTag(it);
    if (wasSel) this.select(it);
    this._emit();
  }
  faceCamera(id) {
    const it = this._person(id); if (!it) return;
    const p = it.root.position, c = this.shot.position;
    it.root.rotation.y = Math.atan2(c.x - p.x, c.z - p.z);
    this._emit();
  }
  /** Turn the head toward the shot camera so the character looks into the lens. */
  lookAtCamera(id) {
    const it = this._person(id); if (!it) return;
    this.lookAtPoint(it, this.shot.position);
  }

  /** Turn a figure's head toward a world point (limited to a natural range). */
  lookAtPoint(it, point) {
    const f = it.fig; f.root.updateMatrixWorld(true);
    const head = f.bones.head;
    const from = head.getWorldPosition(new THREE.Vector3());
    const dirWorld = point.clone().sub(from).normalize();
    const parentQ = head.parent.getWorldQuaternion(new THREE.Quaternion());
    const dirLocal = dirWorld.applyQuaternion(parentQ.invert());
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dirLocal);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    const lim = THREE.MathUtils.degToRad(75);
    if (ang > lim) q.slerp(new THREE.Quaternion(), 1 - lim / ang);
    head.quaternion.copy(q);
    f.poseName = 'custom';
    this._emit();
  }
  /** Select a joint of the selected person: orange = drag wrist/ankle (limb follows), cyan = rotate the joint. */
  selectJoint(it, name, mode) {
    this.selected = it; this.joint = name;
    this.items.forEach((i) => i.fig && i.fig.showHandles(i === it));
    const f = it.fig;
    const isIK = IK_BONES.includes(name), hinge = !!HINGE_END[name], pelvis = name === 'hips';
    const canMove = isIK || hinge || pelvis;
    this.jointMode = canMove && (mode || (isIK ? 'translate' : 'rotate')) === 'translate' ? 'translate' : 'rotate';
    f.root.updateMatrixWorld(true);
    if (this.jointMode === 'translate') {
      let tgt;
      if (isIK) { tgt = f.ikTargets[name]; tgt.position.copy(f.endPoint(name)); }
      else if (hinge) { this.pin = { end: HINGE_END[name], pos: f.endPoint(HINGE_END[name]) }; tgt = f.poleTargets[name]; tgt.position.copy(f.endPoint(name)); }
      else { this.pin = { feet: { footL: f.endPoint('footL'), footR: f.endPoint('footR') } }; tgt = f.pelvisTarget; tgt.position.copy(f.bones.hips.position); }
      this.gizmo.attach(tgt); this.gizmo.setSpace('world'); this.gizmo.setMode('translate');
    } else {
      this.gizmo.attach(f.bones[name]); this.gizmo.setSpace('local'); this.gizmo.setMode('rotate');
    }
    this.cb.onSelect?.(it); this.cb.onJoint?.(name, jointName(name), isIK, this.jointMode, canMove);
  }

  remove(id, keepSelection) {
    const i = this.items.findIndex((x) => x.id === id); if (i < 0) return;
    const it = this.items[i];
    if (this.selected?.id === id) this.gizmo.detach();
    this.scene.remove(it.root);
    this.items.splice(i, 1);
    if (!keepSelection) { this.selected = null; this.cb.onSelect?.(null); }
    this._emit();
  }

  clear() { [...this.items].forEach((i) => this.remove(i.id)); }

  select(itemOrNull) {
    this.selected = itemOrNull || null;
    this.joint = null;
    this.gizmo.setSpace('world'); this.gizmo.setMode(this.mode || 'translate');
    this.items.forEach((i) => i.fig && i.fig.showHandles(i === itemOrNull));
    this.cb.onJoint?.(null);
    if (itemOrNull === 'camera') { this.gizmo.attach(this.shot); this.cb.onSelect?.('camera'); return; }
    if (itemOrNull) this.gizmo.attach(itemOrNull.root); else this.gizmo.detach();
    this.cb.onSelect?.(this.selected);
  }

  setActive(on) { this.active = on; if (on) this._resize(); }

  setLimits(on) { this.limitsOn = on; this.items.forEach((i) => i.fig && i.fig.setLimits(on)); this._emit(); }

  setJointMode(m) { if (this.joint && this.selected && this.selected.fig) this.selectJoint(this.selected, this.joint, m); }

  setGizmo(mode) {
    this.mode = mode;
    if (this.joint && this.selected && this.selected !== 'camera' && this.selected.fig && mode !== 'scale') { this.selectJoint(this.selected, this.joint, mode === 'rotate' ? 'rotate' : 'translate'); return; }
    this.joint = null; this.gizmo.setSpace('world'); if (this.selected && this.selected !== 'camera') this.gizmo.attach(this.selected.root); this.gizmo.setMode(mode); this.cb.onJoint?.(null); }

  // ------------------------------------------------------------------ camera / view
  setLens(mm) { this.lens = mm; this._applyShot(); }
  setAspect(a) { this.aspect = a; this._applyShot(); this._resize(); }
  _applyShot() {
    this.shot.aspect = this.aspect;
    this.shot.fov = lensToFov(this.lens, this.aspect);
    this.shot.updateProjectionMatrix();
    this.helper.update();
    this._emit();
  }
  setShot({ height, pitch, yaw }) {
    if (height != null) this.shot.position.y = height;
    const e = new THREE.Euler().setFromQuaternion(this.shot.quaternion, 'YXZ');
    if (pitch != null) e.x = THREE.MathUtils.degToRad(pitch);
    if (yaw != null) e.y = THREE.MathUtils.degToRad(yaw);
    e.z = 0;
    this.shot.quaternion.setFromEuler(e);
    this._emit();
  }
  lookAt(point) { this.shot.lookAt(point); this._emit(); }
  frameSelected() {
    const it = this.selected && this.selected !== 'camera' ? this.selected : null;
    const c = it ? it.root.position : new THREE.Vector3(0, 1, 0);
    this.orbit.target.copy(c).setY(Math.max(0.8, c.y)); this.orbit.update();
  }
  setView(v) {
    this.view = v;
    this.orbit.enabled = v === 'layout';
    this.gizmo.camera = v === 'layout' ? this.cam : this.shot;
    if (v === 'shot' && this.selected === 'camera') this.select(null);
    this._resize();
  }
  setFloor(on) { this.floorOn = on; this.floor.visible = on; }
  setWall(on) { this.wallOn = !!on; this._updateShell(); }

  /** Size the room so the camera and everyone in the scene are inside it. */
  _updateShell() {
    const pts = [new THREE.Vector3(0, 0, 0), this.shot.position];
    this.items.forEach((i) => pts.push(i.root.position));
    const box = new THREE.Box3().setFromPoints(pts);
    const c = box.getCenter(new THREE.Vector3());
    const w = Math.max(9, box.max.x - box.min.x + 7), d = Math.max(9, box.max.z - box.min.z + 7);
    const h = Math.max(3.1, this.shot.position.y + 0.9, ...this.items.map((i) => (i.fig ? i.fig.build.height + 0.8 : 0)));
    this.shell.scale.set(w, h, d);
    this.shell.position.set(c.x, h / 2 - 0.03, c.z);
  }

  shotInfo() {
    const e = new THREE.Euler().setFromQuaternion(this.shot.quaternion, 'YXZ');
    return {
      height: +this.shot.position.y.toFixed(2), pitch: +THREE.MathUtils.radToDeg(e.x).toFixed(1), yaw: +THREE.MathUtils.radToDeg(e.y).toFixed(1), roll: +THREE.MathUtils.radToDeg(e.z).toFixed(1),
      lens: this.lens, fov: +this.shot.fov.toFixed(1),
    };
  }

  _emit() {
    this.helper.update();
    this._updateShell();
    this.items.forEach((i) => this._placeTag(i));
    this.cb.onObjects?.(this.items.map((i) => ({ id: i.id, kind: i.kind, label: i.label, color: i.color, hasRef: !!i.ref, gender: i.fig?.build.gender })));
    this.cb.onShot?.(this.shotInfo());
  }

  // ------------------------------------------------------------------ interaction
  _pointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null;
      if (moved > 5 || this.gizmo.dragging) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.view === 'layout' ? this.cam : this.shot);
      const sel = this.selected && this.selected !== 'camera' ? this.selected : null;
      if (sel && sel.fig) {
        const hh = ray.intersectObjects(sel.fig.handles.filter((x) => x.visible), false)[0];
        if (hh) { this.selectJoint(sel, hh.object.userData.joint); return; }
      }
      const targets = this.items.map((i) => i.root);
      if (this.view === 'layout') targets.push(this.camBody);
      const hit = ray.intersectObjects(targets, true).find((h) => !h.object.isSprite);
      if (!hit) { this.select(null); return; }
      if (hit.object === this.camBody || hit.object.parent === this.camBody) { this.select('camera'); return; }
      const id = hit.object.userData.rootId;
      this.select(this.items.find((i) => i.id === id) || null);
    });
  }

  _resize() {
    const w = this.container.clientWidth || 800, h = this.container.clientHeight || 500;
    this.renderer.setSize(w, h);
    this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
    // letterboxed rectangle of the output frame inside the viewport (shot view)
    let rw = w, rh = w / this.aspect;
    if (rh > h) { rh = h; rw = h * this.aspect; }
    this.rect = this.view === 'shot' ? { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh } : { x: 0, y: 0, w, h };
    this.cb.onRect?.({ ...this.rect, view: this.view });
  }

  _draw() {
    this.items.forEach((i) => i.fig?.syncSkin?.());
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const r = this.rect;
    this.renderer.setScissor(0, 0, w, h); this.renderer.setViewport(0, 0, w, h);
    this.renderer.setClearColor(0x080a10, 1); this.renderer.clear();
    this.renderer.setScissor(r.x, h - r.y - r.h, r.w, r.h);
    this.renderer.setViewport(r.x, h - r.y - r.h, r.w, r.h);
    this.helper.visible = this.view === 'layout';
    this.shell.visible = this.wallOn && this.view === 'shot';      // hidden in the layout view so you can see inside
    this.camBody.visible = this.view === 'layout';
    this.items.forEach((i) => { if (i.fig) i.fig.arrow.visible = this.view === 'layout'; i.tag.visible = this.view === 'layout'; });
    this.gizmo.visible = !!this.gizmo.object;
    this.renderer.setClearColor(0x0f1320, 1);
    this.renderer.render(this.scene, this.view === 'layout' ? this.cam : this.shot);
  }

  // ------------------------------------------------------------------ outputs
  /** Depth map PNG of the shot camera (white = near). */
  async renderDepth(width, height) {
    this.items.forEach((i) => i.fig?.syncSkin?.());
    const mat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      // skinning chunks so a posed realistic body is measured where it stands, not in its bind pose
      vertexShader: `#include <common>
#include <skinning_pars_vertex>
varying float vZ; void main(){
#include <skinbase_vertex>
#include <begin_vertex>
#include <skinning_vertex>
 vec4 mv = modelViewMatrix*vec4(transformed,1.0); vZ=-mv.z; gl_Position=projectionMatrix*mv; }`,
      fragmentShader: 'varying float vZ; void main(){ gl_FragColor = vec4(vZ,0.0,0.0,1.0); }',
    });
    const rt = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const cam = this.shot.clone(); cam.aspect = width / height; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    const hidden = [];
    this.scene.traverse((o) => { if ((o.userData.helper || o === this.gizmo || o.isTransformControls) && o.visible) { hidden.push(o); o.visible = false; } });
    this._updateShell(); this.shell.visible = this.wallOn;
    const prevBg = this.scene.background; this.scene.background = new THREE.Color(0x000000);
    this.scene.overrideMaterial = mat;
    this.renderer.setScissorTest(false);
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    const buf = new Float32Array(width * height * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);
    this.renderer.setRenderTarget(null);
    this.renderer.setScissorTest(true);
    this.scene.overrideMaterial = null; this.scene.background = prevBg;
    hidden.forEach((o) => { o.visible = true; });
    rt.dispose(); mat.dispose();

    // inverse depth, 1st-99th percentile stretch (matches how DA-style depth maps look), bg = black
    const inv = new Float32Array(width * height);
    const samples = [];
    for (let i = 0; i < width * height; i++) {
      const z = buf[i * 4];
      inv[i] = z > 0 ? 1 / z : 0;
      if (z > 0 && i % 7 === 0) samples.push(inv[i]);
    }
    samples.sort((a, b) => a - b);
    const lo = samples[Math.floor(samples.length * 0.01)] ?? 0;
    const hi = samples[Math.floor(samples.length * 0.99)] ?? 1;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); const img = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const src = (height - 1 - y) * width + x;      // GL reads bottom-up
        const v = inv[src] > 0 ? Math.max(0, Math.min(1, (inv[src] - lo) / Math.max(1e-6, hi - lo))) : 0;
        const o = (y * width + x) * 4;
        const g = Math.round(20 + v * 235);
        img.data[o] = img.data[o + 1] = img.data[o + 2] = inv[src] > 0 ? g : 0; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return new Promise((res) => canvas.toBlob(res, 'image/png'));
  }

  /** Text description of the layout in the camera's frame, so the model knows who is where. */
  describe(opts = {}) {
    const cam = this.shot;
    cam.updateMatrixWorld();
    const info = this.shotInfo();
    const out = [];
    const v = new THREE.Vector3();
    for (const it of this.items) {
      v.copy(it.root.position); v.y += it.kind === 'person' ? 0.9 * ((it.fig && it.fig.build.height) || 1.75) / 1.75 : 0.4;
      const world = v.clone();
      v.project(cam);
      const inFront = world.clone().applyMatrix4(cam.matrixWorldInverse).z < 0;
      const dist = world.distanceTo(cam.position);
      const entry = { label: it.label, kind: it.kind, sx: v.x, sy: v.y, dist, inFrame: inFront && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15, note: it.note };
      if (it.kind === 'person') {
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(it.root.quaternion).setY(0).normalize();
        const toCam = cam.position.clone().sub(it.root.position).setY(0).normalize();
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
        const dot = fwd.dot(toCam);                       // +1: looking straight into the lens
        const lr = fwd.dot(right) > 0 ? 'right' : 'left'; // which side of the frame they face
        entry.facing = dot > 0.85 ? 'facing the camera'
          : dot > 0.35 ? `turned three-quarters toward the camera, facing ${lr} of frame`
            : dot > -0.35 ? `in profile, facing ${lr}`
              : dot > -0.85 ? `back three-quarters to the camera, facing ${lr} of frame`
                : 'facing away from the camera, back to us';
        entry.pose = it.fig ? it.fig.poseName : 'stand';
        // the mannequin is bare, and a depth silhouette alone makes the image model paint bare skin: always name an outfit unless the user gave one
        const dressed = /(wear|wearing|wears|dress|dressed|shirt|t-shirt|top|jacket|hoodie|suit|coat|uniform|jeans|pants|trousers|skirt|sweater|jumper|robe|pajamas|pyjamas|gown|apron|costume|clothes)/i.test(it.note || '');
        entry.outfit = dressed ? '' : outfitText(it.fig?.build.gender, it.fig?.build.outfit);     // the clothes the 3D body is wearing
        entry.sits = it.sitsOn; entry.limbs = Object.values(it.limbText || {}).filter(Boolean);
        if (opts.body && it.fig) entry.body = describeBuild(it.fig.build);
      }
      out.push(entry);
    }
    const band = (d) => (d < 3.5 ? 'foreground' : d < 9 ? 'midground' : 'background');
    const lines = out.filter((e) => e.inFrame).sort((a, b) => a.sx - b.sx).map((e) => {
      const xs = e.sx < -0.5 ? 'far left' : e.sx < -0.15 ? 'left' : e.sx > 0.5 ? 'far right' : e.sx > 0.15 ? 'right' : 'center';
      const ys = e.sy > 0.45 ? ', high in frame' : e.sy < -0.35 ? ', low in frame' : '';
      const pl = e.pose && e.pose !== 'stand' && e.pose !== 'custom' && POSES[e.pose] ? POSES[e.pose].label.toLowerCase() : '';
      const extra = [e.facing, e.sits ? `sitting on the ${e.sits}, thighs on the seat, knees bent, lower legs hanging down in front of the seat with both feet flat on the floor` : pl, ...(e.limbs || []), e.note].filter(Boolean).join(', ');
      return `${e.label}${e.body ? ` (${e.body})` : ''}${e.outfit ? `, fully clothed, wearing ${e.outfit}` : ''}: ${xs} of frame${ys}, ${band(e.dist)}${extra ? `, ${extra}` : ''}`;
    });
    const tilt = info.pitch > 12 ? 'looking up (low angle)' : info.pitch < -12 ? 'looking down (high angle)' : 'level';
    const heightWord = info.height < 0.8 ? 'ground-level' : info.height > 3 ? 'high' : info.height > 1.9 ? 'raised' : 'eye-level';
    const lensWord = info.lens <= 24 ? 'wide-angle' : info.lens >= 85 ? 'telephoto' : info.lens >= 50 ? 'portrait' : 'standard';
    const dutch = Math.abs(info.roll) > 6 ? `, Dutch angle (horizon tilted ${Math.abs(Math.round(info.roll))} degrees)` : '';
    return { camera: `${lensWord} ${info.lens} mm lens, ${heightWord} camera at ${info.height} m, ${tilt}${dutch}`, subjects: lines, info };
  }

  /** The whole scene as plain data (people with full pose + build, props, furniture, camera). */
  serialize() {
    return {
      v: 1,
      items: this.items.map((it) => ({
        kind: it.kind, type: it.kind === 'furniture' ? it.root.userData.furn.type : it.kind === 'prop' ? it.root.userData.prop.type : it.kind, label: it.label, color: it.color, note: it.note || '', auto: it.auto || null,
        p: it.root.position.toArray(), ry: it.root.rotation.y, s: it.root.scale.toArray(),
        fig: it.fig ? { build: { ...it.fig.build }, pose: it.fig.getPose(), poseName: it.fig.poseName, limits: it.fig.limitsOn } : null,
        sitsOn: it.sitsOn || null, limbText: it.limbText || {},
      })),
      shot: { p: this.shot.position.toArray(), q: this.shot.quaternion.toArray(), lens: this.lens, aspect: this.aspect },
      floor: this.floorOn, wall: this.wallOn,
    };
  }

  /** Rebuild a scene from `serialize()` output. Item order is preserved (so reference photos can be re-attached by index). */
  load(d) {
    this.select(null);
    this.clear();
    (d.items || []).forEach((o) => {
      const base = { label: o.label, color: o.color, position: o.p, rotationY: o.ry, silent: true };
      let it;
      if (o.fig) {
        it = this.add('person', { ...base, gender: o.fig.build.gender, build: o.fig.build });
        it.fig.limitsOn = o.fig.limits !== false;
        it.fig.setPose({ ...o.fig.pose, name: o.fig.poseName, clamp: false });
        it.fig.poseName = o.fig.poseName;
        it.root.position.fromArray(o.p); it.root.rotation.y = o.ry;
      } else {
        it = this.add(o.type, { ...base, scale: o.kind === 'furniture' ? undefined : o.s });
        if (o.kind === 'furniture') it.root.scale.fromArray(o.s);
      }
      it.note = o.note || ''; it.auto = o.auto || undefined; it.sitsOn = o.sitsOn || null; it.limbText = o.limbText || {};
    });
    if (d.shot) {
      this.shot.position.fromArray(d.shot.p); this.shot.quaternion.fromArray(d.shot.q);
      this.aspect = d.shot.aspect; this.lens = d.shot.lens; this._applyShot(); this._resize();
    }
    if (d.floor != null) this.setFloor(d.floor);
    if (d.wall != null) this.setWall(d.wall);
    this._emit();
  }

  /** Pixel box of a person in an image rendered from the shot camera (W x H), padded and clamped. */
  screenBox(it, W, H, pad = 0.08) {
    this.shot.updateMatrixWorld(); this.shot.updateProjectionMatrix();
    it.root.updateMatrixWorld(true);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const v = new THREE.Vector3();
    it.root.traverse((m) => {
      if (!m.isMesh || m.userData.helper || m.userData.skinMesh) return;   // the (hidden) mannequin follows the same pose and has true bounds
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(m.matrixWorld).project(this.shot);
        const px = ((v.x + 1) / 2) * W, py = ((1 - v.y) / 2) * H;
        x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
      }
    });
    const pw = (x1 - x0) * pad, ph = (y1 - y0) * pad;
    return { x0: Math.max(0, x0 - pw), y0: Math.max(0, y0 - ph), x1: Math.min(W, x1 + pw), y1: Math.min(H, y1 + ph) };
  }

  /** Small JPEG of the current view, for the saved-scene list. Call right after a draw. */
  thumbnail(w = 240) {
    this._draw();
    const src = this.renderer.domElement; const h = Math.round((w * src.height) / src.width);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.7);
  }

  dispose() {
    this._offSkins?.();
    this._running = false; cancelAnimationFrame(this._raf);
    this._ro.disconnect(); this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
