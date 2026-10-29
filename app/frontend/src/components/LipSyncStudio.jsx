import GenProgress from './GenProgress.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { runLipSync, runFfmpegMux, cancelJob, speakText } from '../api.js';
import DropZone from './DropZone.jsx';
import { useToolMemory } from '../toolMemory.js';

const DEFAULT_PROMPT = 'A person speaks naturally to the camera, clear lip movements in sync with the speech, subtle head motion and natural expressions.';

/** Lip-sync Studio: a face still + a speech clip -> a talking video. The speech is encoded into
 * LTX 2.3's audio latent and frozen, so the joint audio-video model generates matching lips. */
export default function LipSyncStudio({ assets, addAsset, incoming }) {
  const [image, setImage] = useState(null);       // {name, blob, url}
  const [audio, setAudio] = useState(null);       // {name, blob, url, dur}
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [mp, setMp] = useState(0.3);
  const [seed, setSeed] = useState(-1);
  const [rec, setRec] = useState({ on: false, secs: 0 });
  const [run, setRun] = useState({ phase: 'idle', progress: 0, status: '', jobId: null, error: null });
  const [result, setResult] = useState(null);
  const audioFile = useRef(null);
  const [line, setLine] = useState('');
  const [speaking, setSpeaking] = useState('');     // status text while the character's voice is being made
  // the face may be the character itself or one of its sheet views: either way its voice is known
  const picked = image ? assets.find((a) => a.id === image.id) : null;
  const speaker = picked?.kind === 'character' ? picked : (picked?.meta?.characterId ? assets.find((a) => a.id === picked.meta.characterId) : null);
  const speakerVoice = speaker?.meta?.voice || '';
  const sayIt = async () => {
    setSpeaking('Starting the voice…');
    try {
      const { blob } = await speakText(line.trim(), speakerVoice, setSpeaking);
      setAudioBlob(blob, `${speaker.meta?.name || speaker.name} · ${line.trim().slice(0, 24)}.wav`);
    } catch (e) { setRun((r) => ({ ...r, phase: 'error', error: e.message })); }
    setSpeaking('');
  };
  const recRef = useRef(null);
  const timer = useRef(null);
  const busy = run.phase === 'run';

  useEffect(() => { if (incoming?.asset) pickImage(incoming.asset); }, [incoming?.nonce]);

  const pickImage = (a) => { setImage({ id: a.id, name: a.name, blob: a.blob, url: a.url || URL.createObjectURL(a.blob) }); setResult(null); };
  const pickImageUpload = (f) => pickImage(addAsset(f, 'image', f.name, { source: 'upload' }));
  useToolMemory('lipsync', { prompt, mp, seed, imgId: image?.id || null, audId: audio?.id || null, needs: [image?.id, audio?.id].filter(Boolean) }, (sv, byId) => {
    if (sv.prompt) setPrompt(sv.prompt);
    if (sv.mp != null) setMp(sv.mp);
    if (sv.seed != null) setSeed(sv.seed);
    const ia = sv.imgId && byId.get(sv.imgId);
    if (ia) pickImage(ia);
    const aa = sv.audId && byId.get(sv.audId);
    if (aa) setAudioBlob(aa.blob, aa.name, aa.id);
  }, assets);
  const setAudioBlob = (blob, name, id = null) => {
    if (!id) { try { id = addAsset(blob, 'audio', name || 'speech', { source: 'upload' }).id; } catch { /* not remembered */ } }   // joins the Gallery so a refresh can bring it back
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.onloadedmetadata = () => setAudio({ id, name, blob, url, dur: a.duration });
    a.onerror = () => setAudio({ id, name, blob, url, dur: null });
    setResult(null);
  };

  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(timer.current);
        setRec({ on: false, secs: 0 });
        setAudioBlob(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }), 'recording.webm');
      };
      recRef.current = mr; mr.start();
      setRec({ on: true, secs: 0 });
      timer.current = setInterval(() => setRec((r) => { if (r.secs >= 7) { mr.stop(); return r; } return { ...r, secs: r.secs + 1 }; }), 1000);
    } catch (e) { setRun((r) => ({ ...r, phase: 'error', error: `Microphone unavailable: ${e.message}` })); }
  };
  const stopRec = () => recRef.current?.stop();

  const go = async () => {
    setRun({ phase: 'run', progress: 0, status: 'Submitting…', jobId: null, error: null });
    try {
      const res = await runLipSync(image.blob, audio.blob, { prompt, megapixels: mp, seed, max_seconds: 6, ...(mp >= 0.75 ? { quality: true } : {}) }, (ev) => {
        if (ev.type === 'submitted') setRun((r) => ({ ...r, jobId: ev.jobId }));
        else if (ev.type === 'progress') setRun((r) => ({ ...r, progress: ev.max ? ev.value / ev.max : 0, status: `Sampling ${ev.value}/${ev.max}` }));
        else if (ev.type === 'status') setRun((r) => ({ ...r, status: ev.text }));
      });
      let blob = await (await fetch(res.url)).blob();
      try { blob = await runFfmpegMux(blob, audio.blob); } catch { /* keep the model's own audio */ }
      const asset = addAsset(blob, 'video', `${image.name.replace(/\.[^.]+$/, '')} · talking`, { source: 'lipsync', seed: res.seed });
      setResult({ url: asset.url });
      setRun((r) => ({ ...r, phase: 'done', status: 'Done' }));
    } catch (e) { setRun((r) => ({ ...r, phase: e.message === 'Cancelled' ? 'idle' : 'error', error: e.message })); }
  };

  return (
    <div className="edit-studio video-lab">
      <div className="es-stage">
        {!image ? (
          <DropZone accept="image" icon="🗣️" title="Drop the face to animate" hint="A clear, front-facing portrait works best" assets={assets}
            onFile={pickImageUpload} onAsset={(a) => pickImage(a)} />
        ) : (
          <div className="vl-compare">
            <figure><figcaption>Face</figcaption><img src={image.url} alt="" /></figure>
            <figure><figcaption>{result ? 'Talking result' : 'Result appears here'}</figcaption>
              {result ? <video src={result.url} controls loop autoPlay /> : <div className="es-empty" style={{ padding: 40 }}>—</div>}
              {result && <div className="row"><a className="dl" href={result.url} download="talking.mp4">⬇ Download</a></div>}
            </figure>
          </div>
        )}
        {image && <div className="es-bar"><button onClick={() => setImage(null)}>Change face</button></div>}
      </div>

      <div className="es-side glass gj-panel">
        <h3>Lip-sync Studio<small className="gj-count">MiniMax H3 · your voice</small></h3>
        <div className="es-body">
        <div className="hint">Give it a face and some speech. The voice is fed into MiniMax H3, which makes the face and the sound together, so the mouth follows the words. Characters with a voice can speak a typed line.</div>

        <label>Speech *</label>
        {speakerVoice && (
          <>
            <textarea rows={3} value={line} disabled={busy || !!speaking} onChange={(e) => setLine(e.target.value)}
              placeholder={`Type what ${speaker.meta?.name || speaker.name} says (up to about 15 words fits the 6 seconds)…`} />
            <button disabled={busy || !!speaking || !line.trim()} onClick={sayIt}>{speaking ? `⏳ ${speaking}` : `🎙 Say it in ${speaker.meta?.name || speaker.name}'s voice`}</button>
            <div className="hint">Or add your own audio below.</div>
          </>
        )}
        {assets.some((a) => a.kind === 'audio') && (
          <label>Or pick a voice from your Gallery
            <select value="" disabled={busy} onChange={(e) => { const a = assets.find((x) => x.id === e.target.value); if (a) setAudioBlob(a.blob, a.name, a.id); }}>
              <option value="">Choose…</option>
              {assets.filter((a) => a.kind === 'audio').slice().reverse().map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
        <div className="row">
          <button disabled={busy || rec.on} onClick={() => audioFile.current?.click()}>＋ Audio file</button>
          {!rec.on
            ? <button disabled={busy} onClick={startRec}>🎙 Record</button>
            : <button className="danger" onClick={stopRec}>■ Stop ({rec.secs}s)</button>}
        </div>
        <input ref={audioFile} type="file" accept="audio/*,video/*" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) setAudioBlob(f, f.name); e.target.value = ''; }} />
        {audio && (
          <div className="audio-chip">
            <audio src={audio.url} controls />
            <span className="hint">{audio.name}{audio.dur ? ` · ${audio.dur.toFixed(1)} s` : ''}{audio.dur > 6 ? ' — only the first 6 s are used' : ''}</span>
          </div>
        )}

        <label>Direction</label>
        <textarea rows={4} value={prompt} disabled={busy} onChange={(e) => setPrompt(e.target.value)} />
        <div className="grid2">
          <label>Resolution
            <select value={mp} disabled={busy} onChange={(e) => setMp(+e.target.value)}>
              <option value={0.2}>Draft 0.2 MP</option><option value={0.3}>Standard 0.3 MP</option><option value={0.45}>High 0.45 MP</option><option value={0.8}>Best 0.8 MP (slower; for small faces)</option>
            </select>
          </label>
          <label>Seed (−1 = rnd)
            <input type="number" value={seed} disabled={busy} onChange={(e) => setSeed(+e.target.value)} />
          </label>
        </div>
        </div>
        <div className="es-foot">
        <button className="primary" disabled={busy || !image || !audio} onClick={go}>
          {busy ? 'Animating…' : !image ? 'Add a face first' : !audio ? 'Add speech first' : '🗣️ Make it talk'}
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
