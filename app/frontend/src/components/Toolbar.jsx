import React from 'react';
import CameraCube from './CameraCube.jsx';
import CameraDial from './CameraDial.jsx';

const PRIMS = [
  ['cube', '◼ Cube'],
  ['sphere', '● Sphere'],
  ['cylinder', '▮ Cylinder'],
  ['cone', '▲ Cone'],
  ['torus', '◯ Torus'],
  ['plane', '▬ Plane'],
];

export default function Toolbar({ style, gizmoMode, depthView, hasSelection, studioRef, onAdd, onMode, onDelete, onDepthView }) {
  return (
    <nav className="toolbar" style={style}>
      <div className="group-label">Camera</div>
      <div className="camera-console">
        <CameraCube studioRef={studioRef} size={92} />
        <CameraDial studioRef={studioRef} />
        <button className="cc-home" title="Reset to the establishing view" onClick={() => studioRef.current?.resetView()}>⌂ Home</button>
      </div>

      <div className="group-label">Add</div>
      {PRIMS.map(([t, label]) => (
        <button key={t} onClick={() => onAdd(t)}>{label}</button>
      ))}
      <div className="group-label">Gizmo</div>
      {['translate', 'rotate', 'scale'].map((m) => (
        <button key={m} className={gizmoMode === m ? 'active' : ''} onClick={() => onMode(m)}>
          {m[0].toUpperCase() + m.slice(1)}
        </button>
      ))}
      <div className="group-label">View</div>
      <button className={depthView ? 'active' : ''} onClick={onDepthView} title="Preview the exact depth pass sent to LTX">
        Depth view
      </button>
      <div className="spacer" />
      <button className="danger" disabled={!hasSelection} onClick={onDelete}>Delete</button>
    </nav>
  );
}
