// Some tunnels and proxies (Cloudflare "quick" tunnels among them) buffer server-sent events, so a stream opens but never delivers.
// Wrap EventSource: if nothing arrives within a few seconds, carry on by polling the same information instead.
// Streams that work (home Wi-Fi, localhost) are untouched. Set localStorage.hfForcePoll = '1' to test the fallback.
const Native = window.EventSource;
const WAIT_MS = 7000;
const forced = () => { try { return localStorage.getItem('hfForcePoll') === '1'; } catch { return false; } };

class HFEventSource {
  constructor(url) {
    this.url = url; this.readyState = 0;
    this.onopen = null; this.onmessage = null; this.onerror = null;
    this._got = false; this._polling = false; this._closed = false; this._timers = [];
    this._es = new Native(url);
    this._es.onopen = (e) => { if (!this._polling) { this.readyState = 1; this.onopen?.(e); } };
    this._es.onmessage = (e) => { if (this._polling) return; this._got = true; clearTimeout(this._wd); this.onmessage?.(e); };
    this._es.onerror = (e) => { if (!this._polling) { this.readyState = this._es.readyState; this.onerror?.(e); } };
    this._wd = setTimeout(() => { if (!this._got && !this._closed) this._poll(); }, forced() ? 300 : WAIT_MS);
  }

  close() {
    this._closed = true; this.readyState = 2;
    clearTimeout(this._wd); this._timers.forEach(clearInterval); this._timers = [];
    try { this._es.close(); } catch { /* already closed */ }
  }

  _emit(obj) { if (!this._closed) this.onmessage?.({ data: JSON.stringify(obj), type: 'message' }); }

  _poll() {
    this._polling = true;
    try { this._es.close(); } catch { /* ignore */ }
    this.readyState = 1;
    const path = new URL(this.url, location.href).pathname;
    const job = path.match(/^\/api\/events\/([^/]+)$/);
    if (job) this._pollJob(job[1]);
    else if (path === '/api/feed') this._pollFeed();
    // any other stream: leave it to the caller's own error handling
    else { this.readyState = 2; this.onerror?.({ type: 'error' }); }
  }

  _pollJob(id) {
    let misses = 0, lastText = '', lastProg = -1;
    const tick = async () => {
      if (this._closed) return;
      try {
        const r = await fetch(`/api/jobs/${id}`);
        if (!r.ok) throw new Error(String(r.status));
        misses = 0;
        const j = await r.json();
        if (j.status_text && j.status_text !== lastText) { lastText = j.status_text; this._emit({ type: 'status', text: lastText }); }
        if (typeof j.progress === 'number' && j.progress !== lastProg) { lastProg = j.progress; this._emit({ type: 'progress', value: j.progress, max: 1 }); }
        if (j.status === 'done') { this._emit({ type: 'done', url: `/api/jobs/${id}/media` }); return this.close(); }
        if (j.status === 'error' || j.status === 'cancelled' || j.status === 'interrupted') {
          this._emit({ type: 'error', text: j.error || (j.status === 'cancelled' ? 'Cancelled' : 'Job failed') });
          return this.close();
        }
      } catch {
        if (++misses > 40) { this._emit({ type: 'error', text: 'Lost connection to backend' }); return this.close(); }
      }
    };
    tick();
    this._timers.push(setInterval(tick, 2500));
  }

  _pollFeed() {
    let last = null, n = 0;
    const tick = async () => {
      if (this._closed) return;
      try {
        const r = await fetch('/api/session/revs');
        if (!r.ok) return;
        const cur = await r.json();
        if (last) for (const k of ['rev', 'results', 'refs']) {
          if (cur[k] !== last[k]) this._emit({ type: k === 'rev' ? 'session' : k, rev: cur[k], clientId: '' });
        }
        last = cur;
        if (n++ % 3 === 0) this.onopen?.({ type: 'open' });     // lets the app catch up on finished jobs
      } catch { /* offline: try again next tick */ }
    };
    tick();
    this._timers.push(setInterval(tick, 3000));
  }
}
HFEventSource.CONNECTING = 0; HFEventSource.OPEN = 1; HFEventSource.CLOSED = 2;

if (Native && !window.__hfPollShim) { window.__hfPollShim = true; window.EventSource = HFEventSource; }
