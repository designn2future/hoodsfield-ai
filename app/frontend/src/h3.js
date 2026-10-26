import { withMotion } from './genreStore.js';
/** MiniMax H3 helpers shared by scene cards, the detail view and the
 * music-video director. Mirrors backend/h3.py (frame grid, canvas rule). */

export const H3_FPS = 24;
/** 17k+5 frame grid; the backend clamps to its H3_MAX_FRAMES (175 = 7.3 s). */
export const H3_GRID_FALLBACK = [22, 39, 56, 73, 90, 107, 124, 141, 158, 175];
export const H3_DEFAULT_FRAMES = 124;

export const framesToSeconds = (f) => f / H3_FPS;

/** Nearest grid length at or below `frames`. */
export function snapFrames(frames, grid = H3_GRID_FALLBACK) {
  let out = grid[0];
  for (const f of grid) { if (f <= frames) out = f; else break; }
  return out;
}

export const secondsToFrames = (s, grid) => snapFrames(Math.round(s * H3_FPS + 1e-6), grid);

export function durationOptions(grid = H3_GRID_FALLBACK) {
  return grid.map((f, i) => ({
    frames: f,
    seconds: framesToSeconds(f),
    label: `${framesToSeconds(f).toFixed(1)} s${i === grid.length - 1 ? ' (max)' : ''}`,
  }));
}

/** Canvas for a pixel budget at an aspect (w/h), /32, width rounded first. */
export function canvasFor(aspect, megapixels = 0.4) {
  const a = Math.max(0.2, Math.min(5, aspect || 1));
  const area = Math.max(0.05, megapixels) * 1e6;
  const w = Math.max(32, Math.round(Math.sqrt(area * a) / 32) * 32);
  const h = Math.max(32, Math.round((w / a) / 32) * 32);
  return { width: w, height: h };
}

export const ASPECTS = [
  { id: '9:16', ratio: 9 / 16, label: '9:16 vertical' },
  { id: '16:9', ratio: 16 / 9, label: '16:9 widescreen' },
  { id: '1:1', ratio: 1, label: '1:1 square' },
  { id: '4:3', ratio: 4 / 3, label: '4:3' },
  { id: '3:4', ratio: 3 / 4, label: '3:4 portrait' },
];
export const aspectRatio = (id) => (ASPECTS.find((a) => a.id === id) || ASPECTS[0]).ratio;

/** Krea 2 still size for an aspect: ~1.0 MP, multiples of 64. Proven live:
 * the same prompt/seed at 832x1472 (1.2 MP, this function's old default)
 * reliably rendered as a 3-panel vertical contact sheet; at 1024x1024 or
 * 768x1344 (~1.0-1.05 MP) it rendered clean every time. Krea 2's Qwen-Image
 * backbone uses RoPE positional embeddings that don't extrapolate cleanly
 * past its trained resolution buckets — pushing total pixel count past
 * ~1.05 MP measurably raises the odds of this periodic/tiled failure,
 * independent of prompt wording or seed. Stay at or below 1.0 MP. */
export function stillSizeFor(aspectId, megapixels = 1.0) {
  const a = aspectRatio(aspectId);
  const area = megapixels * 1e6;
  const w = Math.max(256, Math.round(Math.sqrt(area * a) / 64) * 64);
  const h = Math.max(256, Math.round((w / a) / 64) * 64);
  return { width: w, height: h };
}

export const RESOLUTIONS = [
  { mp: 0.4, label: '0.4 MP — fast (proven on this GPU)' },
  { mp: 0.56, label: '0.56 MP — 768 short edge, square' },
  { mp: 0.75, label: '0.75 MP' },
  { mp: 0.98, label: '0.98 MP — H3 native 16:9 (heavy)' },
];

/** Read an image blob's aspect (w/h). */
export function imageAspect(url) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img.naturalWidth / img.naturalHeight || 1);
    img.onerror = () => res(16 / 9);
    img.src = url;
  });
}

/** Read a video blob's metadata: {duration, width, height}. */
export function videoMeta(url) {
  return new Promise((res) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => res({ duration: v.duration || 0, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => res({ duration: 0, width: 0, height: 0 });
    v.src = url;
  });
}

export const LOCK_STILL_TEXT =
  'Use the provided image as the exact starting frame and keep its character design, wardrobe, location, composition and lighting.';

/** Description text for a scene's H3 clip: motion prompt (+ dialogue line). */
/** Camera-movement wording for a 0-100 "chaos" level: how frantic the operator is (calm, alert, scared, panicked). */
export function chaosPhrase(level) {
  if (level == null || Number.isNaN(+level)) return '';
  const c = +level;
  if (c < 20) return 'The camera is almost steady, only a slight natural sway, the operator is calm.';
  if (c < 45) return 'Gentle handheld sway, the camera drifts slowly as the operator looks around.';
  if (c < 70) return 'Restless handheld shaking, the framing keeps drifting and correcting, the operator is on edge.';
  if (c < 90) return 'Violent shaking, sudden whip-pans and jerks toward noises, the framing swings wildly, the operator is scared.';
  return 'Frantic, the camera is thrown around wildly, extreme shaking and motion blur, whip-pans in every direction, the operator is panicking.';
}

export function sceneDescription(scene, castNames = []) {
  let desc = withMotion((scene.prompt || '').trim());
  if (scene.chaos != null) desc += ` ${chaosPhrase(scene.chaos)}`;
  const line = (scene.dialogue || '').trim().replace(/^"|"$/g, '');
  if (line) {
    const who = (castNames.length ? castNames.join(', ') : 'the subject');
    desc += `\n\n${who} says clearly and naturally: "${line}"`;
  }
  return desc;
}

/** Fresh scene defaults (H3 is the default engine; LTX 2.3 stays selectable). */
export const SCENE_VIDEO_DEFAULTS = {
  engine: 'h3', preset: 'fast', frames: H3_DEFAULT_FRAMES, megapixels: 0.4,
  soundscape: '', music: 'No music.', dialogue: '', lockStill: true,
  shiftVideo: 12, shiftAudio: 3, sampler: '', steps: 8, seed: -1,
};

// ------------------------------------------------------------------ MiniMax H3 LoRAs
const H3_LORA_KEY = 'hoodsfield.h3loras';
const readH3Default = () => { try { return JSON.parse(localStorage.getItem(H3_LORA_KEY) || '[]'); } catch { return []; } };

/** The scene's own H3 LoRAs, else the saved "every clip" default. */
export const loadH3Loras = (scene) => (Array.isArray(scene?.h3Loras) ? scene.h3Loras : readH3Default());

export const saveH3LoraDefault = (loras) => { try { localStorage.setItem(H3_LORA_KEY, JSON.stringify(loras)); } catch { /* storage blocked */ } };

/** Form entries "name|strength" for /api/generate_h3. */
export const h3LoraParams = (sceneLoras) =>
  (Array.isArray(sceneLoras) ? sceneLoras : readH3Default()).filter((l) => l.name && +l.strength !== 0).map((l) => `${l.name}|${+l.strength || 1}`);
