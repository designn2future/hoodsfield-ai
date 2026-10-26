import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CompareIfSame } from './BeforeAfter.jsx';

const PAGE = 60;                                   // thumbnails drawn at a time; more are added as you scroll
const isVideo = (a) => (a.mime || '').startsWith('video') || a.kind === 'video';
const isAudio = (a) => (a.mime || '').startsWith('audio') || a.kind === 'audio';
const isEdit = (a) => !!(a.meta?.editedFrom || a.meta?.editTool);
const isUpload = (a) => a.meta?.source === 'upload';

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'image', label: 'Images', test: (a) => !isVideo(a) && !isAudio(a) && a.kind !== 'character' },
  { id: 'video', label: 'Videos', test: isVideo },
  { id: 'audio', label: 'Sounds', test: isAudio },
  { id: 'edit', label: 'Edits', test: isEdit },
  { id: 'upload', label: 'Uploads', test: isUpload },
  { id: 'character', label: 'Characters', test: (a) => a.kind === 'character' },
];

/** Gallery browser: a side panel with every asset in a grid. Search, filter, newest-first, scrolls without limit
 * (thumbnails load as they come into view), and a preview with ← / → to step through the filtered list. */
export default function GalleryPanel({ onToTimeline, assets, open, onClose, onAddToBoard, onDeleteAsset, onEditStudio, onVideoLab, onGenjutsu, onRemix, onOpenMv }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [oldest, setOldest] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [pv, setPv] = useState(null);                 // asset id open in the preview
  const [pick, setPick] = useState(null);             // Set of ids while selecting several, else null
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState('');
  const gridRef = useRef(null);
  const sentinel = useRef(null);

  const list = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter) || FILTERS[0];
    const needle = q.trim().toLowerCase();
    const out = assets.filter((a) => f.test(a) && (!needle || `${a.name || ''} ${a.meta?.prompt || ''} ${a.meta?.name || ''} ${a.kind}`.toLowerCase().includes(needle)));
    return oldest ? out : out.slice().reverse();
  }, [assets, q, filter, oldest]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, assets.filter(f.test).length])), [assets]);

  useEffect(() => { setShown(PAGE); gridRef.current?.scrollTo?.(0, 0); }, [q, filter, oldest]);
  useEffect(() => {                                // draw more thumbnails when the end of the grid comes into view
    if (!open || !sentinel.current) return undefined;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) setShown((n) => n + PAGE); }, { root: gridRef.current, rootMargin: '400px' });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [open, list.length, shown]);

  const idx = pv ? list.findIndex((a) => a.id === pv) : -1;
  const cur = idx >= 0 ? list[idx] : null;
  const step = (d) => { const n = list[idx + d]; if (n) { setPv(n.id); setNote(''); } };
  useEffect(() => {
    if (!open) return undefined;
    const on = (e) => {
      if (e.target.closest?.('input, textarea, select')) return;
      if (e.key === 'Escape') { if (pv) setPv(null); else onClose(); }
      else if (pv && e.key === 'ArrowLeft') step(-1);
      else if (pv && e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });
  useEffect(() => { if (pv && !assets.some((a) => a.id === pv)) setPv(null); }, [assets, pv]);
  useEffect(() => { if (!open) { setPv(null); setPick(null); setConfirm(false); } }, [open]);

  if (!open) return null;
  const go = (fn, a) => { onClose(); fn?.(a); };
  const src = (a) => (a.meta?.editedFrom ? assets.find((x) => x.id === a.meta.editedFrom) : null);
  const toggle = (id) => setPick((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const del = () => { [...pick].forEach((id) => onDeleteAsset(id)); setPick(new Set()); setConfirm(false); };

  return (
    <aside className="gp" role="dialog" aria-label="Gallery">
      <div className="gp-head">
        <b>Gallery</b><span className="gp-n">{list.length === assets.length ? `${assets.length} items` : `${list.length} of ${assets.length}`}</span>
        <span className="spacer" />
        <button className={pick ? 'active' : ''} onClick={() => { setPick(pick ? null : new Set()); setConfirm(false); }} title="Pick several items to delete at once">{pick ? 'Done' : 'Select'}</button>
        <button onClick={onClose} aria-label="Close the Gallery">✕</button>
      </div>
      <input className="gp-q" type="search" id="gp-search" placeholder="Search by name or prompt" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="gp-chips">
        {FILTERS.filter((f) => f.id === 'all' || counts[f.id] > 0).map((f) => (
          <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>{f.label}<small>{counts[f.id]}</small></button>
        ))}
        <button className="gp-sort" onClick={() => setOldest((v) => !v)} title="Change the order">{oldest ? 'Oldest first' : 'Newest first'}</button>
      </div>
      {pick && (
        <div className="gp-bulk">
          <span>{pick.size} selected</span>
          <button onClick={() => setPick(new Set(list.map((a) => a.id)))}>All {list.length}</button>
          <button onClick={() => setPick(new Set())} disabled={!pick.size}>None</button>
          {confirm
            ? <button className="danger" onClick={del}>Delete {pick.size} for good?</button>
            : <button className="danger" disabled={!pick.size} onClick={() => setConfirm(true)}>Delete</button>}
        </div>
      )}
      <div className="gp-grid" ref={gridRef}>
        {list.slice(0, shown).map((a) => (
          <div key={a.id} className={`gp-cell ${pick?.has(a.id) ? 'sel' : ''}`} draggable={!isAudio(a) && a.kind !== 'styleref'}
            onDragStart={(e) => e.dataTransfer.setData('asset-id', a.id)}
            onClick={() => (pick ? toggle(a.id) : setPv(a.id))} title={a.name}>
            {isAudio(a) ? <div className="gp-aud"><span>♪</span><small>{a.name}</small></div>
              : isVideo(a) ? <video src={a.url} muted playsInline preload="metadata" onMouseEnter={(e) => e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => { e.currentTarget.pause(); }} />
                : <img src={a.url} alt={a.name} loading="lazy" decoding="async" />}
            <span className="gp-k">{isVideo(a) ? 'video' : isAudio(a) ? 'sound' : a.kind === 'character' ? 'character' : isEdit(a) ? 'edit' : ''}</span>
            {pick && <i className="gp-chk">{pick.has(a.id) ? '✓' : ''}</i>}
          </div>
        ))}
        {!list.length && <p className="gp-empty">{assets.length ? 'Nothing matches. Clear the search or pick All.' : 'Empty. Anything you generate or upload appears here.'}</p>}
        <div ref={sentinel} className="gp-end">{shown < list.length ? 'Loading more…' : ''}</div>
      </div>

      {cur && (
        <div className="gp-pv" onClick={() => setPv(null)}>
          <div className="gp-pv-in" onClick={(e) => e.stopPropagation()}>
            <div className="gp-pv-stage">
              {isAudio(cur) ? <audio src={cur.url} controls autoPlay />
                : isVideo(cur) ? <video src={cur.url} controls autoPlay loop playsInline />
                  : src(cur) ? <CompareIfSame before={src(cur).url} after={cur.url}><img src={cur.url} alt={cur.name} /></CompareIfSame>
                    : <img src={cur.url} alt={cur.name} />}
            </div>
            <div className="gp-pv-bar">
              <button onClick={() => step(-1)} disabled={idx <= 0} aria-label="Previous">←</button>
              <span className="gp-pv-name">{cur.name} <small>{idx + 1} / {list.length}</small></span>
              <button onClick={() => step(1)} disabled={idx >= list.length - 1} aria-label="Next">→</button>
            </div>
            <div className="gp-pv-act">
              {!isAudio(cur) && cur.kind !== 'styleref' && <button onClick={() => { onAddToBoard(cur.id); setNote('Added to the Board'); }}>Add to Board</button>}
              {onToTimeline && cur.kind !== 'styleref' && <button onClick={() => { onToTimeline(cur.id); setNote('Sent to the Timeline'); }}>Send to Timeline</button>}
              {!isVideo(cur) && !isAudio(cur) && cur.kind !== 'styleref' && cur.kind !== 'sketch' && <button onClick={() => go(onEditStudio, cur)}>Edit image</button>}
              {!isVideo(cur) && !isAudio(cur) && cur.kind !== 'styleref' && cur.kind !== 'sketch' && <button onClick={() => go(onRemix, cur)}>Remix</button>}
              {isVideo(cur) && <button onClick={() => go(onGenjutsu, cur)}>Edit video</button>}
              {isVideo(cur) && <button onClick={() => go(onVideoLab, cur)}>Finish</button>}
              {(isAudio(cur) || cur.kind === 'styleref') && <button onClick={() => go(onOpenMv)}>Open in Music Video</button>}
              <a className="btn" href={cur.url} download={cur.name || 'asset'}>Download</a>
              <button className="danger" onClick={() => { const nx = list[idx + 1] || list[idx - 1]; onDeleteAsset(cur.id); setPv(nx ? nx.id : null); }}>Delete</button>
              {note && <span className="gp-note">{note}</span>}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
