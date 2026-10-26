import React, { useEffect, useRef, useState } from 'react';

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return '–';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** Live progress for any generation: percentage, the current step ("Sampling 5/8"), elapsed time and an estimate of what is left,
 * plus Cancel. `progress` is 0..1 (0 = no numbers yet, shown as an animated bar). `startedAt` (ms) is optional; otherwise the
 * clock starts when this component mounts, which is when the job starts. */
export default function GenProgress({ progress = 0, status = '', onCancel, cancelDisabled = false, startedAt, compact = false, running = true }) {
  const t0 = useRef(startedAt || Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const elapsed = Math.max(0, (now - t0.current) / 1000);
  const p = Math.max(0, Math.min(1, progress || 0));
  const known = p > 0.005;
  const eta = known && p < 1 && elapsed > 4 ? (elapsed * (1 - p)) / p : null;
  const step = /(\d+)\s*\/\s*(\d+)/.exec(status || '');
  const label = (status || '').replace(/\s*\d+\s*\/\s*\d+\s*$/, '').replace(/[:\s]+$/, '') || (running ? 'Working' : 'Done');
  return (
    <div className={`genp ${compact ? 'compact' : ''} ${known ? '' : 'indet'}`} role="progressbar" aria-valuenow={Math.round(p * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="genp-top">
        <span className="genp-label" title={status}>{label}</span>
        <span className="genp-pct">{known ? `${Math.round(p * 100)}%` : '…'}</span>
      </div>
      <div className="genp-bar"><div style={{ width: known ? `${p * 100}%` : '100%' }} /></div>
      <div className="genp-meta">
        <span>{step ? `Step ${step[1]} of ${step[2]}` : running ? 'Starting…' : ''}</span>
        {running && <span>{fmt(elapsed)} elapsed{eta != null ? ` · about ${fmt(eta)} left` : ''}</span>}
        {onCancel && <button className="cancel-btn" disabled={cancelDisabled} title="Cancel this generation" onClick={onCancel}>✕ Cancel</button>}
      </div>
    </div>
  );
}
