// Timeline model + pure edit operations for the Hoodsfield editor. No React in here.
//
// timeline = { aspect, fps, look, v1:[clip], v2:[clip], text:[textClip], audio:[clip], zoom }
// clip     = { id, assetId, kind:'video'|'image'|'audio', name, start, in, out, srcDur, speed, volume, mute,
//              fadeIn, fadeOut, x, y, scale, opacity }
// All times are seconds. A clip occupies [start, start + (out-in)/speed) on the timeline.

export const ASPECTS = {
  '16:9': { w: 1280, h: 720, label: '16:9 landscape' },
  '9:16': { w: 720, h: 1280, label: '9:16 vertical' },
  '1:1': { w: 1080, h: 1080, label: '1:1 square' },
  '4:5': { w: 1080, h: 1350, label: '4:5 portrait' },
  '21:9': { w: 1680, h: 720, label: '21:9 cinema' },
};
export const EXPORT_SCALE = { '720p': 1, '1080p': 1.5 };
export const TRACKS = [
  { id: 'v2', label: 'Overlay', kind: 'video' },
  { id: 'text', label: 'Text', kind: 'text' },
  { id: 'v1', label: 'Video', kind: 'video' },
  { id: 'audio', label: 'Audio', kind: 'audio' },
];

let _n = 0;
export const cid = () => `c${Date.now().toString(36)}${(_n++).toString(36)}`;

export const newTimeline = () => ({ aspect: '16:9', fps: 30, look: 'none', v1: [], v2: [], text: [], audio: [], zoom: 70 });

export const clipDur = (c) => Math.max(0.05, (c.out - c.in) / (c.speed || 1));
export const clipEnd = (c) => c.start + clipDur(c);
export const textEnd = (t) => t.start + t.dur;

export const timelineDuration = (tl) => Math.max(
  0,
  ...tl.v1.map(clipEnd), ...tl.v2.map(clipEnd), ...tl.audio.map(clipEnd), ...tl.text.map(textEnd),
);

export const canvasFor = (tl, exportScale = 1) => {
  const a = ASPECTS[tl.aspect] || ASPECTS['16:9'];
  return { width: Math.round((a.w * exportScale) / 2) * 2, height: Math.round((a.h * exportScale) / 2) * 2 };
};

/** Build a clip from a Gallery asset. `srcDur` may be unknown (null) until its metadata is measured. */
export function clipFromAsset(asset, track, start, srcDur) {
  const kind = asset.mime?.startsWith('audio') || asset.kind === 'audio' ? 'audio'
    : asset.mime?.startsWith('video') || asset.kind === 'video' ? 'video' : 'image';
  const dur = kind === 'image' ? 4 : (srcDur || asset.meta?.seconds || 4);
  return {
    id: cid(), assetId: asset.id, kind, name: asset.meta?.name || asset.name || 'clip', start,
    in: 0, out: dur, srcDur: kind === 'image' ? 3600 : dur, speed: 1, volume: 1, mute: false,
    fadeIn: 0, fadeOut: 0,
    ...(track === 'v2' ? { x: 0.8, y: 0.2, scale: 0.28, opacity: 1 } : {}),
  };
}

export const newText = (start, text = 'Your text here') => ({
  id: cid(), text, start, dur: 3, size: 0.07, color: '#ffffff', x: 0.5, y: 0.86, box: true,
});

const sortByStart = (arr) => [...arr].sort((a, b) => a.start - b.start);

/** Set a dissolve on clips that overlap the one before them (video track). */
export function autoTransitions(clips) {
  const s = sortByStart(clips);
  return s.map((c, i) => {
    if (i === 0) return { ...c, fadeIn: c.fadeInManual ? c.fadeIn : 0 };
    const prev = s[i - 1];
    const overlap = clipEnd(prev) - c.start;
    return overlap > 0.05 ? { ...c, fadeIn: Math.min(overlap, clipDur(c) / 2, clipDur(prev) / 2), fadeInManual: false } : c;
  });
}

