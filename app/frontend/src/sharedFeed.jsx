import React, { useEffect, useRef, useState } from 'react';
import { localJobs } from './api.js';

/** Live feed of every job on this PC, from any screen (PC or phone). Images started on ANOTHER screen are handed to
 * `onRemoteImage({ jobId, url, title })` when they finish, so they land in this screen's gallery; a screen that was
 * asleep or closed catches up on reconnect. Returns the jobs currently running on other screens. */
const SEEN_KEY = 'hf-feed-seen';       // server time of the last catch-up
const IMPORTED_KEY = 'hf-feed-imported'; // job ids already imported here (so a reload doesn't import twice)

const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export function useSharedFeed(onRemoteImage) {
  const [running, setRunning] = useState({});          // job_id -> {kind, title, progress}
  const cb = useRef(onRemoteImage);
  cb.current = onRemoteImage;

  useEffect(() => {
    let es = null; let closed = false; let retry = null;
    const imported = new Set(lsGet(IMPORTED_KEY, []));

    const importJob = (j) => {
      if (!j.job_id || localJobs.has(j.job_id) || imported.has(j.job_id)) return;
      imported.add(j.job_id);
      lsSet(IMPORTED_KEY, [...imported].slice(-150));
      cb.current?.({ jobId: j.job_id, url: `/api/video/${j.job_id}`, title: j.title || '' });
    };

    const catchUp = async () => {
      try {
        const since = lsGet(SEEN_KEY, null);
        const r = await fetch(`/api/feed/recent?since=${since ?? 1e12}`);   // first run: nothing to catch up on
        if (!r.ok) return;
        const { now, jobs } = await r.json();
        lsSet(SEEN_KEY, now);
        jobs.forEach(importJob);
      } catch { /* backend not up yet */ }
    };

    const connect = () => {
      if (closed) return;
      es = new EventSource('/api/feed');
      es.onopen = catchUp;
      es.onmessage = (e) => {
        let ev; try { ev = JSON.parse(e.data); } catch { return; }
        if (ev.type === 'presence') { window.__hfDevices = ev.devices; window.dispatchEvent(new CustomEvent('hf-presence', { detail: ev.devices })); return; }
        if (ev.type === 'session' || ev.type === 'refs' || ev.type === 'results' || ev.type === 'assistant') { window.dispatchEvent(new CustomEvent('hf-feed-event', { detail: ev })); return; }
        const id = ev.job_id; if (!id) return;
        if (ev.type === 'started') {
          if (!localJobs.has(id)) setRunning((r) => ({ ...r, [id]: { kind: ev.kind, title: ev.title, progress: 0 } }));
        } else if (ev.type === 'progress') {
          setRunning((r) => (r[id] ? { ...r, [id]: { ...r[id], progress: ev.max ? ev.value / ev.max : 0, overall: ev.overall ?? r[id].overall } } : r));
        } else if (ev.type === 'overall') {
          setRunning((r) => (r[id] ? { ...r, [id]: { ...r[id], overall: ev.overall, stage: ev.stage || r[id].stage } } : r));
        } else if (ev.type === 'done' || ev.type === 'error') {
          setRunning((r) => { if (!r[id]) return r; const n = { ...r }; delete n[id]; return n; });
          if (ev.type === 'done' && String(ev.kind || '').startsWith('image')) importJob({ job_id: id, title: ev.title });
        }
      };
      es.onerror = () => { es?.close(); if (!closed) retry = setTimeout(connect, 3000); };
    };
    connect();
    // A phone that locks or leaves the page drops its connection abruptly, which can upset the PC's network layer. On touch devices close the
    // live connection politely when the page is hidden and open it again when it is shown.
    const touch = window.matchMedia?.('(pointer: coarse)').matches;
    const onVis = () => {
      if (document.visibilityState === 'hidden') { if (touch) { clearTimeout(retry); es?.close(); es = null; } return; }
      if (!es || es.readyState === 2) connect();
      catchUp();
    };
    window.addEventListener('pagehide', () => { if (touch) es?.close(); });
    document.addEventListener('visibilitychange', onVis);
    return () => { closed = true; clearTimeout(retry); es?.close(); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  return running;
}

/** Small pill: what is generating on another screen right now. */
export function RemoteJobsPill({ running }) {
  const list = Object.entries(running);
  if (!list.length) return null;
  const [, j] = list[0];
  const whole = j.overall != null ? j.overall : (j.progress || 0);     // whole workflow when the backend reports it, else the current step
  const pct = Math.round(whole * 100);
  return (
    <div className="remote-pill" title="Started on another screen. The result will appear in your gallery when it is done.">
      <span className="remote-dot" />
      <span>Generating on another device{list.length > 1 ? ` (+${list.length - 1})` : ''}{pct ? ` · ${pct}%` : ''}</span>
      <div className="remote-bar"><i style={{ width: `${Math.max(2, pct)}%` }} /></div>
      {(j.stage || j.title) && <small>{j.stage ? `${j.stage}${j.progress > 0 && j.progress < 1 ? ` · step ${Math.round(j.progress * 100)}%` : ''}` : j.title.slice(0, 60)}</small>}
    </div>
  );
}
