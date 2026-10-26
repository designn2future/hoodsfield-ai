import { useEffect, useRef } from 'react';

/** Remembers a tool's inputs across a page refresh. Small settings are stored as JSON in this browser; pictures, clips
 * and sounds are remembered by their Gallery id (the Gallery itself is restored from the autosave), so a tool only
 * needs to put the ids of the assets it uses in `snap.needs`. `restore(saved, assetById)` runs once, as soon as every
 * needed asset is back (or after a few seconds, with whatever came back). */
const KEY = (k) => `hf.tool.${k}`;
const read = (k) => { try { return JSON.parse(localStorage.getItem(KEY(k))) || null; } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(KEY(k), JSON.stringify(v)); } catch { /* storage full or blocked */ } };

export function useToolMemory(key, snap, restore, assets = []) {
  const saved = useRef(undefined);
  if (saved.current === undefined) saved.current = read(key);
  const ready = useRef(!saved.current);
  const restoreRef = useRef(restore); restoreRef.current = restore;
  const assetsRef = useRef(assets); assetsRef.current = assets;

  const run = () => {
    if (ready.current) return;
    ready.current = true;
    try { restoreRef.current(saved.current, new Map(assetsRef.current.map((a) => [a.id, a]))); } catch (e) { console.warn(`restore ${key} failed:`, e.message); }
  };

  useEffect(() => {
    if (ready.current) return;
    const have = new Set(assets.map((a) => a.id));
    if ((saved.current.needs || []).every((id) => have.has(id))) run();
  }, [assets]);
  useEffect(() => {
    if (ready.current) return undefined;
    const t = setTimeout(run, 8000);                // an asset that never comes back must not block the rest
    return () => clearTimeout(t);
  }, []);

  const sig = JSON.stringify(snap);
  useEffect(() => {
    if (!ready.current) return undefined;           // never overwrite what was saved with the empty defaults of a fresh load
    const t = setTimeout(() => write(key, snap), 400);
    return () => clearTimeout(t);
  }, [sig]);
}
