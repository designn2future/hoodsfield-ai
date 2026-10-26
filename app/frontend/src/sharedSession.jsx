import { isViewOnly, setViewOnly } from './viewOnly.js';
import React, { useEffect, useRef, useState } from 'react';

/** Keeps one copy of the working project on the PC so the PC and the phone show the same thing and follow each other live.
 * Local changes are pushed (debounced) to /api/session; when another screen pushes, a {type:'session'} announcement
 * arrives on the shared feed and this screen pulls and applies it. Last writer wins. Generation progress (`gen`) and the
 * board pan/zoom stay per screen. See backend/session_routes.py. */
export const CLIENT_ID = Math.random().toString(36).slice(2, 12);

const sigOf = (snap) => {
  const s = snap.state;
  const lite = { ...s, view: undefined, scenes: (s.scenes || []).map(({ gen, ...x }) => x),
    mv: s.mv ? { ...s.mv, scriptError: null } : null, tk: s.tk ? { ...s.tk, scriptError: null } : null };
  return JSON.stringify(lite) + '|' + snap.assets.map((a) => a.id + ':' + (a.blob?.size || 0)).join(',');
};
const syncState = (s) => ({ ...s, view: undefined, fluxSettings: s.fluxSettings ? { ...s.fluxSettings, resultIds: undefined } : s.fluxSettings,
  scenes: (s.scenes || []).map(({ gen, ...x }) => x),
  mv: s.mv ? { ...s.mv, scriptError: null } : null, tk: s.tk ? { ...s.tk, scriptError: null } : null });

