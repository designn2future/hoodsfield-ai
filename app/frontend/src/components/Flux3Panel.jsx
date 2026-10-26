import GenProgress from './GenProgress.jsx';
import { CompareIfSame } from './BeforeAfter.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { CLIENT_ID } from '../sharedSession.jsx';
import { withStill, useGenre } from '../genreStore.js';
import { generateFlux3, generateQwen21, qwen21Models, flux3Models, flux3Upsample, listFaceSwapModels, listLoras, cancelJob } from '../api.js';
import LoraRows from './LoraRows.jsx';
import FaceSwapRows from './FaceSwapRows.jsx';
import CinemaRig from './CinemaRig.jsx';
import { withRig } from '../cinema.js';
import { characterList, unknownMentions, resolveMentions } from '../mentions.js';
import { isViewOnly } from '../viewOnly.js';

export const ASPECTS = [
  ['1:1', 1, 1], ['4:5', 4, 5], ['3:4', 3, 4], ['2:3', 2, 3], ['9:16', 9, 16],
  ['5:4', 5, 4], ['4:3', 4, 3], ['3:2', 3, 2], ['16:9', 16, 9], ['21:9', 21, 9],
];
const snap16 = (n) => Math.max(256, Math.round(n / 16) * 16);

/** Pixel size for an aspect + megapixel budget (multiples of 16). */
export const sizeFor = (aw, ah, mp) => {
  const k = Math.sqrt((mp * 1e6) / (aw * ah));
  return { width: snap16(aw * k), height: snap16(ah * k) };
};

export const FLUX_DEFAULTS = {
  prompt: '', aspect: '1:1', mp: 1.0, steps: 8, cfg: 1.0, seed: -1, variants: 1,
  upsample: false, mode: 'generate', refStrengthNote: '', engine: 'flux3',
  rig: null, // filled from DEFAULT_RIG by App
};

const uid = () => Math.random().toString(36).slice(2, 10);

const IDEAS = [
  { e: '🎬', t: 'Cinematic still', p: 'A lone traveler on a rain-soaked neon street at night, anamorphic lens flare, teal and magenta glow, shallow depth of field' },
  { e: '🧑', t: 'Studio portrait', p: 'Studio portrait of a woman with silver hair and freckles, soft window light, 85mm, f/1.4, natural skin texture' },
  { e: '🛍️', t: 'Product shot', p: 'A matte black wireless speaker on wet slate with rim light and subtle mist, premium product photography' },
  { e: '🏔️', t: 'Epic landscape', p: 'A glacier valley at sunrise with golden light on the ridges and a tiny red tent, ultra wide angle' },
  { e: '🍜', t: 'Food', p: 'A steaming bowl of tonkotsu ramen with soft egg and scallions, moody izakaya lighting, macro' },
  { e: '🐉', t: 'Fantasy', p: 'A colossal ancient dragon curled around a ruined lighthouse in a storm, volumetric clouds, painterly concept art' },
  { e: '🏛️', t: 'Architecture', p: 'A brutalist concrete museum with a curved skylight, long shadows, empty plaza, blue hour' },
  { e: '🚀', t: 'Sci-fi', p: 'Interior of a lived-in spaceship cockpit with holographic maps and a sleeping pilot, warm practical lights' },
];

const blobUrls = new WeakMap();
const urlOf = (blob) => { let u = blobUrls.get(blob); if (!u) { u = URL.createObjectURL(blob); blobUrls.set(blob, u); } return u; };

/** Flux 3 Klein: text-to-image, reference-guided generation and instruction
 * editing, with the BFL prompt upsampler and a Cinema rig. Runs `variants`
 * jobs back to back (~5 s each warm); every result is handed to `onResult`
 * (App adds it to the Gallery). */