/** Append to the end of a track (v1/audio) or at `at` (overlays). */
export function addClipToTrack(tl, track, clip) {
  const arr = tl[track];
  const withStart = { ...clip };
  if (track === 'v1') withStart.start = arr.length ? Math.max(...arr.map(clipEnd)) : 0;
  return { ...tl, [track]: [...arr, withStart] };
}

export function updateClip(tl, track, id, patch) {
  const arr = tl[track].map((c) => (c.id === id ? { ...c, ...patch } : c));
  return { ...tl, [track]: track === 'v1' ? autoTransitions(arr) : arr };
}

export function removeClip(tl, track, id, ripple = false) {
  const gone = tl[track].find((c) => c.id === id);
  let arr = tl[track].filter((c) => c.id !== id);
  if (ripple && gone && track !== 'text') {
    const d = clipDur(gone);
    arr = arr.map((c) => (c.start >= clipEnd(gone) - 1e-6 ? { ...c, start: Math.max(0, c.start - d) } : c));
  }
  return { ...tl, [track]: arr };
}

/** Split the clip at timeline time t (no-op if t is not strictly inside it). */
export function splitClip(tl, track, id, t) {
  const c = tl[track].find((x) => x.id === id);
  if (!c) return tl;
  if (track === 'text') {
    if (t <= c.start + 0.1 || t >= textEnd(c) - 0.1) return tl;
    const a = { ...c, dur: t - c.start };
    const b = { ...c, id: cid(), start: t, dur: textEnd(c) - t };
    return { ...tl, text: tl.text.flatMap((x) => (x.id === id ? [a, b] : [x])) };
  }
  if (t <= c.start + 0.1 || t >= clipEnd(c) - 0.1) return tl;
  const srcAt = c.in + (t - c.start) * c.speed;
  const a = { ...c, out: srcAt, fadeOut: 0 };
  const b = { ...c, id: cid(), start: t, in: srcAt, fadeIn: 0 };
  const arr = tl[track].flatMap((x) => (x.id === id ? [a, b] : [x]));
  return { ...tl, [track]: arr };
}

export function duplicateClip(tl, track, id) {
  const c = (track === 'text' ? tl.text : tl[track]).find((x) => x.id === id);
  if (!c) return tl;
  const end = track === 'text' ? textEnd(c) : clipEnd(c);
  const copy = { ...c, id: cid(), start: end };
  return { ...tl, [track]: [...tl[track], copy] };
}

/** Snap a proposed start to 0, the playhead and neighbouring clip edges within `tol` seconds. */
export function snapStart(tl, track, id, proposed, dur, playhead, tol, extra = []) {
  const edges = [0, playhead, ...extra];
  for (const tr of ['v1', 'v2', 'audio']) {
    for (const c of tl[tr]) { if (c.id !== id) { edges.push(c.start, clipEnd(c)); } }
  }
  for (const t of tl.text) { if (t.id !== id) edges.push(t.start, textEnd(t)); }
  let best = proposed, bestD = tol;
  for (const e of edges) {
    for (const cand of [e, e - dur]) {
      const d = Math.abs(cand - proposed);
      if (d < bestD) { best = cand; bestD = d; }
    }
  }
  return Math.max(0, best);
}

/** The clip showing on a track at time t (later start wins, so an overlapping clip covers the earlier one). */
export function activeClip(arr, t) {
  let hit = null;
  for (const c of arr) {
    if (t >= c.start && t < clipEnd(c) && (!hit || c.start >= hit.start)) hit = c;
  }
  return hit;
}

/** Source time inside a clip for timeline time t. */
export const sourceTime = (c, t) => c.in + (t - c.start) * (c.speed || 1);

export const fmtTime = (t) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

