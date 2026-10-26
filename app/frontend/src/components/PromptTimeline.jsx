import React, { useEffect, useRef, useState } from 'react';

/** Segment palette — matches the PromptRelay timeline widget's look. */
export const SEG_COLORS = ['#5cb85c', '#4f8edc', '#e07b3a', '#b05bd6', '#d6b25b', '#5bc9d6', '#d65b8a', '#7d8fd0'];

const TAG_RE = /^\[(\d+(?:\.\d+)?)\s*(s|f)\]\s*/i;
const uid = () => Math.random().toString(36).slice(2, 9);
const round1 = (x) => Math.round(x * 10) / 10;

/** Parse the scene-prompt timeline DSL (mirror of backend `_parse_timeline_prompt`):
 * `|` splits time segments, a leading `[3s]`/`[72f]` fixes a segment's
 * duration, `*` marks the global anchor. A plain prompt parses to one
 * full-length segment. */
export function parsePrompt(str, fps = 24) {
  const global = [];
  const segments = [];
  for (const raw of (str || '').split('|')) {
    let text = raw.trim();
    if (!text) continue;
    if (text.startsWith('*')) {
      global.push(text.replace(/^\*+\s*/, ''));
      continue;
    }
    let sec = null;
    const m = TAG_RE.exec(text);
    if (m) {
      const n = parseFloat(m[1]);
      sec = m[2].toLowerCase() === 's' ? n : n / fps;
      text = text.slice(m[0].length).trim();
    }
    if (text) segments.push({ id: uid(), text, sec });
  }
  if (!segments.length) segments.push({ id: uid(), text: '', sec: null });
  return { global: global.join(' '), segments };
}

export function serializePrompt({ global, segments }) {
  const parts = [];
  if (global.trim()) parts.push(`*${global.trim()}`);
  for (const s of segments) {
    const text = s.text.trim();
    if (!text) continue;
    parts.push(s.sec != null ? `[${round1(s.sec)}s] ${text}` : text);
  }
  return parts.join(' | ');
}

/** Seconds each segment actually occupies: fixed segments keep their tag,
 * untagged ones share the remaining runtime evenly (same rule the backend
 * uses when computing PromptRelay segment_lengths). */
export function effectiveSecs(segments, totalSeconds) {
  const fixedSum = segments.reduce((a, s) => a + (s.sec ?? 0), 0);
  const autos = segments.filter((s) => s.sec == null).length;
  const share = autos ? Math.max((totalSeconds - fixedSum) / autos, 0.2) : 0;
  return segments.map((s) => (s.sec != null ? s.sec : share));
}

/** Visual editor for multi-prompt timeline videos: color-coded regions on a
 * duration bar (drag the boundaries to retime), one prompt per region, plus
 * an optional global anchor. Reads/writes the plain DSL string, so it stays
 * interchangeable with the raw-text prompt box. */
