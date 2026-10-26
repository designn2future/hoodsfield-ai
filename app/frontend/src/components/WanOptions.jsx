import React, { useEffect, useMemo, useState } from 'react';
import { wanModels, wanEnhancePrompt } from '../api.js';

/** Pair Wan 2.2 high-/low-noise LoRA files. Names are tokenised; the high/low/noise
 * markers and pure counters (epochs, steps, versions like "e20", "000050", "106epoc")
 * are dropped, so differently-numbered checkpoints of one LoRA still pair. */
export const pairWanLoras = (names) => {
  const COUNTER = /^(e|ep|epoch|step|s)?\d+(\.\d+)?(epoc?h?s?)?$/;
  const tokens = (n) => n.toLowerCase().replace(/\.safetensors$/, '').split(/[-_ ]+/).filter(Boolean);
  const sideOf = (n) => (/high/i.test(n) ? 'high' : /low/i.test(n) ? 'low' : 'both');
  const keyOf = (n) => tokens(n).filter((t) => !/^(high|low|noise|highnoise|lownoise)$/.test(t) && !COUNTER.test(t)).join('-');
  const groups = {};
  names.forEach((n) => { (groups[keyOf(n)] ||= {})[sideOf(n)] = n; });
  return Object.entries(groups)
    .filter(([, g]) => (g.high && g.low) || g.both)
    .map(([k, g]) => ({
      id: k,
      label: (g.high || g.both).replace(/\.safetensors$/, '').replace(/[-_ ]?(high|low)[-_ ]?(noise)?/gi, ' ').replace(/\s+/g, ' ').trim(),
      high: g.high || g.both, low: g.low || g.both,
    }));
};

export default function WanOptions({ scene, set, busy, stillPrompt, onLongShot, hasStill }) {
  const [models, setModels] = useState(null);
  const [enh, setEnh] = useState({ busy: false, error: '' });
  useEffect(() => { wanModels().then(setModels); }, []);
  const pairs = useMemo(() => pairWanLoras(models?.loras || []), [models]);
  const loras = scene.wanLoras || [];
  const setLoras = (v) => set('wanLoras', v);

  const enhance = async () => {
    setEnh({ busy: true, error: '' });
    try {
      const p = await wanEnhancePrompt({ still: stillPrompt || '', motion: scene.prompt || '', seconds: scene.wanSeconds ?? 5 });
      set('prompt', p);
      setEnh({ busy: false, error: '' });
    } catch (e) { setEnh({ busy: false, error: e.message }); }
  };

  return (
    <>
      {models && !models.i2v_ready && <div className="error">Wan 2.2 I2V models were not found in ComfyUI.</div>}
      <div className="row">
        <button disabled={busy || enh.busy} onClick={enhance}
          title="Rewrite your prompt in Wan's preferred structure (subject + scene + motion + camera + light) with the local LLM">
          {enh.busy ? '⏳ Writing…' : '✨ Enhance prompt for Wan'}
        </button>
      </div>
      {enh.error && <div className="error">{enh.error}</div>}
      <div className="grid2">
        <label>Clip length
          <select value={scene.wanSeconds ?? 5} disabled={busy} onChange={(e) => set('wanSeconds', +e.target.value)}>
            {[2, 3, 4, 5, 6].map((s) => <option key={s} value={s}>{s} s</option>)}
          </select>
          <span className="param-hint">Wan renders 16 fps natively, up to ~6 s here.</span>
        </label>
        <label>Quality
          <select value={scene.wanLightning === false ? 'full' : 'fast'} disabled={busy} onChange={(e) => set('wanLightning', e.target.value === 'fast')}>
            <option value="fast">Fast — Lightning 4-step</option>
            <option value="full">Full — 20 steps, cfg 3.5 (slow)</option>
          </select>
        </label>
        <label>Resolution
          <select value={scene.wanMp ?? 0.4} disabled={busy} onChange={(e) => set('wanMp', +e.target.value)}>
            <option value={0.2}>0.2 MP — draft</option>
            <option value={0.3}>0.3 MP</option>
            <option value={0.4}>0.4 MP — 480p class</option>
            <option value={0.6}>0.6 MP</option>
          </select>
        </label>
        <label>Seed (−1 = rnd)
          <input type="number" value={scene.seed ?? -1} disabled={busy} onChange={(e) => set('seed', +e.target.value)} />
        </label>
      </div>
      <label className="checkbox-label">
        <input type="checkbox" checked={scene.wanSmooth !== false} disabled={busy} onChange={(e) => set('wanSmooth', e.target.checked)} />
        Smooth to 32 fps (RIFE) — Wan has no audio; the clip is silent.
      </label>
      <div className="longshot-box">
        <b>🎥 Long shot</b>
        <div className="hint" style={{ marginTop: 2 }}>Chains segments into one continuous shot: each starts from the previous segment's last frame, with your still kept as an identity anchor. The local LLM plans what happens in each segment.</div>
        <div className="row">
          <select value={scene.longSeconds ?? 12} disabled={busy} onChange={(e) => set('longSeconds', +e.target.value)} style={{ width: 'auto' }}>
            {[8, 12, 16, 20, 24, 32].map((s) => <option key={s} value={s}>{s} s ({Math.ceil(s / 4)} segments)</option>)}
          </select>
          <button disabled={busy || !hasStill} onClick={() => onLongShot(scene.id)}
            title={hasStill ? 'Each 4 s segment takes several minutes on this GPU' : 'Generate a still first'}>Generate long shot</button>
        </div>
        <span className="param-hint">≈ {Math.ceil((scene.longSeconds ?? 12) / 4) * 6} min (each segment is a full-quality render). Watch it in 📋 Jobs.</span>
      </div>
      <label>Wan LoRAs (high/low pairs applied to the matching expert)</label>
      {loras.map((l, i) => (
        <div className="grid2" key={i}>
          <select value={l.pair} disabled={busy} onChange={(e) => setLoras(loras.map((x, j) => (j === i ? { ...x, pair: e.target.value } : x)))}>
            {pairs.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <div className="row" style={{ marginTop: 0 }}>
            <input type="number" step={0.05} min={-2} max={2} value={l.strength} disabled={busy}
              onChange={(e) => setLoras(loras.map((x, j) => (j === i ? { ...x, strength: +e.target.value } : x)))} />
            <button disabled={busy} onClick={() => setLoras(loras.filter((_, j) => j !== i))}>✕</button>
          </div>
        </div>
      ))}
      <button disabled={busy || !pairs.length} onClick={() => setLoras([...loras, { pair: pairs[0].id, strength: 1 }])}>+ Add LoRA</button>
    </>
  );
}
