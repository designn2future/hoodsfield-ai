import React, { useEffect, useRef, useState } from 'react';
import DropZone from './DropZone.jsx';
import LivingScene from './LivingScene.jsx';

// One click: drop a picture, Claude looks at it like an art director and plans the loop (what is water, what must stay still, which effects suit it,
// and where), and the app renders it. Water and fog scenes are drawn on the graphics card; rain, snow, stars, aurora, fireflies and lamps use the
// layer engine. A one-line hint ("stars and a lamp flicker, no fog") re-plans it.

const jerr = async (r) => { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* not json */ } throw new Error(d); };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const INDOOR = ['interior', 'rainy_window'];

function decide(plan) {
  const e = plan.effects || {};
  const weather = (e.rain ?? 0) >= 0.25 || (e.snow ?? 0) >= 0.25;
  if (weather || plan.indoors || INDOOR.includes(plan.scene)) return 'layers';     // the GPU scene has fog and water only
  const water = (plan.water || []).length > 0 && (e.water_motion ?? 0) > 0.05;
  const onlyFog = (e.mist ?? 0) >= 0.4 && (e.stars ?? 0) < 0.2 && (e.aurora ?? 0) < 0.2 && (e.fireflies ?? 0) < 0.2;
  return water || onlyFog ? 'gpu' : 'layers';
}

function describe(plan, mode) {
  const e = plan.effects || {};
  const bits = [];
  if (mode === 'gpu') {
    if ((e.mist ?? 0) >= 0.05) bits.push('drifting fog');
    if ((plan.water || []).length && (e.water_motion ?? 0) > 0.05) bits.push('rippling water with glints');
  } else {
    const out = plan.indoors && plan.window_box ? ' outside the window' : '';
    if ((e.aurora ?? 0) >= 0.2) bits.push(`a shimmering aurora${out}`);
    if ((e.stars ?? 0) >= 0.2) bits.push(`twinkling stars${out}`);
    if ((e.rain ?? 0) >= 0.15) bits.push(`falling rain${out}`);
    if ((e.snow ?? 0) >= 0.15) bits.push(`drifting snow${out}`);
    if ((e.mist ?? 0) >= 0.15 && !plan.indoors) bits.push('soft mist');
    if ((e.fireflies ?? 0) >= 0.15) bits.push(`floating fireflies${out}`);
    if ((e.flicker ?? 0) >= 0.15) bits.push('a warm light flicker');
  }
  const list = bits.length ? bits.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'a gentle film grain';
  return `I see ${plan.title ? plan.title.charAt(0).toLowerCase() + plan.title.slice(1) : 'your picture'}. I'll add ${list}, and keep everything else perfectly still.`;
}

function toPreset(plan, pic) {
  const e = plan.effects || {};
  const hasWater = (plan.water || []).length > 0 && (e.water_motion ?? 0) > 0.05;
  const top = hasWater ? Math.min(...plan.water.flat().map(([, y]) => y)) : 0.65;
  return {
    blob: pic.blob, url: pic.url, name: pic.name,
    water: hasWater ? plan.water : [], still: plan.keep_still || [],
    params: {
      dens: (e.mist ?? 0) < 0.05 ? 0 : Math.round(clamp(0.15 + 0.4 * e.mist, 0, 0.7) * 100) / 100,
      hgt: Math.round(clamp(1 - top, 0.1, 0.9) * 100) / 100,
      wave: hasWater ? Math.round(clamp(0.3 + 0.6 * (e.water_motion ?? 0), 0, 1.2) * 100) / 100 : 0,
      glint: hasWater ? Math.round(clamp(1.5 * (e.glints ?? 0), 0, 1.2) * 100) / 100 : 0,
    },
    summary: describe(plan, 'gpu'),
  };
}

function toLayers(plan) {
  const e = plan.effects || {};
  const wb = plan.indoors && plan.window_box ? plan.window_box : null;       // outdoor motions live behind the window glass
  const sky = plan.sky_box ? plan.sky_box[3] : null;
  const L = [];
  const inWindow = (l) => (wb ? { ...l, box: wb } : l);
  if ((e.aurora ?? 0) >= 0.2) L.push(inWindow({ type: 'aurora', opacity: 0.22 + 0.3 * e.aurora, amount: 0.5, speed: 1, blend: 'screen', color: plan.aurora_color || '#52ffb8', region: wb ? 0.95 : clamp(sky ?? 0.45, 0.2, 0.9) }));
  if ((e.stars ?? 0) >= 0.2) L.push(inWindow({ type: 'stars', opacity: 0.9, amount: 0.3 + 0.4 * e.stars, speed: 1, blend: 'screen', color: '#ffffff', region: wb ? 0.95 : clamp(sky ?? 0.38, 0.2, 0.9) }));
  if ((e.mist ?? 0) >= 0.15 && !plan.indoors) L.push({ type: 'mist', opacity: 0.12 + 0.25 * e.mist, amount: 0.5, speed: 1, blend: 'screen', color: '#e8f0ff', region: 0.3 });
  if ((e.rain ?? 0) >= 0.15) L.push(inWindow({ type: 'rain', opacity: 0.45, amount: 0.3 + 0.6 * e.rain, speed: 1, blend: 'screen', color: '#c8d7ff' }));
  if ((e.snow ?? 0) >= 0.15) L.push(inWindow({ type: 'snow', opacity: 0.85, amount: 0.3 + 0.5 * e.snow, speed: 1, blend: 'screen', color: '#ffffff' }));
  if ((e.fireflies ?? 0) >= 0.15) L.push(inWindow({ type: 'fireflies', opacity: 0.8, amount: 0.2 + 0.5 * e.fireflies, speed: 1, blend: 'screen', color: '#ffe9a8' }));
  if ((e.flicker ?? 0) >= 0.15) L.push({ type: 'flicker', amount: 0.3 + 0.4 * e.flicker });
  L.push({ type: 'vignette', amount: 0.35 }, { type: 'grain', amount: 0.3 });
  return L;
}

