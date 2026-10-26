import React, { useState } from 'react';
import { CAMERA_MOTIONS, MOTION_CATEGORIES, EFFECTS, EFFECT_CATEGORIES } from '../cinema.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Camera-move + effect library (Higgsfield DOP / effects presets, local).
 * Picking a move inserts its motion clause at the front of the prompt (and
 * swaps out whichever move was inserted before); picking an effect replaces
 * the prompt body. The prompt stays plain text, so everything is editable. */
export default function MotionPicker({ prompt, onChange, busy }) {
  const [tab, setTab] = useState('camera');
  const [cat, setCat] = useState(MOTION_CATEGORIES[1]);
  const [ecat, setEcat] = useState(EFFECT_CATEGORIES[0]);
  const present = CAMERA_MOTIONS.find((m) => prompt.includes(cap(m.text)));

  const pickMove = (m) => {
    let base = prompt;
    if (present) base = base.replace(`${cap(present.text)}. `, '').replace(cap(present.text), '').trim();
    if (present?.id === m.id) { onChange(base); return; }       // toggle off
    onChange(`${cap(m.text)}. ${base}`.trim());
  };
  const pickEffect = (e) => onChange(prompt.trim() ? `${prompt.trim().replace(/[.\s]+$/, '')}. ${cap(e.video)}.` : `${cap(e.video)}.`);

  return (
    <div className="motion-picker">
      <div className="seg">
        <button className={tab === 'camera' ? 'active' : ''} onClick={() => setTab('camera')}>🎥 Camera moves ({CAMERA_MOTIONS.length})</button>
        <button className={tab === 'fx' ? 'active' : ''} onClick={() => setTab('fx')}>✨ Effects ({EFFECTS.length})</button>
      </div>
      {tab === 'camera' ? (
        <>
          <div className="chips">
            {MOTION_CATEGORIES.map((c) => (
              <button key={c} className={cat === c ? 'active' : ''} onClick={() => setCat(c)}>{c}</button>
            ))}
          </div>
          <div className="chips motion-chips">
            {CAMERA_MOTIONS.filter((m) => m.cat === cat).map((m) => (
              <button key={m.id} disabled={busy} className={present?.id === m.id ? 'on' : ''}
                title={m.text} onClick={() => pickMove(m)}>{m.label}</button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="chips">
            {EFFECT_CATEGORIES.map((c) => (
              <button key={c} className={ecat === c ? 'active' : ''} onClick={() => setEcat(c)}>{c}</button>
            ))}
          </div>
          <div className="chips motion-chips">
            {EFFECTS.filter((e) => e.cat === ecat).map((e) => (
              <button key={e.id} disabled={busy} title={e.video} onClick={() => pickEffect(e)}>{e.label}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
