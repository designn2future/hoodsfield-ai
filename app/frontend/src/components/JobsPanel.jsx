import GenProgress from './GenProgress.jsx';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { cancelJob } from '../api.js';

const KIND_META = {
  'image-flux3': ['⚡', 'Flux 3 image'], 'image-flux3-edit': ['🪄', 'Flux 3 edit'], 'image-krea2': ['🖼️', 'Krea 2 image'],
  'video-wan': ['🎞️', 'Wan video'], 'video-h3': ['🎬', 'H3 video'], 'video-ltx': ['🎬', 'LTX video'], 'video-genjutsu': ['🌀', 'Genjutsu'],
  'video-long': ['🎥', 'Long shot'], 'video-control': ['🎯', 'Motion control'], 'video-lipsync': ['🗣️', 'Lip-sync'],
  'tool-upscale': ['🔍', 'Upscale'], 'tool-interpolate': ['🎞️', 'Interpolate'], 'tool-cutout': ['✂️', 'Cutout'], 'tool-faceswap': ['🎭', 'Face swap'],
  'image-qwen21': ['✦', 'Qwen Image 2.1'], 'image-qwen21-edit': ['✦', 'Qwen 2.1 edit'],
  'audio-voice': ['🎙️', 'Voiceover'],
  'prompt-upsample': ['🧠', 'Prompt upsample'], other: ['⚙️', 'Job'],
};
const FAMILY_COLOR = { qwen21: '#a78bfa', voice: '#ffb347', flux3: '#14e8ff', wan: '#45c4ff', ltx: '#8b7bff', h3: '#ff6b6b', krea2: '#ff9ad5', tools: '#34f5c5', composite: '#ff4df0', other: '#8b93a3' };