export default function Flux3Panel({
  settings, setSettings, assets, onResult, faces, setFaces, loras, setLoras, active, seedRefs, onAnimate,
}) {
  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));
  const { genre } = useGenre();
  const [models, setModels] = useState(null);
  const [refs, setRefs] = useState([]);            // [{id, name, blob}]
  const [loraOptions, setLoraOptions] = useState([]);
  const [qwen, setQwen] = useState(null);
  const [swapModels, setSwapModels] = useState([]);
  const [faceRestoreModels, setFaceRestoreModels] = useState([]);
  const [run, setRun] = useState({ phase: 'idle', progress: 0, status: '', jobId: null, error: null, i: 0, n: 0 });
  const [results, setResults] = useState([]);       // [{id, url, seed, prompt}]
  const [upBusy, setUpBusy] = useState(false);
  const [origPrompt, setOrigPrompt] = useState(null);
  const cancelled = useRef(false);
  const fileRef = useRef(null);

  useEffect(() => {
    flux3Models().then(setModels);
    qwen21Models().then(setQwen);
    listLoras().then(setLoraOptions);
    listFaceSwapModels().then(({ swapModels, faceRestoreModels }) => {
      setSwapModels(swapModels); setFaceRestoreModels(faceRestoreModels);
    });
  }, []);

  // reference photos are shared with the other screens (phone <-> PC): uploaded to the PC, pulled when another screen changes them
  const refsRef = useRef(refs); refsRef.current = refs;
  const sharedIds = useRef('');
  const uploaded = useRef(new Set());
  useEffect(() => {
    const ids = refs.map((r) => r.id).join(',');
    if (ids === sharedIds.current || isViewOnly()) return undefined;
    const t = setTimeout(async () => {
      try {
        for (const r of refs) {
          if (uploaded.current.has(r.id)) continue;
          await fetch(`/api/session/blob/${r.id}`, { method: 'PUT', headers: { 'x-client-id': CLIENT_ID, 'Content-Type': 'application/octet-stream' }, body: r.blob });
          uploaded.current.add(r.id);
        }
        await fetch('/api/session/refs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: CLIENT_ID, refs: refs.map((r) => ({ id: r.id, name: r.name })) }) });
        sharedIds.current = ids;
      } catch { /* offline: stays local */ }
    }, 900);
    return () => clearTimeout(t);
  }, [refs]);
  useEffect(() => {
    const pull = async () => {
      try {
        const j = await (await fetch('/api/session/refs')).json();
        const ids = j.refs.map((r) => r.id).join(',');
        if (ids === sharedIds.current) return;
        const cur = new Map(refsRef.current.map((r) => [r.id, r]));
        const next = [];
        for (const x of j.refs) {
          if (cur.has(x.id)) { next.push(cur.get(x.id)); continue; }
          const b = await fetch(`/api/session/blob/${x.id}`);
          if (b.ok) { uploaded.current.add(x.id); next.push({ id: x.id, name: x.name, blob: new Blob([await b.blob()], { type: 'image/png' }) }); }
        }
        sharedIds.current = ids;
        // keep anything attached on this screen while the pull was in flight (and not yet uploaded), or it silently vanishes
        setRefs((now) => {
          const have = new Set(next.map((r) => r.id));
          return [...next, ...now.filter((r) => !have.has(r.id) && !uploaded.current.has(r.id))];
        });
      } catch { /* backend busy: the next announcement retries */ }
    };
    pull();
    const on = (e) => { const d = e.detail || {}; if (d.type === 'refs' && d.clientId !== CLIENT_ID) pull(); };
    window.addEventListener('hf-feed-event', on);
    return () => window.removeEventListener('hf-feed-event', on);
  }, []);

  // the pictures on the canvas follow the other screens, the same way the reference photos do: this screen pushes its list only when
  // IT changed it, and applies a pulled list without pushing it back (so two screens can never ping-pong)
  const resultsRef = useRef(results); resultsRef.current = results;
  const assetsRef = useRef(assets); assetsRef.current = assets;
  const sharedResultIds = useRef('');
  const pendingIds = useRef(null);
  const applyResultIds = (ids) => {
    const cur = resultsRef.current;
    const byAsset = new Map(cur.filter((r) => r.asset).map((r) => [r.asset.id, r]));
    const next = [];
    for (const id of ids) {
      const r = byAsset.get(id);
      if (r) { next.push(r); continue; }
      const a = assetsRef.current.find((x) => x.id === id);
      if (a) next.push({ id: 'r-' + a.id, url: a.url, seed: -1, prompt: a.meta?.prompt || '', asset: a });
    }
    if (next.length < ids.length) { pendingIds.current = ids; return; }   // some pictures have not arrived yet
    pendingIds.current = null;
    sharedResultIds.current = ids.join(',');
    if (next.map((r) => r.id).join(',') !== cur.map((r) => r.id).join(',')) setResults(next);
  };
  useEffect(() => {   // push: only when the local list differs from what the screens last agreed on
    const ids = results.filter((r) => r.asset).map((r) => r.asset.id).slice(0, 30);
    if (ids.join(',') === sharedResultIds.current || isViewOnly()) return undefined;
    const t = setTimeout(async () => {
      try {
        await fetch('/api/session/results', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: CLIENT_ID, ids }) });
        sharedResultIds.current = ids.join(',');
      } catch { /* offline: stays local */ }
    }, 700);
    return () => clearTimeout(t);
  }, [results]);
  useEffect(() => {
    const pull = async () => {
      try {
        const j = await (await fetch('/api/session/results')).json();
        if (j.ids.join(',') === sharedResultIds.current && !pendingIds.current) return;
        applyResultIds(j.ids);
      } catch { /* the next announcement retries */ }
    };
    const on = (e) => { const d = e.detail || {}; if ((d.type === 'results' && d.clientId !== CLIENT_ID) || (d.type === 'session' && pendingIds.current)) pull(); };
    window.addEventListener('hf-feed-event', on);
    if (!results.length) pull();
    return () => window.removeEventListener('hf-feed-event', on);
  }, []);
  useEffect(() => { if (pendingIds.current) applyResultIds(pendingIds.current); }, [assets]);

  // a picture finished on another screen (phone <-> PC): show it here too
  useEffect(() => {
    const on = (e) => {
      const d = e.detail || {};
      setResults((rs) => (rs.some((r) => r.jobId === d.jobId) ? rs : [{ id: uid(), jobId: d.jobId, url: d.url, seed: -1, prompt: d.prompt, asset: d.asset }, ...rs]));
    };
    window.addEventListener('hf-remote-result', on);
    return () => window.removeEventListener('hf-remote-result', on);
  }, []);

  // anything pushed in from elsewhere ("Use as reference" on a gallery asset)
  useEffect(() => {
    if (seedRefs?.length) setRefs((r) => [...r, ...seedRefs.map((a) => ({ id: uid(), name: a.name, blob: a.blob, assetId: a.id }))]);
  }, [seedRefs]);

  const busy = run.phase === 'run';
  const aspect = ASPECTS.find((a) => a[0] === settings.aspect) || ASPECTS[0];
  const { width, height } = sizeFor(aspect[1], aspect[2], settings.mp);
  const editMode = settings.mode === 'edit';
  const isQwen = settings.engine === 'qwen21';
  const pickEngine = (eng) => setSettings((s) => (s.engine === eng ? s : { ...s, engine: eng, steps: eng === 'qwen21' ? 25 : 8, cfg: 1 }));
  const loraList = isQwen ? loraOptions.filter((n) => /qwen/i.test(n)) : loraOptions;
  const promptRef = useRef(null);
  // Refs are numbered in strip order, which is the order they reach the model: "image 1" = first chip. Plain words, not tags,
  // because both Flux 3 Klein and Qwen read natural-language references.
  const insertRef = (n, el = promptRef.current) => {
    const txt = `image ${n}`;
    const p = settings.prompt || '';
    const a = el ? el.selectionStart ?? p.length : p.length;
    const b = el ? el.selectionEnd ?? a : a;
    const pad = (c) => (c && !/\s/.test(c) ? ' ' : '');
    const ins = `${pad(p[a - 1])}${txt}${pad(p[b])}`;
    set('prompt', p.slice(0, a) + ins + p.slice(b));
    setTimeout(() => { el?.focus(); el?.setSelectionRange(a + ins.length, a + ins.length); }, 0);
  };
  const needsRef = editMode && refs.length === 0;
  const beforeOf = (a) => (a?.meta?.editedFrom ? assets.find((x) => x.id === a.meta.editedFrom)?.url || null : null);   // the picture this one was edited from
  const imageAssets = assets.filter((a) => a.kind === 'image' || a.kind === 'character' || a.kind === 'styleref');
  const chars = characterList(assets);
  const strayNames = unknownMentions(settings.prompt, chars);
  const usesNames = resolveMentions(settings.prompt, [], chars, uid).used.length > 0;
  // tap a name to write it at the cursor (or finish the "@Ha" being typed)
  const insertName = (nm, el = promptRef.current) => {
    const p = settings.prompt || '';
    const a = el ? el.selectionStart ?? p.length : p.length;
    const b = el ? el.selectionEnd ?? a : a;
    const partial = /@[\w-]*$/.exec(p.slice(0, a));
    const from = partial ? a - partial[0].length : a;
    const pad = (c) => (c && !/\s/.test(c) ? ' ' : '');
    const ins = `${partial ? '' : pad(p[from - 1])}@${nm}${pad(p[b]) || ' '}`;
    set('prompt', p.slice(0, from) + ins + p.slice(b));
    setTimeout(() => { el?.focus(); el?.setSelectionRange(from + ins.length, from + ins.length); }, 0);
  };

  const doUpsample = async () => {
    setUpBusy(true);
    try {
      setOrigPrompt(settings.prompt);
      const p = await flux3Upsample(settings.prompt, width, height);
      set('prompt', p);
    } catch (e) {
      setRun((r) => ({ ...r, phase: 'error', error: `Prompt upsample failed: ${e.message}` }));
    } finally { setUpBusy(false); }
  };

  const generate = async () => {
    cancelled.current = false;
    const n = Math.max(1, Math.min(12, settings.variants || 1));
    setRun({ phase: 'run', progress: 0, status: 'Submitting…', jobId: null, error: null, i: 0, n });
    const baseSeed = settings.seed >= 0 ? settings.seed : -1;
    // @Name -> "Name (the person from image N)" and the character's picture joins the strip if it is not there yet
    const linked = resolveMentions(settings.prompt, refs, chars, uid);
    if (linked.refs.length !== refs.length) setRefs(linked.refs);
    const genRefs = linked.refs;
    // the picture being edited must be a Gallery item, so the before/after link survives a refresh (a temporary browser address would not)
    if (editMode && genRefs[0] && !genRefs[0].assetId) {
      try {
        const o = await onResult(URL.createObjectURL(genRefs[0].blob), { prompt: (genRefs[0].name || 'original').replace(/\.[^.]+$/, ''), source: 'upload' });
        if (o?.id) { genRefs[0].assetId = o.id; setRefs((rs) => rs.map((r) => (r.id === genRefs[0].id ? { ...r, assetId: o.id } : r))); }
      } catch { /* no before/after for this one */ }
    }
    try {
      for (let i = 0; i < n; i++) {
        if (cancelled.current) break;
        let jobId = null;
        const rigged = withRig(linked.prompt, settings.rig);
        const finalPrompt = settings.genreLook === false ? rigged : withStill(rigged);   // the top-bar genre's camera look, unless switched off here
        const onEv = (ev) => {
          if (ev.type === 'submitted') { jobId = ev.jobId; setRun((r) => ({ ...r, jobId })); }
          else if (ev.type === 'progress') setRun((r) => ({ ...r, progress: ev.max ? ev.value / ev.max : 0, status: `Sampling ${ev.value}/${ev.max}` }));
          else if (ev.type === 'status') setRun((r) => ({ ...r, status: ev.text }));
        };
        const loraEntries = loras.filter((l) => l.name).map((l) => ({ name: l.name, strength: l.strength }));
        const result = isQwen
          ? await generateQwen21(
            { prompt: finalPrompt, width, height, steps: settings.steps, cfg: settings.cfg, seed: baseSeed >= 0 ? baseSeed + i : -1, match_ref_size: editMode },
            genRefs.map((r) => r.blob), loraEntries, onEv)
          : await generateFlux3(
          {
            prompt: finalPrompt, width, height, steps: settings.steps, cfg: settings.cfg,
            seed: baseSeed >= 0 ? baseSeed + i : -1,
            upsample: settings.upsample, match_ref_size: editMode,
            swap_model: settings.swapModel || 'inswapper_128.onnx',
            face_restore_model: settings.faceRestoreModel || 'none',
          },
          genRefs.map((r) => r.blob),
          faces.filter((f) => f.file).map((f) => ({ index: f.index, blob: f.file })),
          loraEntries, onEv);
        const asset = await onResult(result.url, {
          prompt: result.prompt || finalPrompt, source: 'flux3', jobId,
          settings: { ...settings, prompt: settings.prompt, seed: result.seed },
          loras: loras.filter((l) => l.name).map((l) => ({ ...l })),
          ...(editMode && genRefs[0]?.assetId ? { editedFrom: genRefs[0].assetId } : {}),   // lets the Gallery show a before/after slider
        });
        setResults((rs) => [{ id: uid(), url: asset?.url || result.url, seed: result.seed, prompt: result.prompt, asset }, ...rs]);
        setRun((r) => ({ ...r, i: i + 1, progress: 0 }));
      }
      setRun((r) => ({ ...r, phase: 'done', status: cancelled.current ? 'Stopped' : 'Done' }));
    } catch (e) {
      setRun((r) => (e.message === 'Cancelled' ? { ...r, phase: 'idle', status: 'Cancelled' } : { ...r, phase: 'error', error: e.message }));
    }
  };

  const cancel = () => { cancelled.current = true; if (run.jobId) cancelJob(run.jobId); };

  const addFiles = (list) => {
    const added = Array.from(list).map((f) => ({ id: uid(), name: f.name, blob: f }));   // copied now: the input is cleared right after, which empties its live file list
    setRefs((r) => [...r, ...added]);
  };
  const addAssetRef = (id) => {
    const a = assets.find((x) => x.id === id);
    if (a) setRefs((r) => [...r, { id: uid(), name: a.name, blob: a.blob, assetId: a.id }]);
  };

  const stage = (
    <div className="f3-stage">
      {busy && (
        <div className="f3-skel">
          <div className="f3-skel-bar"><div style={{ width: `${run.progress * 100}%` }} /></div>
          <span>{run.status || 'Working…'} · image {Math.min(run.i + 1, run.n)}/{run.n}</span>
        </div>
      )}
      {results.length === 0 && !busy ? (
        <div className="f3-empty">
          <h2>What do you want to see?</h2>
          <p>Type a prompt on the right, or start from one of these ideas.</p>
          <div className="f3-ideas">
            {IDEAS.map((i) => (
              <button key={i.t} className="f3-idea" onClick={() => set('prompt', i.p)}>
                <span>{i.e}</span><b>{i.t}</b><small>{i.p}</small>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="f3-results">
          <div className="f3-bar">
            <button disabled={busy} onClick={() => setResults([])} title="Remove these images from the canvas (they stay in your Gallery)">🧹 Clear results</button>
            <button disabled={busy} onClick={() => { setResults([]); setRefs([]); set('prompt', ''); set('mode', 'generate'); setOrigPrompt(null); }}
              title="Clear the canvas, the prompt and the reference images, and start fresh">＋ New image</button>
          </div>
          {results.map((r) => (
            <figure key={r.id} className="f3-card">
              <button className="f3-x" title="Remove from the canvas (stays in your Gallery)" onClick={() => setResults((rs) => rs.filter((x) => x.id !== r.id))}>✕</button>
              {beforeOf(r.asset) ? <CompareIfSame before={beforeOf(r.asset)} after={r.url}><img src={r.url} alt="result" decoding="async" /></CompareIfSame> : <img src={r.url} alt="result" decoding="async" />}
              <figcaption>
                <button title="Edit this image with a text instruction" onClick={() => {
                  if (r.asset) setRefs((rs) => [...rs, { id: uid(), name: 'result', blob: r.asset.blob, assetId: r.asset.id }]);
                  set('mode', 'edit');
                }}>🪄 Edit</button>
                {onAnimate && r.asset && <button title="Send to the storyboard as a scene to animate" onClick={() => onAnimate(r.asset)}>🎞️ Animate</button>}
                <button title="Reuse this seed" onClick={() => set('seed', r.seed)}>🎲 {String(r.seed).slice(-5)}</button>
                <a href={r.url} download={`flux3_${r.seed}.png`}>⬇</a>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="f3-layout">
      {stage}
    <section className="panel gen flux3 f3-side gj-panel">
      <h3>{isQwen ? 'Qwen Image 2.1' : 'Flux 3 — Image Studio'}<small className="gj-count">{isQwen ? '25 steps · quality' : 'Klein · 8 steps'}</small></h3>
      <div className="es-body">
      <div className="f3-engine">
        <button className={!isQwen ? 'on' : ''} disabled={busy} onClick={() => pickEngine('flux3')}><b>⚡ Flux 3 Klein</b><small>~10 s · fast, great stills</small></button>
        <button className={isQwen ? 'on' : ''} disabled={busy || (qwen && !qwen.ready)} onClick={() => pickEngine('qwen21')}
          title={qwen && !qwen.ready ? 'Qwen Image 2.1 models were not found in ComfyUI' : 'Slower, with stronger prompt following and text rendering'}><b>✦ Qwen Image 2.1</b><small>~1-2 min · detail, text, edits</small></button>
      </div>
      {models && !models.ready && (
        <div className="error">Flux 3 models not found in ComfyUI. Need the Klein diffusion model, flux3 Qwen3-VL text encoder and flux3 VAE.</div>
      )}
      <div className="seg">
        <button className={!editMode ? 'active' : ''} disabled={busy} onClick={() => set('mode', 'generate')}>✨ Generate</button>
        <button className={editMode ? 'active' : ''} disabled={busy} onClick={() => set('mode', 'edit')}>🪄 Edit / Reference</button>
      </div>
      <div className="hint">
        {editMode
          ? 'Drop in one or more images and describe the change ("make it night", "put her in a red jacket"). Canvas follows the first image.'
          : 'Text → image in ~5 s. Add reference images to guide a character, product or style.'}
      </div>

      <label>Prompt</label>
      <textarea rows={4} value={settings.prompt} disabled={busy} ref={promptRef}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-ref')) e.preventDefault(); }}
        onDrop={(e) => { const n = e.dataTransfer.getData('text/x-ref'); if (n) { e.preventDefault(); insertRef(+n, e.currentTarget); } }}
        placeholder={editMode ? 'What should change?' : 'e.g. a lighthouse keeper at dusk'}
        onChange={(e) => set('prompt', e.target.value)} />
      {chars.length > 0 && (
        <div className="char-chips" title="Tap a name to write it in the prompt. The app adds that character's picture and tells the model which image is them.">
          <small>Characters:</small>
          {chars.map((c) => <button key={c.name} type="button" disabled={busy} onClick={() => insertName(c.name)}>@{c.name}</button>)}
        </div>
      )}
      {strayNames.length > 0 && <div className="hint" style={{ color: '#e8b04a' }}>No saved character named {strayNames.map((n) => `@${n}`).join(', ')}. Save one in Character Studio with that name, or tap a name above.</div>}
      {genre.still_style && (
        <div className="genre-look">
          <label className="checkbox-label" title="The top-bar genre adds its own camera and lighting words to every picture you make here. Untick for a clean, neutral picture.">
            <input type="checkbox" checked={settings.genreLook !== false} disabled={busy} onChange={(e) => set('genreLook', e.target.checked)} />
            Add the “{genre.label}” look to my prompt
          </label>
          <details><summary className="hint">what this adds</summary><div className="hint">{genre.still_style}</div></details>
        </div>
      )}
      <div className="row">
        <button disabled={busy || upBusy || !settings.prompt.trim()}
          title="Rewrite as a dense, layout-aware caption with Black Forest Labs' Qwen3.5 prompt upsampler (first run loads the model, ~30 s)"
          onClick={doUpsample}>
          {upBusy ? '⏳ Upsampling…' : '🧠 Enhance prompt'}
        </button>
        {origPrompt != null && (
          <button disabled={busy} onClick={() => { set('prompt', origPrompt); setOrigPrompt(null); }}>↩ Original</button>
        )}
        <label className="checkbox-label" style={{ margin: '0 0 0 6px' }} title="Upsample automatically before every generation">
          <input type="checkbox" checked={!!settings.upsample} disabled={busy} onChange={(e) => set('upsample', e.target.checked)} />
          auto
        </label>
      </div>

      <label>References {refs.length ? `(${refs.length})` : ''}</label>
      <div className="ref-strip">
        {refs.map((r, i) => (
          <span key={r.id} className="ref-chip" draggable title={`Drag onto the prompt to write "image ${i + 1}", or click the number`}
            onDragStart={(e) => { e.dataTransfer.setData('text/x-ref', String(i + 1)); e.dataTransfer.effectAllowed = 'copy'; }}>
            <img src={urlOf(r.blob)} alt={r.name} draggable={false} />
            <button className="num" disabled={busy} onClick={() => insertRef(i + 1)}>{i + 1}</button>
            <button className="x" disabled={busy} onClick={() => setRefs((rs) => rs.filter((x) => x.id !== r.id))}>×</button>
          </span>
        ))}
      </div>
      {refs.length > 0 && !usesNames && !/\bimage\s*\d/i.test(settings.prompt || '') && (
        <div className="hint" style={{ color: '#e8b04a' }}>
          💡 Your prompt doesn't mention "image 1". The model holds a reference's face and look much better when the prompt names it
          (e.g. "the woman from image 1, same face and hair, now…"). Click a chip's number to insert it.
        </div>
      )}
      <div className="row">
        <button disabled={busy} onClick={() => fileRef.current?.click()}>＋ Add images</button>
        {imageAssets.length > 0 && (
          <select disabled={busy} value="" onChange={(e) => { if (e.target.value) addAssetRef(e.target.value); }}>
            <option value="">＋ from Gallery…</option>
            {imageAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }} />

      {!editMode && (
        <>
          <label>Aspect ratio — {width}×{height}</label>
          <div className="chips">
            {ASPECTS.map(([id]) => (
              <button key={id} className={settings.aspect === id ? 'active' : ''} disabled={busy}
                onClick={() => set('aspect', id)}>{id}</button>
            ))}
          </div>
          <label>Resolution — {settings.mp} MP</label>
          <input type="range" min={0.5} max={2.5} step={0.25} value={settings.mp} disabled={busy}
            onChange={(e) => set('mp', +e.target.value)} />
        </>
      )}

      <div className="grid2">
        <label>Steps
          <input type="number" min={1} max={50} value={settings.steps} disabled={busy}
            onChange={(e) => set('steps', +e.target.value)} />
        </label>
        <label>Variations
          <input type="number" min={1} max={12} value={settings.variants} disabled={busy}
            onChange={(e) => set('variants', +e.target.value)} />
        </label>
        <label>Seed (−1 = random)
          <input type="number" value={settings.seed} disabled={busy} onChange={(e) => set('seed', +e.target.value)} />
        </label>
        <label>CFG
          <input type="number" step={0.1} min={1} max={10} value={settings.cfg} disabled={busy}
            onChange={(e) => set('cfg', +e.target.value)} />
        </label>
      </div>

      <CinemaRig rig={settings.rig} setRig={(fn) => setSettings((s) => ({ ...s, rig: typeof fn === 'function' ? fn(s.rig) : fn }))} busy={busy} />

      <LoraRows loras={loras} setLoras={setLoras} loraOptions={loraList} busy={busy}
        hint="Only LoRAs trained for Flux 3 / Flux.2 Klein will have an effect." />
      <FaceSwapRows
        faces={faces} setFaces={setFaces} swapModels={swapModels} faceRestoreModels={faceRestoreModels}
        swapModel={settings.swapModel} faceRestoreModel={settings.faceRestoreModel}
        onSwapModelChange={(v) => set('swapModel', v)} onFaceRestoreModelChange={(v) => set('faceRestoreModel', v)}
        busy={busy} />

      </div>
      <div className="es-foot">
      <button className="primary" onClick={generate}
        disabled={busy || !settings.prompt.trim() || needsRef || faces.some((f) => !f.file) || loras.some((l) => !l.name)}>
        {busy ? `Generating ${run.i + 1}/${run.n}…` : needsRef ? 'Add a reference image to edit' : settings.variants > 1 ? `🎨 Generate ${settings.variants}` : '🎨 Generate'}
      </button>
      {busy && (
        <>
          <GenProgress progress={run.progress} status={run.status} onCancel={cancel} />
        </>
      )}
      {run.phase === 'error' && <div className="error">{run.error}</div>}
      </div>
    </section>
    </div>
  );
}
