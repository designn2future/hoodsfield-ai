import ExploreFilms from './ExploreFilms.jsx';
import { CompareIfSame } from './BeforeAfter.jsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Starting points that ship with the app: a showcase clip plus the prompt/engine that makes that kind of shot.
const RECIPES = [
  { id: 'r-hero', media: 'hero', title: 'Neon alley, rain', engine: 'Flux 3 → Wan', aspect: '16:9', hue: 190,
    prompt: 'Moody neon alley in heavy rain, a woman in a yellow raincoat walking away from camera, steam rising from grates, cinematic, shallow depth of field' },
  { id: 'r-wan', media: 'wan', title: 'Fisherman at dawn', engine: 'Wan 2.2', aspect: '16:9', hue: 205,
    prompt: 'A weathered fisherman mends a fishing net on a misty pier at dawn, gentle sway, handheld camera, soft golden light' },
  { id: 'r-cinema', media: 'cinema', title: 'Temple crane-up', engine: 'Cinema rig', aspect: '16:9', hue: 38,
    prompt: 'Ancient jungle temple at sunrise, slow crane up revealing the canopy, volumetric light shafts, birds taking off' },
  { id: 'r-edit', media: 'edit', title: 'Cafe at night', engine: 'Flux 3 Edit', aspect: '16:9', hue: 300,
    prompt: 'Cafe interior at night, rain on the window, warm neon reflections on the table, quiet and moody' },
  { id: 'r-ads', media: 'ads', title: 'Product reveal', engine: 'Ad studio', aspect: '9:16', hue: 330,
    prompt: 'Excited presenter reveals premium over-ear headphones in a bright modern kitchen, clean commercial look' },
  { id: 'r-flux', media: 'flux', title: 'Portrait, window light', engine: 'Flux 3', aspect: '16:9', hue: 28,
    prompt: 'Close-up portrait of an elderly man, deep wrinkles, hyper-detailed skin, soft window light, 85mm' },
  { id: 'r-gj', media: 'genjutsu', title: 'Anime restyle', engine: 'Genjutsu', aspect: '16:9', hue: 270,
    prompt: 'Restyle the clip as hand-painted anime, keep the motion and framing, rich watercolor skies' },
  { id: 'r-chars', media: 'characters', title: 'Same hero, new scenes', engine: 'Characters', aspect: '16:9', hue: 160,
    prompt: 'The same heroine in three scenes: a night market, a rooftop at dusk, a moving train, consistent face and outfit' },
];

const STYLES = ['35mm film grain', 'golden hour', 'noir, high contrast', 'anime, hand-painted', 'macro, shallow focus', 'drone aerial', 'vaporwave neon', 'documentary handheld'];

const KIND = {
  'image-flux3': ['⚡', 'Flux 3', 190], 'image-qwen21': ['✦', 'Qwen 2.1', 265], 'image-qwen21-edit': ['✦', 'Qwen 2.1 edit', 265], 'image-flux3-edit': ['🪄', 'Flux 3 Edit', 190], 'image-krea2': ['🖼️', 'Krea 2', 320],
  'video-wan': ['🎞️', 'Wan 2.2', 205], 'video-h3': ['🎬', 'H3', 0], 'video-ltx': ['🎬', 'LTX 2.3', 255], 'video-genjutsu': ['🌀', 'Genjutsu', 270],
  'video-long': ['🎥', 'Long shot', 205], 'video-control': ['🎯', 'Motion control', 255], 'video-lipsync': ['🗣️', 'Lip-sync', 25],
  'tool-upscale': ['🔍', 'Upscale', 160], 'tool-cutout': ['✂️', 'Cutout', 160], timeline: ['🎞️', 'Timeline', 270],
};
const kindOf = (k) => KIND[k] || ['✨', 'Render', 200];
const cleanTitle = (t = '') => t.replace(/^(Lip-sync|Long shot \(.*?\)|Timeline export) ?[·-]? ?/i, '').trim() || t;
const ago = (t) => {
  const d = Date.now() / 1000 - t;
  return d < 90 ? 'just now' : d < 3600 ? `${Math.floor(d / 60)} min ago` : d < 86400 ? `${Math.floor(d / 3600)} h ago` : `${Math.floor(d / 86400)} d ago`;
};