const fmtDur = (s) => (s == null ? '' : s < 90 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
const ago = (t) => { const d = Date.now() / 1000 - t; return d < 60 ? 'just now' : d < 3600 ? `${Math.floor(d / 60)} min ago` : d < 86400 ? `${Math.floor(d / 3600)} h ago` : `${Math.floor(d / 86400)} d ago`; };

/** Jobs & history: everything the studio has rendered, with live progress, thumbnails and a
 * model-aware view of ComfyUI's queue (every model change costs minutes on this GPU, so the
 * panel warns when pending work will thrash between families). */
export default function JobsPanel({ active, onUseJob, onCount }) {
  const [jobs, setJobs] = useState([]);
  const [queue, setQueue] = useState({ running: [], pending: [] });
  const [filter, setFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('');
  const [err, setErr] = useState('');
  const queueOp = async (url, form) => {
    try {
      const fd = new FormData();
      Object.entries(form || {}).forEach(([k, v]) => fd.append(k, v));
      const r = await fetch(url, { method: 'POST', body: fd });
      if (!r.ok) throw new Error(await r.text());
      setQueue(await (await fetch('/api/queue')).json());
    } catch (e) { setErr(e.message); }
  };

  const load = useCallback(async () => {
    try {
      const [j, q] = await Promise.all([fetch('/api/jobs?limit=150').then((r) => r.json()), fetch('/api/queue').then((r) => r.json()).catch(() => null)]);
      setJobs(j.jobs || []);
      if (q && Array.isArray(q.running) && Array.isArray(q.pending)) setQueue(q);   // an error body (ComfyUI busy) must not replace the queue shape and blank the app
      onCount?.((j.jobs || []).filter((x) => x.status === 'running').length);
      setErr('');
    } catch (e) { setErr('Backend not reachable'); }
  }, [onCount]);

  useEffect(() => {
    load();
    const t = setInterval(load, active ? 2000 : 7000);
    return () => clearInterval(t);
  }, [active, load]);

  const visible = useMemo(() => jobs.filter((j) => {
    if (filter === 'running' && j.status !== 'running') return false;
    if (filter === 'done' && j.status !== 'done') return false;
    if (filter === 'error' && !['error', 'interrupted', 'cancelled'].includes(j.status)) return false;
    if (kindFilter && !j.kind?.startsWith(kindFilter)) return false;
    return true;
  }), [jobs, filter, kindFilter]);

  // pending work that alternates between model families = repeated multi-GB reloads over the x1 link
  const pend = queue.pending.map((p) => p.family).filter(Boolean);
  const swaps = pend.reduce((n, f, i) => n + (i > 0 && f !== pend[i - 1] ? 1 : 0), 0);

  const remove = async (id) => { await fetch(`/api/jobs/${id}`, { method: 'DELETE' }); load(); };
  const clear = async () => { await fetch('/api/jobs/clear', { method: 'POST' }); load(); };
  const stop = async (id) => { try { await cancelJob(id); } catch { /* already finished */ } setTimeout(load, 600); };

  const counts = { running: jobs.filter((j) => j.status === 'running').length, done: jobs.filter((j) => j.status === 'done').length };

  return (
    <div className="jobs-page">
      <div className="jobs-head">
        <div className="jobs-title"><span className="jobs-ico">📋</span><div><h2>Jobs &amp; history<em>Node graph</em></h2><p>Live ComfyUI queue, batch progress and every rendered output.</p></div></div>
        <div className="chips">
          {[['all', `All (${jobs.length})`], ['running', `Running (${counts.running})`], ['done', `Done (${counts.done})`], ['error', 'Failed / stopped']].map(([k, label]) => (
            <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{label}</button>
          ))}
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All kinds</option><option value="image">Images</option><option value="video">Videos</option><option value="tool">Tools</option>
          </select>
          <button onClick={clear} title="Forget finished, failed and stopped jobs (ComfyUI keeps its output files)">Clear finished</button>
        </div>
      </div>
      {err && <div className="error">{err}</div>}

      {(queue.running.length > 0 || queue.pending.length > 0) && (
        <div className="queue-box">
          <b>ComfyUI queue</b>
          <div className="queue-row">
            {queue.running.map((q) => <span key={q.prompt_id} className="q-chip run" style={{ '--c': FAMILY_COLOR[q.family] || FAMILY_COLOR.other }}>▶ {q.title?.slice(0, 34) || 'running'}</span>)}
            {queue.pending.map((q, i) => <span key={q.prompt_id} className="q-chip" style={{ '--c': FAMILY_COLOR[q.family] || FAMILY_COLOR.other }}>{i + 1}. {q.title?.slice(0, 30) || q.kind || 'job'}{i > 0 && <button className="q-up" title="Run this next" onClick={() => queueOp('/api/queue/prioritize', { prompt_id: q.prompt_id })}>▲</button>}</span>)}
          </div>
          {swaps > 0 && <div className="hint">⚠ {swaps} model change{swaps > 1 ? 's' : ''} in the pending queue. Each swap re-streams several GB over the PCIe x1 link (minutes). Grouping same-model jobs together is much faster. <button className="q-group" onClick={() => queueOp('/api/queue/optimize')}>⇅ Group by model</button></div>}
        </div>
      )}

      <div className="jobs-sec"><span>Render history</span><small>{visible.length} job{visible.length === 1 ? '' : 's'}</small></div>
      <div className="jobs-list">
        {visible.map((j) => {
          const [icon, label] = KIND_META[j.kind] || KIND_META.other;
          const dur = j.finished && j.started ? j.finished - j.started : j.started && j.status === 'running' ? Date.now() / 1000 - j.started : null;
          return (
            <div key={j.id} className={`job-card st-${j.status}`}>
              <div className="job-thumb">
                {j.status === 'done' && !String(j.kind).startsWith('audio') ? <img src={`/api/jobs/${j.id}/thumb`} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : <span>{icon}</span>}
              </div>
              <div className="job-body">
                {j.status === 'running' && <span className="job-live"><i />Running now</span>}
                <div className="job-title">{j.title || label}</div>
                <div className="job-meta">
                  <span className="kind" style={{ '--c': FAMILY_COLOR[j.family] || FAMILY_COLOR.other }}>{icon} {label}</span>
                  <span className={`st st-${j.status}`}>{j.status}</span>
                  {dur != null && <span>{fmtDur(dur)}</span>}
                  {j.created && <span className="dim">{ago(j.created)}</span>}
                </div>
                {j.status === 'running' && (
                  <GenProgress progress={j.progress || 0} status={j.status_text || 'Working…'} />
                )}
                {j.error && j.status !== 'done' && <div className="job-err">{j.error}</div>}
              </div>
              <div className="job-actions">
                {j.status === 'running' && <button onClick={() => stop(j.id)}>✕ Stop</button>}
                {j.status === 'done' && <button onClick={() => onUseJob(j)} title="Add this result to the Gallery">＋ Gallery</button>}
                {j.status === 'done' && <a className="dl" href={`/api/jobs/${j.id}/media`} download>⬇</a>}
                {j.status !== 'running' && <button onClick={() => remove(j.id)} title="Forget this job">🗑</button>}
              </div>
            </div>
          );
        })}
        {!visible.length && <div className="es-empty" style={{ padding: 40 }}>No jobs here yet — everything you render shows up in this list, even after a restart.</div>}
      </div>
    </div>
  );
}
