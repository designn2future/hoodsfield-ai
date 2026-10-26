import React, { useCallback, useEffect, useState } from 'react';

const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

/** Which model files each feature needs, what is installed, disk space, and where to get the rest. */
export default function ModelManager({ active }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (refresh = 0) => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/models/manager?refresh=${refresh}`);
      if (!r.ok) throw new Error(await r.text());
      setData(await r.json());
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }, []);
  useEffect(() => { if (active && !data) load(0); }, [active, data, load]);

  return (
    <div className="mm-page">
      <div className="mm-head">
        <div className="mm-title"><span className="jobs-ico">🧰</span><div><h2>Model manager</h2><p>What each feature needs, what is installed, and where to get the rest.</p></div></div>
        <button disabled={busy} onClick={() => load(1)}>{busy ? 'Scanning…' : '↻ Rescan'}</button>
      </div>
      {err && <div className="error">{err}</div>}
      {data && (
        <>
          <div className="mm-disk">
            {Object.entries(data.disk).map(([d, v]) => (
              <div key={d} className={`mm-meter ${v.free < 8e9 ? 'low' : ''}`}>
                <div><b>{d}:</b> drive<span>{gb(v.free)} free of {gb(v.total)}</span></div>
                <i><u style={{ width: `${Math.round(((v.total - v.free) / v.total) * 100)}%` }} /></i>
              </div>
            ))}
          </div>
          {data.features.map((f) => (
            <section key={f.id} className={`mm-feat ${f.ready ? 'ready' : 'missing'}`}>
              <h3>{f.ready ? '✅' : '⚠️'} {f.title}</h3>
              {f.items.map((i) => (
                <div key={i.label} className="mm-row">
                  <span className="mm-state">{i.found.length ? '●' : i.required ? '✕' : '○'}</span>
                  <div className="mm-main">
                    <b>{i.label}</b>{!i.required && <em> optional</em>}
                    <div className="hint">
                      {i.found.length ? `${i.found[0].split(/[\/]/).pop()} · ${gb(i.size)}` : `not installed → ${i.note}`}
                    </div>
                  </div>
                  {!i.found.length && i.url && (
                    <a href={i.url} target="_blank" rel="noreferrer">{i.gated ? 'Accept licence ↗' : 'Get ↗'}</a>
                  )}
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
