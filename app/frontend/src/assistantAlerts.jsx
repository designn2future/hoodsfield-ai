import React, { useCallback, useEffect, useRef, useState } from 'react';

/* Alerts for the Assistant: when it needs your OK (or finishes / stops) you hear and see it on whichever screen is open.
   - a banner on every screen of the app with an Open button
   - the browser tab title flashes, a chime plays, the phone vibrates
   - a system notification where the browser allows it (the PC; a phone only over https)
   Works while the page is open, even in a background tab. A closed page can't be reached without a push service. */

let ctx = null;
const unlock = () => {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { /* no audio */ }
};
if (typeof window !== 'undefined') window.addEventListener('pointerdown', unlock, { once: false, passive: true });

function chime(kind = 'ask') {
  try {
    unlock();
    if (!ctx || ctx.state !== 'running') return;
    const notes = kind === 'ask' ? [660, 880, 1100] : kind === 'done' ? [523, 659, 784, 1047] : [330, 262];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.start(t); o.stop(t + 0.32);
    });
  } catch { /* ignore */ }
}
const buzz = (p) => { try { navigator.vibrate?.(p); } catch { /* ignore */ } };

/** Called from a button (a user tap is needed to allow sound and notifications). */
export async function enableAlerts() {
  unlock(); chime('ask'); buzz([120, 60, 120]);
  let note = 'Alerts on: sound, vibration and the banner.';
  try { if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/hf-sw.js'); } catch { /* needs a secure context */ }
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) && /Android/i.test(navigator.userAgent)) {
    note += ' This phone browser blocks system notifications on a plain http address. In Chrome open chrome://flags, search "Insecure origins treated as secure", add this page\'s address (' + location.origin + '), set Enabled, relaunch, then tap Alerts again.';
  }
  else if (Notification.permission === 'default') {
    const r = await Notification.requestPermission();
    note += r === 'granted' ? ' System notifications are on too.' : ' System notifications were declined.';
  } else if (Notification.permission === 'granted') note += ' System notifications are on too.';
  else note += ' System notifications are blocked in the browser settings.';
  try { localStorage.setItem('hf-alerts', '1'); } catch { /* ignore */ }
  return note;
}

const ICON = { ask: '⏳', done: '🎬', error: '⚠️' };

export default function AssistantAlerts({ inAssistant, onOpen }) {
  const [pending, setPending] = useState([]);       // runs waiting for an answer
  const prev = useRef({ waiting: new Set(), status: {}, first: true });
  const flash = useRef(null);
  const base = useRef(typeof document !== 'undefined' ? document.title : '');

  const alertUser = useCallback((kind, run) => {
    const title = kind === 'ask' ? 'The Assistant needs your OK' : kind === 'done' ? 'Your video is ready' : 'The Assistant stopped';
    const body = (run.idea || '').slice(0, 90);
    chime(kind);
    buzz(kind === 'ask' ? [250, 120, 250, 120, 500] : [300]);
    (async () => {
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
        const opts = { body, tag: `hf-as-${run.id}`, requireInteraction: kind === 'ask', data: { run: run.id }, vibrate: [250, 120, 250] };
        const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
        if (reg) { await reg.showNotification(`${ICON[kind]} ${title}`, opts); return; }      // Android Chrome only allows this form
        const n = new Notification(`${ICON[kind]} ${title}`, opts);
        n.onclick = () => { window.focus(); onOpen?.(run.id); n.close(); };
      } catch { /* ignore */ }
    })();
  }, [onOpen]);

  useEffect(() => {      // a tapped notification asks the open page to jump to that project
    const msg = (e) => { if (e.data && e.data.type === 'hf-open-assistant') onOpen?.(e.data.run); };
    navigator.serviceWorker?.addEventListener('message', msg);
    return () => navigator.serviceWorker?.removeEventListener('message', msg);
  }, [onOpen]);

  const check = useCallback(async () => {
    let runs;
    try { runs = (await (await fetch('/api/assistant/runs')).json()).runs || []; } catch { return; }
    const p = prev.current;
    const waiting = runs.filter((r) => r.waiting);
    setPending(waiting);
    if (!p.first) {
      waiting.filter((r) => !p.waiting.has(r.id)).forEach((r) => alertUser('ask', r));
      runs.forEach((r) => {
        const was = p.status[r.id];
        if (was && was !== r.status && (r.status === 'done' || r.status === 'error')) alertUser(r.status === 'done' ? 'done' : 'error', r);
      });
    }
    p.first = false;
    p.waiting = new Set(waiting.map((r) => r.id));
    p.status = Object.fromEntries(runs.map((r) => [r.id, r.status]));
  }, [alertUser]);

  useEffect(() => {
    check();
    const on = (e) => { if ((e.detail || {}).type === 'assistant') check(); };
    window.addEventListener('hf-feed-event', on);
    const vis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', vis);
    const t = setInterval(check, 20000);          // covers a missed live event
    return () => { window.removeEventListener('hf-feed-event', on); document.removeEventListener('visibilitychange', vis); clearInterval(t); };
  }, [check]);

  // the tab title flashes while something needs you
  useEffect(() => {
    clearInterval(flash.current);
    if (!pending.length) { document.title = base.current; return undefined; }
    let on = false;
    flash.current = setInterval(() => { on = !on; document.title = on ? `⏳ (${pending.length}) Needs your OK` : base.current; }, 1200);
    return () => { clearInterval(flash.current); document.title = base.current; };
  }, [pending.length]);

  if (!pending.length || inAssistant) return null;
  const r = pending[0];
  return (
    <div className="as-alert" role="alert">
      <span className="as-alert-ico">⏳</span>
      <div className="as-alert-t"><b>The Assistant needs your OK</b><small>{r.idea.slice(0, 70)}{pending.length > 1 ? ` · +${pending.length - 1} more` : ''}</small></div>
      <button className="primary" onClick={() => onOpen?.(r.id)}>Open</button>
    </div>
  );
}
