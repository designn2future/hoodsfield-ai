import GenProgress from './GenProgress.jsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ASPECTS, TRACKS, EXPORT_SCALE, clipDur, clipEnd, textEnd, timelineDuration, canvasFor, clipFromAsset, newText,
  addClipToTrack, updateClip, removeClip, splitClip, duplicateClip, snapStart, activeClip, sourceTime, fmtTime, exportJson,
  kfValue, setKeyframe, KF_PROPS, beatTimes, autoCutToBeats, captionClips, CAPTION_STYLES,
} from '../timeline.js';
import { useTimelineHistory } from '../timelineHistory.js';
import { usePeaks, PEAKS_RATE, analyzeBeats, transcribeWords } from '../timelineAudio.js';
import { cancelJob, runComfyTool, runFfmpegTool } from '../api.js';
import { clipStats, computeMatch, mixMatch } from '../timelineMatch.js';
import { useFxCatalog, groupBy, gradeCss, fxFilterCss, fxOverlays, camTransform, uploadLut, FX_MAX } from '../timelineFx.js';

const TRACK_H = 46;
const LABEL_W = 78;
const KIND_COLOR = { v1: '#00f2fe', v2: '#f472b6', audio: '#2dd4bf', text: '#a78bfa' };

// ------------------------------------------------------------------ small helpers

const measure = (asset) => new Promise((res) => {
  if (asset.meta?.seconds) { res(asset.meta.seconds); return; }
  const el = document.createElement(asset.mime?.startsWith('audio') ? 'audio' : 'video');
  el.preload = 'metadata';
  el.onloadedmetadata = () => res(isFinite(el.duration) ? el.duration : 4);
  el.onerror = () => res(4);
  el.src = asset.url;
});

const TITLE_PRESETS = [
  { id: 'headline', label: 'Cinematic headline', set: { anim: 'words', font: 'black', look: 'shadow', size: 0.085, y: 0.5, box: false } },
  { id: 'neon', label: 'Neon pop', set: { anim: 'pop', font: 'impact', look: 'glow', accent: '#00e5ff', size: 0.09, y: 0.5, box: false } },
  { id: 'magenta', label: 'Magenta pop', set: { anim: 'pop', font: 'impact', look: 'glow', accent: '#ff3df2', size: 0.09, y: 0.5, box: false } },
  { id: 'lower', label: 'Lower third', set: { anim: 'rise', font: 'bold', look: 'shadow', size: 0.05, x: 0.5, y: 0.86, box: false } },
  { id: 'caption', label: 'Clean caption', set: { anim: 'fade', font: 'bold', look: 'box', size: 0.05, y: 0.88, box: true } },
];

const thumbCache = new Map();
function useThumb(asset) {
  const [src, setSrc] = useState(asset ? thumbCache.get(asset.id) || null : null);
  useEffect(() => {
    if (!asset) return undefined;
    if (asset.mime?.startsWith('image')) { setSrc(asset.url); return undefined; }
    if (!asset.mime?.startsWith('video') && asset.kind !== 'video') return undefined;
    if (thumbCache.has(asset.id)) { setSrc(thumbCache.get(asset.id)); return undefined; }
    let dead = false;
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = asset.url;
    v.onloadeddata = () => { v.currentTime = Math.min(0.2, (v.duration || 1) / 4); };
    v.onseeked = () => {
      if (dead) return;
      const c = document.createElement('canvas'); c.width = 128; c.height = 72;
      c.getContext('2d').drawImage(v, 0, 0, 128, 72);
      const u = c.toDataURL('image/jpeg', 0.6);
      thumbCache.set(asset.id, u); setSrc(u);
    };
    return () => { dead = true; };
  }, [asset?.id]);
  return src;
}

/** One tile of the Timeline gallery: big thumbnail, drag it onto any track (or press ＋ to append it). */
function BinTile({ asset, onAdd, label }) {
  const th = useThumb(asset);
  const isAudio = asset.mime?.startsWith('audio') || asset.kind === 'audio';
  const isVideo = asset.mime?.startsWith('video') || asset.kind === 'video';
  return (
    <div className="bin-tile" draggable onDragStart={(e) => e.dataTransfer.setData('asset-id', asset.id)} title={`${asset.meta?.name || asset.name} — drag onto a track, or press ＋`}>
      {isAudio ? <div className="bin-tile-audio">🎵</div> : th ? <img src={th} alt="" draggable={false} /> : <div className="bin-tile-audio">{isVideo ? '🎞️' : '🖼️'}</div>}
      <span className="bin-tile-kind">{isAudio ? 'audio' : isVideo ? `video${asset.meta?.seconds ? ` ${Number(asset.meta.seconds).toFixed(1)}s` : ''}` : 'image'}</span>
      <span className="bin-tile-name">{label || asset.meta?.name || asset.name}</span>
      <button className="bin-add" onClick={() => onAdd(asset)} title="Add to the timeline">＋</button>
    </div>
  );
}

function BinItem({ asset, onAdd, label }) {
  const th = useThumb(asset);
  const isAudio = asset.mime?.startsWith('audio') || asset.kind === 'audio';
  return (
    <div className="bin-item" draggable onDragStart={(e) => e.dataTransfer.setData('asset-id', asset.id)} title={`${asset.name} — drag to a track or click +`}>
      {isAudio ? <div className="bin-audio">🎵</div> : th ? <img src={th} alt="" /> : <div className="bin-audio">🎞️</div>}
      <span className="bin-name">{label || asset.meta?.name || asset.name}{asset.meta?.seconds ? ` · ${Number(asset.meta.seconds).toFixed(1)}s` : ''}</span>
      <button className="bin-add" onClick={() => onAdd(asset)}>＋</button>
    </div>
  );
}

/** Waveform of the part of the source this clip plays. */
function Wave({ peaks, clip, zoom }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv || !peaks) return;
    const w = Math.min(4000, Math.max(8, Math.round(clipDur(clip) * zoom)));
    cv.width = w; cv.height = 44;
    const g = cv.getContext('2d'); g.clearRect(0, 0, w, 44); g.fillStyle = 'rgba(255,255,255,0.55)';
    const span = clipDur(clip) * (clip.speed || 1);
    for (let x = 0; x < w; x++) {
      const i = Math.floor((clip.in + (x / w) * span) * PEAKS_RATE);
      const h = Math.max(1, (peaks.peaks[i] || 0) * 40);
      g.fillRect(x, (44 - h) / 2, 1, h);
    }
  }, [peaks, clip.in, clip.out, clip.speed, zoom]);
  return <canvas ref={ref} className="tl-wave" />;
}

function ClipView({ clip, track, asset, zoom, selected, onDown }) {
  const th = useThumb(track !== 'audio' ? asset : null);
  const peaks = usePeaks(track === 'audio' || clip.kind === 'video' ? asset : null);
  const w = Math.max(6, (track === 'text' ? clip.dur : clipDur(clip)) * zoom);
  return (
    <div className={`tl-clip tk-${track} ${selected ? 'sel' : ''}`} style={{ left: clip.start * zoom, width: w, '--c': KIND_COLOR[track], backgroundImage: th ? `url(${th})` : undefined }}
      onPointerDown={(e) => onDown(e, 'move')}>
      {peaks && track !== 'text' && <Wave peaks={peaks} clip={clip} zoom={zoom} />}
      {Object.entries(clip.kf || {}).flatMap(([p, pts]) => pts.map((k, i) => <u key={`${p}${i}`} className="kfd" style={{ left: k.t * zoom }} title={`${KF_PROPS[p]?.label || p} keyframe at ${k.t.toFixed(2)} s`} />))}
      <i className="h l" onPointerDown={(e) => { e.stopPropagation(); onDown(e, 'trimL'); }} />
      <span className="tl-clip-name">{track === 'text' ? clip.text : (clip.name || asset?.name || 'missing')}{clip.speed && clip.speed !== 1 ? ` · ${clip.speed}×` : ''}</span>
      {clip.fadeIn > 0 && <b className="fx fi" style={{ width: clip.fadeIn * zoom }} />}
      {clip.fadeOut > 0 && <b className="fx fo" style={{ width: clip.fadeOut * zoom }} />}
      <i className="h r" onPointerDown={(e) => { e.stopPropagation(); onDown(e, 'trimR'); }} />
    </div>
  );
}