function LayersAuto({ plan, pic, onLoop, onError }) {
  const layers = toLayers(plan);
  const [prev, setPrev] = useState(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const tick = useRef(null);
  const form = async (extra = {}) => {
    const fd = new FormData();
    fd.append('image', pic.blob, 'bg.png'); fd.append('layers', JSON.stringify(layers)); fd.append('seconds', '10'); fd.append('fps', '30');
    for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
    return fd;
  };
  useEffect(() => {
    let dead = false;
    setPrev(null);
    (async () => {
      try {
        const r = await fetch('/api/loop/layers_preview', { method: 'POST', body: await form({ t: 0.35 }) });
        if (r.ok && !dead) setPrev(URL.createObjectURL(await r.blob()));
      } catch { /* the preview is only a nicety */ }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pic.url, JSON.stringify(layers)]);
  const go = async () => {
    setBusy(true); setElapsed(0); onError?.('');
    clearInterval(tick.current); const t0 = Date.now(); tick.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    try {
      const img = await createImageBitmap(pic.blob);
      const wide = Math.abs(img.width / img.height - 16 / 9) < 0.06;
      const extra = { max_side: 1920 };
      if (wide) { extra.target_w = 1920; extra.target_h = 1080; }
      const r = await fetch('/api/loop/layers', { method: 'POST', body: await form(extra) });
      if (!r.ok) await jerr(r);
      onLoop?.(await r.json());
    } catch (e) { onError?.(e.message || String(e)); }
    clearInterval(tick.current); setBusy(false);
  };
  return (
    <div className="lv">
      <div className="lv-view"><img src={prev || pic.url} alt="preview" style={{ width: '100%', borderRadius: 12, display: 'block' }} /></div>
      <div className="lv-go">
        <button className="primary" onClick={go} disabled={busy}>{busy ? `Making your loop… ${elapsed}s` : '✨ Make my loop'}</button>
        <small>This kind of scene is built on your computer's processor and takes about 5 to 8 minutes. The picture above shows one frame of it.</small>
      </div>
    </div>
  );
}

export default function MagicLoop({ assets = [], onLoop, onError }) {
  const [pic, setPic] = useState(null);
  const [plan, setPlan] = useState(null);
  const [looking, setLooking] = useState(false);
  const [hint, setHint] = useState('');

  const look = async (p, why = '') => {
    setPic(p); setPlan(null); setLooking(true); onError?.('');
    try {
      const fd = new FormData(); fd.append('image', p.blob, 'picture.png'); fd.append('hint', why);
      const r = await fetch('/api/loop/magic/analyze', { method: 'POST', body: fd });
      if (!r.ok) await jerr(r);
      setPlan(await r.json());
    } catch (e) { onError?.(e.message || String(e)); setPic(null); }
    setLooking(false);
  };

  if (!pic) {
    return (
      <DropZone accept="image" icon="✨" title="Drop a picture. That's it." hint="A lake, a rainy window, a snowy cabin, a night street… Claude looks at it, decides what should move, and makes the loop for you."
        assets={assets} onFile={(f) => { setHint(''); look({ blob: f, url: URL.createObjectURL(f), name: f.name }); }} onAsset={(a) => { setHint(''); look({ blob: a.blob, url: a.url, name: a.name }); }} />
    );
  }
  if (looking || !plan) {
    return (
      <div className="lv">
        <div className="lv-view"><img src={pic.url} alt="your picture" style={{ width: '100%', borderRadius: 12, display: 'block', opacity: 0.7 }} /></div>
        <p className="lv-sum">👀 {hint ? 'Thinking again with your idea…' : 'Looking at your picture…'}</p>
      </div>
    );
  }
  const mode = decide(plan);
  return (
    <div>
      {plan.source !== 'claude' && plan.note && <p className="st-note">{plan.note}</p>}
      <p className="lv-sum">{describe(plan, mode)}</p>
      {plan.reason && <p className="lv-why">{plan.reason}</p>}
      {mode === 'gpu'
        ? <LivingScene key={`${pic.url}-${plan.title}`} preset={toPreset(plan, pic)} simple onLoop={onLoop} onError={onError} />
        : <LayersAuto key={`${pic.url}-${plan.title}-${JSON.stringify(plan.effects)}`} plan={plan} pic={pic} onLoop={onLoop} onError={onError} />}
      <div className="lv-hint">
        <label>Not what you pictured? Tell me in a few words:
          <input type="text" value={hint} onChange={(e) => setHint(e.target.value)} placeholder='e.g. "twinkling stars and the aurora outside, warm lamp flicker, no fog"'
            onKeyDown={(e) => { if (e.key === 'Enter' && hint.trim()) look(pic, hint.trim()); }} />
        </label>
        <button onClick={() => look(pic, hint.trim())} disabled={!hint.trim()}>↻ Plan it again</button>
      </div>
      <p className="lv-again"><button onClick={() => { setPic(null); setPlan(null); setHint(''); }}>Use a different picture</button></p>
    </div>
  );
}
