// Colour grades, effects and camera moves for Timeline clips. The catalogue (ids, labels, CSS approximations for the live
// preview) comes from the backend (backend/timeline_fx.py) so the preview and the export use the same ids. The preview is an
// approximation; the export is exact. camState() mirrors camera_filter() in timeline_fx.py.
import { useEffect, useState } from 'react';

const EMPTY = { grades: [], fx: [], cams: [], luts: [] };
let cache = null;
let inflight = null;
const subs = new Set();

export async function loadFxCatalog(force = false) {
  if (cache && !force) return cache;
  if (!inflight || force) {
    inflight = fetch('/api/timeline/fx').then((r) => (r.ok ? r.json() : EMPTY)).catch(() => EMPTY).then((c) => { cache = c; subs.forEach((f) => f(c)); return c; });
  }
  return inflight;
}

export function useFxCatalog() {
  const [c, setC] = useState(cache || EMPTY);
  useEffect(() => { subs.add(setC); loadFxCatalog().then(setC); return () => { subs.delete(setC); }; }, []);
  return c;
}

export async function uploadLut(file) {
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch('/api/timeline/luts', { method: 'POST', body: fd });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* plain text */ } throw new Error(d); }
  await loadFxCatalog(true);
  return (await r.json()).name;
}

export const groupBy = (list) => list.reduce((m, x) => { (m[x.group] = m[x.group] || []).push(x); return m; }, {});

/** CSS filter text for a grade id (built-in only; a .cube LUT has no CSS stand-in, so it previews as a slight contrast lift). */
export function gradeCss(cat, id) {
  if (!id || id === 'none') return '';
  if (id.startsWith('lut:')) return 'contrast(1.05) saturate(1.05)';
  return cat.grades.find((g) => g.id === id)?.css || '';
}

/** CSS filter for the clip's filter-like effects. */
export function fxFilterCss(list) {
  const out = [];
  for (const e of list || []) {
    const a = e.amt ?? 0.5;
    if (e.id === 'blur') out.push(`blur(${(0.4 + 5 * a).toFixed(1)}px)`);
    else if (e.id === 'dream' || e.id === 'glow') out.push(`brightness(${(1 + 0.12 * a).toFixed(2)}) contrast(${(1 - 0.1 * a).toFixed(2)}) saturate(${(1 + 0.15 * a).toFixed(2)}) blur(${(0.3 + 1.2 * a).toFixed(1)}px)`);
    else if (e.id === 'chroma') out.push(`drop-shadow(${(1 + 3 * a).toFixed(1)}px 0 0 rgba(255,0,60,0.55)) drop-shadow(${(-1 - 3 * a).toFixed(1)}px 0 0 rgba(0,200,255,0.55))`);
    else if (e.id === 'negative') out.push('invert(1)');
    else if (e.id === 'sharpen') out.push(`contrast(${(1 + 0.12 * a).toFixed(2)})`);
    else if (e.id === 'sketch') out.push('grayscale(1) contrast(2.2) invert(1)');
    else if (e.id === 'vhs') out.push(`saturate(${(1.1 + 0.3 * a).toFixed(2)}) contrast(0.94) blur(0.4px)`);
    else if (e.id === 'halftone') out.push('contrast(1.4) saturate(1.4)');
  }
  return out.join(' ');
}

/** Overlay layers the preview paints on top of the picture: [{cls, style}] */
export function fxOverlays(list, aspect = 16 / 9) {
  const out = [];
  for (const e of list || []) {
    const a = e.amt ?? 0.5;
    if (e.id === 'vignette') out.push({ key: 'v', cls: 'tl-fxo-vig', style: { opacity: 0.35 + 0.65 * a } });
    else if (e.id === 'grain') out.push({ key: 'g', cls: 'tl-fxo-grain', style: { opacity: 0.12 + 0.5 * a } });
    else if (e.id === 'scanlines' || e.id === 'vhs') out.push({ key: 's' + e.id, cls: 'tl-fxo-scan', style: { opacity: 0.25 + 0.6 * a } });
    else if (e.id === 'letterbox') out.push({ key: 'b', cls: 'tl-fxo-bars', style: { '--bar': `${Math.max(0, (1 - aspect / 2.39) / 2) * 100}%` } });
    else if (e.id === 'flicker') out.push({ key: 'f', cls: 'tl-fxo-flicker', style: { opacity: 0.4 + 0.6 * a } });
  }
  return out;
}