/** Timeline -> backend JSON (clip.key = assetId; the files are uploaded under the same key). */
export function exportJson(tl, scaleKey = '720p') {
  const { width, height } = canvasFor(tl, EXPORT_SCALE[scaleKey] || 1);
  const pick = (c) => ({
    key: c.assetId, kind: c.kind, start: c.start, in: c.in, out: c.out, speed: c.speed || 1, volume: c.volume ?? 1,
    mute: !!c.mute, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
    ...(c.x != null ? { x: c.x, y: c.y, scale: c.scale, opacity: c.opacity ?? 1 } : {}),
    ...(c.grade ? { grade: c.grade, gradeAmt: c.gradeAmt ?? 1 } : {}),
    ...(c.fx?.length ? { fx: c.fx.map((e) => ({ id: e.id, amt: e.amt ?? 0.5 })) } : {}),
    ...(c.cam?.id ? { cam: { id: c.cam.id, amt: c.cam.amt ?? 0.5 } } : {}),
    ...(c.kf && Object.values(c.kf).some((a) => a?.length) ? { kf: c.kf } : {}),
  });
  return { width, height, fps: tl.fps || 30, look: tl.look || 'none', v1: tl.v1.map(pick), v2: tl.v2.map(pick), audio: tl.audio.map(pick), text: tl.text.map((t) => ({ ...t })) };
}


// ------------------------------------------------------------------ keyframes
// clip.kf = { opacity:[{t,v,e}], zoom, scale, x, y, volume }   t = seconds from the clip's start on the timeline, e = 'smooth' | 'linear' | 'hold'
export const KF_PROPS = {
  opacity: { label: 'Opacity', min: 0, max: 1, step: 0.01, tracks: ['v1', 'v2'], base: () => 1 },
  zoom: { label: 'Zoom', min: 1, max: 3, step: 0.01, tracks: ['v1'], base: () => 1 },
  scale: { label: 'Size', min: 0.05, max: 1, step: 0.01, tracks: ['v2'], base: (c) => c.scale ?? 0.3 },
  x: { label: 'Position X', min: 0, max: 1, step: 0.01, tracks: ['v2'], base: (c) => c.x ?? 0.5 },
  y: { label: 'Position Y', min: 0, max: 1, step: 0.01, tracks: ['v2'], base: (c) => c.y ?? 0.5 },
  volume: { label: 'Volume', min: 0, max: 2, step: 0.05, tracks: ['v1', 'v2', 'audio'], base: () => 1 },
};
const ease = (e, u) => (e === 'linear' ? u : u * u * (3 - 2 * u));

/** The value of a keyframed property at `tl` seconds into the clip (same maths as the exporter); `fallback` when it has no keys. */
export function kfValue(clip, prop, tl, fallback) {
  const pts = clip?.kf?.[prop];
  if (!pts?.length) return fallback;
  if (pts.length === 1 || tl <= pts[0].t) return pts[0].v;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (tl < b.t) {
      if (a.e === 'hold') return a.v;
      const u = Math.min(1, Math.max(0, (tl - a.t) / Math.max(1e-3, b.t - a.t)));
      return a.v + (b.v - a.v) * ease(a.e || 'smooth', u);
    }
  }
  return pts[pts.length - 1].v;
}

/** Set a key at clip-local time t (replaces one within 1/20 s). Returns the new kf object, keys sorted. */
export function setKeyframe(clip, prop, t, v, e = 'smooth') {
  const pts = (clip.kf?.[prop] || []).filter((k) => Math.abs(k.t - t) > 0.05);
  pts.push({ t: Math.max(0, +t.toFixed(3)), v: +v.toFixed(4), e });
  pts.sort((a, b) => a.t - b.t);
  return { ...(clip.kf || {}), [prop]: pts };
}

// ------------------------------------------------------------------ beats
/** Absolute timeline times of every beat of the first music clip that has been analysed. */
export function beatTimes(tl) {
  const m = tl.audio.find((c) => c.beats?.length);
  if (!m) return { times: [], downbeats: [], clip: null };
  const sp = m.speed || 1;
  const map = (arr) => (arr || []).filter((b) => b >= m.in && b <= m.out).map((b) => m.start + (b - m.in) / sp);
  return { times: map(m.beats), downbeats: map(m.downbeats), clip: m };
}

/**
 * Cut the main track to the music: every video/image clip on V1 (in its current order) is trimmed to a whole number of beats and
 * laid end to end on the beat grid, starting at the first beat. `pace`: 'beat' | '2beat' | 'bar' | 'build' (4 -> 2 -> 1 beats) | 'mix'.
 * Source clips shorter than the slot are shortened to the largest whole number of beats they can fill. Loops the clips to cover the song.
 */
