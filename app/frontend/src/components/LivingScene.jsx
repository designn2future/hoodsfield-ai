import React, { useEffect, useRef, useState } from 'react';
import DropZone from './DropZone.jsx';
import { createScene, paintMask, SCENE_DEFAULTS } from '../gpuScene.js';

// "Living scene": fog and water drawn on your graphics card over a still picture. You trace where the water is, tune the look live, and
// render a seamless loop (every motion goes round whole circles, so the end is the start).

const AUTO_WATER = [[[0, 0.66], [1, 0.66], [1, 1], [0, 1]]];
const jerr = async (r) => { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* not json */ } throw new Error(d); };
const SLIDERS = [
  ['dens', 'Mist amount', 0, 1.5, 0.01], ['hgt', 'Mist height', 0.1, 0.9, 0.01], ['scl', 'Wisp size (lower = bigger wisps)', 0.2, 3, 0.01],
  ['wave', 'Water motion', 0, 2, 0.01], ['glint', 'Glints', 0, 2, 0.01], ['gstyle', 'Glint style (soft to glitter)', 0, 1, 0.01],
];

export default function LivingScene({ assets = [], onLoop, onError }) {
  const [bg, setBg] = useState(null);                         // {blob, url, name, w, h}
  const [P, setP] = useState({ ...SCENE_DEFAULTS });
  const [seconds, setSeconds] = useState(10);
  const [water, setWater] = useState(AUTO_WATER);
  const [still, setStill] = useState([]);
  const [mode, setMode] = useState(null);                     // null | 'water' | 'still'
  const [pts, setPts] = useState([]);                         // the shape being drawn
  const [showMap, setShowMap] = useState(true);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [guessed, setGuessed] = useState(true);
  const cv = useRef(null); const scene = useRef(null); const imgEl = useRef(null); const raf = useRef(0); const live = useRef({});
  live.current = { P, seconds, paused };

  // load the picture, make the preview scene
  useEffect(() => {
    if (!bg || !cv.current) return undefined;
    let dead = false;
    const img = new Image();
    img.onload = () => {
      if (dead) return;
      imgEl.current = img;
      try {
        const w = 960, h = Math.round((w * img.height) / img.width / 2) * 2;
        cv.current.width = w; cv.current.height = h;
        scene.current = createScene(cv.current);
        scene.current.setImage(img);
        setBg((b) => (b && (b.w !== img.width || b.h !== img.height) ? { ...b, w: img.width, h: img.height } : b));
      } catch (e) { onError?.(e.message); }
    };
    img.src = bg.url;
    return () => { dead = true; cancelAnimationFrame(raf.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bg?.url]);

  // keep the mask and the look in step with the controls
  useEffect(() => {
    if (!scene.current) return;
    const m = paintMask(water, still);
    scene.current.setMask(m.canvas, m.horizon);
  }, [water, still, bg?.w]);
  useEffect(() => { scene.current?.set(P); }, [P, bg?.w]);

  // play the loop in real time
  useEffect(() => {
    if (!bg) return undefined;
    const t0 = performance.now();
    let frozenAt = null;
    const tick = (now) => {
      const { seconds: s, paused: pz } = live.current;
      if (scene.current) {
        if (pz) { if (frozenAt === null) frozenAt = ((now - t0) % (s * 1000)) / (s * 1000); scene.current.draw(frozenAt); } else { frozenAt = null; scene.current.draw(((now - t0) % (s * 1000)) / (s * 1000)); }
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [bg?.url]);

  const set = (k, v) => setP((p) => ({ ...p, [k]: v }));
  const clickMap = (e) => {
    if (!mode) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPts((a) => [...a, [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]]);
  };
  const finish = () => {
    if (pts.length >= 3) {
      if (mode === 'water') {
        const next = guessed ? [pts] : [...water, pts];
        setWater(next); setGuessed(false);
        const top = Math.min(...next.flat().map(([, y]) => y));
        set('hgt', Math.round(Math.min(0.9, Math.max(0.1, 1 - top)) * 100) / 100);          // mist lies from the waterline down
      } else setStill((s) => [...s, pts]);
    }
    setPts([]); setMode(null);
  };
  const clearMap = () => { setWater(AUTO_WATER); setStill([]); setGuessed(true); setPts([]); setMode(null); };

  const render = async () => {
    const img = imgEl.current; if (!img) return;
    setBusy('render'); setProgress(0); onError?.('');
    let gid = null;
    try {
      const W = Math.min(1920, Math.round(img.width / 2) * 2), H = Math.round((W * img.height) / img.width / 2) * 2;
      const fps = 30, N = Math.round(seconds * fps);
      const off = document.createElement('canvas'); off.width = W; off.height = H;
      const sc = createScene(off);
      sc.setImage(img); const m = paintMask(water, still); sc.setMask(m.canvas, m.horizon); sc.set(P);
      const st = new FormData(); st.append('frames', String(N)); st.append('fps', String(fps)); st.append('width', String(W)); st.append('height', String(H));
      const r0 = await fetch('/api/loop/gpu/start', { method: 'POST', body: st }); if (!r0.ok) await jerr(r0);
      gid = (await r0.json()).id;
      const inflight = new Set();
      for (let i = 0; i < N; i += 1) {
        sc.draw(i / N);
        const blob = await new Promise((res) => off.toBlob(res, 'image/jpeg', 0.95));
        const p = fetch(`/api/loop/gpu/${gid}/frame/${i}`, { method: 'POST', body: blob }).then(async (r) => { if (!r.ok) await jerr(r); });
        inflight.add(p); p.finally(() => inflight.delete(p));
        if (inflight.size >= 3) await Promise.race(inflight);
        setProgress((i + 1) / N);
      }
      await Promise.all(inflight);
      const fd = new FormData(); fd.append('label', 'living scene (fog + water)');
      const r1 = await fetch(`/api/loop/gpu/${gid}/finish`, { method: 'POST', body: fd }); if (!r1.ok) await jerr(r1);
      onLoop?.(await r1.json());
    } catch (e) { onError?.(e.message || String(e)); }
    setBusy('');
  };

  const shapePts = (s) => s.map(([x, y]) => `${x},${y}`).join(' ');
  if (!bg) {
    return (
      <DropZone accept="image" icon="🌫️" title="Drop a calm landscape picture" hint="A lake, a river or a shore works best. Fog drifts over it and the water ripples and glints; everything else stays perfectly still."
        assets={assets} onFile={(f) => setBg({ blob: f, url: URL.createObjectURL(f), name: f.name })} onAsset={(a) => setBg({ blob: a.blob, url: a.url, name: a.name })} />
    );
  }
  return (
    <div className="lv">
      <div className="lv-view">
        <canvas ref={cv} />
        <svg className={`lv-map ${mode ? 'draw' : ''}`} viewBox="0 0 1 1" preserveAspectRatio="none" onClick={clickMap} onDoubleClick={finish}>
          {showMap && water.map((s, i) => <polygon key={`w${i}`} points={shapePts(s)} className={guessed ? 'w guess' : 'w'} />)}
          {showMap && still.map((s, i) => <polygon key={`s${i}`} points={shapePts(s)} className="s" />)}
          {pts.length > 0 && <polyline points={shapePts(pts)} className={mode === 'still' ? 'cur s' : 'cur w'} />}
          {pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="0.006" className="dot" />)}
        </svg>
      </div>
      <p className="lv-help">
        {mode ? `Click around the ${mode === 'water' ? 'water' : 'thing that must stay still'}, point by point. Double-click or press “Finish shape” to close it.`
          : guessed ? 'Starting guess: the bottom third is water. Trace the real water for a better result.' : 'Blue = water that moves. Orange = kept still (dock, rocks).'}
      </p>
      <div className="lv-bar">
        <button className={mode === 'water' ? 'on' : ''} onClick={() => { setPts([]); setMode(mode === 'water' ? null : 'water'); }}>🌊 Trace the water</button>
        <button className={mode === 'still' ? 'on' : ''} onClick={() => { setPts([]); setMode(mode === 'still' ? null : 'still'); }}>🪵 Keep something still</button>
        {mode && <button onClick={finish}>✔ Finish shape</button>}
        {mode && <button onClick={() => setPts((a) => a.slice(0, -1))}>↶ Undo point</button>}
        <button onClick={clearMap}>Reset map</button>
        <label className="lv-chk"><input type="checkbox" checked={showMap} onChange={(e) => setShowMap(e.target.checked)} /> show map</label>
        <button onClick={() => setPaused((x) => !x)}>{paused ? '▶ Play' : '⏸ Pause'}</button>
        <button onClick={() => { setBg(null); scene.current = null; }}>Change picture</button>
      </div>
      <div className="lv-sliders">
        {SLIDERS.map(([k, label, lo, hi, step]) => (
          <label key={k}>{label}: {P[k]}<input type="range" min={lo} max={hi} step={step} value={P[k]} onChange={(e) => set(k, +e.target.value)} /></label>
        ))}
        <label>Mist speed ({P.harm}×)<input type="range" min="1" max="3" step="1" value={P.harm} onChange={(e) => set('harm', +e.target.value)} /></label>
        <label>Water speed ({P.wspd}×)<input type="range" min="1" max="3" step="1" value={P.wspd} onChange={(e) => set('wspd', +e.target.value)} /></label>
        <label>Loop length: {seconds} s<input type="range" min="6" max="20" step="1" value={seconds} onChange={(e) => setSeconds(+e.target.value)} /></label>
      </div>
      <div className="lv-go">
        <button className="primary" onClick={render} disabled={!!busy}>{busy ? `Rendering… ${Math.round(progress * 100)}%` : '🎬 Render the loop'}</button>
        <small>Your graphics card draws every frame ({Math.round(seconds * 30)} frames at up to 1920 px wide), then it is saved as a seamless loop. Keep this tab open while it renders.</small>
      </div>
    </div>
  );
}
