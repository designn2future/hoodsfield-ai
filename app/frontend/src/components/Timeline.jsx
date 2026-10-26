import React from 'react';

export default function Timeline({
  time, setTime, seconds, keyframes, playing, setPlaying,
  throughLens, setThroughLens, onAddKeyframe, onDeleteKeyframe, onClear, disabled,
}) {
  return (
    <footer className="timeline">
      <div className="tl-buttons">
        <button onClick={() => setPlaying((p) => !p)} disabled={disabled || keyframes.length < 2}
          title={keyframes.length < 2 ? 'Add at least 2 keyframes to preview' : ''}>
          {playing ? '■ Stop' : '▶ Play'}
        </button>
        <button className={throughLens ? 'active' : ''} onClick={() => setThroughLens((v) => !v)}
          disabled={!keyframes.length} title="View through the shot camera">
          🎥 Lens
        </button>
        <button onClick={onAddKeyframe} disabled={disabled} title="Capture current view as a camera keyframe at the playhead">
          + Keyframe
        </button>
        <button onClick={onClear} disabled={!keyframes.length}>Clear</button>
      </div>

      <div className="tl-track">
        <input type="range" min={0} max={seconds} step={0.01} value={time}
          onChange={(e) => setTime(parseFloat(e.target.value))} />
        <div className="tl-markers">
          {keyframes.map((k) => (
            <span key={k.id} className="kf" style={{ left: `${(k.t / seconds) * 100}%` }}
              title={`Keyframe @ ${k.t.toFixed(2)}s — click to jump, double-click to delete`}
              onClick={() => setTime(k.t)}
              onDoubleClick={() => onDeleteKeyframe(k.id)} />
          ))}
        </div>
      </div>

      <span className="tl-time">{time.toFixed(2)}s / {seconds}s · {keyframes.length} keys</span>
    </footer>
  );
}
