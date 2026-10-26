import React, { useRef, useState } from 'react';

/** Big drag-and-drop target used as the empty state of the tools: drop or pick a
 * file, or click a thumbnail from the Gallery. `accept` = 'image' | 'video' | 'both'. */
export default function DropZone({ accept = 'both', title, hint, assets = [], onFile, onAsset, icon = '⬆️' }) {
  const [over, setOver] = useState(false);
  const ref = useRef(null);
  const okMime = (m = '') => (accept === 'both' ? /^(image|video)\//.test(m) : m.startsWith(`${accept}/`));
  const pool = assets.filter((a) => okMime(a.mime) && a.kind !== 'sketch' && a.kind !== 'styleref').slice(-10).reverse();
  const acceptAttr = accept === 'both' ? 'image/*,video/*' : `${accept}/*`;

  return (
    <div className="dz-wrap">
      <div
        className={`dz ${over ? 'over' : ''}`}
        onClick={() => ref.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = [...e.dataTransfer.files].find((x) => okMime(x.type)); if (f) onFile(f); }}
      >
        <div className="dz-ico">{icon}</div>
        <div className="dz-title">{title}</div>
        <div className="dz-hint">{hint || `Drop ${accept === 'both' ? 'an image or video' : `a${accept === 'image' ? 'n image' : ' video'}`} here, or click to browse`}</div>
      </div>
      <input ref={ref} type="file" accept={acceptAttr} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      {pool.length > 0 && (
        <>
          <div className="dz-sub">…or pick from your Gallery</div>
          <div className="dz-strip">
            {pool.map((a) => (
              <button key={a.id} className="dz-thumb" title={a.name} onClick={() => onAsset(a)}>
                {a.mime.startsWith('video') ? <video src={a.url} muted /> : <img src={a.url} alt={a.name} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
