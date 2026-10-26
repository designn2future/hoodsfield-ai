/**
 * .vstudio project format — a single JSON container holding the storyboard
 * graph, settings, the music-video state and all binary assets (sketches,
 * images, videos, character photos, the music track) base64-embedded. Zero
 * dependencies, fully self-contained, survives reload/share.
 */

const blobToB64 = (blob) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

const b64ToBlob = async (b64, mime) =>
  (await fetch(`data:${mime};base64,${b64}`)).blob();

export async function saveProject(
  { name, scenes, view, sketchSettings, kreaSettings, fluxSettings, fluxLoras, imageEngine, timeline, videoSettings, sketchLoras, kreaLoras, mv, tk },
  assets
) {
  const encoded = await Promise.all(
    assets.map(async (a) => ({
      id: a.id, kind: a.kind, mime: a.mime, name: a.name, meta: stripTransient(a.meta),
      data: await blobToB64(a.blob),
    }))
  );
  const payload = {
    format: 'vstudio',
    version: 4,
    name: name || '',
    savedAt: new Date().toISOString(),
    view,
    scenes: scenes.map(({ gen, ...s }) => s), // strip transient generation state
    sketchSettings,
    kreaSettings,
    fluxSettings,
    fluxLoras,
    imageEngine,
    timeline,
    videoSettings,
    sketchLoras,
    kreaLoras,
    mv: mv ? { ...mv, scriptError: null, step: mv.step } : null,
    tk: tk ? { ...tk, scriptError: null, step: tk.step } : null,
    assets: encoded,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safe = (name || '').replace(/[<>:"/\\|?*]+/g, '').trim();
  a.download = `${safe || `storyboard-${new Date().toISOString().slice(0, 10)}`}.vstudio`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const stripTransient = (meta) => {
  if (!meta) return null;
  const { describing, beforeUrl, ...rest } = meta;     // beforeUrl was a temporary browser address; it is dead after a reload
  return rest;
};

export async function loadProject(file) {
  const data = JSON.parse(await file.text());
  if (data.format !== 'vstudio') throw new Error('Not a .vstudio project file');
  const assets = await Promise.all(
    (data.assets || []).map(async (a) => {
      const blob = await b64ToBlob(a.data, a.mime);
      return { id: a.id, kind: a.kind, mime: a.mime, name: a.name, meta: a.meta || null, blob, url: URL.createObjectURL(blob) };
    })
  );
  return {
    // v1 files have no name — fall back to the filename so Save keeps it
    name: data.name || file.name.replace(/\.[^.]+$/, ''),
    scenes: (data.scenes || []).map((s) => ({ ...s, gen: { phase: 'idle' } })),
    view: data.view || { x: 0, y: 0, k: 1 },
    sketchSettings: data.sketchSettings,
    kreaSettings: data.kreaSettings,
    fluxSettings: data.fluxSettings,
    fluxLoras: data.fluxLoras || [],
    imageEngine: data.imageEngine,
    timeline: data.timeline,
    videoSettings: data.videoSettings,
    sketchLoras: data.sketchLoras || [],
    kreaLoras: data.kreaLoras || [],
    mv: data.mv || null,
    tk: data.tk || null,
    assets,
  };
}


// ------------------------------------------------------------------ autosave (the whole session, in this browser)
const DB_NAME = 'hoodsfield-autosave';
const STORE = 'session';
const openDb = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const idb = async (mode, fn) => {
  const db = await openDb();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(out?.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } finally { db.close(); }
};

/** Save everything needed to resume (scenes, settings, TikTok / music-video state and every image, clip and sound) into IndexedDB. */
export async function autosaveProject(state, assets) {
  const rec = {
    savedAt: Date.now(),
    state: { ...state, scenes: (state.scenes || []).map(({ gen, ...s }) => s), mv: state.mv ? { ...state.mv, scriptError: null } : null, tk: state.tk ? { ...state.tk, scriptError: null } : null },
    assets: assets.map((a) => ({ id: a.id, kind: a.kind, mime: a.mime, name: a.name, meta: stripTransient(a.meta), blob: a.blob })),
  };
  await idb('readwrite', (s) => s.put(rec, 'latest'));
}

export async function readAutosave() {
  try { return (await idb('readonly', (s) => s.get('latest'))) || null; } catch { return null; }
}

export async function clearAutosave() { try { await idb('readwrite', (s) => s.delete('latest')); } catch { /* nothing to clear */ } }

/** An autosave record -> the same shape loadProject() returns. */
export function projectFromAutosave(rec) {
  const st = rec.state || {};
  const assets = (rec.assets || []).map((a) => ({ ...a, url: URL.createObjectURL(a.blob) }));
  return {
    name: st.name || '', scenes: (st.scenes || []).map((s) => ({ ...s, gen: { phase: 'idle' } })), view: st.view || { x: 0, y: 0, k: 1 },
    sketchSettings: st.sketchSettings, kreaSettings: st.kreaSettings, fluxSettings: st.fluxSettings, fluxLoras: st.fluxLoras || [], imageEngine: st.imageEngine,
    timeline: st.timeline, videoSettings: st.videoSettings, sketchLoras: st.sketchLoras || [], kreaLoras: st.kreaLoras || [], mv: st.mv || null, tk: st.tk || null, assets,
  };
}