// ------------------------------------------------------------------ keyframes
/** Animate a property over the clip: move the playhead, change the slider (a key is made automatically) or press ◆. */
function KeyframePanel({ clip, track, t, patch }) {
  const props = Object.entries(KF_PROPS).filter(([, d]) => d.tracks.includes(track));
  const [prop, setProp] = useState(props[0]?.[0]);
  if (!props.length) return null;
  const key = props.some(([k]) => k === prop) ? prop : props[0][0];
  const def = KF_PROPS[key];
  const len = clipDur(clip);
  const local = Math.min(len, Math.max(0, t - clip.start));
  const inside = t >= clip.start && t <= clip.start + len;
  const cur = kfValue(clip, key, local, def.base(clip));
  const pts = clip.kf?.[key] || [];
  const put = (v) => patch({ kf: setKeyframe(clip, key, local, v) });
  const setPts = (list) => patch({ kf: { ...(clip.kf || {}), [key]: list } });
  return (
    <div className="fx-panel">
      <h5>◆ Keyframes <small>animate over time</small></h5>
      <div className="fx-chips">
        {props.map(([k, d]) => <Chip key={k} on={key === k} onClick={() => setProp(k)}>{d.label}{clip.kf?.[k]?.length ? ` ◆${clip.kf[k].length}` : ''}</Chip>)}
      </div>
      <label>{def.label} at the playhead: {Number(cur).toFixed(2)}
        <input type="range" min={def.min} max={def.max} step={def.step} value={cur} disabled={!inside} onChange={(e) => put(+e.target.value)} />
      </label>
      <div className="row">
        <button disabled={!inside} onClick={() => put(cur)} title="Add a key here with the current value">◆ Key at playhead</button>
        {pts.length > 0 && <button onClick={() => setPts([])}>Clear {def.label}</button>}
      </div>
      {!inside && <div className="hint">Move the playhead inside this clip, then move the slider: a key is made where the playhead is.</div>}
      {pts.map((k, i) => (
        <div className="fx-row kf-row" key={`${k.t}${i}`}>
          <input type="number" step="0.1" min="0" max={len} value={k.t} onChange={(e) => setPts([...pts.slice(0, i), { ...k, t: Math.max(0, Math.min(len, +e.target.value || 0)) }, ...pts.slice(i + 1)].sort((a, b) => a.t - b.t))} title="seconds from the clip start" />
          <input type="range" min={def.min} max={def.max} step={def.step} value={k.v} onChange={(e) => setPts(pts.map((x, n) => (n === i ? { ...x, v: +e.target.value } : x)))} />
          <select value={k.e || 'smooth'} onChange={(e) => setPts(pts.map((x, n) => (n === i ? { ...x, e: e.target.value } : x)))} title="how it moves to the next key">
            <option value="smooth">ease</option><option value="linear">linear</option><option value="hold">hold</option>
          </select>
          <button className="fx-clear" onClick={() => setPts(pts.filter((_, n) => n !== i))}>✕</button>
        </div>
      ))}
    </div>
  );
}

/** Beat detection for a music clip: the grid appears on the timeline and clips snap to it. */
function BeatPanel({ clip, asset, patch }) {
  const [state, setState] = useState({ busy: false, err: '' });
  const run = async () => {
    setState({ busy: true, err: '' });
    try { const r = await analyzeBeats(asset); patch({ beats: r.beats, downbeats: r.downbeats, bpm: r.bpm }); setState({ busy: false, err: '' }); }
    catch (e) { setState({ busy: false, err: e.message }); }
  };
  return (
    <div className="fx-panel">
      <h5>🥁 Beats</h5>
      {clip.beats?.length
        ? <div className="hint"><b>{Math.round(clip.bpm)} BPM</b>, {clip.beats.length} beats found. The beat lines show on the timeline and clips snap to them.</div>
        : <div className="hint">Find the beat of this music so you can cut and snap to it.</div>}
      <div className="row">
        <button disabled={state.busy || !asset?.blob} onClick={run}>{state.busy ? 'Listening…' : clip.beats?.length ? '↻ Detect again' : '🥁 Detect beats'}</button>
        {clip.beats?.length > 0 && <button onClick={() => patch({ beats: undefined, downbeats: undefined, bpm: undefined })}>Clear</button>}
      </div>
      {state.err && <div className="error">{state.err}</div>}
    </div>
  );
}

