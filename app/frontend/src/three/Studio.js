import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

/**
 * Studio — owns the Three.js scene, editor camera, shot camera, gizmo,
 * camera keyframes, and the depth-pass exporter.
 *
 * Depth encoding (must match the ComfyUI workflow's expectation):
 *   8-bit grayscale PNG, WHITE = NEAR, black = far,
 *   linear in view-space Z between camera near and `depthFar`.
 */
export class Studio {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.cb = callbacks; // { onSelect(obj|null), onObjects(list), onKeyframes(list) }

    this.objects = [];
    this.keyframes = []; // { id, t(sec), pos:Vector3, quat:Quaternion, fov }
    this.duration = 4; // seconds, set from UI
    this.depthFar = 25;
    this.previewTime = null; // when a number, viewport renders through shot cam
    this.depthPreview = false;
    this._kfId = 1;
    this._objId = 1;

    this._initRenderer();
    this._initScene();
    this._initControls();
    this._initDepthMaterial();
    this._bindPointer();

    this._resizeObs = new ResizeObserver(() => this._resize());
    this._resizeObs.observe(container);
    this._resize();

    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    // starter content
    this.addPrimitive('plane');
    this.addPrimitive('cube');
    this.select(this.objects[1]);
  }

  // ---------------------------------------------------------- setup

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.container.appendChild(this.renderer.domElement);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x16181d);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    this.camera.position.set(6, 4, 9);
    this.camera.lookAt(0, 0.5, 0);

    this.shotCamera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500);
    this.shotCamera.position.copy(this.camera.position);
    this.shotCamera.quaternion.copy(this.camera.quaternion);
    this.shotHelper = new THREE.CameraHelper(this.shotCamera);
    this.shotHelper.visible = false;
    this.scene.add(this.shotCamera, this.shotHelper);

    this.grid = new THREE.GridHelper(40, 40, 0x3a3f4a, 0x262a32);
    this.scene.add(this.grid);

    this.scene.add(new THREE.HemisphereLight(0xdde4ff, 0x30343c, 1.2));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(5, 10, 6);
    this.scene.add(dir);
  }

  _initControls() {
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 0.5, 0);
    this.orbit.update();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.addEventListener('dragging-changed', (e) => (this.orbit.enabled = !e.value));
    this.scene.add(this.gizmo);
  }

  _initDepthMaterial() {
    this.depthMaterial = new THREE.ShaderMaterial({
      uniforms: { uNear: { value: 0.1 }, uFar: { value: this.depthFar } },
      vertexShader: /* glsl */ `
        varying float vViewZ;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vViewZ = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNear; uniform float uFar;
        varying float vViewZ;
        void main() {
          float d = clamp((vViewZ - uNear) / (uFar - uNear), 0.0, 1.0);
          float v = 1.0 - d; /* white = near */
          gl_FragColor = vec4(v, v, v, 1.0);
        }`,
    });
  }

  _bindPointer() {
    const el = this.renderer.domElement;
    let downPos = null;
    el.addEventListener('pointerdown', (e) => (downPos = [e.clientX, e.clientY]));
    el.addEventListener('pointerup', (e) => {
      if (!downPos) return;
      const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
      downPos = null;
      if (moved > 5 || this.gizmo.dragging) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hits = ray.intersectObjects(this.objects, false);
      this.select(hits.length ? hits[0].object : null);
    });
  }

  _resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _render() {
    let cam = this.camera;
    if (this.previewTime !== null && this.keyframes.length) {
      this.sampleCamera(this.previewTime, this.shotCamera);
      this.shotCamera.aspect = this.camera.aspect;
      this.shotCamera.updateProjectionMatrix();
      cam = this.shotCamera;
    }
    this.shotHelper.visible = this.previewTime === null && this.keyframes.length > 0;
    this.shotHelper.update();

    if (this.depthPreview) {
      this.depthMaterial.uniforms.uFar.value = this.depthFar;
      this._setHelpersVisible(false);
      const bg = this.scene.background;
      this.scene.background = new THREE.Color(0x000000);
      this.scene.overrideMaterial = this.depthMaterial;
      this.renderer.render(this.scene, cam);
      this.scene.overrideMaterial = null;
      this.scene.background = bg;
      this._setHelpersVisible(true);
    } else {
      this.renderer.render(this.scene, cam);
    }
  }

  _setHelpersVisible(v) {
    this.grid.visible = v;
    this.gizmo.visible = v && !!this.gizmo.object;
    this.shotHelper.visible = v && this.previewTime === null && this.keyframes.length > 0;
    if (!v) this.shotHelper.visible = false;
  }

  // ---------------------------------------------------------- objects

  addPrimitive(type) {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(Math.random(), 0.35, 0.6),
      roughness: 0.8,
    });
    let geo, name;
    switch (type) {
      case 'sphere': geo = new THREE.SphereGeometry(0.7, 32, 16); name = 'Sphere'; break;
      case 'cylinder': geo = new THREE.CylinderGeometry(0.5, 0.5, 1.4, 32); name = 'Cylinder'; break;
      case 'cone': geo = new THREE.ConeGeometry(0.6, 1.4, 32); name = 'Cone'; break;
      case 'torus': geo = new THREE.TorusGeometry(0.6, 0.22, 16, 48); name = 'Torus'; break;
      case 'plane': geo = new THREE.PlaneGeometry(30, 30); name = 'Ground'; break;
      default: geo = new THREE.BoxGeometry(1, 1, 1); name = 'Cube';
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `${name} ${this._objId++}`;
    if (type === 'plane') {
      mesh.rotation.x = -Math.PI / 2;
      mesh.material.color.set(0x555a66);
      mesh.material.side = THREE.DoubleSide;
    } else {
      mesh.position.set((Math.random() - 0.5) * 3, 0.7, (Math.random() - 0.5) * 3);
    }
    this.scene.add(mesh);
    this.objects.push(mesh);
    this.cb.onObjects?.([...this.objects]);
    if (type !== 'plane') this.select(mesh);
    return mesh;
  }

  select(obj) {
    this.selected = obj || null;
    if (obj) this.gizmo.attach(obj);
    else this.gizmo.detach();
    this.cb.onSelect?.(this.selected);
  }

  deleteSelected() {
    if (!this.selected) return;
    this.gizmo.detach();
    this.scene.remove(this.selected);
    this.selected.geometry.dispose();
    this.selected.material.dispose();
    this.objects = this.objects.filter((o) => o !== this.selected);
    this.selected = null;
    this.cb.onObjects?.([...this.objects]);
    this.cb.onSelect?.(null);
  }

  setGizmoMode(mode) {
    this.gizmo.setMode(mode); // 'translate' | 'rotate' | 'scale'
  }

  // ---------------------------------------------------------- live camera moves (Camera Console)

  /**
   * Drive the editor camera live from a normalized joystick offset
   * (dx, dy in roughly [-1, 1]) for one animation-frame tick (dt seconds).
   * Called continuously while the Camera Console's joystick is held —
   * this is the "creative" camera-movement input, distinct from the plain
   * mouse-drag orbit. Each mode moves the camera differently:
   *   orbit — sweep azimuth/elevation around the current orbit target
   *   pan   — tilt/rotate the camera in place (tripod pan/tilt), dragging
   *           the look-at target along so orbiting afterward still feels right
   *   dolly — push the camera forward/back along its own view direction
   *   crane — raise/lower the camera (and its target) on the world Y axis
   *   arc   — like orbit but locked elevation — a flat sweep around the subject
   * `speed` scales metres/radians per second; SPEED_SCALE below gives a
   * good feel for the studio's default scene scale.
   */
  applyCameraMove(mode, dx, dy, dt) {
    const S = Studio.SPEED_SCALE;
    switch (mode) {
      case 'orbit': {
        const offset = this.camera.position.clone().sub(this.orbit.target);
        const sph = new THREE.Spherical().setFromVector3(offset);
        sph.theta -= dx * S.orbit * dt;
        sph.phi = THREE.MathUtils.clamp(sph.phi - dy * S.orbit * dt, 0.08, Math.PI - 0.08);
        offset.setFromSpherical(sph);
        this.camera.position.copy(this.orbit.target).add(offset);
        this.camera.lookAt(this.orbit.target);
        this.orbit.update();
        break;
      }
      case 'arc': {
        const offset = this.camera.position.clone().sub(this.orbit.target);
        const sph = new THREE.Spherical().setFromVector3(offset);
        sph.theta -= dx * S.arc * dt;
        offset.setFromSpherical(sph);
        this.camera.position.copy(this.orbit.target).add(offset);
        this.camera.lookAt(this.orbit.target);
        this.orbit.update();
        break;
      }
      case 'pan': {
        const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
        euler.y -= dx * S.pan * dt;
        euler.x = THREE.MathUtils.clamp(euler.x - dy * S.pan * dt, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
        this.camera.quaternion.setFromEuler(euler);
        const dist = Math.max(0.5, this.camera.position.distanceTo(this.orbit.target));
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        this.orbit.target.copy(this.camera.position).addScaledVector(dir, dist);
        this.orbit.update();
        break;
      }
      case 'dolly': {
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        const amt = -dy * S.dolly * dt;
        this.camera.position.addScaledVector(dir, amt);
        this.orbit.target.addScaledVector(dir, amt);
        this.orbit.update();
        break;
      }
      case 'crane': {
        const amt = -dy * S.crane * dt;
        this.camera.position.y = Math.max(0.1, this.camera.position.y + amt);
        this.orbit.target.y += amt;
        this.orbit.update();
        break;
      }
      default:
        break;
    }
  }

  /** Smoothly tween the editor camera to a named preset view, keeping the
   * current orbit target and distance (so zoom level survives the cut). */
  snapView(name) {
    const dir = (Studio.VIEW_DIRS[name] || Studio.VIEW_DIRS.iso).clone().normalize();
    const dist = this.camera.position.distanceTo(this.orbit.target) || 8;
    const startPos = this.camera.position.clone();
    const startQuat = this.camera.quaternion.clone();
    const endPos = this.orbit.target.clone().addScaledVector(dir, dist);
    const look = new THREE.Camera();
    look.position.copy(endPos);
    look.lookAt(this.orbit.target);
    const endQuat = look.quaternion.clone();
    this._tweenCamera(startPos, endPos, startQuat, endQuat);
  }

  /** Return to the studio's initial establishing view. */
  resetView() {
    const startPos = this.camera.position.clone();
    const startQuat = this.camera.quaternion.clone();
    const endPos = new THREE.Vector3(6, 4, 9);
    const look = new THREE.Camera();
    look.position.copy(endPos);
    look.lookAt(0, 0.5, 0);
    this._tweenCamera(startPos, endPos, startQuat, look.quaternion.clone(), new THREE.Vector3(0, 0.5, 0));
  }

  _tweenCamera(startPos, endPos, startQuat, endQuat, endTarget = null) {
    const startTarget = this.orbit.target.clone();
    const finalTarget = endTarget || startTarget;
    const dur = 420;
    const t0 = performance.now();
    const tick = () => {
      const u = Math.min(1, (performance.now() - t0) / dur);
      const e = u * u * (3 - 2 * u); // smoothstep
      this.camera.position.lerpVectors(startPos, endPos, e);
      this.camera.quaternion.slerpQuaternions(startQuat, endQuat, e);
      this.orbit.target.lerpVectors(startTarget, finalTarget, e);
      this.orbit.update();
      if (u < 1) requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------------------------------------------------------- camera keyframes

  /** Capture the CURRENT editor view as a shot-camera keyframe at time t. */
  addKeyframe(t) {
    const kf = {
      id: this._kfId++,
      t,
      pos: this.camera.position.clone(),
      quat: this.camera.quaternion.clone(),
      fov: this.shotCamera.fov,
    };
    this.keyframes = [...this.keyframes.filter((k) => Math.abs(k.t - t) > 1e-3), kf].sort(
      (a, b) => a.t - b.t
    );
    this.cb.onKeyframes?.([...this.keyframes]);
    return kf;
  }

  deleteKeyframe(id) {
    this.keyframes = this.keyframes.filter((k) => k.id !== id);
    this.cb.onKeyframes?.([...this.keyframes]);
  }

  clearKeyframes() {
    this.keyframes = [];
    this.cb.onKeyframes?.([]);
  }

  /** Write the interpolated pose at time t (seconds) into `cam`. */
  sampleCamera(t, cam) {
    const kfs = this.keyframes;
    if (!kfs.length) {
      cam.position.copy(this.camera.position);
      cam.quaternion.copy(this.camera.quaternion);
      return;
    }
    if (t <= kfs[0].t || kfs.length === 1) {
      cam.position.copy(kfs[0].pos);
      cam.quaternion.copy(kfs[0].quat);
      return;
    }
    const last = kfs[kfs.length - 1];
    if (t >= last.t) {
      cam.position.copy(last.pos);
      cam.quaternion.copy(last.quat);
      return;
    }
    let i = 0;
    while (i < kfs.length - 2 && kfs[i + 1].t < t) i++;
    const a = kfs[i], b = kfs[i + 1];
    let u = (t - a.t) / (b.t - a.t);
    u = u * u * (3 - 2 * u); // smoothstep easing per segment
    cam.position.lerpVectors(a.pos, b.pos, u);
    cam.quaternion.slerpQuaternions(a.quat, b.quat, u);
  }

  // ---------------------------------------------------------- depth export

  /**
   * Render the camera path as N depth-pass PNGs.
   * Returns Blob[]; calls onProgress(done, total).
   */
  async exportDepthFrames({ width, height, numFrames, duration, onProgress }) {
    const rt = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const cam = new THREE.PerspectiveCamera(this.shotCamera.fov, width / height, 0.1, 500);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const pixels = new Uint8Array(width * height * 4);
    const blobs = [];

    this.depthMaterial.uniforms.uNear.value = cam.near;
    this.depthMaterial.uniforms.uFar.value = this.depthFar;

    const prevBg = this.scene.background;
    this._setHelpersVisible(false);
    this.scene.background = new THREE.Color(0x000000);
    this.scene.overrideMaterial = this.depthMaterial;

    try {
      for (let i = 0; i < numFrames; i++) {
        const t = numFrames > 1 ? (duration * i) / (numFrames - 1) : 0;
        this.sampleCamera(t, cam);
        cam.updateMatrixWorld();

        this.renderer.setRenderTarget(rt);
        this.renderer.render(this.scene, cam);
        this.renderer.readRenderTargetPixels(rt, 0, 0, width, height, pixels);
        this.renderer.setRenderTarget(null);

        // flip vertically (GL reads bottom-up)
        const img = ctx.createImageData(width, height);
        const rowBytes = width * 4;
        for (let y = 0; y < height; y++) {
          img.data.set(
            pixels.subarray((height - 1 - y) * rowBytes, (height - y) * rowBytes),
            y * rowBytes
          );
        }
        ctx.putImageData(img, 0, 0);
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        blobs.push(blob);
        onProgress?.(i + 1, numFrames);
        if (i % 8 === 0) await new Promise((r) => setTimeout(r, 0)); // keep UI alive
      }
    } finally {
      this.scene.overrideMaterial = null;
      this.scene.background = prevBg;
      this._setHelpersVisible(true);
      rt.dispose();
    }
    return blobs;
  }

  dispose() {
    this._running = false;
    this._resizeObs.disconnect();
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}

// radians or metres per second at full joystick deflection — tuned for the
// studio's default ~10-unit scene scale
Studio.SPEED_SCALE = { orbit: 1.6, arc: 1.6, pan: 1.8, dolly: 9, crane: 6 };

Studio.VIEW_DIRS = {
  front: new THREE.Vector3(0, 0.12, 1),
  back: new THREE.Vector3(0, 0.12, -1),
  left: new THREE.Vector3(-1, 0.12, 0),
  right: new THREE.Vector3(1, 0.12, 0),
  top: new THREE.Vector3(0.001, 1, 0.15),
  bottom: new THREE.Vector3(0.001, -1, 0.15),
  iso: new THREE.Vector3(1, 0.85, 1),
};