export function autoCutToBeats(tl, { pace = '2beat', loop = true } = {}) {
  const { times, clip: music } = beatTimes(tl);
  const clips = [...tl.v1].sort((a, b) => a.start - b.start);
  if (!music || times.length < 4 || !clips.length) return tl;
  const end = clipEnd(music);
  const slotBeats = (i, n) => {
    if (pace === 'beat') return 1;
    if (pace === 'bar') return 4;
    if (pace === 'build') { const k = n > 1 ? i / (n - 1) : 1; return k < 0.4 ? 4 : k < 0.75 ? 2 : 1; }
    if (pace === 'mix') return [2, 1, 2, 4, 1, 2][i % 6];
    return 2;
  };
  const out = [];
  let b = 0;                                             // index into the beat grid
  let i = 0;
  const total = loop ? Math.max(clips.length, Math.ceil(times.length / 2)) : clips.length;
  while (b < times.length - 1 && i < total) {
    const src = clips[i % clips.length];
    let nb = slotBeats(i, total);
    nb = Math.min(nb, times.length - 1 - b);
    const t0 = times[b];
    let t1 = times[b + nb];
    if (t0 >= end - 0.05) break;
    const avail = src.kind === 'image' ? 1e9 : ((src.srcDur ?? src.out) - src.in) / (src.speed || 1);   // how long this clip can play from its in-point
    while (nb > 1 && t1 - t0 > avail) { nb -= 1; t1 = times[b + nb]; }
    const dur = Math.min(t1 - t0, avail);
    out.push({ ...src, id: i < clips.length ? src.id : cid(), start: +t0.toFixed(3), out: +(src.in + dur * (src.speed || 1)).toFixed(3), fadeIn: 0, fadeOut: 0 });
    b += nb; i += 1;
    if (!loop && i >= clips.length) break;
  }
  return { ...tl, v1: out };
}

// ------------------------------------------------------------------ captions
export const CAPTION_STYLES = {
  pop: { label: 'Pop: big words, centre', words: 2, size: 0.1, y: 0.62, color: '#ffffff', box: false, upper: true },
  bold: { label: 'Bold yellow, lower', words: 3, size: 0.075, y: 0.8, color: '#ffe14a', box: false, upper: true },
  lines: { label: 'Subtitles: boxed lines', words: 6, size: 0.05, y: 0.88, color: '#ffffff', box: true, upper: false },
};

/** Words [{w,start,end}] (seconds in the source clip) -> text clips on the timeline, grouped into short chunks that follow the speech. */
export function captionClips(words, srcClip, styleId = 'pop') {
  const st = CAPTION_STYLES[styleId] || CAPTION_STYLES.pop;
  const sp = srcClip.speed || 1;
  const inside = words.filter((w) => w.end > srcClip.in && w.start < srcClip.out);
  const chunks = [];
  let cur = [];
  inside.forEach((w, k) => {
    cur.push(w);
    const gap = inside[k + 1] ? inside[k + 1].start - w.end : 9;
    if (cur.length >= st.words || /[.!?]$/.test(w.w) || gap > 0.6) { chunks.push(cur); cur = []; }
  });
  if (cur.length) chunks.push(cur);
  return chunks.map((ch, k) => {
    const next = chunks[k + 1]?.[0]?.start;
    const t0 = srcClip.start + (Math.max(ch[0].start, srcClip.in) - srcClip.in) / sp;
    let t1 = srcClip.start + (Math.min(ch[ch.length - 1].end, srcClip.out) - srcClip.in) / sp;
    if (next != null) t1 = Math.min(Math.max(t1, t0 + 0.25), srcClip.start + (next - srcClip.in) / sp);   // hold until the next chunk starts
    const text = ch.map((w) => w.w).join(' ');
    return { id: cid(), text: st.upper ? text.toUpperCase() : text, start: +t0.toFixed(3), dur: +Math.max(0.25, t1 - t0).toFixed(3), size: st.size, color: st.color, x: 0.5, y: st.y, box: st.box };
  });
}
