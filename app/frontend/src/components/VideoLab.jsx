import GenProgress from './GenProgress.jsx';
import { useToolMemory } from '../toolMemory.js';
import React, { useEffect, useRef, useState } from 'react';
import { runComfyTool, runFfmpegTool, toolModels, cancelJob } from '../api.js';
import DropZone from './DropZone.jsx';

const ASPECT_CHOICES = ['9:16', '16:9', '1:1', '4:5', '21:9'];

// id, label, blurb, kind ('comfy'|'ffmpeg'), accepts ('video'|'image'|'both'), params
const TOOLS = [
  { group: 'Enhance', items: [
    { id: 'upscale', icon: '🔍', label: 'Upscale', blurb: 'Real-ESRGAN — sharper, bigger. Works on images and video.', kind: 'comfy', accepts: 'both',
      endpoint: '/api/tools/upscale', fields: [{ k: 'scale', label: 'Factor', type: 'select', opts: ['1.5', '2', '3', '4'], def: '2' }, { k: 'model', label: 'Model', type: 'model', key: 'upscalers' }] },
    { id: 'rtxup', icon: '⚡', label: 'RTX Upscale', blurb: 'NVIDIA RTX Video Super Resolution: very fast, sharper and bigger (up to 4×). Images and video. Sharpens what is there; it does not add new detail.', kind: 'comfy', accepts: 'both',
      endpoint: '/api/tools/rtx_upscale', fields: [{ k: 'scale', label: 'Factor', type: 'select', opts: ['1.5', '2', '3', '4'], def: '2' }, { k: 'quality', label: 'Quality', type: 'select', opts: ['ULTRA', 'HIGH', 'MEDIUM', 'LOW'], def: 'ULTRA' }] },
    { id: 'smooth', icon: '🎞️', label: 'Smooth motion', blurb: 'RIFE interpolation — 24 → 48/72 fps, same length.', kind: 'comfy', accepts: 'video',
      endpoint: '/api/tools/interpolate', fixed: { mode: 'smooth' }, fields: [{ k: 'multiplier', label: 'Multiplier', type: 'select', opts: ['2', '3', '4'], def: '2' }] },
    { id: 'slowmo', icon: '🐢', label: 'Slow motion', blurb: 'RIFE-interpolated slow-mo — extra frames, longer clip, no stutter.', kind: 'comfy', accepts: 'video',
      endpoint: '/api/tools/interpolate', fixed: { mode: 'slowmo' }, fields: [{ k: 'multiplier', label: 'Slower by', type: 'select', opts: ['2', '3', '4', '6'], def: '2' }] },
  ] },
  { group: 'Faces', items: [
    { id: 'faceswap', icon: '🎭', label: 'Face swap', blurb: 'ReActor — put one face on every frame of a video (or a still). Faces are counted left → right.', kind: 'comfy', accepts: 'both',
      endpoint: '/api/tools/face_swap', needsFace: true,
      fields: [{ k: 'face_index', label: 'Which person in the clip (0 = leftmost)', type: 'select', opts: ['0', '1', '2', '3'], def: '0' }] },
  ] },
  { group: 'Cutout', items: [
    { id: 'bg', icon: '✂️', label: 'Remove background', blurb: 'BiRefNet — transparent PNG for images, or a solid / green-screen background for video.', kind: 'comfy', accepts: 'both',
      endpoint: '/api/tools/remove_bg', fields: [{ k: 'background', label: 'Background', type: 'select', opts: ['alpha', 'green', 'blue', 'white', 'black', 'grey'], def: 'alpha', note: 'alpha = transparent (images only)' }] },
  ] },
  { group: 'Look', items: [
    { id: 'footage', icon: '📹', label: 'Found-footage look', blurb: 'Make clean AI video read as real recorded footage: handheld shake, focus hunting, exposure hunting, tape wear, glitches, a REC / timecode overlay and cheap-mic audio. Camcorder, VHS, CCTV, night vision, body cam, doorbell cam or phone.',
      kind: 'ffmpeg', accepts: 'video', op: 'footage',
      fields: [
        { k: 'preset', label: 'Camera', type: 'select', opts: ['camcorder', 'vhs', 'cctv', 'nightvision', 'bodycam', 'doorbell', 'phone'], def: 'camcorder' },
        { k: 'shake', label: 'Camera shake', type: 'select', opts: ['none', 'light', 'medium', 'heavy', 'blair witch'], def: 'medium' },
        { k: 'focus', label: 'Focus hunting', type: 'select', opts: ['off', 'some', 'a lot'], def: 'some' },
        { k: 'grain', label: 'Grain / noise', type: 'select', opts: ['low', 'medium', 'high'], def: 'medium' },
        { k: 'wear', label: 'Low-res + compression', type: 'select', opts: ['light', 'medium', 'heavy'], def: 'medium' },
        { k: 'glitches', label: 'Tape / signal glitches', type: 'select', opts: ['none', 'few', 'many'], def: 'few' },
        { k: 'overlay', label: 'Camera overlay (REC, timecode)', type: 'select', opts: ['on', 'off'], def: 'on' },
        { k: 'audio', label: 'Audio', type: 'select', opts: ['passthrough', 'degrade', 'keep', 'none'], def: 'passthrough', note: 'passthrough = the original clip sound, untouched (best before adding one sound layer on the finished video); degrade = cheap-mic filtering + room tone + wind' },
        { k: 'cam_name', label: 'Camera name (CCTV / body cam)', type: 'text', def: 'CAM 03' },
        { k: 'seed', label: 'Variation', type: 'number', def: '7' },
      ] },
  ] },
  { group: 'Sound', items: [
    { id: 'sound', icon: '🎧', label: 'Found-footage sound', blurb: 'The soundtrack a cheap microphone in a frightening place would record: ambience, a creeping drone, distant knocks and creaks, operator breathing and footsteps, and mic bumps placed on the real camera jolts (measured from the video). Add a jump scare at a chosen second.',
      kind: 'ffmpeg', accepts: 'video', op: 'sound', endpoint: '/api/tools/sound',
      fields: [
        { k: 'ambience', label: 'Ambience', type: 'select', opts: ['forest night (AI)', 'city night (AI)', 'lake night (AI)', 'basement (AI)', 'car interior', 'wind', 'room tone', 'house at night', 'hospital hum', 'none'], def: 'forest night (AI)', note: '(AI) = generated locally by Stable Audio, ~30 s' },
        { k: 'unease', label: 'Dread', type: 'select', opts: ['low', 'medium', 'high', 'rising', 'none'], def: 'medium', note: 'drone + distant knocks and creaks; rising builds to the end' },
        { k: 'bumps', label: 'Mic bumps on camera jolts', type: 'select', opts: ['on', 'off'], def: 'on' },
        { k: 'breathing', label: 'Operator breathing', type: 'select', opts: ['none', 'calm', 'scared', 'panicked'], def: 'scared' },
        { k: 'footsteps', label: 'Footsteps', type: 'select', opts: ['none', 'leaves', 'floorboards', 'gravel'], def: 'none' },
        { k: 'pace', label: 'Pace', type: 'select', opts: ['walk', 'run'], def: 'walk' },
        { k: 'scare', label: 'Jump scare at (seconds, -1 = none)', type: 'number', def: '-1', min: -1 },
        { k: 'keep_original', label: 'Keep the existing audio (voices)', type: 'select', opts: ['on', 'off'], def: 'on' },
        { k: 'cheap_mic', label: 'Cheap-microphone filter', type: 'select', opts: ['on', 'off'], def: 'on' },
        { k: 'seed', label: 'Variation', type: 'number', def: '7' },
      ] },
  ] },
  { group: 'Edit', items: [
    { id: 'reverse', icon: '⏪', label: 'Reverse', blurb: 'Play the clip backwards.', kind: 'ffmpeg', accepts: 'video', op: 'reverse', fields: [] },
    { id: 'speed', icon: '⏩', label: 'Speed', blurb: 'Speed up or slow down (audio follows).', kind: 'ffmpeg', accepts: 'video', op: 'speed',
      fields: [{ k: 'factor', label: 'Factor', type: 'select', opts: ['0.25', '0.5', '0.75', '1.5', '2', '3', '4'], def: '2' }] },
    { id: 'boomerang', icon: '🔁', label: 'Boomerang', blurb: 'Forward then backward — a seamless loop.', kind: 'ffmpeg', accepts: 'video', op: 'boomerang', fields: [] },
    { id: 'loop', icon: '♾️', label: 'Loop', blurb: 'Repeat the clip N times.', kind: 'ffmpeg', accepts: 'video', op: 'loop',
      fields: [{ k: 'loops', label: 'Times', type: 'select', opts: ['2', '3', '4', '6', '8'], def: '3' }] },
    { id: 'trim', icon: '✂', label: 'Trim', blurb: 'Keep only a section (seconds).', kind: 'ffmpeg', accepts: 'video', op: 'trim',
      fields: [{ k: 'start', label: 'Start (s)', type: 'number', def: '0' }, { k: 'end', label: 'End (s, 0 = to end)', type: 'number', def: '0' }] },
    { id: 'reframe', icon: '📐', label: 'Reframe', blurb: 'Change aspect ratio — blurred-background fill, crop or letterbox.', kind: 'ffmpeg', accepts: 'video', op: 'reframe',
      fields: [{ k: 'aspect', label: 'Aspect', type: 'select', opts: ASPECT_CHOICES, def: '9:16' }, { k: 'fit', label: 'Fit', type: 'select', opts: ['blur', 'crop', 'black'], def: 'blur' }] },
    { id: 'mute', icon: '🔇', label: 'Mute', blurb: 'Strip the audio track.', kind: 'ffmpeg', accepts: 'video', op: 'mute', fields: [] },
    { id: 'gif', icon: '🖼', label: 'To GIF', blurb: '480 px looping GIF.', kind: 'ffmpeg', accepts: 'video', op: 'gif', fields: [] },
  ] },
  { group: 'Frames', items: [
    { id: 'first', icon: '⏮', label: 'First frame', blurb: 'Save the first frame as an image (new still / reference).', kind: 'ffmpeg', accepts: 'video', op: 'first_frame', asImage: true, fields: [] },
    { id: 'last', icon: '⏭', label: 'Last frame', blurb: 'Save the last frame — the start of the next shot when extending a clip.', kind: 'ffmpeg', accepts: 'video', op: 'last_frame', asImage: true, fields: [] },
  ] },
];

