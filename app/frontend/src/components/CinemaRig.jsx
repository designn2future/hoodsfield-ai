import React from 'react';
import {
  CAMERA_BODIES, LENSES, FOCAL_LENGTHS, APERTURES, SHOT_SIZES, ANGLES, FILM_LOOKS, LIGHTING,
  PALETTE_PRESETS, rigToPrompt,
} from '../cinema.js';

/** Cinema Studio-style virtual camera rig. Pure controlled component: `rig`
 * is plain data (see DEFAULT_RIG); the compiled clause is previewed live. */
export default function CinemaRig({ rig, setRig, busy }) {
  const set = (k, v) => setRig((r) => ({ ...r, [k]: v }));
  const sel = (key, opts, valKey = 'id') => (
    <select value={rig[key]} disabled={busy}
      onChange={(e) => set(key, typeof opts[0][valKey] === 'number' ? +e.target.value : e.target.value)}>
      {opts.map((o) => <option key={o[valKey]} value={o[valKey]}>{o.label || (o.mm ? `${o.mm}mm` : `f/${o.f}`)}</option>)}
    </select>
  );
  const addColor = () => set('palette', [...(rig.palette || []), '#14e8ff'].slice(0, 5));
  const setColor = (i, v) => set('palette', rig.palette.map((c, j) => (j === i ? v : c)));
  const rmColor = (i) => set('palette', rig.palette.filter((_, j) => j !== i));

  return (
    <div className="cinema-rig">
      <label className="checkbox-label">
        <input type="checkbox" checked={!!rig.enabled} disabled={busy}
          onChange={(e) => set('enabled', e.target.checked)} />
        🎥 Cinema rig
      </label>
      <div className="hint" style={{ marginTop: 0 }}>Camera, lens, light &amp; grade are added to the prompt.</div>
      {rig.enabled && (
        <>
          <div className="grid2">
            <label>Camera body{sel('body', CAMERA_BODIES)}</label>
            <label>Lens{sel('lens', LENSES)}</label>
            <label>Focal length{sel('focal', FOCAL_LENGTHS, 'mm')}</label>
            <label>Aperture{sel('aperture', APERTURES, 'f')}</label>
            <label>Shot size{sel('shot', SHOT_SIZES)}</label>
            <label>Camera angle{sel('angle', ANGLES)}</label>
            <label>Film / grade{sel('film', FILM_LOOKS)}</label>
            <label>Lighting{sel('light', LIGHTING)}</label>
          </div>
          <label>Color palette (HEX)</label>
          <div className="palette-row">
            {(rig.palette || []).map((c, i) => (
              <span key={i} className="swatch">
                <input type="color" value={c} disabled={busy} onChange={(e) => setColor(i, e.target.value)} />
                <button className="x" disabled={busy} onClick={() => rmColor(i)} title="Remove">×</button>
              </span>
            ))}
            {(rig.palette || []).length < 5 && <button disabled={busy} onClick={addColor}>+ color</button>}
            {PALETTE_PRESETS.map((p) => (
              <button key={p.id} disabled={busy} title={p.colors.join(' ')} onClick={() => set('palette', p.colors)}
                style={{ background: `linear-gradient(90deg, ${p.colors.join(',')})`, color: '#fff', textShadow: '0 0 3px #000' }}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="hint rig-preview">{rigToPrompt(rig)}</div>
        </>
      )}
    </div>
  );
}
