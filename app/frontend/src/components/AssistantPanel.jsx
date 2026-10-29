import { openPage } from './SettingsPage.jsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useGenre } from '../genreStore.js';
import { enableAlerts } from '../assistantAlerts.jsx';
import { characterList } from '../mentions.js';
import { isViewOnly, VIEW_ONLY_MSG } from '../viewOnly.js';

const jget = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`); return r.json(); };
const jpost = async (u, body) => {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
  return r.json();
};
const isVideo = (n) => /\.(mp4|webm)$/i.test(n);
const STATUS = { starting: 'Starting…', running: 'Working…', waiting: 'Needs your OK', done: 'Finished', error: 'Stopped (error)', cancelled: 'Stopped', interrupted: 'Interrupted' };

const REF_ROLES = {
  image: [['character', 'Keep this character'], ['setting', 'Use this place'], ['style', 'Match this look'], ['other', 'Use as you see fit']],
  video: [['style', 'Match this look'], ['pacing', 'Match this pacing'], ['setting', 'Use this place'], ['character', 'Keep this character'], ['other', 'Use as you see fit']],
  audio: [['audio', 'Cut to this sound']],
};

function Media({ run, names }) {
  if (!names?.length) return null;
  return (
    <div className="as-media">
      {names.map((n) => {
        const u = `/api/assistant/runs/${run}/media/${n}`;
        return isVideo(n)
          ? <video key={n} src={u} controls playsInline preload="metadata" />
          : <a key={n} href={u} target="_blank" rel="noreferrer"><img src={u} alt="" loading="lazy" decoding="async" /></a>;
      })}
    </div>
  );
}

const STAGES = [['script', 'Script', '📝'], ['stills', 'Stills', '🖼️'], ['clips', 'Clips', '🎞️'], ['cut', 'Cut', '✂️'], ['final', 'Final', '🏁']];

function useTick(on) {
  const [, setN] = useState(0);
  useEffect(() => { if (!on) return undefined; const t = setInterval(() => setN((n) => n + 1), 1000); return () => clearInterval(t); }, [on]);
  return Date.now() / 1000;
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function ProgressStrip({ run, now }) {
  const cur = run.board?.stage || (run.status === 'done' ? 'final' : '');
  const ci = STAGES.findIndex((s) => s[0] === cur);
  const live = ['running', 'waiting', 'starting'].includes(run.status);
  return (
    <div className="as-strip">
      {STAGES.map(([id, label, icon], i) => {
        const state = run.status === 'done' || i < ci ? 'done' : i === ci ? (run.status === 'waiting' ? 'ask' : live ? 'active' : 'stop') : 'todo';
        return (
          <React.Fragment key={id}>
            {i > 0 && <span className={`as-link ${i <= ci || run.status === 'done' ? 'on' : ''}`} />}
            <div className={`as-step ${state}`}><span className="as-dot">{state === 'done' ? '✓' : icon}</span><b>{label}</b></div>
          </React.Fragment>
        );
      })}
      <span className="as-elapsed">{mmss(Math.max(0, (run.status === 'done' ? run.updated : now) - run.created))}</span>
    </div>
  );
}

function NowLine({ run, now }) {
  const n = run.board?.now;
  const live = ['running', 'starting'].includes(run.status);
  if (!live || run.approval) return null;
  const text = n?.text || (run.status === 'starting' ? 'Starting up…' : 'Thinking it through…');
  return (
    <div className="as-now">
      <span className="as-spin" />
      <div className="as-now-body">
        <div>{text}{n?.since ? <small> · {mmss(Math.max(0, now - n.since))}</small> : null}</div>
        {n?.progress != null && <div className="as-bar"><i style={{ width: `${Math.round(n.progress * 100)}%` }} /></div>}
      </div>
    </div>
  );
}

function ShotCard({ run, s }) {
  const stillOf = s.stills.find((x) => x.status === 'chosen') || s.stills.filter((x) => x.status !== 'rejected').slice(-1)[0] || s.stills.slice(-1)[0];
  const clip = s.clips.find((x) => x.status === 'chosen') || s.clips.filter((x) => x.status !== 'rejected').slice(-1)[0];
  const rejected = [...s.stills, ...s.clips].filter((x) => x.status === 'rejected');
  const u = (n) => `/api/assistant/runs/${run.id}/media/${n}`;
  const working = run.board?.now?.shot === s.n;
  const [open, setOpen] = useState(false);
  return (
    <div className={`as-shot ${working ? 'working' : ''} ${clip ? 'hasclip' : stillOf ? 'hasstill' : ''}`}>
      <div className="as-shot-frame">
        {clip ? <video key={clip.name} src={u(clip.name)} muted loop playsInline autoPlay /> : stillOf ? <img key={stillOf.name} src={u(stillOf.name)} alt="" decoding="async" /> : <div className="as-shimmer" />}
        <span className="as-shot-n">{s.n}</span>
        {clip && <span className="as-tag">▶ clip</span>}
        {working && <span className="as-tag live">making…</span>}
      </div>
      <div className="as-shot-t"><b>{s.title}</b>{s.caption ? <small>“{s.caption.replace(/^(stamp|strip|reply):/, '')}”</small> : null}</div>
      {(s.still || rejected.length > 0 || s.stills.length > 1) && (
        <button type="button" className="as-more" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Details'}{rejected.length ? ` · ${rejected.length} rejected` : ''}</button>
      )}
      {open && (
        <div className="as-shot-d">
          {s.still && <p>{s.still}</p>}
          {s.stills.length > 1 && <div className="as-vars">{s.stills.map((x) => <img key={x.name} src={u(x.name)} alt="" className={x.status} title={x.label} />)}</div>}
          {rejected.map((x) => <div key={x.name} className="as-rej"><span>✕</span> {x.reason || 'rejected'}{x.label ? ` (${x.label})` : ''}</div>)}
        </div>
      )}
    </div>
  );
}

function ShotBoard({ run }) {
  const shots = run.board?.shots || [];
  if (!shots.length) return null;
  return <div className="as-board">{shots.map((s) => <ShotCard key={s.n} run={run} s={s} />)}</div>;
}

/** The Assistant: describe an idea, Claude produces everything and stops for your OK at the key points. Works from the phone. */
export default function AssistantPanel({ active, assets }) {
  const { defs } = useGenre();
  const savedChars = characterList(assets);
  const [runs, setRuns] = useState([]);
  const [sel, setSel] = useState(null);       // selected run id
  const [run, setRun] = useState(null);
  const [st, setSt] = useState(null);
  const [form, setForm] = useState({ idea: '', genre: '', seconds: 22, notes: '', variations: true, engine: 'claude', char_engine: 'combo' });
  const [refs, setRefs] = useState([]);
  const [picks, setPicks] = useState({});
  const [rev, setRev] = useState('');
  const [attName, setAttName] = useState('');
  const attFile = useRef(null);
  const fileRef = useRef(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const endRef = useRef(null);

  const loadRuns = useCallback(() => jget('/api/assistant/runs').then((d) => setRuns(d.runs)).catch(() => {}), []);
  // a phone that just woke up often fails its first request: retry quietly, clear any old error on success, only complain after 3 tries
  const loadRun = useCallback(async (id) => {
    for (let i = 0; i < 3; i += 1) {
      try { const r = await jget(`/api/assistant/runs/${id}`); setRun(r); setErr(''); return; }
      catch (e) { if (i === 2) setErr(`Couldn't load this project (${e.message}). Check the connection to the PC and tap here to retry.`); else await new Promise((res) => setTimeout(res, 1200 * (i + 1))); }
    }
  }, []);
  useEffect(() => {
    if (active) {
      loadRuns();
      jget('/api/assistant/status').then((s) => { setSt(s); if ((!s.claude_enabled || !s.claude_code) && (s.lite?.installed || !s.claude_enabled)) setForm((f) => ({ ...f, engine: 'lite' })); }).catch(() => {});
    }
  }, [active, loadRuns]);
  useEffect(() => { if (sel) loadRun(sel); else setRun(null); }, [sel, loadRun]);
  useEffect(() => {
    const open = (e) => { if (e.detail) setSel(e.detail); };
    window.addEventListener('hf-assistant-open', open);
    return () => window.removeEventListener('hf-assistant-open', open);
  }, []);
  useEffect(() => {      // coming back to the page (phone unlocked / tab switched): refresh at once
    const vis = () => { if (document.visibilityState === 'visible') { loadRuns(); if (sel) loadRun(sel); } };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [sel, loadRun, loadRuns]);
  const [alertNote, setAlertNote] = useState('');
  const turnOnAlerts = async () => setAlertNote(await enableAlerts());

  // live: the server announces every change on the shared feed (the same on the PC and the phone); a slow poll covers a missed one
  useEffect(() => {
    const on = (e) => { const d = e.detail || {}; if (d.type !== 'assistant') return; loadRuns(); if (d.run === sel) loadRun(sel); };
    window.addEventListener('hf-feed-event', on);
    // any live event for any project refreshes the list; the open project also re-reads every 5 s while it is unfinished or not loaded yet
    const on2 = () => { if (sel && document.visibilityState === 'visible') loadRun(sel); };
    window.addEventListener('hf-feed-event', on2);
    const t = setInterval(() => { if (active && sel && document.visibilityState === 'visible' && (!run || ['running', 'waiting', 'starting'].includes(run.status))) loadRun(sel); }, 5000);
    return () => { window.removeEventListener('hf-feed-event', on); window.removeEventListener('hf-feed-event', on2); clearInterval(t); };
  }, [sel, run?.status, active, loadRun, loadRuns]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [run?.events?.length]);

  const patchRef = (key, p) => setRefs((l) => l.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const addRefs = (files, extra = {}) => {
    for (const f of Array.from(files || [])) {
      const kind = f.type.startsWith('image') ? 'image' : f.type.startsWith('video') ? 'video' : f.type.startsWith('audio') ? 'audio' : '';
      const key = Math.random().toString(36).slice(2);
      if (!kind) { setErr(`${f.name}: use an image, video or audio file.`); continue; }
      setRefs((l) => [...l, { key, kind, name: f.name, role: REF_ROLES[kind][0][0], label: '', char: '', preview: kind === 'audio' ? '' : URL.createObjectURL(f), uploading: true, ...extra }]);
      const fd = new FormData(); fd.append('file', f);
      fetch('/api/assistant/upload', { method: 'POST', body: fd })
        .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`); patchRef(key, { uploading: false, file: j.file }); })
        .catch((e) => patchRef(key, { uploading: false, error: e.message }));
    }
  };
  const uploading = refs.some((r) => r.uploading);
  const start = async () => {
    if (isViewOnly()) { setErr(VIEW_ONLY_MSG); return; }
    setBusy(true); setErr('');
    try {
      const sendRefs = refs.filter((r) => r.file && !r.error).map((r) => ({ file: r.file, name: r.name, role: r.role, label: r.label, char: r.role === 'character' ? r.char : '' }));
      const r = await jpost('/api/assistant/runs', { ...form, refs: sendRefs });
      setSel(r.id); setForm((f) => ({ ...f, idea: '', notes: '' })); setRefs([]); loadRuns();
    }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const answer = async (choice) => {
    setBusy(true); setErr('');
    try { await jpost(`/api/assistant/runs/${sel}/answer`, { approval_id: run.approval.id, choice, note, picks }); setNote(''); setPicks({}); await loadRun(sel); }
    catch (e) { setErr(e.message); loadRun(sel); } finally { setBusy(false); }
  };
  const act = async (what) => { try { await jpost(`/api/assistant/runs/${sel}/${what}`); loadRun(sel); loadRuns(); } catch (e) { setErr(e.message); } };
  const attach = async (file, name) => {
    if (!file || !name?.trim()) return;
    setBusy(true); setErr('');
    try {
      const fd = new FormData(); fd.append('file', file);
      const u = await fetch('/api/assistant/upload', { method: 'POST', body: fd });
      const j = await u.json().catch(() => ({}));
      if (!u.ok) throw new Error(j.detail || `HTTP ${u.status}`);
      await jpost(`/api/assistant/runs/${sel}/refs`, { refs: [{ file: j.file, name: file.name, role: 'character', char: name.trim(), label: '' }] });
      setAttName(''); await loadRun(sel);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const revise = async () => {
    setBusy(true); setErr('');
    try { await jpost(`/api/assistant/runs/${sel}/revise`, { note: rev }); setRev(''); await loadRun(sel); loadRuns(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const again = async () => {
    setBusy(true); setErr('');
    try {
      const f = await jget(`/api/assistant/runs/${sel}/form`);
      setForm({ engine: f.engine || 'claude', char_engine: f.char_engine || 'combo', idea: f.idea, genre: f.genre || '', seconds: f.seconds || 22, notes: f.notes || '', variations: f.variations !== false });
      setRefs(f.refs.map((x) => ({ key: Math.random().toString(36).slice(2), kind: x.kind, name: x.name, role: x.role, label: x.label, char: x.char || '', file: x.file,
        preview: x.kind === 'audio' ? '' : `/api/assistant/runs/${sel}/ref/${x.n}` })));
      setSel(null);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const send = async () => { if (!msg.trim()) return; try { await jpost(`/api/assistant/runs/${sel}/message`, { text: msg }); setMsg(''); loadRun(sel); } catch (e) { setErr(e.message); } };

  const live = run && ['running', 'waiting', 'starting'].includes(run.status);
  const now = useTick(!!live);
  return (
    <div className="as-wrap">
      <div className="as-head">
        {sel && <button className="as-back" onClick={() => { setSel(null); loadRuns(); }}>‹ Projects</button>}
        <h2>🤖 Assistant <button type="button" className="as-bell" onClick={turnOnAlerts} title="Sound, vibration and notifications when it needs you">🔔 Alerts</button></h2>
        {alertNote && <p className="as-hint" onClick={() => setAlertNote('')}>{alertNote}</p>}
        <p className="as-sub">Give it an idea. It writes, makes the pictures and clips, and builds the video, and asks for your OK at the key points. You can leave and answer from your phone.</p>
      </div>
      {st && st.claude_enabled && !st.claude_code && form.engine === 'claude' && <div className="error">{st.claude?.message || "Claude isn't connected on this PC."} <button type="button" onClick={() => openPage('settings', 'claude')}>Set up Claude</button> or switch to Lite mode below.</div>}
      {err && <div className="error" onClick={() => { setErr(''); if (sel) loadRun(sel); else loadRuns(); }}>{err}</div>}

      {!sel && (
        <>
          <div className="as-card">
            <label>Your idea</label>
            <textarea rows={3} value={form.idea} placeholder="e.g. A baby monitor catches something sitting in the rocking chair at 3 AM" onChange={(e) => setForm({ ...form, idea: e.target.value })} />
            <div className="as-row">
              <label>Style
                <select value={form.genre} onChange={(e) => setForm({ ...form, genre: e.target.value })}>
                  <option value="">Let the assistant choose</option>
                  {(defs || []).filter((g) => g.id !== 'cinematic').map((g) => <option key={g.id} value={g.id}>{g.icon} {g.label}</option>)}
                </select>
              </label>
              <label>Length (seconds)
                <input type="number" min={5} max={180} value={form.seconds} onChange={(e) => setForm({ ...form, seconds: e.target.value === '' ? '' : +e.target.value })} />
                <span className="as-chips">
                  {[15, 22, 30, 45, 60].map((s) => <button key={s} type="button" className={+form.seconds === s ? 'on' : ''} onClick={() => setForm({ ...form, seconds: s })}>{s}</button>)}
                  <small>≈ {Math.max(3, Math.round((+form.seconds || 22) / 3.5))} shots</small>
                </span>
              </label>
            </div>

            <label>Assistant brain</label>
            <div className="as-engines">
              {st?.claude_enabled && (
                <button type="button" className={form.engine === 'claude' ? 'on' : ''} disabled={st && !st.claude_code} onClick={() => setForm({ ...form, engine: 'claude' })}>
                  <b>Claude</b><small>Best quality. Uses your Claude login.{st && !st.claude_code ? (st.claude?.installed ? ' (not signed in)' : ' (not installed)') : ''}</small>
                </button>
              )}
              <button type="button" className={form.engine === 'lite' ? 'on' : ''} disabled={st && !(st.lite?.ollama && st.lite?.installed)} onClick={() => setForm({ ...form, engine: 'lite' })}>
                <b>Lite (local)</b><small>Free, no account. Plainer scripts, no self-review.{st && !st.lite?.installed ? ` (needs ${st.lite?.model})` : ''}</small>
              </button>
            </div>

            <label>Pictures with your character
              <select value={form.char_engine} onChange={(e) => setForm({ ...form, char_engine: e.target.value })}>
                <option value="combo">Qwen for close shots, Flux 3 for far shots (recommended)</option>
                <option value="qwen">Qwen Image for every shot with the character (best face, slowest)</option>
                <option value="flux">Flux 3 for everything (fastest)</option>
              </select>
            </label>

            <label className="as-switch">
              <input type="checkbox" checked={form.variations} onChange={(e) => setForm({ ...form, variations: e.target.checked })} />
              <span className="as-sw" />
              <span>Offer alternates for each shot<small>closer / wider options to pick from (adds ~20 s per shot)</small></span>
            </label>

            <label>References (optional)</label>
            <small className="as-hint">Photos of your character or place, a video whose look or pacing to copy, or a sound to cut to.</small>
            {refs.map((r) => (
              <div key={r.key} className="as-ref">
                <div className="as-ref-th">
                  {r.kind === 'image' && r.preview ? <img src={r.preview} alt="" /> : r.kind === 'video' && r.preview ? <video src={r.preview} muted playsInline preload="metadata" /> : <span>{r.kind === 'audio' ? '🎵' : '📄'}</span>}
                </div>
                <div className="as-ref-body">
                  <b>{r.name}</b>
                  {r.error ? <span className="as-err">{r.error}</span> : r.uploading ? <span className="as-chip pulse">uploading…</span> : null}
                  <select value={r.role} onChange={(e) => patchRef(r.key, { role: e.target.value })}>
                    {(REF_ROLES[r.kind] || []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  {r.role === 'character' && r.kind === 'image' && (
                    <input value={r.char || ''} placeholder="Character name, e.g. Harvey (you can then use @Harvey)" maxLength={30} onChange={(e) => patchRef(r.key, { char: e.target.value.replace(/[^\w -]/g, '') })} />
                  )}
                  <input value={r.label} placeholder="What should it do? (optional)" onChange={(e) => patchRef(r.key, { label: e.target.value })} />
                </div>
                <button type="button" aria-label="Remove" onClick={() => setRefs((l) => l.filter((x) => x.key !== r.key))}>✕</button>
              </div>
            ))}
            <input ref={fileRef} type="file" multiple hidden accept="image/*,video/*,audio/*" onChange={(e) => { addRefs(e.target.files); e.target.value = ''; }} />
            <button type="button" onClick={() => fileRef.current?.click()}>＋ Add images, video or audio</button>
            {savedChars.length > 0 && (
              <select value="" onChange={(e) => {
                const c = savedChars.find((x) => x.name === e.target.value);
                if (c) addRefs([new File([c.asset.blob], `${c.name}.${(c.asset.blob.type || 'image/png').split('/')[1].replace('jpeg', 'jpg')}`, { type: c.asset.blob.type || 'image/png' })], { role: 'character', char: c.name });
              }}>
                <option value="">＋ Add a saved character…</option>
                {savedChars.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            )}

            <label>Anything else? (optional)</label>
            <textarea rows={2} value={form.notes} placeholder="No faces. Keep sound sparse…" onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <button className="primary" disabled={busy || uploading || form.idea.trim().length < 4 || !(+form.seconds >= 5) || (st && form.engine === 'claude' && !st.claude_code) || (st && form.engine === 'lite' && !st.lite?.installed)} onClick={start}>{uploading ? 'Uploading…' : '🚀 Start project'}</button>
          </div>
          {runs.length > 0 && <h3 className="as-h3">Your projects</h3>}
          {runs.map((r) => (
            <button key={r.id} className={`as-run ${r.waiting ? 'wait' : ''}`} onClick={() => setSel(r.id)}>
              <b>{r.idea.slice(0, 80)}</b>
              <small>{r.waiting ? '⏳ Needs your OK' : STATUS[r.status] || r.status} · {new Date((r.updated || r.created) * 1000).toLocaleString()}</small>
            </button>
          ))}
        </>
      )}

      {sel && run && (
        <>
          <div className={`as-status ${run.paused ? 'waiting' : run.status}`}>{run.paused && live ? '⏸ Paused' : STATUS[run.status] || run.status}<span>{run.idea.slice(0, 90)}</span></div>
          <ProgressStrip run={run} now={now} />
          <NowLine run={run} now={now} />
          {run.approval && (
            <div className="as-card ask">
              <h3>{run.approval.title}</h3>
              <div className="as-msg">{run.approval.message}</div>
              <Media run={run.id} names={run.approval.media} />
              {(run.approval.picks || []).map((g) => (
                <div key={g.shot} className="as-pick">
                  <div className="as-pick-h">{g.label || `Shot ${g.shot}`}</div>
                  <div className="as-pick-row">
                    {g.options.map((o, i) => (
                      <button type="button" key={o.name} className={`as-pick-o ${(picks[g.shot] ?? 0) === i ? 'on' : ''}`} onClick={() => setPicks((p) => ({ ...p, [g.shot]: i }))}>
                        <img src={`/api/assistant/runs/${run.id}/media/${o.name}`} alt="" loading="lazy" decoding="async" />
                        <span>{o.label || (i === 0 ? 'Recommended' : `Option ${i + 1}`)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {(run.approval.suggestions || []).length > 0 && (
                <div className="as-sugg"><small>Ideas:</small>{run.approval.suggestions.map((t) => <button type="button" key={t} onClick={() => setNote((n) => (n ? `${n}. ${t}` : t))}>＋ {t}</button>)}</div>
              )}
              <textarea rows={2} value={note} placeholder="Add a note (optional). For changes, say exactly what to fix." onChange={(e) => setNote(e.target.value)} />
              <div className="as-opts">
                {run.approval.options.map((o, i) => <button key={o} className={i === 0 ? 'primary' : ''} disabled={busy} onClick={() => answer(o)}>{o}</button>)}
              </div>
            </div>
          )}
          <div className="as-card as-refs">
            <b>Characters &amp; references in this project</b>
            {(run.refs || []).length === 0 && <small className="as-hint">None attached. Add your character so @names link to their picture.</small>}
            {(run.refs || []).map((x) => (
              <div key={x.n} className="as-refline">{x.kind === 'image' ? '🖼️' : x.kind === 'video' ? '🎞️' : '🎵'} <b>{x.char ? `@${x.char}` : x.name}</b> <small>{x.role}</small></div>
            ))}
            {run.engine !== 'lite' && (
              <div className="as-attach">
                {savedChars.length > 0 && (
                  <select value="" disabled={busy} onChange={(e) => { const c = savedChars.find((x) => x.name === e.target.value); if (c) attach(new File([c.asset.blob], `${c.name}.${(c.asset.blob.type || 'image/png').split('/')[1].replace('jpeg', 'jpg')}`, { type: c.asset.blob.type || 'image/png' }), c.name); }}>
                    <option value="">＋ Attach a saved character…</option>
                    {savedChars.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </select>
                )}
                <input value={attName} placeholder="Name for a new picture, e.g. Thomas" maxLength={30} onChange={(e) => setAttName(e.target.value.replace(/[^\w -]/g, ''))} />
                <input ref={attFile} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) attach(f, attName); }} />
                <button type="button" disabled={busy || !attName.trim()} title={attName.trim() ? '' : 'Type the name first'} onClick={() => attFile.current?.click()}>＋ Attach a picture</button>
              </div>
            )}
          </div>
          <ShotBoard run={run} />
          {run.output && run.status === 'done' && (
            <div className="as-card as-final"><b>🎬 Your video is ready</b><div className="as-path">{run.output}</div></div>
          )}
          <details className="as-details" open={!run.board?.shots?.length}><summary>Everything it did</summary>
          <div className="as-log">
            {run.events.map((e, i) => (
              <div key={i} className={`as-ev ${e.kind}`}>
                {e.kind === 'tool' ? <span className="as-chip">⚙️ {e.text}</span> : e.kind === 'ask' ? <span className="as-chip">⏳ Asked: {e.text}</span> : <div>{e.text}</div>}
                <Media run={run.id} names={e.media} />
              </div>
            ))}
            {live && !run.approval && <div className="as-ev tool"><span className="as-chip pulse">working…</span></div>}
            <div ref={endRef} />
          </div></details>
          <div className="as-actions">
            {live && run.status !== 'waiting' && (run.paused
              ? <button className="primary" onClick={() => act('unpause')}>▶ Continue</button>
              : <button onClick={() => act('pause')}>⏸ Pause</button>)}
            {live && <>
              <input value={msg} placeholder="Tell the assistant something…" onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
              <button onClick={send} disabled={!msg.trim()}>Send</button>
              <button className="danger" onClick={() => act('cancel')}>■ Stop</button>
            </>}
            {!live && run.engine !== 'lite' && !(run.status === 'done' && run.output) && <button className="primary" onClick={() => act('resume')}>↻ Resume project</button>}
          </div>
          {!live && (
            <div className="as-card as-again">
              <b>Make changes</b>
              {run.engine === 'lite' && <small className="as-hint">Lite projects can't be revised. “Start again from this” refills the form so you can adjust the idea.</small>}
              {run.engine !== 'lite' && <textarea rows={2} value={rev} placeholder="What should change? e.g. “Make shot 3 a closer view of Harvey and darken the room.” Everything else is kept." onChange={(e) => setRev(e.target.value)} />}
              <div className="as-opts">
                {run.engine !== 'lite' && <button className="primary" disabled={busy || !rev.trim()} onClick={revise}>✏️ Revise this project</button>}
                <button disabled={busy} onClick={again}>⧉ Start again from this</button>
              </div>
              <details className="as-details"><summary>Original idea</summary><div className="as-msg">{run.idea}{run.notes ? `\n\nNotes: ${run.notes}` : ''}</div></details>
            </div>
          )}
        </>
      )}
    </div>
  );
}
