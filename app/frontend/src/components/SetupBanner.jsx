import React, { useEffect, useState } from 'react';
import { openPage } from './SettingsPage.jsx';

const KEY = 'hf_setup_seen';
const seen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return true; } };
const mark = () => { try { localStorage.setItem(KEY, '1'); } catch { /* storage blocked */ } };

/** First run: quietly runs the setup check and, if something needs attention, offers to open Settings. Shown once per browser. */
export default function SetupBanner({ onOpen }) {
  const [res, setRes] = useState(null);
  useEffect(() => {
    if (seen()) return undefined;
    let on = true;
    const t = setTimeout(() => {
      fetch('/api/health/check').then((r) => (r.ok ? r.json() : null)).then((j) => {
        if (!on || !j) return;
        if (j.summary.fail || j.summary.warn) setRes(j); else mark();
      }).catch(() => {});
    }, 2500);
    return () => { on = false; clearTimeout(t); };
  }, []);
  if (!res) return null;
  const n = res.summary.fail + res.summary.warn;
  return (
    <div className="setup-banner" role="status">
      <div>
        <b>Welcome to Hoodsfield.</b>{' '}
        <span>{res.summary.fail ? `${res.summary.fail} thing${res.summary.fail === 1 ? '' : 's'} must be fixed before everything works` : `${n} thing${n === 1 ? '' : 's'} worth a look`}. Settings has a one-page checklist.</span>
      </div>
      <button className="st-cta" onClick={() => { mark(); setRes(null); onOpen?.(); openPage('settings', 'check'); }}>Open setup</button>
      <button className="x" onClick={() => { mark(); setRes(null); }} aria-label="Dismiss">✕</button>
    </div>
  );
}
