import React, { useRef } from 'react';

export default function FloatingBar({ health, onOpenSketch, onOpenStudio, onOpenKrea, onSave, onLoad, onResetView }) {
  const fileRef = useRef(null);
  return (
    <div className="floatbar glass">
      <span className="logo">Hoods<b>field</b></span>
      <button onClick={onOpenSketch}>✏️ Sketch</button>
      <button onClick={onOpenStudio}>🎬 3D Studio</button>
      <button onClick={onOpenKrea}>🖼️ Krea 2</button>
      <span className="divider" />
      <button onClick={onSave} title="Save project (.vstudio)">💾 Save</button>
      <button onClick={() => fileRef.current?.click()} title="Open a .vstudio project">📂 Open</button>
      <button onClick={onResetView} title="Reset board view">⌂</button>
      <input ref={fileRef} type="file" accept=".vstudio,application/json" hidden
        onChange={(e) => { if (e.target.files?.[0]) onLoad(e.target.files[0]); e.target.value = ''; }} />
      {health && (
        <span className={`health ${health.mock || health.comfy_reachable ? 'ok' : 'bad'}`}>
          {health.mock ? 'Mock' : health.comfy_reachable ? 'ComfyUI ●' : 'ComfyUI ○'}
        </span>
      )}
    </div>
  );
}