/** Project-level smart tools: cut to the beat, auto-captions. */
function SmartTools({ tl, commit, assetById }) {
  const grid = beatTimes(tl);
  const [pace, setPace] = useState('2beat');
  const [capStyle, setCapStyle] = useState('pop');
  const [capSrc, setCapSrc] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const sources = [...tl.v1, ...tl.v2, ...tl.audio].filter((c) => c.kind !== 'image');
  const src = sources.find((c) => c.id === capSrc) || sources.find((c) => c.kind === 'video') || sources[0];
  const doCaptions = async () => {
    const a = src && assetById[src.assetId];
    if (!a?.blob) return;
    setBusy('cap'); setMsg('');
    try {
      const r = await transcribeWords(a);
      if (!r.words?.length) { setMsg('No speech found in that clip.'); setBusy(''); return; }
      const clips = captionClips(r.words, src, capStyle);
      commit((p) => ({ ...p, text: [...p.text.filter((x) => !x.auto), ...clips.map((c) => ({ ...c, auto: 'caption' }))] }));
      setMsg(`${clips.length} captions added (${r.language || 'speech'}). Click any to restyle or fix a word.`);
    } catch (e) { setMsg(e.message); }
    setBusy('');
  };
  return (
    <div className="fx-panel">
      <h5>✂ Cut to the beat</h5>
      {grid.times.length ? <div className="hint">Re-lays your main-track clips on the {Math.round(grid.clip.bpm)} BPM grid of the music.</div>
        : <div className="hint">Add a music clip, select it and press “Detect beats”. Then this cuts your video to the rhythm.</div>}
      <label>Pacing
        <select value={pace} onChange={(e) => setPace(e.target.value)}>
          <option value="beat">Every beat (fast, hype)</option><option value="2beat">Every 2 beats</option><option value="bar">Every bar (4 beats, calm)</option>
          <option value="build">Build: slow, then faster</option><option value="mix">Mixed rhythm</option>
        </select>
      </label>
      <button className="primary" disabled={!grid.times.length || !tl.v1.length} onClick={() => commit((p) => autoCutToBeats(p, { pace }))}>✂ Cut my clips to the beat</button>
      <h5>💬 Auto-captions</h5>
      <div className="hint">Listens to a clip and adds the words as captions, timed to the speech.</div>
      <label>Speech from
        <select value={src?.id || ''} onChange={(e) => setCapSrc(e.target.value)} disabled={!sources.length}>
          {sources.map((c) => <option key={c.id} value={c.id}>{c.name || 'clip'}</option>)}
        </select>
      </label>
      <label>Style
        <select value={capStyle} onChange={(e) => setCapStyle(e.target.value)}>
          {Object.entries(CAPTION_STYLES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </label>
      <button className="primary" disabled={!src || busy === 'cap'} onClick={doCaptions}>{busy === 'cap' ? 'Listening…' : '💬 Add captions'}</button>
      {msg && <div className="hint">{msg}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ editor


// ------------------------------------------------------------------ look & motion (per clip)
function Chip({ on, onClick, children, title }) {
  return <button className={`fx-chip ${on ? 'on' : ''}`} onClick={onClick} title={title}>{children}</button>;
}

/** Colour grade, stacked effects and camera move for the selected clip. The thumbnails show each look on the clip itself. */
function LookMotion({ clip, track, asset, cat, patch, others = [] }) {
  const [mBusy, setMBusy] = useState(false);
  const matchTo = async (id) => {
    const o = others.find((x) => x.clip.id === id); if (!o || !asset) return;
    setMBusy(true); setErr('');
    try {
      const [a, b] = [await clipStats(asset, clip), await clipStats(o.asset, o.clip)];
      if (!a || !b) throw new Error('Could not read a frame from one of the clips.');
      patch({ match: computeMatch(a, b), matchAmt: clip.matchAmt ?? 1, matchRef: o.label });
    } catch (x) { setErr(x.message); }
    setMBusy(false);
  };
  const th = useThumb(asset);
  const lutRef = useRef(null);
  const [err, setErr] = useState('');
  const fx = clip.fx || [];
  const gGroups = groupBy(cat.grades);
  const setFx = (list) => patch({ fx: list });
  const addFx = (id) => { if (fx.length < FX_MAX && !fx.some((e) => e.id === id)) setFx([...fx, { id, amt: cat.fx.find((f) => f.id === id)?.amt ?? 0.5 }]); };
  return (
    <div className="fx-panel">
      <h5>🎯 Match colour {clip.match && <button className="fx-clear" onClick={() => patch({ match: undefined, matchAmt: undefined, matchRef: undefined })}>clear</button>}</h5>
      {others.length ? (
        <select value="" disabled={mBusy} onChange={(e) => e.target.value && matchTo(e.target.value)}>
          <option value="">{mBusy ? 'Measuring…' : clip.match ? `Matched to ${clip.matchRef || 'a shot'} — pick another` : 'Make this shot look like…'}</option>
          {others.map((o) => <option key={o.clip.id} value={o.clip.id}>{o.label}</option>)}
        </select>
      ) : <div className="hint">Add a second shot to match colours between them.</div>}
      {clip.match && <label>Match strength {Math.round((clip.matchAmt ?? 1) * 100)}%<input type="range" min={0} max={1} step={0.05} value={clip.matchAmt ?? 1} onChange={(e) => patch({ matchAmt: +e.target.value })} /></label>}
      <h5>🎨 Colour look {clip.grade && <button className="fx-clear" onClick={() => patch({ grade: undefined, gradeAmt: undefined })}>clear</button>}</h5>
      {Object.entries(gGroups).map(([g, list]) => (
        <div key={g}>
          <div className="fx-grp">{g}</div>
          <div className="fx-grid">
            {list.map((x) => (
              <button key={x.id} className={`fx-look ${clip.grade === x.id ? 'on' : ''}`} onClick={() => patch({ grade: x.id, gradeAmt: clip.gradeAmt ?? 1 })} title={x.label}>
                <span className="fx-th" style={{ backgroundImage: th ? `url(${th})` : undefined, filter: x.css || undefined }} />
                <small>{x.label}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="fx-grp">Your LUTs (.cube)</div>
      <div className="fx-grid">
        {cat.luts.map((n) => (
          <button key={n} className={`fx-look ${clip.grade === `lut:${n}` ? 'on' : ''}`} onClick={() => patch({ grade: `lut:${n}`, gradeAmt: clip.gradeAmt ?? 1 })} title={n}>
            <span className="fx-th lut" style={{ backgroundImage: th ? `url(${th})` : undefined }} /><small>{n.replace(/\.cube$/i, '')}</small>
          </button>
        ))}
        <button className="fx-look add" onClick={() => lutRef.current?.click()} title="Import a 3D LUT from your colourist or a LUT pack"><span className="fx-th plus">＋</span><small>Import .cube</small></button>
      </div>
      <input ref={lutRef} type="file" accept=".cube" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
        try { setErr(''); const n = await uploadLut(f); patch({ grade: `lut:${n}`, gradeAmt: 1 }); } catch (x) { setErr(x.message); }
      }} />
      {err && <div className="error">{err}</div>}
      {clip.grade && <label>Look strength {Math.round((clip.gradeAmt ?? 1) * 100)}%<input type="range" min={0} max={1} step={0.05} value={clip.gradeAmt ?? 1} onChange={(e) => patch({ gradeAmt: +e.target.value })} /></label>}

      <h5>✨ Effects <small>(up to {FX_MAX}, applied in order)</small></h5>
      {fx.map((e, i) => (
        <div className="fx-row" key={e.id}>
          <b>{cat.fx.find((f) => f.id === e.id)?.label || e.id}</b>
          <input type="range" min={0} max={1} step={0.05} value={e.amt ?? 0.5} onChange={(ev) => setFx(fx.map((x, k) => (k === i ? { ...x, amt: +ev.target.value } : x)))} />
          <button className="fx-clear" onClick={() => setFx(fx.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      {Object.entries(groupBy(cat.fx)).map(([g, list]) => (
        <div key={g} className="fx-chips"><span className="fx-grp">{g}</span>
          {list.map((x) => <Chip key={x.id} on={fx.some((e) => e.id === x.id)} onClick={() => (fx.some((e) => e.id === x.id) ? setFx(fx.filter((e) => e.id !== x.id)) : addFx(x.id))}>{x.label}</Chip>)}
        </div>
      ))}

      {track === 'v1' && (
        <>
          <h5>🎥 Camera move {clip.cam?.id && <button className="fx-clear" onClick={() => patch({ cam: undefined })}>clear</button>}</h5>
          {Object.entries(groupBy(cat.cams)).map(([g, list]) => (
            <div key={g} className="fx-chips"><span className="fx-grp">{g}</span>
              {list.map((x) => <Chip key={x.id} on={clip.cam?.id === x.id} onClick={() => patch({ cam: clip.cam?.id === x.id ? undefined : { id: x.id, amt: clip.cam?.amt ?? 0.5 } })}>{x.label}</Chip>)}
            </div>
          ))}
          {clip.cam?.id && <label>Move strength {Math.round((clip.cam.amt ?? 0.5) * 100)}%<input type="range" min={0.05} max={1} step={0.05} value={clip.cam.amt ?? 0.5} onChange={(e) => patch({ cam: { ...clip.cam, amt: +e.target.value } })} /></label>}
          <div className="hint">A virtual camera: it pushes, pans or shakes the frame across this clip (a Ken Burns move on photos). Cuts and the export stay frame-accurate.</div>
        </>
      )}
    </div>
  );
}

export default function TimelineEditor({ assets, scenes = [], timeline: tl, setTimeline, addAsset, looks = [], active, onExtend, onPlaced }) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState(null);                 // {track, id}
  const [binTab, setBinTab] = useState('all');
  const [binQ, setBinQ] = useState('');
  const [binMax, setBinMax] = useState(60);
  const [ripple, setRipple] = useState(true);
  const [scaleKey, setScaleKey] = useState('720p');
  const [exp, setExp] = useState({ phase: 'idle', progress: 0, status: '', jobId: null, error: null, url: null });
  const [view, setView] = useState({ v1: null, v2: [], text: [] });
  const cat = useFxCatalog();

  const tlRef = useRef(tl); tlRef.current = tl;
  const tRef = useRef(0);
  const playRef = useRef(false);
  const clock = useRef({ wall: 0, t0: 0 });
  const vEls = useRef([null, null]);                // two stacked players: the next clip is loaded in the hidden one, so a cut never goes through a reload (black frames)
  const front = useRef(0);
  const ovEls = useRef({});
  const auEls = useRef({});
  const scroller = useRef(null);
  const assetById = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a])), [assets]);
  const abyId = useRef(assetById); abyId.current = assetById;
  const dur = timelineDuration(tl);
  const zoom = tl.zoom || 70;
  const canvas = canvasFor(tl);
  const selClip = sel ? (sel.track === 'text' ? tl.text : tl[sel.track]).find((c) => c.id === sel.id) : null;

  const getTl = useCallback(() => tlRef.current, []);
  const { commit, silent, undo, redo, canUndo, canRedo } = useTimelineHistory(setTimeline, getTl);
  const beatGrid = useMemo(() => beatTimes(tl), [tl.audio]);          // eslint-disable-line react-hooks/exhaustive-deps
  const beatSnapOn = tl.beatSnap !== false && beatGrid.times.length > 0;

  // ---------------------------------------------------------------- playback engine
  const syncMedia = useCallback((tt, isPlaying) => {
    const cur = tlRef.current;
    const a1 = activeClip(cur.v1, tt);
    const [e0, e1] = vEls.current;
    if (e0 && e1) {
      const show = (el, on) => { el.style.visibility = on ? 'visible' : 'hidden'; };
      let v = vEls.current[front.current];
      let back = vEls.current[1 - front.current];
      if (a1 && a1.kind === 'video' && abyId.current[a1.assetId]) {
        const url = abyId.current[a1.assetId].url;
        if (v.dataset.cid !== a1.id) {
          if (back.dataset.cid === a1.id && back.readyState >= 2) {       // preloaded: swap players, no reload
            v.pause(); v.muted = true; v.dataset.cid = ''; show(v, false);
            front.current = 1 - front.current; [v, back] = [back, v];
          } else { v.dataset.cid = a1.id; v.src = url; }
        }
        show(v, true);
        const target = sourceTime(a1, tt);
        if (Math.abs(v.currentTime - target) > (isPlaying ? 0.4 : 0.05)) { try { v.currentTime = target; } catch { /* not ready */ } }
        v.playbackRate = Math.min(4, Math.max(0.25, a1.speed || 1));
        v.muted = !!a1.mute; v.volume = Math.min(1, Math.max(0, (a1.volume ?? 1) * kfValue(a1, 'volume', tt - a1.start, 1)));
        if (isPlaying) { if (v.paused) v.play().catch(() => {}); } else v.pause();
      } else {
        // a hairline gap between two clips keeps the last picture instead of flashing black
        const prev = cur.v1.filter((c) => c.kind === 'video' && clipEnd(c) <= tt && tt - clipEnd(c) < 0.25).sort((x, y) => clipEnd(y) - clipEnd(x))[0];
        v.pause();
        if (prev && v.dataset.cid === prev.id) show(v, true); else { v.dataset.cid = ''; show(v, false); }
      }
      // load the upcoming clip into the hidden player
      const nxt = cur.v1.filter((c) => c.kind === 'video' && c.start > tt && c.start - tt < 3 && c.id !== a1?.id && abyId.current[c.assetId]).sort((x, y) => x.start - y.start)[0];
      if (nxt && back.dataset.cid !== nxt.id) {
        back.dataset.cid = nxt.id; back.muted = true; back.pause(); show(back, false);
        const at = nxt.in || 0;
        back.onloadedmetadata = () => { try { back.currentTime = at; } catch { /* not ready */ } };
        back.src = abyId.current[nxt.assetId].url;
      } else if (!nxt && back.dataset.cid && back.dataset.cid !== a1?.id) { back.dataset.cid = ''; }
    }
    for (const c of cur.v2) {
      const el = ovEls.current[c.id];
      if (!el || el.tagName !== 'VIDEO') continue;
      if (tt >= c.start && tt < clipEnd(c)) {
        const target = sourceTime(c, tt);
        if (Math.abs(el.currentTime - target) > (isPlaying ? 0.4 : 0.05)) { try { el.currentTime = target; } catch { /* not ready */ } }
        if (isPlaying) { if (el.paused) el.play().catch(() => {}); } else el.pause();
      }
    }
    for (const c of cur.audio) {
      const el = auEls.current[c.id];
      if (!el) continue;
      const inside = tt >= c.start && tt < clipEnd(c);
      if (inside && isPlaying) {
        const target = sourceTime(c, tt);
        if (el.paused || Math.abs(el.currentTime - target) > 0.4) { try { el.currentTime = target; } catch { /* not ready */ } }
        el.playbackRate = Math.min(4, Math.max(0.25, c.speed || 1));
        let g = (c.volume ?? 1) * kfValue(c, 'volume', tt - c.start, 1);
        if (c.fadeIn > 0 && tt < c.start + c.fadeIn) g *= (tt - c.start) / c.fadeIn;
        if (c.fadeOut > 0 && tt > clipEnd(c) - c.fadeOut) g *= (clipEnd(c) - tt) / c.fadeOut;
        el.volume = Math.min(1, Math.max(0, g));
        if (el.paused) el.play().catch(() => {});
      } else if (!el.paused) el.pause();
    }
    // which overlays/text are visible (re-render only when the set changes)
    const ids = (arr, f) => arr.filter(f).map((x) => x.id).join(',');
    const nv = {
      v1: a1, v2: cur.v2.filter((c) => tt >= c.start && tt < clipEnd(c)), text: cur.text.filter((x) => tt >= x.start && tt < textEnd(x)),
    };
    const look = (c) => (c ? `${JSON.stringify(c.match)}|${c.matchAmt}|${c.grade}|${c.gradeAmt}|${JSON.stringify(c.fx)}|${JSON.stringify(c.cam)}|${JSON.stringify(c.kf)}|${c.x}|${c.y}|${c.scale}|${c.opacity}` : '');   // a look change must reach the preview even when the same clip stays on screen
    setView((old) => (old.v1?.id === nv.v1?.id && look(old.v1) === look(nv.v1) && ids(old.v2, () => true) === ids(nv.v2, () => true) && old.v2.map(look).join('~') === nv.v2.map(look).join('~') && ids(old.text, () => true) === ids(nv.text, () => true) ? old : nv));
  }, []);

  useEffect(() => {
    if (!active) { playRef.current = false; setPlaying(false); return undefined; }
    let raf;
    const tick = () => {
      let tt = tRef.current;
      if (playRef.current) {
        tt = clock.current.t0 + (performance.now() - clock.current.wall) / 1000;
        const d = timelineDuration(tlRef.current);
        if (tt >= d) { tt = d; playRef.current = false; setPlaying(false); }
        tRef.current = tt; setT(tt);
      }
      syncMedia(tt, playRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, syncMedia]);

  const seek = (tt) => { const c = Math.max(0, Math.min(tt, Math.max(dur, 0.01))); tRef.current = c; setT(c); clock.current = { wall: performance.now(), t0: c }; };
  const togglePlay = () => {
    if (playRef.current) { playRef.current = false; setPlaying(false); return; }
    if (tRef.current >= dur - 0.05) seek(0);
    clock.current = { wall: performance.now(), t0: tRef.current };
    playRef.current = true; setPlaying(true);
  };

  // ---------------------------------------------------------------- editing actions
  const addAssetTo = async (asset, trackHint, at) => {
    const isAudio = asset.mime?.startsWith('audio') || asset.kind === 'audio';
    let track = trackHint || (isAudio ? 'audio' : 'v1');
    if (isAudio) track = 'audio'; else if (track === 'audio') track = 'v1';
    const d = asset.mime?.startsWith('image') ? 4 : await measure(asset);
    const start = track === 'v1' ? 0 : (at ?? tRef.current);
    const clip = clipFromAsset(asset, track, start, d);
    commit((p) => addClipToTrack(p, track, clip));
    setSel({ track, id: clip.id });
  };
  const patch = (track, id, p) => commit((prev) => (track === 'text'
    ? { ...prev, text: prev.text.map((x) => (x.id === id ? { ...x, ...p } : x)) } : updateClip(prev, track, id, p)), `p:${track}:${id}:${Object.keys(p).join(',')}`);
  // An extension made from a Timeline clip lands right after that clip as soon as its video exists (later clips on V1 shift along)
  const placing = useRef(new Set());
  useEffect(() => {
    for (const sc of scenes) {
      const pa = sc.placeAfter, a = sc.videoAssetId && assetById[sc.videoAssetId];
      if (!pa || !a || placing.current.has(sc.id)) continue;
      placing.current.add(sc.id);
      (async () => {
        const d = await measure(a);
        commit((p) => {
          const orig = (p[pa.track] || []).find((c) => c.id === pa.clipId);
          const clip = clipFromAsset(a, pa.track, orig ? clipEnd(orig) : 0, d);
          if (!orig) return addClipToTrack(p, pa.track, clip);
          const at = clipEnd(orig);
          const arr = pa.track === 'v1' ? p.v1.map((c) => (c.start >= at - 1e-6 ? { ...c, start: c.start + d } : c)) : p[pa.track];
          return { ...p, [pa.track]: [...arr, clip] };
        });
        onPlaced?.(sc.id);
      })();
    }
  }, [scenes, assetById]);
  const [bgBusy, setBgBusy] = useState('');
  /** Cut the subject out of the selected clip: only the part in use is processed, the result (transparent WebM) replaces its footage. */
  const removeBg = async () => {
    const c = sel && tl[sel.track]?.find((x) => x.id === sel.id), a = c && assetById[c.assetId];
    if (!c || !a?.blob || bgBusy) return;
    const track = sel.track;
    try {
      setBgBusy('Preparing…');
      const part = await runFfmpegTool(a.blob, 'trim', { start: c.in, end: c.out });
      const res = await runComfyTool('/api/tools/remove_bg', part, { background: 'green' }, (ev) => {
        if (ev.type === 'progress') setBgBusy(`Cutting out ${ev.max ? Math.round((ev.value / ev.max) * 100) : 0}%`);
        else if (ev.type === 'status') setBgBusy(ev.text || 'Working…');
      });
      setBgBusy('Making it transparent…');
      const keyed = await runFfmpegTool(await (await fetch(res.url)).blob(), 'greenkey', {});
      const na = addAsset(keyed, 'video', `${(a.name || 'clip').replace(/\.[^.]+$/, '')} · cut-out`, { source: 'tool', tool: 'cutout' });
      patch(track, c.id, { assetId: na.id, in: 0, out: c.out - c.in });
      setBgBusy('');
    } catch (e) { setBgBusy(e.message === 'Cancelled' ? '' : `Cut-out failed: ${String(e.message).slice(0, 80)}`); }
  };
  const del = () => { if (sel) { commit((p) => removeClip(p, sel.track, sel.id, ripple && sel.track === 'v1')); setSel(null); } };
  const split = () => {
    const tt = tRef.current;
    const target = sel || (() => {
      for (const tr of ['v1', 'v2', 'audio']) { const c = activeClip(tl[tr], tt); if (c) return { track: tr, id: c.id }; }
      return null;
    })();
    if (target) commit((p) => splitClip(p, target.track, target.id, tt));
  };
  const dup = () => { if (sel) commit((p) => duplicateClip(p, sel.track, sel.id)); };
  const addTextClip = () => { const x = newText(tRef.current); commit((p) => ({ ...p, text: [...p.text, x] })); setSel({ track: 'text', id: x.id }); };
  const closeGaps = () => commit((p) => {
    let at = 0;
    const v1 = [...p.v1].sort((a, b) => a.start - b.start).map((c) => { const n = { ...c, start: at }; at += clipDur(c); return n; });
    return { ...p, v1 };
  });

  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 's' || e.key === 'S') split();
      else if (e.key === 'Delete' || e.key === 'Backspace') del();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); dup(); }
      else if (e.key === 'ArrowLeft') seek(tRef.current - (e.shiftKey ? 1 : 1 / 30));
      else if (e.key === 'ArrowRight') seek(tRef.current + (e.shiftKey ? 1 : 1 / 30));
      else if (e.key === 'Home') seek(0);
      else if (e.key === 'End') seek(dur);
      else if (e.key === '=' || e.key === '+') silent((p) => ({ ...p, zoom: Math.min(300, (p.zoom || 70) * 1.25) }));
      else if (e.key === '-') silent((p) => ({ ...p, zoom: Math.max(15, (p.zoom || 70) / 1.25) }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------------------------------------------------------------- pointer interactions
  const startDrag = (e, track, clip, mode) => {
    e.preventDefault();
    setSel({ track, id: clip.id });
    const x0 = e.clientX;
    const orig = { ...clip };
    const isText = track === 'text';
    const tol = 8 / zoom;
    const onMove = (ev) => {
      const dt = (ev.clientX - x0) / zoom;
      commit((prev) => {
        if (mode === 'move') {
          const d = isText ? orig.dur : clipDur(orig);
          const s = snapStart(prev, track, orig.id, orig.start + dt, d, tRef.current, tol, beatSnapOn ? beatGrid.times : []);
          return isText ? { ...prev, text: prev.text.map((x) => (x.id === orig.id ? { ...x, start: s } : x)) } : updateClip(prev, track, orig.id, { start: s });
        }
        if (isText) {
          if (mode === 'trimR') return { ...prev, text: prev.text.map((x) => (x.id === orig.id ? { ...x, dur: Math.max(0.3, orig.dur + dt) } : x)) };
          const ns = Math.min(orig.start + orig.dur - 0.3, Math.max(0, orig.start + dt));
          return { ...prev, text: prev.text.map((x) => (x.id === orig.id ? { ...x, start: ns, dur: orig.dur - (ns - orig.start) } : x)) };
        }
        if (mode === 'trimR') {
          const out = Math.min(orig.srcDur ?? 1e9, Math.max(orig.in + 0.2, orig.out + dt * orig.speed));
          return updateClip(prev, track, orig.id, { out });
        }
        // trimL: moves the in-point and start together so the picture stays put
        const dIn = Math.min(orig.out - 0.2 - orig.in, Math.max(-orig.in, dt * orig.speed));
        return updateClip(prev, track, orig.id, { in: orig.in + dIn, start: Math.max(0, orig.start + dIn / orig.speed) });
      }, `drag:${orig.id}:${mode}`);
    };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  };

  const scrubFrom = (e) => {
    const el = scroller.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const at = (ev) => (ev.clientX - rect.left + el.scrollLeft - LABEL_W) / zoom;
    seek(at(e));
    const mv = (ev) => seek(at(ev));
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  const onDropTrack = (e, track) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('asset-id');
    const a = assetById[id];
    if (!a) return;
    const el = scroller.current; const rect = el.getBoundingClientRect();
    addAssetTo(a, track, Math.max(0, (e.clientX - rect.left + el.scrollLeft - LABEL_W) / zoom));
  };

  // ---------------------------------------------------------------- export
  const doExport = async () => {
    const used = new Set([...tl.v1, ...tl.v2, ...tl.audio].map((c) => c.assetId));
    const missing = [...used].filter((id) => !assetById[id]);
    if (missing.length) { setExp((x) => ({ ...x, phase: 'error', error: 'Some clips use assets that were deleted from the Gallery.' })); return; }
    setExp({ phase: 'run', progress: 0, status: 'Uploading…', jobId: null, error: null, url: null });
    try {
      const fd = new FormData();
      fd.append('timeline', JSON.stringify(exportJson(tl, scaleKey)));
      used.forEach((id) => fd.append(id, assetById[id].blob, assetById[id].name || id));
      const r = await fetch('/api/timeline/render', { method: 'POST', body: fd });
      if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* plain text */ } throw new Error(d); }
      const { job_id } = await r.json();
      setExp((x) => ({ ...x, jobId: job_id }));
      const url = await new Promise((resolve, reject) => {
        const es = new EventSource(`/api/events/${job_id}`);
        es.onmessage = (m) => {
          const ev = JSON.parse(m.data);
          if (ev.type === 'progress') setExp((x) => ({ ...x, progress: ev.max ? ev.value / ev.max : 0 }));
          else if (ev.type === 'status') setExp((x) => ({ ...x, status: ev.text }));
          else if (ev.type === 'done') { es.close(); resolve(ev.url); }
          else if (ev.type === 'error') { es.close(); reject(new Error(ev.text)); }
        };
        es.onerror = () => { es.close(); reject(new Error('Lost connection to backend')); };
      });
      const blob = await (await fetch(url)).blob();
      const asset = addAsset(blob, 'video', 'Timeline export', { source: 'timeline', seconds: dur });
      setExp({ phase: 'done', progress: 1, status: 'Done', jobId: null, error: null, url: asset.url });
    } catch (e) {
      setExp((x) => ({ ...x, phase: e.message === 'Cancelled' ? 'idle' : 'error', error: e.message }));
    }
  };

  // ---------------------------------------------------------------- render
  // the Board tab: every scene that has a finished clip, in board order, named by scene number
  const boardClips = scenes.map((sc, i) => ({ sc, n: i + 1, asset: sc.videoAssetId ? assetById[sc.videoAssetId] : null })).filter((x) => x.asset);
  const addAllBoard = async () => { for (const x of boardClips) await addAssetTo(x.asset, 'v1'); };
  const isAud = (a) => a.mime?.startsWith('audio') || a.kind === 'audio';
  const isVid = (a) => a.mime?.startsWith('video') || a.kind === 'video';
  const isImg = (a) => a.mime?.startsWith('image') && a.kind !== 'sketch' && !isVid(a);
  const q = binQ.trim().toLowerCase();
  const binAll = binTab === 'board' ? [] : assets.filter((a) => (binTab === 'audio' ? isAud(a) : binTab === 'image' ? isImg(a) : binTab === 'video' ? isVid(a) : (isAud(a) || isVid(a) || isImg(a))))
    .filter((a) => !q || `${a.name || ''} ${a.meta?.name || ''} ${a.meta?.prompt || ''}`.toLowerCase().includes(q))
    .reverse();                                                     // newest first
  const binAssets = binAll.slice(0, binMax);
  const totalW = Math.max(dur + 8, 20) * zoom;
  const ticks = [];
  const step = zoom >= 120 ? 1 : zoom >= 50 ? 2 : zoom >= 28 ? 5 : 10;
  for (let s = 0; s <= totalW / zoom; s += step) ticks.push(s);

  const field = (label, value, onChange, props = {}) => (
    <label>{label}<input type="number" value={Number.isFinite(value) ? +value.toFixed(3) : 0} onChange={(e) => onChange(+e.target.value)} {...props} /></label>
  );

  return (
    <div className="tl-root">
      <div className="tl-top">
        {/* ---------------- asset bin */}
        <aside className="tl-bin">
          <div className="tl-tabs">
            {[['all', 'All'], ['board', 'Board'], ['video', 'Video'], ['image', 'Images'], ['audio', 'Audio']].map(([k, ic]) => (
              <button key={k} className={binTab === k ? 'on' : ''} onClick={() => { setBinTab(k); setBinMax(60); }}>{ic}</button>
            ))}
          </div>
          <input className="bin-search" placeholder={`Search ${assets.length} items…`} value={binQ} onChange={(e) => { setBinQ(e.target.value); setBinMax(60); }} />
          <div className="bin-list">
            {binTab === 'board' && boardClips.length > 0 && <button className="bin-wide" onClick={addAllBoard} title="Add every scene clip to the main track, in board order">＋ Add all {boardClips.length} scene clips in order</button>}
            {binTab === 'board' && boardClips.map((x) => <BinTile key={x.sc.id} asset={x.asset} label={`Scene ${x.n}${x.sc.title ? ' · ' + x.sc.title.slice(0, 22) : ''}`} onAdd={(a) => addAssetTo(a)} />)}
            {binTab === 'board' && !boardClips.length && <div className="hint">No scene on the Board has a finished clip yet.</div>}
            {binAssets.map((a) => <BinTile key={a.id} asset={a} onAdd={(x) => addAssetTo(x)} />)}
            {binAll.length > binMax && <button className="bin-more" onClick={() => setBinMax((m) => m + 60)}>Show more ({binAll.length - binMax} left)</button>}
            {binTab !== 'board' && !binAssets.length && <div className="hint">{q ? 'Nothing matches that search.' : 'Nothing here yet. Everything you generate or import appears here.'}</div>}
          </div>
          <button onClick={addTextClip}>＋ Text</button>
        </aside>

        {/* ---------------- preview */}
        <section className="tl-preview">
          <div className="tl-monbar">
            <span className="tl-live"><i />Cinema monitor</span>
            <span>{canvas.width}×{canvas.height}</span>
            <span>{tl.aspect}</span>
            <span>{tl.fps || 30} fps</span>
            {tl.look && tl.look !== 'none' && <span className="tl-look">{tl.look}</span>}
          </div>
          <div className="tl-stage-wrap">
            <div className="tl-stage" style={{ aspectRatio: `${canvas.width} / ${canvas.height}`, filter: gradeCss(cat, tl.look) || undefined }}>
              {view.v1?.match && (() => { const m = mixMatch(view.v1.match, view.v1.matchAmt ?? 1); return (
                <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true"><filter id="tl-match" colorInterpolationFilters="sRGB"><feComponentTransfer>
                  {['R', 'G', 'B'].map((ch, k) => React.createElement(`feFunc${ch}`, { key: ch, type: 'linear', slope: m.g[k], intercept: m.o[k] }))}
                </feComponentTransfer></filter></svg>); })()}
              <div className="tl-pic" style={{
                filter: [view.v1?.match ? 'url(#tl-match)' : '', gradeCss(cat, view.v1?.grade), fxFilterCss(view.v1?.fx)].filter(Boolean).join(' ') || undefined,
                opacity: view.v1?.kf?.opacity ? kfValue(view.v1, 'opacity', t - view.v1.start, 1) : undefined,
                transform: [view.v1?.cam ? camTransform(view.v1.cam, t - view.v1.start, clipDur(view.v1)) : '', view.v1?.kf?.zoom ? `scale(${kfValue(view.v1, 'zoom', t - view.v1.start, 1)})` : ''].filter(Boolean).join(' ') || undefined,
              }}>
                <video ref={(el) => { vEls.current[0] = el; }} className="tl-v1" playsInline preload="auto" style={{ visibility: 'hidden' }} />
                <video ref={(el) => { vEls.current[1] = el; }} className="tl-v1" playsInline preload="auto" style={{ visibility: 'hidden' }} />
                {view.v1?.kind === 'image' && assetById[view.v1.assetId] && <img className="tl-v1" src={assetById[view.v1.assetId].url} alt="" />}
              </div>
              {fxOverlays(view.v1?.fx, canvas.width / canvas.height).map((o) => <i key={o.key} className={`tl-fxo ${o.cls}`} style={o.style} />)}
              {view.v2.map((c) => {
                const a = assetById[c.assetId]; if (!a) return null;
                const lt = t - c.start;
                const st = { left: `${kfValue(c, 'x', lt, c.x ?? 0.5) * 100}%`, top: `${kfValue(c, 'y', lt, c.y ?? 0.5) * 100}%`, width: `${kfValue(c, 'scale', lt, c.scale ?? 0.3) * 100}%`, opacity: (c.opacity ?? 1) * kfValue(c, 'opacity', lt, 1) };
                return c.kind === 'image'
                  ? <img key={c.id} ref={(el) => { ovEls.current[c.id] = el; }} className="tl-ov" style={st} src={a.url} alt="" />
                  : <video key={c.id} ref={(el) => { ovEls.current[c.id] = el; }} className="tl-ov" style={st} src={a.url} muted playsInline />;
              })}
              {view.text.map((x) => (
                <div key={x.id} className={`tl-text ${x.box ? 'box' : ''}`} style={{ left: `${x.x * 100}%`, top: `${x.y * 100}%`, color: x.color, fontSize: `${x.size * 100}cqh` }}>{x.text}</div>
              ))}
              {!view.v1 && !view.v2.length && <div className="tl-black">{dur === 0 ? 'Add clips from the bin, or drag them onto the timeline' : ''}</div>}
            </div>
          </div>
          {tl.audio.map((c) => assetById[c.assetId] && (
            <audio key={c.id} ref={(el) => { auEls.current[c.id] = el; }} src={assetById[c.assetId].url} preload="auto" />
          ))}
          <div className="tl-transport">
            <button onClick={() => seek(0)} title="Start (Home)">⏮</button>
            <button className="play" onClick={togglePlay} title="Play / pause (Space)">{playing ? '⏸' : '▶'}</button>
            <button onClick={() => seek(dur)} title="End">⏭</button>
            <span className="tl-time">{fmtTime(t)} <small>/ {fmtTime(dur)}</small></span>
            <span className="spacer" />
            <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">↶</button>
            <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">↷</button>
            <button onClick={split} title="Split at playhead (S)">✂ Split</button>
            {selClip && selClip.kind === 'video' && sel.track !== 'audio' && sel.track !== 'text' && <button onClick={removeBg} disabled={!!bgBusy && !bgBusy.startsWith('Cut-out failed')} title="Remove the background of this clip (needs a GPU job; only the part you use is processed). Lay it over another shot on the Overlay track.">{bgBusy && !bgBusy.startsWith('Cut-out failed') ? `⏳ ${bgBusy}` : bgBusy ? `⚠ ${bgBusy}` : '✂ Remove background'}</button>}
            {onExtend && selClip && selClip.kind === 'video' && sel.track !== 'audio' && sel.track !== 'text' && <button onClick={() => onExtend(selClip.assetId, { track: sel.track, clipId: selClip.id })} title="Continue this shot: its last frame becomes the first frame of a new scene on the board">⏭ Extend clip</button>}
            <button onClick={dup} disabled={!sel} title="Duplicate (Ctrl+D)">⧉</button>
            <button className="danger" onClick={del} disabled={!sel} title="Delete (Del)">🗑</button>
            <label className="checkbox-label" style={{ margin: 0 }} title="Closing the gap when you delete a video clip"><input type="checkbox" checked={ripple} onChange={(e) => setRipple(e.target.checked)} /> ripple</label>
            <input type="range" min={15} max={300} value={zoom} onChange={(e) => silent((p) => ({ ...p, zoom: +e.target.value }))} style={{ width: 90 }} title="Zoom (+ / −)" />
          </div>
        </section>

        {/* ---------------- inspector */}
        <aside className="tl-inspector">
          {!selClip ? (
            <>
              <h4>Project</h4>
              <label>Aspect ratio
                <select value={tl.aspect} onChange={(e) => commit((p) => ({ ...p, aspect: e.target.value }))}>
                  {Object.entries(ASPECTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </label>
              <label>Colour look (whole video)
                <select value={tl.look} onChange={(e) => commit((p) => ({ ...p, look: e.target.value }))}>
                  <option value="none">None</option>
                  {Object.entries(groupBy(cat.grades)).map(([g, list]) => <optgroup key={g} label={g}>{list.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</optgroup>)}
                  {cat.luts.length > 0 && <optgroup label="Your LUTs">{cat.luts.map((n) => <option key={n} value={`lut:${n}`}>{n.replace(/\.cube$/i, '')}</option>)}</optgroup>}
                  {!cat.grades.length && looks.filter((l) => l.id !== 'none').map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
              </label>
              <div className="hint">Select a clip to give just that clip its own look, effects and camera move.</div>
              <label>Export size
                <select value={scaleKey} onChange={(e) => setScaleKey(e.target.value)}>
                  {Object.keys(EXPORT_SCALE).map((k) => <option key={k} value={k}>{k} ({canvasFor(tl, EXPORT_SCALE[k]).width}×{canvasFor(tl, EXPORT_SCALE[k]).height})</option>)}
                </select>
              </label>
              <button onClick={closeGaps} disabled={!tl.v1.length}>Close gaps on Video track</button>
              {beatGrid.times.length > 0 && (
                <label className="checkbox-label"><input type="checkbox" checked={beatSnapOn} onChange={(e) => silent((p) => ({ ...p, beatSnap: e.target.checked }))} /> Snap clips to the beat ({Math.round(beatGrid.clip.bpm)} BPM)</label>
              )}
              <SmartTools tl={tl} commit={commit} assetById={assetById} />
              <div className="hint">Drag clips on the timeline. Overlap two video clips to dissolve between them. <b>S</b> splits at the playhead, <b>Space</b> plays, <b>+ / −</b> zoom. The preview is approximate; the export is exact.</div>
            </>
          ) : sel.track === 'text' ? (
            <>
              <h4>Text</h4>
              <textarea rows={3} value={selClip.text} onChange={(e) => patch('text', selClip.id, { text: e.target.value })} />
              <div className="grid2">
                {field('Start (s)', selClip.start, (v) => patch('text', selClip.id, { start: Math.max(0, v) }), { step: 0.1 })}
                {field('Length (s)', selClip.dur, (v) => patch('text', selClip.id, { dur: Math.max(0.3, v) }), { step: 0.1 })}
              </div>
              <label>Size {Math.round(selClip.size * 100)}%<input type="range" min={0.03} max={0.2} step={0.005} value={selClip.size} onChange={(e) => patch('text', selClip.id, { size: +e.target.value })} /></label>
              <label>Position X<input type="range" min={0} max={1} step={0.01} value={selClip.x} onChange={(e) => patch('text', selClip.id, { x: +e.target.value })} /></label>
              <label>Position Y<input type="range" min={0} max={1} step={0.01} value={selClip.y} onChange={(e) => patch('text', selClip.id, { y: +e.target.value })} /></label>
              <div className="row"><input type="color" value={selClip.color} onChange={(e) => patch('text', selClip.id, { color: e.target.value })} style={{ width: 46, height: 30, padding: 0 }} />
                <label className="checkbox-label"><input type="checkbox" checked={selClip.box} onChange={(e) => patch('text', selClip.id, { box: e.target.checked })} /> background box</label></div>
              <h5>✨ Title style</h5>
              <select value="" onChange={(e) => { const pr = TITLE_PRESETS.find((x) => x.id === e.target.value); if (pr) patch('text', selClip.id, pr.set); }}>
                <option value="">Preset…</option>
                {TITLE_PRESETS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
              <div className="grid2">
                <label>Animation<select value={selClip.anim || 'none'} onChange={(e) => patch('text', selClip.id, { anim: e.target.value })}>
                  {[['none', 'None'], ['fade', 'Fade'], ['rise', 'Rise up'], ['pop', 'Pop (overshoot)'], ['words', 'Word by word']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                <label>Font<select value={selClip.font || 'default'} onChange={(e) => patch('text', selClip.id, { font: e.target.value })}>
                  {[['default', 'Segoe Bold'], ['impact', 'Impact'], ['black', 'Arial Black'], ['heavy', 'Segoe Black'], ['bahn', 'Bahnschrift']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                <label>Look<select value={selClip.look || ''} onChange={(e) => patch('text', selClip.id, { look: e.target.value || undefined })}>
                  {[['', 'Auto (box setting)'], ['plain', 'Outline'], ['shadow', 'Soft shadow'], ['glow', 'Neon glow'], ['box', 'Box']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                {selClip.look === 'glow' && <label>Glow colour<input type="color" value={selClip.accent || '#00e5ff'} onChange={(e) => patch('text', selClip.id, { accent: e.target.value })} style={{ width: 46, height: 30, padding: 0 }} /></label>}
              </div>
              <div className="hint">Animations play in the exported video; the preview shows the final look.</div>
            </>
          ) : (
            <>
              <h4>{selClip.name}</h4>
              <div className="grid2">
                {field('Start (s)', selClip.start, (v) => patch(sel.track, selClip.id, { start: Math.max(0, v) }), { step: 0.1 })}
                {field('Speed ×', selClip.speed, (v) => patch(sel.track, selClip.id, { speed: Math.min(4, Math.max(0.25, v || 1)) }), { step: 0.25 })}
                {selClip.kind !== 'image' && field('In (s)', selClip.in, (v) => patch(sel.track, selClip.id, { in: Math.max(0, Math.min(v, selClip.out - 0.2)) }), { step: 0.1 })}
                {field(selClip.kind === 'image' ? 'Show for (s)' : 'Out (s)', selClip.kind === 'image' ? selClip.out : selClip.out,
                  (v) => patch(sel.track, selClip.id, { out: Math.max(selClip.in + 0.2, Math.min(v, selClip.srcDur ?? 1e9)) }), { step: 0.1 })}
                {field('Fade in (s)', selClip.fadeIn || 0, (v) => patch(sel.track, selClip.id, { fadeIn: Math.max(0, v), fadeInManual: true }), { step: 0.1 })}
                {field('Fade out (s)', selClip.fadeOut || 0, (v) => patch(sel.track, selClip.id, { fadeOut: Math.max(0, v) }), { step: 0.1 })}
              </div>
              {selClip.kind !== 'image' && (
                <>
                  <label>Volume {Math.round((selClip.volume ?? 1) * 100)}%<input type="range" min={0} max={2} step={0.05} value={selClip.volume ?? 1} onChange={(e) => patch(sel.track, selClip.id, { volume: +e.target.value })} /></label>
                  {selClip.kind === 'video' && <label className="checkbox-label"><input type="checkbox" checked={!!selClip.mute} onChange={(e) => patch(sel.track, selClip.id, { mute: e.target.checked })} /> mute this clip's audio</label>}
                </>
              )}
              {sel.track === 'v2' && (
                <>
                  <label>Position X<input type="range" min={0} max={1} step={0.01} value={selClip.x} onChange={(e) => patch('v2', selClip.id, { x: +e.target.value })} /></label>
                  <label>Position Y<input type="range" min={0} max={1} step={0.01} value={selClip.y} onChange={(e) => patch('v2', selClip.id, { y: +e.target.value })} /></label>
                  <label>Size {Math.round(selClip.scale * 100)}%<input type="range" min={0.05} max={1} step={0.01} value={selClip.scale} onChange={(e) => patch('v2', selClip.id, { scale: +e.target.value })} /></label>
                  <label>Opacity {Math.round((selClip.opacity ?? 1) * 100)}%<input type="range" min={0.1} max={1} step={0.05} value={selClip.opacity ?? 1} onChange={(e) => patch('v2', selClip.id, { opacity: +e.target.value })} /></label>
                </>
              )}
              {sel.track === 'audio' && <BeatPanel clip={selClip} asset={assetById[selClip.assetId]} patch={(p) => patch(sel.track, selClip.id, p)} />}
              <KeyframePanel clip={selClip} track={sel.track} t={t} patch={(p) => patch(sel.track, selClip.id, p)} />
              {selClip.kind !== 'audio' && sel.track !== 'audio' && <LookMotion others={[...tl.v1.map((c, i) => ({ c, n: `Shot ${i + 1}` })), ...tl.v2.map((c, i) => ({ c, n: `Overlay ${i + 1}` }))].filter((x) => x.c.id !== selClip.id && x.c.kind !== 'audio' && assetById[x.c.assetId]).map((x) => ({ clip: x.c, asset: assetById[x.c.assetId], label: `${x.n} · ${assetById[x.c.assetId].name || ''}`.slice(0, 48) }))} clip={selClip} track={sel.track} asset={assetById[selClip.assetId]} cat={cat} patch={(p) => patch(sel.track, selClip.id, p)} />}
            </>
          )}
          <div className="tl-export">
            <button className="primary" disabled={exp.phase === 'run' || !dur} onClick={doExport}>{exp.phase === 'run' ? 'Rendering…' : '⬇ Export video'}</button>
            {exp.phase === 'run' && (
              <>
                <GenProgress progress={exp.progress} status={exp.status} onCancel={() => cancelJob(exp.jobId)} cancelDisabled={!exp.jobId} />
              </>
            )}
            {exp.phase === 'error' && <div className="error">{exp.error}</div>}
            {exp.phase === 'done' && <div className="hint">Done — saved to your Gallery. <a className="dl" href={exp.url} download="timeline.mp4">Download</a></div>}
          </div>
        </aside>
      </div>

      {/* ---------------- tracks */}
      <div className="tl-tracks" ref={scroller}>
        <div className="tl-inner" style={{ width: totalW + LABEL_W }}>
          <div className="tl-ruler" onPointerDown={scrubFrom} style={{ paddingLeft: LABEL_W }}>
            {ticks.map((s) => <span key={s} style={{ left: LABEL_W + s * zoom }}>{s % 60 === 0 && s ? `${s / 60}m` : `${s}s`}</span>)}
          </div>
          {TRACKS.map((tr) => (
            <div key={tr.id} className="tl-row" style={{ height: TRACK_H }} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropTrack(e, tr.id)}
              onPointerDown={(e) => { if (e.target === e.currentTarget || e.target.classList.contains('tl-lane')) { setSel(null); scrubFrom(e); } }}>
              <div className="tl-label" style={{ width: LABEL_W }}><i className="tl-dot" style={{ background: KIND_COLOR[tr.id], boxShadow: `0 0 8px ${KIND_COLOR[tr.id]}` }} />{tr.label}</div>
              <div className="tl-lane" style={{ left: LABEL_W, width: totalW }}>
                {(tr.id === 'text' ? tl.text : tl[tr.id]).map((c) => (
                  <ClipView key={c.id} clip={c} track={tr.id} asset={assetById[c.assetId]} zoom={zoom}
                    selected={sel?.id === c.id} onDown={(e, mode) => startDrag(e, tr.id, c, mode)} />
                ))}
              </div>
            </div>
          ))}
          {beatGrid.times.length > 0 && (
            <div className="tl-beats" style={{ left: LABEL_W }}>
              {beatGrid.times.map((b, i) => <i key={i} className={beatGrid.downbeats.some((d) => Math.abs(d - b) < 0.02) ? 'dn' : ''} style={{ left: b * zoom }} />)}
            </div>
          )}
          <div className="tl-playhead" style={{ left: LABEL_W + t * zoom }}><i /></div>
        </div>
      </div>
    </div>
  );
}