function Tile({ it, onOpen, hidden, onHide, onRestore, onForget }) {
  const [menu, setMenu] = useState(false);
  const v = useRef(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const el = v.current;
    if (!el) return;
    if (hover) el.play().catch(() => {}); else el.pause();
  }, [hover]);
  return (
    <button className={`xp-tile ${it.recipe ? 'recipe' : ''}`} style={{ '--h': it.hue }} onClick={() => onOpen(it)}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="xp-media" style={{ aspectRatio: it.ratio || '16 / 10' }}>
        {it.video
          ? <video ref={v} src={it.mediaUrl} poster={it.thumb} muted loop playsInline preload="none" />
          : <img src={it.thumb || it.mediaUrl} alt="" loading="lazy" />}
        <span className="xp-glow" />
      </div>
      <div className="xp-badges">
        <span className="xp-chip">{it.icon} {it.engine}</span>
        {it.video && <span className="xp-chip dim">▶ video</span>}
        {it.recipe && <span className="xp-chip hot">recipe</span>}
      </div>
      <div className="xp-cap">
        <div className="xp-title">{it.title}</div>
        <div className="xp-sub">{it.prompt || it.sub}</div>
      </div>
      <span className="xp-remix">✦ Remix</span>
      <span className="xp-kebab" role="button" tabIndex={0} aria-label="More options" title="More options"
        onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setMenu((m) => !m); } }}>⋯</span>
      {menu && (
        <span className="xp-menu" onClick={(e) => e.stopPropagation()} onMouseLeave={() => setMenu(false)}>
          {hidden
            ? <b onClick={() => { setMenu(false); onRestore(it); }}>↩ Restore to Explore</b>
            : <b onClick={() => { setMenu(false); onHide(it); }}>🙈 Remove from Explore</b>}
          {it.job && !hidden && <b className="danger" onClick={() => { setMenu(false); onForget(it); }}>🗑 Delete from history</b>}
        </span>
      )}
    </button>
  );
}

