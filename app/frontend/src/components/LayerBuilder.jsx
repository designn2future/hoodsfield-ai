import React, { useEffect, useRef, useState } from 'react';
import DropZone from './DropZone.jsx';

// The "layers" way of making a loop, like an After Effects comp: a perfectly still picture underneath, animated effect layers on top, blended with
// screen / add / soft light ... Every layer runs on an exact cycle, so the loop is seamless by construction.

export const LAYER_DEFS = {
  rain: { label: '🌧️ Rain', hint: 'Streaks falling and slanting slightly', color: true, region: false },
  snow: { label: '❄️ Snow', hint: 'Soft flakes drifting down', color: true },
  petals: { label: '🌸 Petals & leaves', hint: 'Falling, tumbling, swaying', color: true },
  fireflies: { label: '✨ Fireflies & orbs', hint: 'Glowing lights drifting on slow loops', color: true },
  stars: { label: '⭐ Twinkling stars', hint: 'Stars and flares in the sky area', color: true, region: true },
  mist: { label: '🌫️ Mist', hint: 'Fog rolling slowly along the ground', color: true, region: true },
  aurora: { label: '🌌 Aurora glow', hint: 'Colour curtains rippling in the sky', color: true, region: true },
  flow: { label: '💧 Waterfall flow', hint: 'Streams the bright water in your picture', post: true },
  shimmer: { label: '🌊 Water glitter', hint: 'Slow sparkle across a lake or sea', region: true, post: true },
  flicker: { label: '🕯️ Light flicker', hint: 'Lamps and glows breathe softly', post: true },
  breathing: { label: '🫧 Camera breathing', hint: 'A tiny, slow push-in and back', post: true },
  vignette: { label: '🎞️ Vignette', hint: 'Darker corners', post: true },
  grain: { label: '🎞️ Film grain', hint: 'Fine moving grain over everything', post: true },
};
const BLENDS = [['screen', 'Screen (light on dark)'], ['add', 'Add (glow)'], ['normal', 'Normal'], ['soft_light', 'Soft light'], ['overlay', 'Overlay'], ['multiply', 'Multiply']];
const NEW = {
  rain: { opacity: 0.35, amount: 0.5, speed: 1, blend: 'screen', color: '#c8d7ff' }, snow: { opacity: 0.8, amount: 0.5, speed: 1, blend: 'normal', color: '#ffffff' },
  petals: { opacity: 0.9, amount: 0.4, speed: 1, blend: 'normal', color: '#ffb7d5' }, fireflies: { opacity: 0.9, amount: 0.5, speed: 1, blend: 'screen', color: '#ffe49a' },
  stars: { opacity: 0.9, amount: 0.5, speed: 1, blend: 'screen', color: '#ffffff', region: 0.5 }, mist: { opacity: 0.22, amount: 0.5, speed: 1, blend: 'screen', color: '#cfe0ff', region: 0.4 },
  aurora: { opacity: 0.28, amount: 0.5, speed: 1, blend: 'screen', color: '#52ffb8', region: 0.45 }, flow: { amount: 0.5, speed: 1 }, shimmer: { amount: 0.5, speed: 1, region: 0.4 },
  flicker: { amount: 0.5 }, breathing: { amount: 0.5 }, vignette: { amount: 0.4 }, grain: { amount: 0.4 },
};
const jerr = async (r) => { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* not json */ } throw new Error(d); };

