import GenProgress from './GenProgress.jsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cancelJob } from '../api.js';

const SAMPLE = "It was two fourteen in the morning when the three lights appeared over the ridge. They did not move like stars. I told myself it was nothing. But then the whole field went silent, and something above us began to hum.";

const TIPS = [
  'Write numbers and times as you want them spoken: "two fourteen", not "2:14". Common ones are converted for you.',
  'Short sentences sound more human. Use a full stop where you would breathe.',
  'For horror, lower the pace slider and raise expressiveness a little; for hype, do the opposite.',
  'A clean 8–15 second reference with no music and no room echo clones best.',
];

async function postForm(url, fd) {
  const r = await fetch(url, { method: 'POST', body: fd });
  if (!r.ok) {
    let d = await r.text();
    try { d = JSON.parse(d).detail || d; } catch { /* keep text */ }
    throw new Error(d);
  }
  return r.json();
}

/** Voiceover: Chatterbox (local, MIT) with voice cloning. Result goes to the Gallery / Timeline / Lip-sync. */
export default function VoiceStudio({ active, addAsset, onUseInTimeline, characters = [] }) {
  const [voices, setVoices] = useState([]);
  const [voice, setVoice] = useState('');
  const [text, setText] = useState(SAMPLE);
  const [exag, setExag] = useState(0.5);
  const [pace, setPace] = useState(0.5);
  const [seed, setSeed] = useState(0);
  const [device, setDevice] = useState('auto');
  const [status, setStatus] = useState(null);
  const [run, setRun] = useState({ phase: 'idle', status: '', progress: 0, jobId: null, error: null });
  const [results, setResults] = useState([]);   // {url, blob, name, device, text}
  const [rec, setRec] = useState({ on: false, secs: 0 });
  const [newName, setNewName] = useState('');
  const fileRef = useRef(null);
  const recRef = useRef(null);
  const timer = useRef(null);
  const prev = useRef(null);
  const busy = run.phase === 'run';

  const loadVoices = useCallback(async () => {
    try {
      const d = await (await fetch('/api/tts/voices')).json();
      setVoices(d.voices || []);
      setVoice((v) => v || (d.voices?.[0]?.id ?? ''));
    } catch { /* backend offline */ }
  }, []);
  const loadStatus = useCallback(async () => {
    try { setStatus(await (await fetch('/api/tts/status')).json()); } catch { setStatus(null); }
  }, []);
  useEffect(() => { if (active) { loadVoices(); loadStatus(); } }, [active, loadVoices, loadStatus]);

  const preview = (id) => {
    prev.current?.pause();
    prev.current = new Audio(`/api/tts/voices/${encodeURIComponent(id)}/audio`);
    prev.current.play().catch(() => {});
  };

  const addVoice = async (blob, name) => {
    try {
      const fd = new FormData();
      fd.append('name', name || 'My voice');
      fd.append('file', blob, blob.name || 'voice.webm');
      const r = await postForm('/api/tts/voices', fd);
      await loadVoices();
      setVoice(r.id);
      setNewName('');
    } catch (e) { setRun((x) => ({ ...x, error: e.message })); }
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
        addVoice(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }), newName || 'My recording');
      };
      recRef.current = mr; mr.start();
      setRec({ on: true, secs: 0 });
      timer.current = setInterval(() => setRec((r) => { if (r.secs >= 14) { mr.stop(); return r; } return { ...r, secs: r.secs + 1 }; }), 1000);
    } catch (e) { setRun((x) => ({ ...x, phase: 'error', error: `Microphone unavailable: ${e.message}` })); }
  };

  const go = async () => {
    setRun({ phase: 'run', status: 'Submitting…', progress: 0, jobId: null, error: null });
    try {
      const fd = new FormData();
      fd.append('text', text); fd.append('voice', voice); fd.append('exaggeration', exag);
      fd.append('cfg_weight', pace); fd.append('seed', seed); fd.append('device', device);
      const { job_id } = await postForm('/api/tts/speak', fd);
      setRun((r) => ({ ...r, jobId: job_id }));
      await new Promise((resolve, reject) => {
        const es = new EventSource(`/api/events/${job_id}`);
        es.onmessage = (e) => {
          const ev = JSON.parse(e.data);
          if (ev.type === 'status') setRun((r) => ({ ...r, status: ev.text }));
          else if (ev.type === 'progress') setRun((r) => ({ ...r, progress: ev.max ? ev.value / ev.max : 0 }));
          else if (ev.type === 'done') { es.close(); resolve(); }
          else if (ev.type === 'error') { es.close(); reject(new Error(ev.text)); }
        };
        es.onerror = () => { es.close(); reject(new Error('Lost connection to backend')); };
      });
      const blob = await (await fetch(`/api/tts/audio/${job_id}`)).blob();
      const url = URL.createObjectURL(blob);
      const vname = voices.find((v) => v.id === voice)?.name || 'voice';
      setResults((r) => [{ url, blob, name: `${vname} · ${text.slice(0, 28)}`, text, job: job_id }, ...r]);
      setRun({ phase: 'done', status: 'Done', progress: 1, jobId: null, error: null });
      loadStatus();
    } catch (e) {
      setRun((r) => ({ ...r, phase: e.message === 'Cancelled' ? 'idle' : 'error', error: e.message }));
    }
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const mine = voices.filter((v) => v.source === 'yours');
  const lib = voices.filter((v) => v.source === 'library');
  const VoiceRow = ({ v }) => (
    <div className={`vo-row ${voice === v.id ? 'on' : ''}`} onClick={() => setVoice(v.id)}>
      <button className="vo-play" onClick={(e) => { e.stopPropagation(); preview(v.id); }} title="Preview this voice">▶</button>
      <span className="vo-name">{v.name}</span><span className="vo-sec">{v.seconds ? `${v.seconds}s` : ''}</span>
    </div>
  );

  return (
    <div className="edit-studio vo">
      <div className="es-stage vo-stage">
        <div className="vo-hero">
          <span className="eyebrow">Voiceover · Chatterbox · local</span>
          <h2>Give your film a <em>voice that doesn't sound like a robot.</em></h2>
        </div>
        <textarea className="vo-script" value={text} disabled={busy} onChange={(e) => setText(e.target.value)} placeholder="Write the narration…" rows={7} />
        <div className="vo-meta"><span>{words} words</span><span>≈ {Math.max(1, Math.round(words / 2.6))} s of speech</span></div>

        {results.length > 0 && (
          <div className="vo-results">
            {results.map((r) => (
              <div key={r.job} className="vo-result">
                <div className="vo-rt">{r.name}</div>
                <audio src={r.url} controls />
                <div className="row">
                  <button onClick={() => addAsset(r.blob, 'audio', r.name.slice(0, 40), { source: 'voice', text: r.text })}>＋ Gallery</button>
                  <button onClick={() => { const a = addAsset(r.blob, 'audio', r.name.slice(0, 40), { source: 'voice', text: r.text }); onUseInTimeline?.(a); }}>🎬 Add to timeline</button>
                  <a className="dl" href={r.url} download="voiceover.wav">⬇ Download</a>
                </div>
              </div>
            ))}
          </div>
        )}
        <ul className="vo-tips">{TIPS.map((t) => <li key={t}>{t}</li>)}</ul>
      </div>

      <div className="es-side glass">
        <h3>Voice</h3>
        <div className="hint">Pick a reference voice (it clones the sound from a short clean sample), write the line, generate.</div>
        {characters.some((c) => c.meta?.voice) && (
          <>
            <label>Speak as <span className="param-hint">your characters</span></label>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {characters.filter((c) => c.meta?.voice).map((c) => (
                <button key={c.id} className={voice === c.meta.voice ? 'active' : ''} onClick={() => setVoice(c.meta.voice)} title={`Use ${c.meta?.name || c.name}'s voice`}>{c.meta?.name || c.name}</button>
              ))}
            </div>
          </>
        )}
        {mine.length > 0 && <><label>Your voices</label><div className="vo-list">{mine.map((v) => <VoiceRow key={v.id} v={v} />)}</div></>}
        <label>Library ({lib.length})</label>
        <div className="vo-list tall">{lib.map((v) => <VoiceRow key={v.id} v={v} />)}</div>

        <label>Add a voice</label>
        <input type="text" placeholder="Name it (e.g. Narrator)" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <div className="row">
          <button disabled={busy || rec.on} onClick={() => fileRef.current?.click()}>＋ Audio file</button>
          {!rec.on ? <button disabled={busy} onClick={startRec}>🎙 Record</button>
            : <button className="danger" onClick={() => recRef.current?.stop()}>■ Stop ({rec.secs}s)</button>}
        </div>
        <input ref={fileRef} type="file" accept="audio/*,video/*" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) addVoice(f, newName || f.name.replace(/\.[^.]+$/, '')); e.target.value = ''; }} />

        <div className="grid2">
          <label>Expressiveness — {exag.toFixed(2)}
            <input type="range" min={0.25} max={1} step={0.05} value={exag} disabled={busy} onChange={(e) => setExag(+e.target.value)} />
          </label>
          <label>Pace — {pace.toFixed(2)}
            <input type="range" min={0.2} max={0.8} step={0.05} value={pace} disabled={busy} onChange={(e) => setPace(+e.target.value)} />
            <span className="param-hint">Lower = slower, more deliberate.</span>
          </label>
        </div>
        <div className="grid2">
          <label>Seed (0 = random)<input type="number" value={seed} disabled={busy} onChange={(e) => setSeed(+e.target.value)} /></label>
          <label>Run on
            <select value={device} disabled={busy} onChange={(e) => setDevice(e.target.value)}>
              <option value="auto">Auto (GPU if free)</option><option value="cuda">GPU</option><option value="cpu">CPU (slow, never blocks ComfyUI)</option>
            </select>
          </label>
        </div>
        <button className="primary" disabled={busy || !voice || !text.trim()} onClick={go}>{busy ? 'Speaking…' : '🎙 Generate voiceover'}</button>
        {busy && (
          <GenProgress progress={run.progress || 0} status={run.status} onCancel={() => cancelJob(run.jobId)} cancelDisabled={!run.jobId} />
        )}
        {run.error && <div className="error">{run.error}</div>}
        {status && (
          <div className="hint">Engine: {!status.installed ? 'not installed' : status.running ? `running${status.loaded ? ` · model on ${status.device}` : ' · idle'}` : 'starts on first use'}
            {status.running && status.loaded && <> · <button className="link" onClick={() => fetch('/api/tts/unload', { method: 'POST' }).then(loadStatus)}>free VRAM</button></>}
          </div>
        )}
      </div>
    </div>
  );
}
