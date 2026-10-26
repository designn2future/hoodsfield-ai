import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

const FACES = ['right', 'left', 'top', 'bottom', 'front', 'back']; // three.js BoxGeometry material-group order
const LABELS = { front: 'FRONT', back: 'BACK', left: 'LEFT', right: 'RIGHT', top: 'TOP', bottom: 'BOTTOM' };

function faceTexture(label, accent) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#20242c';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = accent;
  g.lineWidth = 4;
  g.strokeRect(2, 2, 124, 124);
  g.fillStyle = '#cfd6e4';
  g.font = '700 20px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 64, 64);
  return new THREE.CanvasTexture(c);
}

/**
 * A live 3D orientation gizmo (the "view cube" pattern from Blender/Maya/
 * Unreal) — a small always-rendering cube whose rotation mirrors the studio
 * camera's current orientation, so at a glance you see which way you're
 * looking. Click a face to smoothly cut the studio camera to that view.
 */
export default function CameraCube({ studioRef, size = 96 }) {
  const mountRef = useRef(null);
  const stateRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
    camera.position.set(0, 0, 5.2);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(size, size);
    mount.appendChild(renderer.domElement);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff8a1f';
    const materials = FACES.map((f) => new THREE.MeshBasicMaterial({ map: faceTexture(LABELS[f], accent) }));
    const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), materials);
    scene.add(cube);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(cube.geometry),
      new THREE.LineBasicMaterial({ color: 0x0b0d10 })
    );
    cube.add(edges);
    scene.add(new THREE.AmbientLight(0xffffff, 1));

    const raycaster = new THREE.Raycaster();
    const hoverState = { face: -1 };

    const pick = (e) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObject(cube, false)[0];
      return hit ? hit.face.materialIndex : -1;
    };

    const onMove = (e) => { hoverState.face = pick(e); };
    const onLeave = () => { hoverState.face = -1; };
    const onClick = (e) => {
      const idx = pick(e);
      if (idx >= 0) studioRef?.current?.snapView(FACES[idx]);
    };
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerleave', onLeave);
    renderer.domElement.addEventListener('click', onClick);

    let raf;
    const tick = () => {
      const studio = studioRef?.current;
      if (studio) {
        // mirror the main camera's orientation so the cube always shows
        // "which way you're currently looking"
        cube.quaternion.copy(studio.camera.quaternion);
      }
      materials.forEach((m, i) => (m.color.setScalar(i === hoverState.face ? 1.15 : 1)));
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    stateRef.current = { renderer };
    return () => {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerleave', onLeave);
      renderer.domElement.removeEventListener('click', onClick);
      renderer.dispose();
      materials.forEach((m) => { m.map?.dispose(); m.dispose(); });
      cube.geometry.dispose();
      edges.geometry.dispose();
      edges.material.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [studioRef, size]);

  return (
    <div className="camera-cube" style={{ width: size, height: size }}>
      <div ref={mountRef} />
    </div>
  );
}
