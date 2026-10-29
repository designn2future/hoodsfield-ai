import React, { useRef, useState } from 'react';
import GenProgress from './GenProgress.jsx';
import DropZone from './DropZone.jsx';
import { runFfmpegTool, generateFlux3, generateQwen21, runLipSync, cancelJob } from '../api.js';

const MAX_LEN = 7;     // MiniMax H3 makes up to about 7 seconds per clip

/** Swap & Perform: a clip + "who to replace" + a character in, a clip out where the character has taken that person's place and
 * performs the clip's own audio (rap, song, speech) with the lips in sync.
 *   1. cut the clip, grab its first frame      2. a full-body picture of the new person (their own look)
 *   3. Qwen swaps the WHOLE person into frame 1 (face, hair, body, clothes)
 *   4. MiniMax H3 lip-sync: the swapped picture + the clip's audio -> the new person performs it; the others stay quiet. */
export default function SwapPerform({ assets = [], addAsset }) {
  const characters = assets.filter((a) => a.kind === 'character');
  const [src, setSrc] = useState(null);                 // {blob, url, name, dur}
  const [who, setWho] = useState('');
  const [charId, setCharId] = useState('');
  const [photo, setPhoto] = useState(null);             // {blob, url} an uploaded photo instead of a character
  const [whole, setWhole] = useState(false);            // the uploaded photo already shows the whole person
  const [outfit, setOutfit] = useState('');
  const [start, setStart] = useState(0);
  const [mp, setMp] = useState(0.4);
  const [run, setRun] = useState({ phase: 'idle', stage: '', progress: 0, status: '', jobId: null, error: null });
  const [frames, setFrames] = useState(null);           // {before, swapped} previews
  const [result, setResult] = useState(null);
  const take = useRef(0);
  const cancelled = useRef(false);
  const fileRef = useRef(null);
  const busy = run.phase === 'run';

  const char = characters.find((c) => c.id === charId) || null;
  const person = photo?.blob || char?.blob || null;
  const len = src ? Math.max(2, Math.min(MAX_LEN, (src.dur || MAX_LEN) - start)) : MAX_LEN;

  const load = (blob, url, name) => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.src = url;
    v.onloadedmetadata = () => setSrc({ blob, url, name, dur: v.duration || 0 });
    v.onerror = () => setSrc({ blob, url, name, dur: 0 });
    setStart(0); setFrames(null); setResult(null);
  };

  const ev = (stage) => (e) => {
    if (e.type === 'submitted') setRun((r) => ({ ...r, jobId: e.jobId }));
    else if (e.type === 'progress') setRun((r) => ({ ...r, stage, progress: e.overall ?? (e.max ? e.value / e.max : 0), status: `${stage}…` }));
    else if (e.type === 'status') setRun((r) => ({ ...r, stage, status: e.text }));
  };

  const go = async (another = false) => {
    if (!src || !person) return;
    cancelled.current = false;
    if (another) take.current += 1;
    const seed = 4242 + take.current * 7919;
    setResult(null); setFrames(null);
    const stage = (s) => setRun({ phase: 'run', stage: s, progress: 0, status: `${s}…`, jobId: null, error: null });
    try {
      stage('Cutting the clip');
      const clip = await runFfmpegTool(new File([src.blob], 'source.mp4', { type: src.blob.type || 'video/mp4' }), 'trim', { start: start.toFixed(2), end: (start + len).toFixed(2) });
      const frame = await runFfmpegTool(clip, 'first_frame', {});

      // the new person, head to toe, in their own clothes (a ready full-body view is reused when they have one and no outfit was asked for)
      let body = null;
      if (photo && whole) body = photo.blob;
      else if (char && !outfit.trim()) {
        body = (char.meta?.refIds || []).map((id) => assets.find((a) => a.id === id)).filter(Boolean).find((a) => /^Full body/i.test(a.meta?.view || ''))?.blob || null;
      }
      if (!body) {
        stage('Dressing the new person');
        const wear = outfit.trim() || 'a simple, well-fitting casual outfit that suits the scene';
        const res = await generateFlux3({
          prompt: `Show the exact same person from image 1 as a full-body photograph, standing relaxed from head to toe, wearing ${wear}, in front of a plain light-grey studio background with soft even lighting. Keep their face, hair, skin tone and age identical to image 1.`,
          width: 768, height: 1152, steps: 8, cfg: 1, seed,
        }, [person], [], [], ev('Dressing the new person'));
        body = await (await fetch(res.url)).blob();
      }
      if (cancelled.current) throw new Error('Cancelled');

      stage('Swapping the person in');
      const target = who.trim() || 'main person';
      const swapPrompt = `Edit image 1: replace the ENTIRE ${target} (their face, hair, head wear, glasses, body, arms, tattoos and clothes) with the person from image 2: their face, hair, body and clothes. The new person stands in exactly the same place and at the same size as the person they replace, with the same head direction, gaze and body pose, mouth slightly open as if performing. Leave everyone else, the objects, the camera angle, the lighting and the background exactly as they are in image 1.`;
      const sres = await generateQwen21({ prompt: swapPrompt, steps: 25, cfg: 1, match_ref_size: true, seed }, [frame, body], [], ev('Swapping the person in'));
      const swapped = await (await fetch(sres.url)).blob();
      setFrames({ before: URL.createObjectURL(frame), swapped: URL.createObjectURL(swapped) });
      if (cancelled.current) throw new Error('Cancelled');

      stage('Performing the audio');
      const direction = `The person who was just swapped in (${target}) performs the audio: clear, accurate mouth shapes on every word, an expressive face, natural head and hand movements in time with the sound. Everyone else in the frame does not speak or sing: their mouths stay closed or in a small smile as they listen and move along. The camera is locked off.`;
      const lres = await runLipSync(swapped, new File([clip], 'clip.mp4', { type: 'video/mp4' }), { prompt: direction, megapixels: mp, seed: -1, max_seconds: len }, ev('Performing the audio'));
      const blob = await (await fetch(lres.url)).blob();
      const asset = addAsset(blob, 'video', `${src.name.replace(/\.[^.]+$/, '')} · swap & perform`, { source: 'swap-perform', seed: lres.seed });
      setResult({ url: asset.url });
      setRun((r) => ({ ...r, phase: 'done', status: 'Done' }));
    } catch (e) { setRun((r) => ({ ...r, phase: e.message === 'Cancelled' ? 'idle' : 'error', error: e.message })); }
  };

  const stop = () => { cancelled.current = true; if (run.jobId) cancelJob(run.jobId); };

  return (
    <div className="edit-studio video-lab">
      <div className="es-stage">
        {!src ? (
          <DropZone accept="video" icon="🎤" title="Drop the clip with the performance" hint="A clip with sound where someone sings, raps or talks. Up to about 7 seconds is used."
            assets={assets} onFile={(f) => load(f, URL.createObjectURL(f), f.name)} onAsset={(a) => load(a.blob, a.url || URL.createObjectURL(a.blob), a.name)} />
        ) : (
          <div className="vl-compare">
            <figure><figcaption>Your clip</figcaption><video src={src.url} controls loop playsInline /></figure>
            <figure><figcaption>{result ? 'Swapped and performing' : frames ? 'The new person in frame 1' : 'Result appears here'}</figcaption>
              {result ? <video src={result.url} controls loop autoPlay playsInline />
                : frames ? <img src={frames.swapped} alt="swapped frame" /> : <div className="es-empty" style={{ padding: 40 }}>—</div>}
              {result && <div className="row"><a className="dl" href={result.url} download="swap_and_perform.mp4">⬇ Download</a></div>}
            </figure>
          </div>
        )}
        {src && <div className="es-bar"><button disabled={busy} onClick={() => { setSrc(null); setFrames(null); setResult(null); }}>Change clip</button></div>}
      </div>

      <div className="es-side glass gj-panel">
        <h3>Swap &amp; Perform<small className="gj-count">MiniMax H3</small></h3>
        <div className="es-body">
          <div className="hint">Replace a person in a clip with your character, and have them perform the clip's own audio with their lips in sync. About 10 to 12 minutes.</div>

          <label>Who to replace *
            <input type="text" value={who} disabled={busy} onChange={(e) => setWho(e.target.value)} placeholder="e.g. the man on the left in the yellow cap" />
          </label>

          <label>The new person *</label>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {characters.map((c) => (
              <button key={c.id} className={charId === c.id && !photo ? 'active' : ''} disabled={busy} onClick={() => { setCharId(c.id); setPhoto(null); }}>{c.meta?.name || c.name}</button>
            ))}
            <button className={photo ? 'active' : ''} disabled={busy} onClick={() => fileRef.current?.click()}>{photo ? '✓ Your photo' : '＋ Upload a photo'}</button>
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) { setPhoto({ blob: f, url: URL.createObjectURL(f) }); setCharId(''); } e.target.value = ''; }} />
          {!characters.length && !photo && <div className="hint">No characters yet: make one in Characters, or upload a photo.</div>}
          {photo && <label className="gj-check"><input type="checkbox" checked={whole} disabled={busy} onChange={(e) => setWhole(e.target.checked)} /> This photo already shows the whole person</label>}

          <label>What they wear <span className="param-hint">optional</span>
            <input type="text" value={outfit} disabled={busy || (photo && whole)} onChange={(e) => setOutfit(e.target.value)} placeholder="e.g. a white t-shirt, jeans and white sneakers" />
          </label>

          <div className="grid2">
            <label>Start at (s)
              <input type="number" min="0" max={Math.max(0, (src?.dur || 0) - 2)} step="0.5" value={start} disabled={busy || !src} onChange={(e) => setStart(Math.max(0, +e.target.value || 0))} />
            </label>
            <label>Quality
              <select value={mp} disabled={busy} onChange={(e) => setMp(+e.target.value)}>
                <option value={0.4}>Standard</option><option value={0.5}>High (slower)</option><option value={0.8}>Best (slowest, for small faces)</option>
              </select>
            </label>
          </div>
          {src && <div className="hint">Uses {len.toFixed(1)} seconds of the clip, starting at {start.toFixed(1)} s.</div>}

          {busy && <GenProgress progress={run.progress} status={`${run.stage ? run.stage + ': ' : ''}${run.status}`} />}
          {run.error && <div className="error">{run.error}</div>}
          {frames && !result && busy && <div className="hint">Frame 1 is ready (left picture). If the swap looks wrong, press Stop and try another take.</div>}
        </div>
        <div className="es-foot">
          <button className="primary" disabled={busy || !src || !person} onClick={() => go(false)}>{busy ? 'Working…' : result ? '🎤 Run it again' : '🎤 Swap & perform'}</button>
          {busy && <button className="cancel-btn" onClick={stop}>✕ Stop</button>}
          {!busy && (result || frames) && <button onClick={() => go(true)}>🎲 Another take</button>}
        </div>
      </div>
    </div>
  );
}