export default function LayerBuilder({ assets = [], templates = [], initial, baseLoop, onClearBase, onLoop, onError }) {
  const [bg, setBg] = useState(null);                       // {blob, url, name}
  const [layers, setLayers] = useState([{ type: 'fireflies', ...NEW.fireflies }, { type: 'mist', ...NEW.mist }, { type: 'grain', ...NEW.grain }]);
  const [seconds, setSeconds] = useState(10);
  const [side, setSide] = useState(1920);
  const [hd, setHd] = useState(true);
  const [prev, setPrev] = useState(null);
  const [busy, setBusy] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [open, setOpen] = useState(null);
  const [example, setExample] = useState(null);           // the opened template, to show its finished example
  const tick = useRef(null);

  useEffect(() => { // a template was opened from the parent
    if (!initial) return;
    (async () => {
      try {
        const r = await fetch(`/api/loop/templates/${initial.id}/still`);
        if (!r.ok) throw new Error('Could not load the template picture.');
        const blob = await r.blob();
        setBg({ blob, url: URL.createObjectURL(blob), name: initial.title });
        setLayers(initial.layers.map((l) => ({ ...l })));
        setSeconds(initial.seconds || 10); setPrev(null); setExample(initial); onClearBase?.();
      } catch (e) { onError?.(e.message); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const upd = (i, patch) => setLayers((L) => L.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const add = (type) => setLayers((L) => [...L, { type, ...NEW[type] }]);
  const del = (i) => setLayers((L) => L.filter((_, k) => k !== i));
  const have = new Set(layers.map((l) => l.type));

  const form = async (extra = {}) => {
    const fd = new FormData();
    if (bg) fd.append('image', bg.blob, 'bg.png');
    fd.append('layers', JSON.stringify(layers)); fd.append('seconds', String(seconds)); fd.append('fps', '30');
    for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
    return fd;
  };
  const preview = async () => {
    if (!bg) return;
    setBusy('preview'); onError?.('');
    try {
      const r = await fetch('/api/loop/layers_preview', { method: 'POST', body: await form({ t: 0.35 }) });
      if (!r.ok) await jerr(r);
      setPrev(URL.createObjectURL(await r.blob()));
    } catch (e) { onError?.(e.message); }
    setBusy('');
  };
  const render = async () => {
    if (!bg && !baseLoop) return;
    setBusy('render'); onError?.(''); setElapsed(0);
    clearInterval(tick.current); const t0 = Date.now(); tick.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    try {
      const extra = { max_side: side };
      if (hd) { extra.target_w = 1920; extra.target_h = 1080; }
      if (baseLoop) extra.base_loop_id = baseLoop.id;
      const r = await fetch('/api/loop/layers', { method: 'POST', body: await form(extra) });
      if (!r.ok) await jerr(r);
      onLoop?.(await r.json());
    } catch (e) { onError?.(e.message); }
    clearInterval(tick.current); setBusy('');
  };
  const est = () => {
    const frames = baseLoop ? (baseLoop.frames || 100) : seconds * 30;
    const px = side * side * 0.5625;
    return Math.max(1, Math.round((frames * 0.65 * px) / (1280 * 714) / 60 * 10) / 10);
  };

  return (
    <div className="lb">
      {templates.length > 0 && (
        <div className="lb-tpl">
          <b>Start from a template</b>
          <div className="lb-tpl-row">
            {templates.map((t) => (
              <button key={t.id} className="lb-card" onClick={() => onLoop?.({ __template: t })}>
                <img src={`/api/loop/templates/${t.id}/still`} alt={t.title} />
                <span><b>{t.icon} {t.title}</b><small>{t.blurb}</small></span>
              </button>
            ))}
          </div>
        </div>
      )}

      {example?.has_preview && !baseLoop && (
        <div className="lb-example">
          <video src={`/api/loop/templates/${example.id}/preview`} muted loop autoPlay playsInline />
          <div><b>{example.icon} {example.title}</b><p>This is what the template looks like once rendered (it loops forever). Below are its layers: switch some off, move the sliders, change colours and press <b>Preview a frame</b> to see the effect, then <b>Render the loop</b> to make your own.</p></div>
        </div>
      )}

      {baseLoop ? (
        <div className="lb-base">🔁 Building on your loop ({baseLoop.seconds}s, {baseLoop.width}×{baseLoop.height}). The layers will be added on top of its motion. <button onClick={onClearBase}>Use a picture instead</button></div>
      ) : !bg ? (
        <DropZone accept="image" icon="🖼️" title="Drop the background picture" hint="It stays perfectly still, in full quality. The layers add all the motion." assets={assets}
          onFile={(f) => setBg({ blob: f, url: URL.createObjectURL(f), name: f.name })} onAsset={(a) => setBg({ blob: a.blob, url: a.url, name: a.name })} />
      ) : (
        <div className="lb-main">
          <div className="lb-view">
            <img src={prev || bg.url} alt="preview" />
            <div className="lb-viewbar">
              <button onClick={preview} disabled={busy}>{busy === 'preview' ? 'Rendering a frame…' : '👁 Preview a frame'}</button>
              <button onClick={() => { setBg(null); setPrev(null); }}>Change picture</button>
            </div>
          </div>
        </div>
      )}

      {(bg || baseLoop) && (
        <>
          <h4 className="lb-h">Layers <small>(top of the list = bottom of the stack)</small></h4>
          <div className="lb-layers">
            {layers.map((l, i) => {
              const d = LAYER_DEFS[l.type] || { label: l.type };
              return (
                <div key={i} className="lb-layer">
                  <div className="lb-lhead">
                    <b>{d.label}</b><small>{d.hint}</small>
                    <span className="spacer" />
                    <button onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'Less' : 'More'}</button>
                    <button className="danger" onClick={() => del(i)} title="Remove this layer">✕</button>
                  </div>
                  <div className="lb-ctl">
                    <label>Amount {Math.round((l.amount ?? 0.5) * 100)}%<input type="range" min="0" max="100" value={Math.round((l.amount ?? 0.5) * 100)} onChange={(e) => upd(i, { amount: +e.target.value / 100 })} /></label>
                    {!d.post && <label>Speed {l.speed ?? 1}×<input type="range" min="1" max="4" step="1" value={l.speed ?? 1} onChange={(e) => upd(i, { speed: +e.target.value })} /></label>}
                    {l.opacity != null && !d.post && <label>Opacity {Math.round(l.opacity * 100)}%<input type="range" min="0" max="100" value={Math.round(l.opacity * 100)} onChange={(e) => upd(i, { opacity: +e.target.value / 100 })} /></label>}
                  </div>
                  {open === i && (
                    <div className="lb-ctl lb-more">
                      {d.color && <label>Colour<input type="color" value={l.color || '#ffffff'} onChange={(e) => upd(i, { color: e.target.value })} /></label>}
                      {l.blend && <label>Blend mode<select value={l.blend} onChange={(e) => upd(i, { blend: e.target.value })}>{BLENDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>}
                      {l.region != null && <label>Area: top/bottom {Math.round(l.region * 100)}% of the picture<input type="range" min="10" max="90" value={Math.round(l.region * 100)} onChange={(e) => upd(i, { region: +e.target.value / 100 })} /></label>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="lb-add">
            <span>Add a layer:</span>
            {Object.entries(LAYER_DEFS).filter(([k]) => !have.has(k)).map(([k, d]) => <button key={k} onClick={() => add(k)}>+ {d.label}</button>)}
          </div>
          <div className="ls-grid">
            {!baseLoop && <label>Loop length: {seconds} s<input type="range" min="6" max="20" step="1" value={seconds} onChange={(e) => setSeconds(+e.target.value)} /></label>}
            <label>Size<select value={side} onChange={(e) => { setSide(+e.target.value); setHd(+e.target.value >= 1920); }}>
              <option value={960}>Small (960 wide, very fast)</option><option value={1280}>HD (1280 wide, fast)</option><option value={1920}>Full HD (1920×1080)</option></select>
              {side >= 1920 && <small className="ls-sub">Trims a sliver if your picture is not exactly 16:9.</small>}</label>
          </div>
          <div className="st-actions">
            <button className="st-cta" disabled={!!busy} onClick={render}>{busy === 'render' ? `Rendering… ${elapsed}s` : '🎬 Render the loop'}</button>
            <span className="st-hint">About {est()} min on this PC. The loop closes exactly on itself, so it is seamless by construction.</span>
          </div>
        </>
      )}
    </div>
  );
}