export default function PromptTimeline({ value, seconds, fps = 24, disabled, onChange }) {
  const lastEmitted = useRef(value);
  const [model, setModel] = useState(() => parsePrompt(value, fps));
  const [sel, setSel] = useState(0);
  const barRef = useRef(null);

  // External edits (project load, raw-text mode, card textarea) → re-parse.
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setModel(parsePrompt(value, fps));
      setSel(0);
    }
  }, [value, fps]);

  const emit = (next) => {
    setModel(next);
    const s = serializePrompt(next);
    lastEmitted.current = s;
    onChange(s);
  };

  const eff = effectiveSecs(model.segments, seconds);
  const total = eff.reduce((a, b) => a + b, 0);
  const color = (i) => SEG_COLORS[i % SEG_COLORS.length];

  const setSegText = (i, text) =>
    emit({ ...model, segments: model.segments.map((s, j) => (j === i ? { ...s, text } : s)) });

  const setSegSec = (i, sec) =>
    emit({
      ...model,
      segments: model.segments.map((s, j) =>
        j === i ? { ...s, sec: sec != null && sec > 0 ? sec : null } : s),
    });

  const addSeg = () => {
    emit({ ...model, segments: [...model.segments, { id: uid(), text: '', sec: null }] });
    setSel(model.segments.length);
  };

  const removeSeg = (i) => {
    if (model.segments.length <= 1) return;
    emit({ ...model, segments: model.segments.filter((_, j) => j !== i) });
    setSel((s) => Math.max(0, Math.min(s, model.segments.length - 2)));
  };

  const evenSplit = () =>
    emit({ ...model, segments: model.segments.map((s) => ({ ...s, sec: null })) });

  /** Drag the boundary between segment i and i+1 — both become fixed-length,
   * their combined duration stays constant so the rest of the bar holds. */
  const startDrag = (i, e) => {
    if (disabled) return;
    e.preventDefault();
    const effNow = effectiveSecs(model.segments, seconds);
    const pair = effNow[i] + effNow[i + 1];
    const pxPerSec = barRef.current.getBoundingClientRect().width / effNow.reduce((a, b) => a + b, 0);
    const startX = e.clientX;
    const segsAtStart = model.segments;
    const move = (ev) => {
      const a = round1(Math.min(Math.max(effNow[i] + (ev.clientX - startX) / pxPerSec, 0.2), pair - 0.2));
      emit({
        ...model,
        segments: segsAtStart.map((s, j) =>
          j === i ? { ...s, sec: a } : j === i + 1 ? { ...s, sec: round1(pair - a) } : s),
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const allFixed = model.segments.every((s) => s.sec != null);
  const overrun = allFixed && Math.abs(total - seconds) > 0.05;

  return (
    <div className="pt">
      <div className="pt-bar" ref={barRef}>
        {model.segments.map((s, i) => (
          <React.Fragment key={s.id}>
            <div
              className={`pt-seg ${sel === i ? 'sel' : ''}`}
              style={{ flexGrow: eff[i], background: color(i) }}
              title={s.text || `Segment ${i + 1}`}
              onClick={() => setSel(i)}
            >
              <span className="pt-seg-time">{round1(eff[i])}s</span>
            </div>
            {i < model.segments.length - 1 && (
              <div className="pt-handle" title="Drag to retime" onPointerDown={(e) => startDrag(i, e)} />
            )}
          </React.Fragment>
        ))}
      </div>

      <label className="pt-label" title="Persistent context prepended for the whole clip — character, setting, style. Maps to the * segment.">
        Global anchor (whole clip — character / setting / style)
      </label>
      <textarea
        className="pt-global" rows={2} value={model.global} disabled={disabled}
        placeholder="e.g. astronaut on a dusty alien plain, cinematic…"
        onChange={(e) => emit({ ...model, global: e.target.value.replace(/\|/g, '/') })}
      />

      {model.segments.map((s, i) => (
        <div key={s.id} className={`pt-row ${sel === i ? 'sel' : ''}`} onFocusCapture={() => setSel(i)}>
          <span className="pt-dot" style={{ background: color(i) }} />
          <textarea
            rows={3} value={s.text} disabled={disabled}
            placeholder={`Segment ${i + 1} — what happens during this slice…`}
            onChange={(e) => setSegText(i, e.target.value.replace(/\|/g, '/'))}
          />
          <div className="pt-row-side">
            <input
              className="pt-sec" type="number" min={0.2} step={0.1} disabled={disabled}
              value={s.sec ?? ''} placeholder={`${round1(eff[i])}s`}
              title="Duration in seconds — leave blank to share the remaining time evenly"
              onChange={(e) => setSegSec(i, e.target.value === '' ? null : +e.target.value)}
            />
            <button className="xbtn" disabled={disabled || model.segments.length <= 1}
              title="Remove segment" onClick={() => removeSeg(i)}>✕</button>
          </div>
        </div>
      ))}

      <div className="pt-actions">
        <button disabled={disabled || model.segments.length >= SEG_COLORS.length} onClick={addSeg}>＋ Segment</button>
        <button disabled={disabled} title="Clear fixed durations — segments share the clip evenly" onClick={evenSplit}>Even split</button>
      </div>
      {overrun && (
        <div className="hint pt-warn">
          Segments total {round1(total)}s but the clip is {seconds}s — durations will be squeezed to fit.
        </div>
      )}
    </div>
  );
}
