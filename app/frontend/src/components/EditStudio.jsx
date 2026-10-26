import GenProgress from './GenProgress.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { faceSwap, faceMatch, generateFlux3, cancelJob, listLoras, listLoraFamilies } from '../api.js';
import LoraRows from './LoraRows.jsx';
import { EDIT_TOOLS } from '../editTools.js';
import DropZone from './DropZone.jsx';
import BeforeAfter from './BeforeAfter.jsx';
import { useToolMemory } from '../toolMemory.js';
import { useSameCamera } from '../cameraMatch.js';

const uid = () => Math.random().toString(36).slice(2, 10);

/** Edit Studio: pick a source image, choose a tool, optionally paint a mask,
 * and run a Flux 3 instruction edit. Every result becomes a Gallery asset and
 * can be chained as the next source (non-destructive history). */
export default function EditStudio({ assets, onResult, incoming, active }) {
  const [source, setSource] = useState(null);       // {id, name, blob, url}
  const [history, setHistory] = useState([]);       // previous sources (undo)
  const [toolId, setToolId] = useState('free');
  const [optIdx, setOptIdx] = useState(0);
  const [text, setText] = useState('');
  const [refs, setRefs] = useState({});             // slotIndex -> {name, blob, url}
  const [feather, setFeather] = useState(12);
  const [brush, setBrush] = useState({ size: 48, erase: false });
  const [hasMask, setHasMask] = useState(false);
  const [run, setRun] = useState({ phase: 'idle', progress: 0, status: '', jobId: null, error: null });
  const [result, setResult] = useState(null);       // {url, asset}
  const [showAfter, setShowAfter] = useState(true);
  const [slide, setSlide] = useState(true);
  const sameCam = useSameCamera(result ? source?.url : null, result?.url);   // the slider only makes sense when the camera did not move
  const sliderOn = !!result && showAfter && slide && sameCam === true;          // after an edit, show the drag-to-compare slider first
  const [steps, setSteps] = useState(8);
  const [loras, setLoras] = useState([]);           // [{id, name, strength}] chained onto the model for every tool
  const [loraOptions, setLoraOptions] = useState([]);
  const [fams, setFams] = useState({});               // lora file -> model family it was trained for
  const [showAllLoras, setShowAllLoras] = useState(false);
  const imgRef = useRef(null);
  const dispRef = useRef(null);   // visible overlay canvas
  const maskRef = useRef(null);   // offscreen natural-size mask canvas
  const drawing = useRef(false);
  const fileRef = useRef(null);
  const refFileRef = useRef(null);
  const refSlot = useRef(0);

  const tool = EDIT_TOOLS.find((t) => t.id === toolId);
  const busy = run.phase === 'run';

  const loadSource = (a, pushHistory = true) => {
    if (!a) return;
    if (source && pushHistory) setHistory((h) => [...h, source]);
    setSource({ id: a.id || uid(), name: a.name || 'image', blob: a.blob, url: a.url || URL.createObjectURL(a.blob) });
    setResult(null); setHasMask(false); setRun((r) => ({ ...r, phase: 'idle', error: null }));
  };

  useEffect(() => { if (active !== false) { listLoras().then(setLoraOptions); listLoraFamilies().then(setFams); } }, [active]);
  const haveFams = Object.keys(fams).length > 0;       // old backend without /api/loras/info: show every LoRA
  const fits = haveFams ? loraOptions.filter((n) => fams[n] === 'flux3') : loraOptions;
  const famName = { flux3: 'Flux 3', krea2: 'Krea 2', qwen: 'Qwen', zimage: 'Z-Image', ltx: 'LTX video', wan: 'Wan video', minimax_h3: 'MiniMax H3', sdxl: 'SDXL', unknown: '?' };
  const loraEntries = loras.filter((l) => l.name).map((l) => ({ name: l.name, strength: l.strength }));

  // an asset pushed in from the gallery / scene editor
  useEffect(() => { if (incoming?.asset) loadSource(incoming.asset, false); }, [incoming?.nonce]);

  // (re)size the mask canvases whenever the displayed source changes
  const onImgLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    const m = document.createElement('canvas');
    m.width = img.naturalWidth; m.height = img.naturalHeight;
    const mc = m.getContext('2d'); mc.fillStyle = '#000'; mc.fillRect(0, 0, m.width, m.height);
    maskRef.current = m;
    const d = dispRef.current;
    d.width = img.clientWidth; d.height = img.clientHeight;
    d.getContext('2d').clearRect(0, 0, d.width, d.height);
  };

  const pos = (e) => {
    const r = dispRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const stroke = (a, b) => {
    const d = dispRef.current, m = maskRef.current;
    if (!d || !m) return;
    const dc = d.getContext('2d'), mc = m.getContext('2d');
    const sizeN = brush.size * (m.width / d.width);
    dc.lineCap = mc.lineCap = 'round'; dc.lineJoin = mc.lineJoin = 'round';
    if (brush.erase) {
      dc.globalCompositeOperation = 'destination-out'; dc.strokeStyle = 'rgba(0,0,0,1)';
      mc.strokeStyle = '#000';
    } else {
      dc.globalCompositeOperation = 'source-over'; dc.strokeStyle = 'rgba(255,60,60,0.55)';
      mc.strokeStyle = '#fff';
    }
    dc.lineWidth = brush.size; mc.lineWidth = sizeN;
    dc.beginPath(); dc.moveTo(a.x * d.width, a.y * d.height); dc.lineTo(b.x * d.width, b.y * d.height); dc.stroke();
    mc.beginPath(); mc.moveTo(a.x * m.width, a.y * m.height); mc.lineTo(b.x * m.width, b.y * m.height); mc.stroke();
    setHasMask(true);
  };
  const last = useRef(null);
  const down = (e) => { if (tool.mask === 'none' || busy) return; drawing.current = true; last.current = pos(e); stroke(last.current, last.current); e.currentTarget.setPointerCapture(e.pointerId); };
  const move = (e) => { if (!drawing.current) return; const p = pos(e); stroke(last.current, p); last.current = p; };
  const up = () => { drawing.current = false; };
  const clearMask = () => { onImgLoad(); setHasMask(false); };
  const invertMask = () => {
    const m = maskRef.current, d = dispRef.current; if (!m) return;
    const mc = m.getContext('2d');
    const id = mc.getImageData(0, 0, m.width, m.height);
    for (let i = 0; i < id.data.length; i += 4) { const v = 255 - id.data[i]; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; }
    mc.putImageData(id, 0, 0);
    const dc = d.getContext('2d'); dc.globalCompositeOperation = 'source-over';
    dc.clearRect(0, 0, d.width, d.height);
    const tmp = document.createElement('canvas'); tmp.width = d.width; tmp.height = d.height;
    const tc = tmp.getContext('2d'); tc.drawImage(m, 0, 0, d.width, d.height);
    const td = tc.getImageData(0, 0, d.width, d.height);
    for (let i = 0; i < td.data.length; i += 4) { const on = td.data[i] > 127; td.data[i] = 255; td.data[i + 1] = 60; td.data[i + 2] = 60; td.data[i + 3] = on ? 140 : 0; }
    dc.putImageData(td, 0, 0);
    setHasMask(true);
  };

  const apply = async () => {
    if (!source) return;
    const option = tool.options?.items[optIdx]?.text || '';
    const refList = (tool.refs || []).map((_, i) => refs[i]).filter(Boolean);
    const instruction = tool.build(text, option, refList.length > 0, hasMask);
    const useMask = tool.mask !== 'none' && hasMask;
    let maskBlob = null;
    if (useMask) maskBlob = await new Promise((res) => maskRef.current.toBlob(res, 'image/png'));
    setRun({ phase: 'run', progress: 0, status: 'Submitting…', jobId: null, error: null });
    try {
      if (tool.id === 'character' && refList[0]) {          // exact identity: InSwapper on the chosen face, then a detail pass
        try {
          setRun((r) => ({ ...r, status: 'Swapping the face (exact identity)…', progress: 0.1 }));
          const pick = /all/i.test(text) ? 'all' : /left/i.test(text) ? 'left' : /right/i.test(text) ? 'right' : /(middle|center|centre)/i.test(text) ? 'center' : 'largest';
          const swapped = await faceSwap(source.blob, refList[0].blob, { pick, mask: maskBlob });
          const polishPrompt = "Enhance this portrait photo: restore sharp, natural skin texture, crisp eyes, eyelashes and lips on the faces. Keep every person's face, expression, hair, pose, clothing and the background exactly as they are.";
          const res = await generateFlux3({ prompt: polishPrompt, steps: 8, cfg: 1, match_ref_size: true }, [swapped], [], loraEntries, (ev) => {
            if (ev.type === 'submitted') setRun((r) => ({ ...r, jobId: ev.jobId }));
            else if (ev.type === 'progress') setRun((r) => ({ ...r, progress: 0.2 + 0.8 * (ev.max ? ev.value / ev.max : 0), status: `Restoring detail ${ev.value}/${ev.max}` }));
          });
          let url = res.url;
          try {   // the detail pass can drift the face: keep whichever is closer to the reference
            const pol = await (await fetch(res.url)).blob();
            const a = (await faceMatch(refList[0].blob, pol)).sim, b = (await faceMatch(refList[0].blob, swapped)).sim;
            if (b != null && (a == null || b > a + 0.05)) url = URL.createObjectURL(swapped);
          } catch { /* keep the polished one */ }
          const asset = await onResult(url, { prompt: instruction, source: 'flux3', editTool: tool.id, editedFrom: source.id });
          setResult({ url: asset?.url || url, asset });
          setShowAfter(true);
          setRun((r) => ({ ...r, phase: 'done', status: 'Done' }));
          return;
        } catch (e) {
          if (e.message === 'Cancelled') { setRun((r) => ({ ...r, phase: 'idle' })); return; }
          setRun((r) => ({ ...r, status: `Face swap unavailable (${e.message}). Using the image model instead…`, progress: 0 }));
        }
      }
      const res = await generateFlux3(
        { prompt: instruction, steps, cfg: 1, match_ref_size: true, mask_feather: feather },
        [source.blob, ...refList.map((r) => r.blob)], [], loraEntries,
        (ev) => {
          if (ev.type === 'submitted') setRun((r) => ({ ...r, jobId: ev.jobId }));
          else if (ev.type === 'progress') setRun((r) => ({ ...r, progress: ev.max ? ev.value / ev.max : 0, status: `Sampling ${ev.value}/${ev.max}` }));
          else if (ev.type === 'status') setRun((r) => ({ ...r, status: ev.text }));
        },
        maskBlob,
      );
      const asset = await onResult(res.url, { prompt: instruction, source: 'flux3', editTool: tool.id, editedFrom: source.id });
      setResult({ url: asset?.url || res.url, asset });
      setShowAfter(true);
      setRun((r) => ({ ...r, phase: 'done', status: 'Done' }));
    } catch (e) {
      setRun((r) => (e.message === 'Cancelled' ? { ...r, phase: 'idle' } : { ...r, phase: 'error', error: e.message }));
    }
  };

  // an uploaded picture joins the Gallery first, so it (and the before/after link to it) survives a refresh
  const addUpload = async (f) => {
    try { const a = await onResult(URL.createObjectURL(f), { prompt: f.name.replace(/\.[^.]+$/, ''), source: 'upload' }); if (a) return a; } catch { /* use the bare file */ }
    return { name: f.name, blob: f };
  };
  const refIds = Object.fromEntries(Object.entries(refs).filter(([, r]) => r?.assetId).map(([k, r]) => [k, r.assetId]));
  useToolMemory('edit', {
    toolId, optIdx, text, feather, brush, steps, loras: loras.map(({ name, strength }) => ({ name, strength })), srcId: source?.id || null, resultId: result?.asset?.id || null, refIds,
    needs: [source?.id, result?.asset?.id, ...Object.values(refIds)].filter(Boolean),
  }, (sv, byId) => {
    if (sv.toolId && EDIT_TOOLS.some((t) => t.id === sv.toolId)) setToolId(sv.toolId);
    setOptIdx(sv.optIdx || 0); setText(sv.text || '');
    if (sv.feather != null) setFeather(sv.feather);
    if (sv.brush) setBrush(sv.brush);
    if (sv.steps != null) setSteps(sv.steps);
    setLoras((sv.loras || []).map((l) => ({ id: uid(), name: l.name, strength: l.strength })));
    const rr = {};
    Object.entries(sv.refIds || {}).forEach(([k, id]) => { const a = byId.get(id); if (a) rr[k] = { name: a.name, blob: a.blob, url: a.url, assetId: a.id }; });
    setRefs(rr);
    const sa = sv.srcId && byId.get(sv.srcId);
    if (sa) {
      setSource({ id: sa.id, name: sa.name, blob: sa.blob, url: sa.url });
      const ra = sv.resultId && byId.get(sv.resultId);
      if (ra) { setResult({ url: ra.url, asset: ra }); setShowAfter(true); setSlide(true); }
    }
  }, assets);

  const chain = () => { if (result?.asset) loadSource(result.asset); };
  const undo = () => { const h = [...history]; const prev = h.pop(); if (prev) { setHistory(h); setSource(prev); setResult(null); setHasMask(false); } };

  const missingRef = (tool.refs || []).some((r, i) => r.required && !refs[i]);
  const needText = tool.needsText && !text.trim();
  const needMask = tool.mask === 'required' && !hasMask;
  const imageAssets = assets.filter((a) => ['image', 'character', 'styleref', 'sketch'].includes(a.kind));
  const stageUrl = result && showAfter ? result.url : source?.url;

  return (
    <div className="edit-studio">
      <div className="es-stage">
        {!source ? (
          <DropZone accept="image" icon="🪄" title="Drop a photo to edit" assets={assets}
            onFile={async (f) => loadSource(await addUpload(f), false)} onAsset={(a) => loadSource(a, false)} />
        ) : (
          sliderOn ? (
            <div className="es-canvas-wrap"><BeforeAfter before={source.url} after={result.url} /></div>
          ) : (
          <div className="es-canvas-wrap">
            <img ref={imgRef} src={stageUrl} alt="source" onLoad={onImgLoad} draggable={false} />
            <canvas ref={dispRef} className={`es-mask ${result && showAfter ? 'hidden' : ''} ${tool.mask === 'none' ? 'off' : ''}`}
              onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
          </div>
          )
        )}
        {source && (
          <div className="es-bar">
            {result && (
              <>
                {sameCam === true && <button className={sliderOn ? 'active' : ''} onClick={() => { setShowAfter(true); setSlide(true); }} title="Drag to compare the original and the edit">↔ Slider</button>}
                <button className={showAfter && !sliderOn ? 'active' : ''} onClick={() => { setShowAfter(true); setSlide(false); }}>After</button>
                <button className={!showAfter ? 'active' : ''} onClick={() => setShowAfter(false)}>Before</button>
                <button onClick={chain} title="Make the result the new source and keep editing">⛓ Keep editing this</button>
                <a className="dl" href={result.url} download="edit.png">⬇</a>
              </>
            )}
            {history.length > 0 && <button onClick={undo}>↶ Undo ({history.length})</button>}
            <button onClick={() => fileRef.current?.click()}>Change image</button>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden
          onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) loadSource(await addUpload(f)); }} />
      </div>

      <div className="es-side glass gj-panel">
        <h3>Edit Studio<small className="gj-count">{EDIT_TOOLS.length} tools</small></h3>
        <div className="hint" title="flux3_image_klein_sd_int8_convrot.safetensors">Model: Flux 3 Klein (every tool below)</div>
        <div className="es-body">
        <div className="es-tools">
          {EDIT_TOOLS.map((t) => (
            <button key={t.id} className={toolId === t.id ? 'active' : ''} disabled={busy}
              title={t.blurb} onClick={() => { setToolId(t.id); setOptIdx(0); setRefs({}); }}>
              <span>{t.icon}</span>{t.label}
            </button>
          ))}
        </div>
        <div className="hint">{tool.blurb}</div>

        {tool.options && (
          <label>{tool.options.label}
            <select value={optIdx} disabled={busy} onChange={(e) => setOptIdx(+e.target.value)}>
              {tool.options.items.map((o, i) => <option key={o.label} value={i}>{o.label}</option>)}
            </select>
          </label>
        )}
        {(tool.needsText || tool.placeholder) && (
          <>
            <label>{tool.needsText ? 'Describe' : 'Details (optional)'}</label>
            <textarea rows={3} value={text} disabled={busy} placeholder={tool.placeholder || ''}
              onChange={(e) => setText(e.target.value)} />
          </>
        )}
        {(tool.refs || []).map((slot, i) => (
          <div key={i}>
            <label>{slot.label}{slot.required ? ' *' : ''}</label>
            <div className="row">
              {refs[i] && <span className="ref-chip"><img src={refs[i].url} alt="" /><button className="x" onClick={() => setRefs((r) => { const n = { ...r }; delete n[i]; return n; })}>×</button></span>}
              <button disabled={busy} onClick={() => { refSlot.current = i; refFileRef.current?.click(); }}>＋ Choose</button>
              {imageAssets.length > 0 && (
                <select value="" disabled={busy} onChange={(e) => { const a = assets.find((x) => x.id === e.target.value); if (a) setRefs((r) => ({ ...r, [i]: { name: a.name, blob: a.blob, url: a.url, assetId: a.id } })); }}>
                  <option value="">Gallery…</option>
                  {imageAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
            </div>
          </div>
        ))}
        <input ref={refFileRef} type="file" accept="image/*" hidden
          onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; const slot = refSlot.current; const ua = await addUpload(f); setRefs((r) => ({ ...r, [slot]: { name: f.name, blob: f, url: ua.url || URL.createObjectURL(f), assetId: ua.id } })); }} />

        {tool.mask !== 'none' && source && (
          <div className="es-mask-tools">
            <label>Brush mask {tool.mask === 'required' ? '(required)' : '(optional — limits the edit to the painted area)'}</label>
            <div className="row">
              <button className={!brush.erase ? 'active' : ''} onClick={() => setBrush((b) => ({ ...b, erase: false }))}>🖌 Paint</button>
              <button className={brush.erase ? 'active' : ''} onClick={() => setBrush((b) => ({ ...b, erase: true }))}>⌫ Erase</button>
              <button onClick={invertMask} disabled={!hasMask}>⇄ Invert</button>
              <button onClick={clearMask} disabled={!hasMask}>Clear</button>
            </div>
            <label>Brush size {brush.size}px
              <input type="range" min={8} max={160} value={brush.size} onChange={(e) => setBrush((b) => ({ ...b, size: +e.target.value }))} />
            </label>
            <label>Edge feather {feather}px
              <input type="range" min={0} max={31} value={feather} onChange={(e) => setFeather(+e.target.value)} />
            </label>
          </div>
        )}
        <label>Steps
          <input type="number" min={1} max={30} value={steps} disabled={busy} onChange={(e) => setSteps(+e.target.value)} />
        </label>
        <LoraRows loras={loras} setLoras={setLoras} loraOptions={showAllLoras ? loraOptions : fits} busy={busy}
          labelFor={showAllLoras ? (n) => `[${famName[fams[n]] || '?'}] ${n}` : undefined}
          hint={`Edits run on Flux 3 Klein, so only Flux 3 LoRAs are listed (${fits.length} of ${loraOptions.length} installed). Applies to every tool above.`} />
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showAllLoras} onChange={(e) => setShowAllLoras(e.target.checked)} />
          Show all LoRAs (other models' LoRAs will not work here)
        </label>
        {loras.some((l) => l.name && fams[l.name] && fams[l.name] !== 'flux3') && (
          <div className="error">A selected LoRA is for {famName[fams[loras.find((l) => l.name && fams[l.name] !== 'flux3').name]]}, not Flux 3. It will be ignored or give broken results.</div>
        )}

        </div>
        <div className="es-foot">
        <button className="primary" onClick={apply} disabled={busy || !source || missingRef || needText || needMask || loras.some((l) => !l.name)}>
          {busy ? 'Editing…' : !source ? 'Pick an image first' : needMask ? 'Paint a mask first' : missingRef ? 'Add the reference image' : needText ? 'Describe the change' : `${tool.icon} Apply`}
        </button>
        {busy && (
          <>
            <GenProgress progress={run.progress} status={run.status} onCancel={() => cancelJob(run.jobId)} cancelDisabled={!run.jobId} />
          </>
        )}
        {run.phase === 'error' && <div className="error">{run.error}</div>}
        </div>
      </div>
    </div>
  );
}