/** The virtual camera at clip-local time tc (seconds) of a clip lasting T seconds -> {z, fx, fy, rot} (fx/fy 0..1 across the margin). */
export function camState(cam, tc, T) {
  if (!cam?.id) return null;
  const a = Math.max(0, Math.min(1, cam.amt ?? 0.5));
  const p = Math.max(0, Math.min(1, tc / Math.max(0.2, T)));
  const t = tc;
  const S = (s) => Math.sin(s);
  switch (cam.id) {
    case 'push_in': return { z: 1 + 0.30 * a * p, fx: 0.5, fy: 0.5, rot: 0 };
    case 'pull_out': return { z: 1 + 0.30 * a * (1 - p), fx: 0.5, fy: 0.5, rot: 0 };
    case 'slow_push': return { z: 1 + 0.10 * a * p, fx: 0.5, fy: 0.5, rot: 0 };
    case 'pan_left': return { z: 1 + 0.20 * a, fx: 1 - p, fy: 0.5, rot: 0 };
    case 'pan_right': return { z: 1 + 0.20 * a, fx: p, fy: 0.5, rot: 0 };
    case 'tilt_up': return { z: 1 + 0.20 * a, fx: 0.5, fy: 1 - p, rot: 0 };
    case 'tilt_down': return { z: 1 + 0.20 * a, fx: 0.5, fy: p, rot: 0 };
    case 'drift': return { z: 1 + 0.14 * a, fx: 0.5 + 0.5 * S(t * 0.45), fy: 0.5 + 0.5 * S(t * 0.31 + 1), rot: 0 };
    case 'ken_burns': return { z: 1 + 0.28 * a * p, fx: 0.35 + 0.3 * p, fy: 0.6 - 0.2 * p, rot: 0 };
    case 'ken_burns_out': { const z = 1 + 0.28 * a; return { z: z - (z - 1) * p, fx: 0.65 - 0.3 * p, fy: 0.4 + 0.2 * p, rot: 0 }; }
    case 'handheld': case 'handheld_heavy': case 'earthquake': {
      const k = { handheld: 0.35, handheld_heavy: 0.8, earthquake: 1.0 }[cam.id];
      const [s1, s2, s3] = cam.id === 'earthquake' ? [23, 31, 9] : [6.1, 11.3, 2.3];
      const amp = Math.min(1, k * (0.35 + 0.9 * a));
      return {
        z: 1 + (0.05 + 0.07 * k) * (0.4 + a),
        fx: 0.5 + amp * 0.5 * (0.6 * S(t * s1) + 0.3 * S(t * s2 + 1.3) + 0.5 * S(t * s3 + 0.4)) / 1.4,
        fy: 0.5 + amp * 0.5 * (0.6 * S(t * s1 * 1.13 + 2.1) + 0.3 * S(t * s2 * 0.9 + 0.7) + 0.5 * S(t * s3 * 1.2 + 1.9)) / 1.4,
        rot: 0,
      };
    }
    case 'impact': { const d = Math.exp(-t * (3 + 3 * (1 - a))); return { z: 1 + 0.10 * (0.5 + a), fx: 0.5 + 0.5 * d * S(t * 38), fy: 0.5 + 0.5 * d * S(t * 31 + 1), rot: 0 }; }
    case 'roll': return { z: 1.12, fx: 0.5, fy: 0.5, rot: 0.06 * a * S(t * 0.5) };
    case 'dutch': return { z: 1.5, fx: 0.5, fy: 0.5, rot: 0.09 + 0.13 * a };
    default: return null;
  }
}

export function camTransform(cam, tc, T) {
  const s = camState(cam, tc, T);
  if (!s) return '';
  const tx = (0.5 - s.fx) * (s.z - 1) * 100, ty = (0.5 - s.fy) * (s.z - 1) * 100;
  return `translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%) rotate(${s.rot.toFixed(4)}rad) scale(${s.z.toFixed(4)})`;
}

export const FX_MAX = 4;