export function useSharedSession({ snapRef, applyShared }) {
  const [status, setStatus] = useState('starting');   // starting | live | syncing | offline
  const st = useRef({ ready: false, rev: 0, pushedSig: '', pushing: false, pulling: false, settleUntil: 0 });
  const applyRef = useRef(applyShared);
  applyRef.current = applyShared;

  useEffect(() => {
    let dead = false;
    const S = st.current;
    const empty = (snap) => !snap.assets.length && !(snap.state.scenes || []).length;

    const pull = async () => {
      if (S.pulling) return; S.pulling = true;
      try {
        setStatus('syncing');
        const r = await fetch('/api/session'); if (!r.ok) throw new Error(String(r.status));
        const sess = await r.json();
        if (sess.rev > S.rev && sess.state) {
          const local = new Map(snapRef.current.assets.map((a) => [a.id, a]));
          const assets = []; let incomplete = false;
          const todo = (sess.assets || []).filter((a) => !local.has(a.id));
          const got = new Map();
          let i = 0;
          const worker = async () => {
            while (i < todo.length) {
              const a = todo[i++];
              if (!a.have) { incomplete = true; continue; }
              try { const b = await fetch(`/api/session/blob/${a.id}`); if (b.ok) got.set(a.id, new Blob([await b.blob()], { type: a.mime || 'application/octet-stream' })); else incomplete = true; } catch { incomplete = true; }
            }
          };
          await Promise.all([worker(), worker(), worker()]);
          for (const a of sess.assets || []) {
            if (local.has(a.id)) assets.push({ ...local.get(a.id), name: a.name, meta: { ...(local.get(a.id).meta || {}), ...(a.meta || {}) } });
            else if (got.has(a.id)) { const blob = got.get(a.id); assets.push({ id: a.id, kind: a.kind, mime: a.mime, name: a.name, meta: a.meta || null, blob, url: URL.createObjectURL(blob) }); }
          }
          S.settleUntil = Date.now() + 3500;
          applyRef.current(sess.state, assets);
          S.rev = incomplete ? S.rev : sess.rev;   // a file that had not finished uploading: pull again when its upload is announced
          setTimeout(() => { S.pushedSig = sigOf(snapRef.current); }, 2600);
        } else if (sess.rev > S.rev) S.rev = sess.rev;
        setStatus('live');
      } catch { setStatus('offline'); } finally { S.pulling = false; }
    };

    const push = async () => {
      if (isViewOnly()) return;
      if (S.pushing) return; S.pushing = true;
      try {
        // circuit breaker: more than 6 pushes in 20 s means two screens are fighting, so stop and sit out for a while
        const nowT = Date.now(); S.log = (S.log || []).filter((t) => nowT - t < 20000); S.log.push(nowT);
        if (S.log.length > 6) { S.mute = nowT + 60000; S.log = []; setStatus('offline'); console.warn('shared session: pushing too fast, paused for 60 s'); return; }
        const snap = snapRef.current;
        const body = { clientId: CLIENT_ID, state: syncState(snap.state),
          assets: snap.assets.map((a) => ({ id: a.id, kind: a.kind, mime: a.mime, name: a.name, meta: a.meta ? { ...a.meta, describing: undefined } : null })) };
        const sig = sigOf(snap);
        setStatus('syncing');
        const r = await fetch('/api/session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(String(r.status));
        const { rev, missing } = await r.json();
        S.rev = rev; S.pushedSig = sig;
        const byId = new Map(snap.assets.map((a) => [a.id, a]));
        for (const id of missing || []) {
          const a = byId.get(id); if (!a?.blob) continue;
          await fetch(`/api/session/blob/${id}`, { method: 'PUT', headers: { 'x-client-id': CLIENT_ID, 'Content-Type': 'application/octet-stream' }, body: a.blob });
        }
        setStatus('live');
      } catch { setStatus('offline'); } finally { S.pushing = false; }
    };

    // start: take whatever the PC already holds (the PC is the copy), then follow changes both ways
    (async () => {
      await pull();
      if (dead) return;
      S.ready = true;
      if (!S.pushedSig) S.pushedSig = sigOf(snapRef.current);   // a tab that merely opened pushes nothing
    })();

    let pullTimer = null;
    const onFeed = (e) => {
      const ev = e.detail || {};
      if (ev.type !== 'session' || ev.clientId === CLIENT_ID) return;
      clearTimeout(pullTimer); pullTimer = setTimeout(pull, 350);
    };
    window.addEventListener('hf-feed-event', onFeed);
    const tick = setInterval(() => {
      if (!S.ready || S.pushing || S.pulling || Date.now() < S.settleUntil || Date.now() < (S.mute || 0)) return;
      const snap = snapRef.current;
      if (empty(snap)) return;
      if (sigOf(snap) !== S.pushedSig || window.__hfDirty) { window.__hfDirty = false; push(); }   // __hfDirty: a repair made right after load must still be shared
    }, 1500);
    const onVis = () => { if (document.visibilityState === 'visible' && S.ready) pull(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { dead = true; clearInterval(tick); clearTimeout(pullTimer); window.removeEventListener('hf-feed-event', onFeed); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  return status;
}

export function SyncBadge({ status }) {
  const label = { starting: 'Connecting…', live: 'Synced', syncing: 'Syncing…', offline: 'Not synced' }[status] || '';
  const [vo, setVo] = useState(isViewOnly());
  const [devices, setDevices] = useState(window.__hfDevices || 0);
  useEffect(() => {
    const a = () => setVo(isViewOnly()); const b = (e) => setDevices(e.detail || 0);
    window.addEventListener('hf-viewonly', a); window.addEventListener('hf-presence', b);
    return () => { window.removeEventListener('hf-viewonly', a); window.removeEventListener('hf-presence', b); };
  }, []);
  return (
    <div className={`sync-badge ${status} ${vo ? 'viewonly' : ''}`} title="This screen shares one project with your other devices. Changes appear on both.">
      <span className="sync-dot" />{vo ? 'View-only' : label}{devices > 1 ? ` · ${devices} devices` : ''}
      <button type="button" className="vo" onClick={() => setViewOnly(!vo)} title="View-only: browse without changing the shared project or starting generations">{vo ? '✎ Allow edits' : '👀 View-only'}</button>
    </div>
  );
}
