import GenProgress from './GenProgress.jsx';
import React from 'react';
import { parsePrompt, effectiveSecs, SEG_COLORS } from './PromptTimeline.jsx';
import { durationOptions, H3_GRID_FALLBACK } from '../h3.js';

export default function SceneCard({
  scene, idx, asset, videoAsset, castNames = [], sections, h3Grid, k,
  onMove, onUpdate, onGenerate, onGenerateStill, onDelete, onCancel, onOpenDetail, onToTimeline,
}) {
  const busy = scene.gen?.phase === 'run';
  // which song section(s) this shot is scheduled to be cross-cut into — a
  // setup (and so its shots) can recur across more than one section, which
  // is easy to lose track of once shots are scattered across the board
  const secIdxs = scene.sections?.length ? scene.sections : (scene.section ? [scene.section] : []);
  const secLabels = [...new Set(
    secIdxs.map((i) => sections?.[i - 1]?.label).filter(Boolean)
  )];
  if (!secLabels.length && scene.sectionLabel) secLabels.push(scene.sectionLabel);
  const isH3 = (scene.engine || 'h3') === 'h3';
  const parsed = parsePrompt(scene.prompt, scene.fps ?? 24);
  const clipSecs = isH3 ? (scene.frames || 124) / 24 : scene.seconds;
  const segSecs = parsed.segments.length > 1 ? effectiveSecs(parsed.segments, clipSecs) : null;
  const durations = durationOptions(h3Grid || H3_GRID_FALLBACK);

  const startDrag = (e) => {
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, sx: scene.x, sy: scene.y };
    const move = (ev) =>
      onMove(scene.id, start.sx + (ev.clientX - start.x) / k, start.sy + (ev.clientY - start.y) / k);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const stop = (e) => e.stopPropagation();
  const canVideo = !busy && !!asset && !!scene.prompt.trim();

  return (
    <div className={`scene-card glass ${scene.mv ? 'mv' : ''}`} style={{ left: scene.x, top: scene.y }}>
      <div className="card-head" onPointerDown={startDrag}>
        <span className="badge">{idx + 1}</span>
        <span className="card-title" title={scene.title || `Scene ${idx + 1}`}>{scene.title || `Scene ${idx + 1}`}</span>
        <span className={`engine-tag ${isH3 ? 'h3' : 'ltx'}`} title={isH3 ? 'MiniMax H3 (video + audio)' : 'LTX 2.3'}>{isH3 ? 'H3' : 'LTX'}</span>
        <button className="xbtn" onPointerDown={stop} onClick={() => onDelete(scene.id)}>✕</button>
      </div>

      <div className="card-media" onPointerDown={startDrag} onDoubleClick={() => onOpenDetail(scene.id)}
        title="Double-click to open">
        {videoAsset ? (
          (videoAsset.kind === 'video' || String(videoAsset.mime || '').startsWith('video')) ? (
            <video src={videoAsset.url} controls loop muted />
          ) : (
            <img src={videoAsset.url} alt="result" />
          )
        ) : asset ? (
          <img src={asset.url} alt="scene" />
        ) : (
          <div className="card-missing" onPointerDown={stop}>
            <div className="hint">No still yet</div>
            <button className="mini-primary" disabled={busy || !(scene.stillPrompt || '').trim()}
              title={(scene.stillPrompt || '').trim() ? 'Generate the key frame with Krea 2 from the still prompt (open the card to edit it)' : 'Open the card and write a still prompt first'}
              onClick={() => onGenerateStill(scene.id)}>{busy ? '…' : '🎨 Generate still'}</button>
          </div>
        )}
      </div>

      {castNames.length > 0 && (
        <div className="card-cast" title="Characters in this scene (faces pinned on the still)">
          {castNames.map((n) => <span key={n} className="chip">{n}</span>)}
        </div>
      )}

      {secLabels.length > 0 && (
        <div className="card-cast" title="Song section(s) this shot is scheduled to be cut into — it can recur in more than one">
          {secLabels.map((l) => <span key={l} className="chip sec-chip">{l}</span>)}
        </div>
      )}

      <textarea
        className="card-prompt"
        rows={2}
        placeholder={isH3 ? 'What happens in the clip — motion, camera, performance… ( | splits shots)' : 'Describe this shot — motion, mood, style… ( | splits time segments)'}
        title={'Motion prompt. Separate shots with | — each directs a slice of the clip.\nPrefix a segment with [2s] to fix its length. Start one with * for a global anchor.'}
        value={scene.prompt}
        disabled={busy}
        onChange={(e) => onUpdate(scene.id, { prompt: e.target.value })}
        onPointerDown={stop}
      />

      {segSecs && (
        <div className="pt-strip" title="Shots — click to edit visually"
          onPointerDown={stop} onClick={() => onOpenDetail(scene.id)}>
          {segSecs.map((sec, i) => (
            <div key={i} style={{ flexGrow: sec, background: SEG_COLORS[i % SEG_COLORS.length] }}
              title={parsed.segments[i].text} />
          ))}
        </div>
      )}

      <div className="card-row" onPointerDown={stop}>
        {isH3 ? (
          <>
            <label>length
              <select value={scene.frames || 124} disabled={busy}
                onChange={(e) => onUpdate(scene.id, { frames: +e.target.value })}>
                {durations.map((d) => <option key={d.frames} value={d.frames}>{d.label}</option>)}
              </select>
            </label>
            <label>quality
              <select value={scene.preset || 'fast'} disabled={busy}
                title="Fast = 4-step turbo schedule (~2–3 min). Quality = 8 steps, cleaner audio (~2× slower)."
                onChange={(e) => onUpdate(scene.id, { preset: e.target.value })}>
                <option value="fast">Fast</option>
                <option value="quality">Quality</option>
              </select>
            </label>
          </>
        ) : (
          <>
            <label>s
              <input type="number" min={0.5} max={8} step={0.5} value={scene.seconds} disabled={busy}
                onChange={(e) => onUpdate(scene.id, { seconds: +e.target.value })} />
            </label>
            <label>steps
              <input type="number" min={1} max={50} value={scene.steps} disabled={busy}
                onChange={(e) => onUpdate(scene.id, { steps: +e.target.value })} />
            </label>
          </>
        )}
        {videoAsset && onToTimeline && (
          <button className="mini" onPointerDown={stop} onClick={() => onToTimeline(videoAsset.id)}
            title="Put this clip on the Timeline (end of the main track)">🎞 Timeline</button>
        )}
        <button className="mini-primary" disabled={!canVideo}
          title={!asset ? 'Generate a still first — video starts from it' : ''}
          onClick={() => onGenerate(scene.id)}>
          {busy ? '…' : videoAsset ? '↻ Re-gen' : '▶ Video'}
        </button>
      </div>

      {busy && (
        <div className="card-progress" onPointerDown={stop}>
          <GenProgress progress={(scene.gen.progress || 0)} status={scene.gen.status} onCancel={() => onCancel(scene)} cancelDisabled={!scene.gen.jobId} />
        </div>
      )}
      {scene.gen?.phase === 'error' && <div className="error" onPointerDown={stop}>{scene.gen.error}</div>}
    </div>
  );
}