/** Explore: everything you've rendered plus starter recipes, each one a doorway to remix it. */
export default function Explore({ active, onRecreate, onUse, onRecreateShot, onRecreateFilm }) {
  const [jobs, setJobs] = useState([]);
  const [extra, setExtra] = useState([]);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  // the phone's Back gesture / browser Back closes the open item instead of leaving Explore
  const selOpen = useRef(false);
  useEffect(() => {
    if (sel && !selOpen.current) { selOpen.current = true; try { history.pushState({ hfExplore: 1 }, ''); } catch { /* ignore */ } }
    if (!sel && selOpen.current) { selOpen.current = false; if (history.state?.hfExplore) { window.__hfSkipPop = true; try { history.back(); } catch { window.__hfSkipPop = false; } } }
  }, [sel]);
  useEffect(() => {
    if (!sel) return undefined;
    const close = () => setSel(null);
    (window.__hfLayers = window.__hfLayers || []).push(close);
    window.dispatchEvent(new Event('hf-layers'));
    return () => { window.__hfLayers = (window.__hfLayers || []).filter((f) => f !== close); window.dispatchEvent(new Event('hf-layers')); };
  }, [sel]);
  useEffect(() => {
    const onPop = () => { if (selOpen.current) { selOpen.current = false; window.__hfSkipPop = true; setSel(null); } };
    const onKey = (e) => { if (e.key === 'Escape') setSel(null); };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('keydown', onKey); };
  }, []);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [hidden, setHidden] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem('hf_explore_hidden') || '[]')); } catch { return new Set(); } });
  const saveHidden = (set) => { setHidden(new Set(set)); try { localStorage.setItem('hf_explore_hidden', JSON.stringify([...set])); } catch { /* private mode */ } };
  useEffect(() => { if (filter === 'hidden' && !hidden.size) setFilter('all'); }, [filter, hidden]);
  const hide = (it) => { saveHidden(new Set([...hidden, it.id])); if (sel?.id === it.id) setSel(null); };
  const restore = (it) => { const n = new Set(hidden); n.delete(it.id); saveHidden(n); };
  const forget = async (it) => {
    if (!window.confirm(`Delete "${it.title}" from your history? The Jobs list forgets it too. The rendered file stays on disk.`)) return;
    try { await fetch(`/api/jobs/${it.id}`, { method: 'DELETE' }); } catch { /* offline */ }
    setSel(null); load();
  };

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/jobs?limit=200');
      const d = await r.json();
      setJobs((d.jobs || []).filter((j) => j.status === 'done' && j.output && !j.parent && !String(j.kind).startsWith('audio') && j.kind !== 'tool-upscale'));
    } catch { /* offline: recipes still show */ }
  }, []);
  useEffect(() => { if (active) load(); }, [active, load]);
  useEffect(() => {   // real example renders shipped in public/showcase/recipes.json (made by tools/make_showcase.py --only explore)
    fetch('/showcase/recipes.json').then((r) => (r.ok ? r.json() : [])).then((a) => Array.isArray(a) && setExtra(a)).catch(() => {});
  }, []);
  useEffect(() => { if (!active) setSel(null); }, [active]);

  const items = useMemo(() => {
    const mine = jobs.map((j) => {
      const [icon, engine, hue] = kindOf(j.kind);
      const video = j.kind.startsWith('video') || j.kind === 'timeline';
      return {
        id: j.id, job: true, video, icon, engine, hue, title: cleanTitle(j.title).slice(0, 70), prompt: j.params?.prompt || cleanTitle(j.title),
        sub: ago(j.created), when: j.created, mediaUrl: `/api/jobs/${j.id}/media`, thumb: `/api/jobs/${j.id}/thumb`, kind: j.kind,
        ratio: video ? '16 / 11' : '1 / 1',
      };
    });
    const rec = RECIPES.map((r) => ({
      id: r.id, recipe: true, video: true, icon: '✦', engine: r.engine, hue: r.hue, title: r.title, prompt: r.prompt, aspect: r.aspect,
      mediaUrl: `/showcase/${r.media}.mp4`, thumb: `/showcase/${r.media}.jpg`, ratio: r.aspect === '9:16' ? '9 / 14' : '16 / 10',
    }));
    const RATIO = { '9:16': '9 / 14', '3:4': '3 / 4', '1:1': '1 / 1', '16:9': '16 / 10' };
    const more = extra.map((e, i) => ({
      id: e.id, recipe: true, restyle: !!e.restyle, video: !!e.video, icon: '✦', engine: e.engine, hue: (i * 47 + 20) % 360, title: e.title, prompt: e.prompt, aspect: e.aspect,
      mediaUrl: `/showcase/${e.video || e.image}`, thumb: `/showcase/${e.image}`, ratio: RATIO[e.aspect] || '16 / 10',
    }));
    // newest-looking first: your own renders, then the real examples, then the showcase-clip recipes
    const everyAll = [...mine, ...more, ...rec];
    const every = everyAll.filter((i) => !hidden.has(i.id));
    let all = every;
    if (filter === 'recipes') all = [...more, ...rec];
    else if (filter === 'mine') all = mine;
    else if (filter === 'restyle') all = every.filter((i) => i.restyle);
    else if (filter === 'hidden') all = everyAll.filter((i) => hidden.has(i.id));
    else if (filter === 'video') all = every.filter((i) => i.video);
    else if (filter === 'image') all = every.filter((i) => !i.video);
    const s = q.trim().toLowerCase();
    return s ? all.filter((i) => `${i.title} ${i.prompt} ${i.engine}`.toLowerCase().includes(s)) : all;
  }, [jobs, extra, filter, q, hidden]);

  const open = (it) => { setSel(it); setPrompt(it.prompt || ''); setErr(''); };
  const run = async (key, fn) => {
    setBusy(key); setErr('');
    try { await fn(); } catch (e) { setErr(e.message || String(e)); }
    setBusy('');
  };
  const aspectOf = (it) => it.aspect || (it.video ? '16:9' : '1:1');
  const FILTERS = [['all', 'Everything'], ['mine', 'My renders'], ['recipes', 'Recipes'], ['restyle', 'Restyles'], ['video', 'Videos'], ['image', 'Images'], ...(hidden.size ? [['hidden', `Hidden (${hidden.size})`]] : [])];

  return (
    <div className="xp">
      <header className="xp-hero">
        <div className="xp-aurora" />
        <div className="xp-hero-copy">
          <span className="eyebrow">Explore · remix anything</span>
          <h1>Start from <em>something that already works.</em></h1>
          <p>Every render you've made and a shelf of starter recipes. Open one, bend the prompt, and send it straight into the studio, or just generate your own take.</p>
        </div>
        <div className="xp-search">
          <span>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search prompts, engines…" />
        </div>
      </header>

      <ExploreFilms active={active} onRecreateShot={onRecreateShot} onRecreateFilm={onRecreateFilm} />

      <div className="xp-bar">
        {FILTERS.map(([id, label]) => (
          <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{label}</button>
        ))}
        <span className="xp-count">{items.length} {items.length === 1 ? 'item' : 'items'}</span>
      </div>

      {items.length === 0
        ? <div className="xp-empty">Nothing matches. Render something, or clear the search.</div>
        : <div className="xp-grid">{items.map((it) => <Tile key={it.id} it={it} onOpen={open} hidden={hidden.has(it.id)} onHide={hide} onRestore={restore} onForget={forget} />)}</div>}

      {sel && (
        <div className="xp-modal" onClick={() => setSel(null)}>
          <div className="xp-sheet" style={{ '--h': sel.hue }} onClick={(e) => e.stopPropagation()}>
            <button className="xp-back" onClick={() => setSel(null)}>← Back to Explore</button>
            <button className="xp-x" onClick={() => setSel(null)} aria-label="Close">✕</button>
            <div className="xp-stage">
              {sel.video
                ? <video key={sel.id} src={sel.mediaUrl} poster={sel.thumb} controls autoPlay loop muted playsInline />
                : sel.job && /edit$/.test(sel.kind || '')
                  ? <CompareIfSame before={`/api/jobs/${sel.id}/source`} after={sel.mediaUrl}><img src={sel.mediaUrl} alt="" onError={(e) => { e.currentTarget.src = sel.thumb; }} /></CompareIfSame>
                  : <img src={sel.mediaUrl} alt="" onError={(e) => { e.currentTarget.src = sel.thumb; }} />}
            </div>
            <div className="xp-side">
              <div className="xp-badges">
                <span className="xp-chip">{sel.icon} {sel.engine}</span>
                {sel.recipe ? <span className="xp-chip hot">starter recipe</span> : <span className="xp-chip dim">{ago(sel.when)}</span>}
              </div>
              <h2>{sel.title}</h2>

              <label className="xp-label">Prompt <em>edit it, then generate</em></label>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} />
              <div className="xp-styles">
                {STYLES.map((s) => (
                  <button key={s} onClick={() => setPrompt((p) => (p.includes(s) ? p : `${p.replace(/[.\s]+$/, '')}, ${s}`))}>+ {s}</button>
                ))}
              </div>

              <button className="xp-go" disabled={!prompt.trim()} onClick={() => { onRecreate(prompt.trim(), aspectOf(sel)); setSel(null); }}>
                ✦ Generate my own from this
              </button>

              <label className="xp-label">Take it further</label>
              <div className="xp-acts">
                {!sel.video && <button disabled={!!busy} onClick={() => run('animate', () => onUse(sel, 'animate', prompt))}>🎞️ Animate this still</button>}
                {!sel.video && <button disabled={!!busy} onClick={() => run('edit', () => onUse(sel, 'edit', prompt))}>🪄 Edit it</button>}
                {!sel.video && <button disabled={!!busy} onClick={() => run('lipsync', () => onUse(sel, 'lipsync', prompt))}>🗣️ Make it talk</button>}
                {sel.video && <button disabled={!!busy} onClick={() => run('genjutsu', () => onUse(sel, 'genjutsu', prompt))}>🌀 Restyle (Genjutsu)</button>}
                <button disabled={!!busy} onClick={() => run('timeline', () => onUse(sel, 'timeline', prompt))}>🎬 Add to timeline</button>
                {hidden.has(sel.id)
                  ? <button disabled={!!busy} onClick={() => { restore(sel); setSel(null); }}>↩ Restore to Explore</button>
                  : <button disabled={!!busy} onClick={() => hide(sel)}>🙈 Remove from Explore</button>}
                <a className="xp-dl" href={sel.mediaUrl} download={`${sel.title.replace(/\W+/g, '_')}${sel.video ? '.mp4' : '.png'}`}>⬇ Download</a>
              </div>
              {busy && <div className="hint">Sending to the studio…</div>}
              {err && <div className="error">{err}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
