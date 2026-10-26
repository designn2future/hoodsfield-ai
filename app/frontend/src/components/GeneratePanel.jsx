import GenProgress from './GenProgress.jsx';
import React from 'react';

const PRESETS = {
  Draft: { width: 512, height: 288, steps: 4 },
  Balanced: { width: 768, height: 448, steps: 8 },
  Quality: { width: 960, height: 544, steps: 12 },
};

const snap32 = (n) => Math.max(64, Math.round(n / 32) * 32);

export default function GeneratePanel({ settings, setSettings, numFrames, gen, busy, onGenerate, onCancel }) {
  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));

  return (
    <section className="panel gen">
      <h3>Generate</h3>

      <label>Prompt — describes the look; the 3D scene supplies structure & motion</label>
      <textarea rows={3} value={settings.prompt} disabled={busy}
        placeholder="e.g. a moss-covered stone monolith in a misty forest clearing, cinematic, volumetric light"
        onChange={(e) => set('prompt', e.target.value)} />

      <label>Negative prompt</label>
      <textarea rows={1} value={settings.negative} disabled={busy}
        onChange={(e) => set('negative', e.target.value)} />

      <label>Quality preset</label>
      <div className="row">
        {Object.entries(PRESETS).map(([name, p]) => (
          <button key={name} disabled={busy}
            className={settings.width === p.width && settings.steps === p.steps ? 'active' : ''}
            onClick={() => setSettings((s) => ({ ...s, ...p }))}>
            {name}
          </button>
        ))}
      </div>

      <div className="grid2">
        <label>Width
          <input type="number" step={32} min={256} max={1280} value={settings.width} disabled={busy}
            onChange={(e) => set('width', +e.target.value)}
            onBlur={(e) => set('width', snap32(+e.target.value))} />
        </label>
        <label>Height
          <input type="number" step={32} min={256} max={1280} value={settings.height} disabled={busy}
            onChange={(e) => set('height', +e.target.value)}
            onBlur={(e) => set('height', snap32(+e.target.value))} />
        </label>
        <label>Duration (s)
          <input type="number" step={0.5} min={0.5} max={10} value={settings.seconds} disabled={busy}
            onChange={(e) => set('seconds', Math.min(10, Math.max(0.5, +e.target.value)))} />
        </label>
        <label>FPS
          <input type="number" min={8} max={30} value={settings.fps} disabled={busy}
            onChange={(e) => set('fps', +e.target.value)} />
        </label>
        <label>Steps
          <input type="number" min={1} max={50} value={settings.steps} disabled={busy}
            onChange={(e) => set('steps', +e.target.value)} />
        </label>
        <label>CFG
          <input type="number" step={0.5} min={1} max={10} value={settings.cfg} disabled={busy}
            onChange={(e) => set('cfg', +e.target.value)} />
        </label>
        <label>Denoise
          <input type="number" step={0.05} min={0.1} max={1} value={settings.denoise} disabled={busy}
            onChange={(e) => set('denoise', +e.target.value)} />
        </label>
        <label>Seed (−1 = rnd)
          <input type="number" value={settings.seed} disabled={busy}
            onChange={(e) => set('seed', +e.target.value)} />
        </label>
        <label>Depth far
          <input type="number" step={1} min={2} max={200} value={settings.depthFar} disabled={busy}
            onChange={(e) => set('depthFar', +e.target.value)} />
        </label>
      </div>

      <div className="hint">
        {numFrames} frames @ {settings.fps} fps ({(numFrames / settings.fps).toFixed(2)}s — LTX needs 8n+1)
      </div>

      <button className="primary" onClick={onGenerate} disabled={busy || !settings.prompt.trim()}
        title={!settings.prompt.trim() ? 'Write a prompt first' : ''}>
        {busy ? 'Working…' : '⚡ Generate video'}
      </button>

      {(busy || gen.phase === 'done') && (
        <>
          <GenProgress progress={gen.progress} status={gen.status} onCancel={busy ? onCancel : undefined} cancelDisabled={!gen.jobId} running={busy} />
        </>
      )}
      {gen.phase === 'error' && <div className="error">{gen.error}</div>}
      {gen.videoUrl && (
        <>
          {gen.media?.startsWith('image') ? (
            <img className="result" src={gen.videoUrl} alt="Generated result" />
          ) : (
            <video src={gen.videoUrl} controls autoPlay loop />
          )}
          <a className="dl" href={gen.videoUrl} download>Download result</a>
        </>
      )}
    </section>
  );
}
