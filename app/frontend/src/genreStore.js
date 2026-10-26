import { useEffect, useState } from 'react';

// The studio-wide genre / niche (Cinematic, Found footage horror, CCTV, ...). One module-level store so non-React code
// (generation functions) and React components read the same value. Definitions come from the backend (/api/genres).

const KEY = 'hoodsfield.genre.v1';
const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

let defs = [];
let id = read(KEY, 'cinematic');
let autoPost = read(`${KEY}.post`, '1') !== '0';
let autoSound = read(`${KEY}.sound2`, '0') === '1';     // off by default: sound design belongs on the finished video, one continuous layer
let focusMode = read(`${KEY}.focus`, 'genre');     // genre | off | some | a lot: the camera's focus hunting (blurring in and out)
const subs = new Set();
const emit = () => subs.forEach((f) => f());

export async function loadGenres() {
  try { const r = await fetch('/api/genres'); if (r.ok) { defs = (await r.json()).genres || []; emit(); } } catch { /* backend not up yet */ }
}

const FALLBACK = { id: 'cinematic', label: 'Cinematic', icon: '🎬', still_style: '', motion_style: '', sound: '', post: null, post_opts: {} };
export const getGenre = () => defs.find((g) => g.id === id) || FALLBACK;
export const getAutoPost = () => autoPost;
export const getAutoSound = () => autoSound;
export const getFocusMode = () => focusMode;
export function setFocusMode(v) { focusMode = v; write(`${KEY}.focus`, v); emit(); }
/** The post-look focus level: the user's override, else the genre's own. */
export const focusLevel = (genreDefault) => (focusMode === 'genre' ? genreDefault : focusMode);
export function setAutoSound(v) { autoSound = !!v; write(`${KEY}.sound2`, v ? '1' : '0'); emit(); }
export function setGenre(v) { id = v; write(KEY, v); emit(); }
export function setAutoPost(v) { autoPost = !!v; write(`${KEY}.post`, v ? '1' : '0'); emit(); }

const NO_HUNT = /(?:,\s*)?\b(?:auto)?focus (?:hunting|drifting)(?: in and out)?\b,?|(?:,\s*)?\bsoft focus\b,?/gi;
const add = (prompt, style) => {
  const p = (prompt || '').trim();
  if (style && focusMode === 'off') style = `${style.replace(NO_HUNT, ',').replace(/(,\s*){2,}/g, ', ').replace(/\s{2,}/g, ' ').replace(/,\s*$/, '')}, steady sharp focus throughout, no focus hunting, no blur`;
  if (!style || p.includes(style.slice(0, 40))) return p;
  return `${p.replace(/[.\s]+$/, '')}${p ? '. ' : ''}${style}.`;
};
/** Append the genre's camera/footage look to an image prompt (once). */
export const withStill = (prompt) => add(prompt, getGenre().still_style);
/** Append the genre's camera behaviour to a video motion prompt (once). */
export const withMotion = (prompt) => add(prompt, getGenre().motion_style);

export function useGenre() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    subs.add(f);
    if (!defs.length) loadGenres();
    return () => { subs.delete(f); };
  }, []);
  return { genre: getGenre(), defs, autoPost, autoSound, focusMode, setGenre, setAutoPost, setAutoSound, setFocusMode };
}

/** With focus set to "off", remove focus-hunting wording from a prompt (the backend adds it with the genre's camera style). */
export const scrubFocus = (text) => (focusMode === 'off' && typeof text === 'string'
  ? text.replace(NO_HUNT, ',').replace(/(,\s*){2,}/g, ', ').replace(/\s{2,}/g, ' ').replace(/,\s*([.]|$)/g, '$1')
  : text);
/** Scrub every prompt field of a written script's scenes. */
export const scrubScript = (script) => (focusMode === 'off' && script?.scenes
  ? { ...script, scenes: script.scenes.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, /prompt/i.test(k) ? scrubFocus(v) : v]))) }
  : script);