/** Video Lab: the finishing toolbox (upscale, interpolate, cutout, retime,
 * reframe, frames). Every result is added to the Gallery. */
export default function VideoLab({ assets, addAsset, incoming }) {
  // (inputs are remembered across a refresh, see useToolMemory below)
  const [source, setSource] = useState(null);       // {name, blob, url, isVideo}
  const [toolId, setToolId] = useState('upscale');
  const [vals, setVals] = useState({});
  const [models, setModels] = useState(null);
  const [run, setRun] = useState({ phase: 'idle', progress: 0, status: '', jobId: null, error: null });
  const [result, setResult] = useState(null);       // {url, isVideo, name}
  const [face, setFace] = useState(null);           // {blob, url} source face for Face swap
  const fileRef = useRef(null);
  const faceFileRef = useRef(null);

  const tool = TOOLS.flatMap((g) => g.items).find((t) => t.id === toolId);
  const busy = run.phase === 'run';

  useEffect(() => { toolModels().then(setModels); }, []);
  useEffect(() => { if (incoming?.asset) pick(incoming.asset); }, [incoming?.nonce]);

  const pick = (a) => {
    const isVideo = (a.mime || a.blob?.type || '').startsWith('video') || a.kind === 'video';
    setSource({ id: a.id, name: a.name, blob: a.blob, url: a.url || URL.createObjectURL(a.blob), isVideo });
    setResult(null); setRun((r) => ({ ...r, phase: 'idle', error: null }));
  };
  const pickUpload = (f) => { const isV = f.type.startsWith('video'); pick(addAsset(f, isV ? 'video' : 'image', f.name, { source: 'upload' })); };
  useToolMemory('lab', {
    toolId, vals, srcId: source?.id || null, faceId: face?.assetId || null, needs: [source?.id, face?.assetId].filter(Boolean),
  }, (sv, byId) => {
    if (sv.toolId) setToolId(sv.toolId);
    setVals(sv.vals || {});
    const fa = sv.faceId && byId.get(sv.faceId);
    if (fa) setFace({ blob: fa.blob, url: fa.url, assetId: fa.id });
    const sa = sv.srcId && byId.get(sv.srcId);
    if (sa) pick(sa);
  }, assets);
  const mediaAssets = assets.filter((a) => a.kind !== 'audio' && a.kind !== 'sketch');

  const fieldVal = (f) => vals[`${tool.id}.${f.k}`] ?? f.def ?? (f.type === 'model' ? '' : '');
  const accepts = !source || tool.accepts === 'both' || (tool.accepts === 'video') === source.isVideo;

  const apply = async () => {
    const fields = { ...(tool.fixed || {}) };
    tool.fields.forEach((f) => { fields[f.k] = fieldVal(f); });
    setRun({ phase: 'run', progress: 0, status: 'Working…', jobId: null, error: null });
    try {
      let blob, isVideo;
      if (tool.kind === 'ffmpeg') {
        blob = await runFfmpegTool(source.blob, tool.op, fields);
        isVideo = !tool.asImage && tool.op !== 'gif';
      } else {
        const res = await runComfyTool(tool.endpoint, source.blob, fields, (ev) => {
          if (ev.type === 'submitted') setRun((r) => ({ ...r, jobId: ev.jobId }));
          else if (ev.type === 'progress') setRun((r) => ({ ...r, progress: ev.max ? ev.value / ev.max : 0, status: `Processing ${ev.value}/${ev.max}` }));
          else if (ev.type === 'status') setRun((r) => ({ ...r, status: ev.text }));
        }, tool.needsFace ? { face: face.blob } : undefined);
        blob = await (await fetch(res.url)).blob();
        isVideo = (res.media || blob.type).startsWith('video');
      }
      const kind = tool.asImage || !isVideo ? 'image' : 'video';
      const asset = addAsset(blob, kind, `${source.name.replace(/\.[^.]+$/, '')} · ${tool.label}`, { source: 'tool', tool: tool.id });
      setResult({ url: asset.url, isVideo: kind === 'video', name: asset.name, asset });
      setRun((r) => ({ ...r, phase: 'done', status: 'Done' }));
    } catch (e) {
      setRun((r) => (e.message === 'Cancelled' ? { ...r, phase: 'idle' } : { ...r, phase: 'error', error: e.message }));
    }
  };

  const show = (u, isVideo) => (isVideo ? <video src={u} controls loop autoPlay muted /> : <img src={u} alt="" />);

  return (
    <div className="edit-studio video-lab">
      <div className="es-stage">
        {!source ? (
          <DropZone accept="both" icon="🧰" title="Drop a video or image to process" assets={assets}
            onFile={pickUpload} onAsset={(a) => pick(a)} />
        ) : (
          <div className="vl-compare">
            <figure><figcaption>Source</figcaption>{show(source.url, source.isVideo)}</figure>
            {result && <figure><figcaption>{tool.label}</figcaption>{show(result.url, result.isVideo)}
              <div className="row"><a className="dl" href={result.url} download={result.name}>⬇ Download</a>
                <button onClick={() => pick(result.asset)}>⛓ Use result as source</button></div></figure>}
          </div>
        )}
        {source && <div className="es-bar"><button onClick={() => fileRef.current?.click()}>Change file</button></div>}
        <input ref={fileRef} type="file" accept="video/*,image/*" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) pickUpload(f); e.target.value = ''; }} />
      </div>

      <div className="es-side glass gj-panel">
        <h3>Video Lab<small className="gj-count">pro finishing</small></h3>
        <div className="es-body">
        {TOOLS.map((g) => (
          <div key={g.group}>
            <div className="hint" style={{ marginTop: 8 }}>{g.group}</div>
            <div className="es-tools">
              {g.items.map((t) => (
                <button key={t.id} className={toolId === t.id ? 'active' : ''} disabled={busy} title={t.blurb}
                  onClick={() => setToolId(t.id)}><span>{t.icon}</span>{t.label}</button>
              ))}
            </div>
          </div>
        ))}
        <div className="hint">{tool.blurb}</div>
        {tool.needsFace && (
          <div>
            <label>Source face *</label>
            <div className="row">
              {face && <span className="ref-chip"><img src={face.url} alt="" /><button className="x" onClick={() => setFace(null)}>×</button></span>}
              <button disabled={busy} onClick={() => faceFileRef.current?.click()}>＋ Choose photo</button>
              {assets.some((a) => a.kind === 'character' || a.kind === 'image') && (
                <select value="" disabled={busy} onChange={(e) => { const a = assets.find((x) => x.id === e.target.value); if (a) setFace({ blob: a.blob, url: a.url, assetId: a.id }); }}>
                  <option value="">Gallery…</option>
                  {assets.filter((a) => a.kind === 'character' || a.kind === 'image').map((a) => <option key={a.id} value={a.id}>{a.meta?.name || a.name}</option>)}
                </select>
              )}
            </div>
            <input ref={faceFileRef} type="file" accept="image/*" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { const na = addAsset(f, 'image', f.name, { source: 'upload' }); setFace({ blob: f, url: na.url, assetId: na.id }); } e.target.value = ''; }} />
          </div>
        )}
        {tool.fields.map((f) => (
          <label key={f.k}>{f.label}
            {f.type === 'select' && (
              <select value={fieldVal(f)} disabled={busy} onChange={(e) => setVals((v) => ({ ...v, [`${tool.id}.${f.k}`]: e.target.value }))}>
                {f.opts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
            {f.type === 'number' && (
              <input type="number" step="0.1" min={f.min ?? 0} value={fieldVal(f)} disabled={busy}
                onChange={(e) => setVals((v) => ({ ...v, [`${tool.id}.${f.k}`]: e.target.value }))} />
            )}
            {f.type === 'text' && (
              <input type="text" value={fieldVal(f)} disabled={busy} onChange={(e) => setVals((v) => ({ ...v, [`${tool.id}.${f.k}`]: e.target.value }))} />
            )}
            {f.type === 'model' && (
              <select value={fieldVal(f)} disabled={busy} onChange={(e) => setVals((v) => ({ ...v, [`${tool.id}.${f.k}`]: e.target.value }))}>
                <option value="">auto</option>
                {(models?.[f.key] || []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
            {f.note && <span className="param-hint">{f.note}</span>}
          </label>
        ))}
        {source && !accepts && <div className="error">{tool.label} works on {tool.accepts === 'video' ? 'videos' : 'images'} only.</div>}
        </div>
        <div className="es-foot">
        <button className="primary" disabled={busy || !source || !accepts || (tool.needsFace && !face)} onClick={apply}>
          {busy ? 'Working…' : !source ? 'Pick a file first' : `${tool.icon} ${tool.label}`}
        </button>
        {busy && tool.kind === 'comfy' && (
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
