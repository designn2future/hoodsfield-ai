import { useCallback, useRef, useState } from 'react';

/**
 * Undo / redo for the Timeline. `commit(fn, key)` replaces setTimeline(fn): it remembers the timeline as it was before the change.
 * Changes that carry the same `key` within 0.8 s (dragging a clip, moving a slider) become ONE undo step. `silent(fn)` changes
 * the timeline without making a step (zoom, scrolling...). The history lives in this editor only; another device's edits arrive
 * as plain timeline updates and are never undone by accident.
 */
export function useTimelineHistory(setTimeline, getTimeline) {
  const h = useRef({ past: [], future: [], lastKey: '', lastAt: 0, lastPrev: null });
  const [, bump] = useState(0);
  const refresh = () => queueMicrotask(() => bump((n) => n + 1));

  const commit = useCallback((fn, key = '') => {
    setTimeline((prev) => {
      const next = fn(prev);
      if (next === prev) return prev;
      const s = h.current;
      if (s.lastPrev !== prev) {                       // an updater can be called twice (React dev mode): count each starting point once
        const now = Date.now();
        const merge = key && key === s.lastKey && now - s.lastAt < 800;
        if (!merge) { s.past.push(prev); if (s.past.length > 200) s.past.shift(); }
        s.future = []; s.lastKey = key; s.lastAt = now; s.lastPrev = prev;
        refresh();
      }
      return next;
    });
  }, [setTimeline]);

  const silent = useCallback((fn) => setTimeline((prev) => fn(prev)), [setTimeline]);

  const undo = useCallback(() => {
    const s = h.current; const prev = s.past.pop(); if (!prev) return false;
    s.future.push(getTimeline()); s.lastKey = ''; s.lastPrev = null;
    setTimeline(() => prev); refresh(); return true;
  }, [setTimeline, getTimeline]);

  const redo = useCallback(() => {
    const s = h.current; const next = s.future.pop(); if (!next) return false;
    s.past.push(getTimeline()); s.lastKey = ''; s.lastPrev = null;
    setTimeline(() => next); refresh(); return true;
  }, [setTimeline, getTimeline]);

  return { commit, silent, undo, redo, canUndo: h.current.past.length > 0, canRedo: h.current.future.length > 0, steps: h.current.past.length };
}
