import React, { useEffect, useState } from 'react';
import '../settings.css';

/** "What the H3 prompt coach will send": the user's words plus the camera, physics, audio and constraint lines it adds. */
export default function H3CoachPreview({ prompt, soundscape, music, seconds, hasImage, lockStill }) {
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open || !(prompt || '').trim()) { setRes(null); return undefined; }
    const t = setTimeout(async () => {
      try {
        const fd = new FormData();
        fd.append('prompt', prompt || ''); fd.append('soundscape', soundscape || ''); fd.append('music', music ?? 'No music.');
        fd.append('seconds', String(seconds || 5)); fd.append('has_image', hasImage ? 'true' : 'false'); fd.append('lock_still', lockStill ? 'true' : 'false');
        fd.append('use_llm', 'false');
        const r = await fetch('/api/h3/coach', { method: 'POST', body: fd });
        if (!r.ok) throw new Error(await r.text());
        setRes(await r.json()); setErr('');
      } catch (e) { setErr(e.message); }
    }, 450);
    return () => clearTimeout(t);
  }, [open, prompt, soundscape, music, seconds, hasImage, lockStill]);

  return (
    <details className="h3c" open={open} onToggle={(e) => setOpen(e.target.open)}>
      <summary>🎯 Prompt coach: see what H3 will actually receive</summary>
      {open && !(prompt || '').trim() && <p className="hint">Type a motion prompt above and the coached version appears here.</p>}
      {err && <div className="error">{err}</div>}
      {res?.prompt && (
        <>
          <pre>{res.prompt}</pre>
          {res.notes?.length > 0 && <ul>{res.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <p className="hint">Your wording is kept. Turn the coach off in Settings → H3 prompt coach.</p>
        </>
      )}
    </details>
  );
}
