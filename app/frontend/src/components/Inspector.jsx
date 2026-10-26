import React, { useReducer } from 'react';

function Vec3Row({ label, obj, prop, step = 0.1, toDeg = false, onChange }) {
  const v = obj[prop];
  const conv = toDeg ? (x) => (x * 180) / Math.PI : (x) => x;
  const back = toDeg ? (x) => (x * Math.PI) / 180 : (x) => x;
  return (
    <div className="vec3">
      <span className="vlabel">{label}</span>
      {['x', 'y', 'z'].map((axis) => (
        <input key={axis} type="number" step={step} value={round(conv(v[axis]))}
          onChange={(e) => { v[axis] = back(parseFloat(e.target.value) || 0); onChange(); }} />
      ))}
    </div>
  );
}

const round = (n) => Math.round(n * 100) / 100;

export default function Inspector({ selected, objects, onPick, onChange }) {
  const [, force] = useReducer((x) => x + 1, 0);
  const refresh = () => { force(); onChange(); };

  return (
    <section className="panel">
      <h3>Scene</h3>
      <div className="objlist">
        {objects.map((o) => (
          <div key={o.uuid} className={`objrow ${selected === o ? 'sel' : ''}`} onClick={() => onPick(o)}>
            {o.name}
          </div>
        ))}
        {!objects.length && <div className="hint">Add a primitive from the toolbar</div>}
      </div>
      {selected && (
        <>
          <h3>Transform — {selected.name}</h3>
          <Vec3Row label="Pos" obj={selected} prop="position" onChange={refresh} />
          <Vec3Row label="Rot°" obj={selected} prop="rotation" step={5} toDeg onChange={refresh} />
          <Vec3Row label="Scale" obj={selected} prop="scale" onChange={refresh} />
        </>
      )}
    </section>
  );
}
