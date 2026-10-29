import React, { useCallback, useEffect, useRef, useState } from 'react';
import GenProgress from './GenProgress.jsx';
import DropZone from './DropZone.jsx';
import LayerBuilder from './LayerBuilder.jsx';
import LivingScene from './LivingScene.jsx';
import MagicLoop from './MagicLoop.jsx';
import { generateH3, generateWan, runComfyTool, cancelJob } from '../api.js';
import '../settings.css';
import '../loop.css';

// Seamless Loop Studio: make the quiet, endlessly repeating scenes used for study / lofi / sleep videos.
// 1. a scene (animate one picture, or bring a clip)  2. make it seamless (the end hands over to the start with no visible seam)
// 3. export one long video, optionally with your music.

const LOCK = 'Static locked-off tripod shot, absolute zero camera movement, completely stationary camera, no panning, no zooming. Cinemagraph style. Only the elements inside the frame move; the camera frame remains perfectly still and frozen in place for the entire duration. ';
const TAIL = ' Everything else stays perfectly still. The light stays constant. No people, no text, no sudden changes, no cuts. Masterpiece, highly detailed, cozy lo-fi aesthetic, serene, calm and endlessly peaceful, seamless loop feel.';
const PRESETS = [
  { id: 'paradise', label: '✨ Enchanted paradise', motion: 'Waterfalls pour steadily from the floating islands into the glowing lake, the aurora ripples slowly across the sky, flower petals and glowing fireflies drift lazily through the air, soft mist rolls over the water, and the lotus lights pulse gently.' },
  { id: 'aurora', label: '🌌 Aurora & starlight', motion: 'The aurora ripples and breathes slowly across the sky, the stars twinkle softly, the lake surface glimmers with slow reflections, a thin mist drifts, and tiny glowing motes float upward.' },
  { id: 'rain', label: '🌧️ Rainy window', motion: 'Soft rain streaks slowly down the window glass, the leaves of the plants sway very gently, steam curls up slowly from the cup, and the distant city lights twinkle almost imperceptibly.' },
  { id: 'forest', label: '🌲 Forest & falling leaves', motion: 'The trees sway very gently in a light breeze, a few leaves fall slowly and drift through the air, shafts of light shimmer softly between the branches, and a thin mist moves lazily.' },
  { id: 'fire', label: '🔥 Fireplace / candle', motion: 'The flames flicker softly and warm light moves gently on the walls, tiny sparks and dust motes drift slowly upward, and smoke curls up in thin wisps.' },
  { id: 'snow', label: '❄️ Snowfall', motion: 'Fine snow falls gently and steadily, a thin curl of smoke rises slowly from the chimney, the lit windows glow softly, and the branches sway a tiny amount.' },
  { id: 'city', label: '🌃 City at night', motion: 'The city lights twinkle gently, a few clouds drift slowly across the sky, far-away cars slide silently along the distant roads, and the window reflections shimmer faintly.' },
  { id: 'sea', label: '🌅 Sunset by the sea', motion: 'Small waves roll slowly onto the shore, the clouds drift very slowly, the water glitters softly in the low sun, and the grass sways gently in the breeze.' },
];
const ASPECTS = [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['21:9', 21 / 9]];
const LENGTHS = [['10 min', 10], ['30 min', 30], ['1 hour', 60], ['2 hours', 120], ['3 hours', 180]];

const jerr = async (r) => { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* not json */ } throw new Error(d); };
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function imageAspect(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const r = bmp.width / bmp.height;
    return ASPECTS.reduce((a, b) => (Math.abs(Math.log(b[1] / r)) < Math.abs(Math.log(a[1] / r)) ? b : a))[0];
  } catch { return '16:9'; }
}

export default function LoopStudio({ assets = [], addAsset, active }) {
  const [tab, setTab] = useState('picture');
  const [adv, setAdv] = useState(false);
  const clipTab = tab === 'picture' || tab === 'clip';
  const [templates, setTemplates] = useState([]);
  const [tpl, setTpl] = useState(null);
  const [baseLoop, setBaseLoop] = useState(null);
  const resultRef = useRef(null);
  const [still, setStill] = useState(null);                 // {blob, url, name}
  const [engine, setEngine] = useState('h3');
  const [preset, setPreset] = useState('rain');
  const [motion, setMotion] = useState(PRESETS[0].motion);
  const [seconds, setSeconds] = useState(6.5);
  const [better, setBetter] = useState(false);
  const [anchor, setAnchor] = useState(true);
  const [gen, setGen] = useState(null);                      // {progress, status}
  const [src, setSrc] = useState(null);                      // {blob, url, name}
  const [minLoop, setMinLoop] = useState(4);
  const [blend, setBlend] = useState(1.2);
  const [hold, setHold] = useState(70);
  const [showMask, setShowMask] = useState(false);
  const [making, setMaking] = useState(false);
  const [loop, setLoop] = useState(null);                    // meta from /api/loop/make
  const [upscaling, setUpscaling] = useState(null);
  const [minutes, setMinutes] = useState(60);
  const [custom, setCustom] = useState('');
  const [music, setMusic] = useState(null);
  const [matchMusic, setMatchMusic] = useState(true);
  const [fade, setFade] = useState(4);
  const [exp, setExp] = useState(null);                      // {status, text, url, info}
  const [err, setErr] = useState('');
  const vid = useRef(null);
  const poll = useRef(null);
  const abort = useRef(null);

  useEffect(() => () => clearInterval(poll.current), []);
  useEffect(() => { if (active && !templates.length) fetch('/api/loop/templates').then((r) => (r.ok ? r.json() : null)).then((j) => j && setTemplates(j.templates || [])).catch(() => {}); }, [active, templates.length]);
  const [recent, setRecent] = useState([]);
  useEffect(() => { if (active) fetch('/api/loop/recent').then((r) => (r.ok ? r.json() : null)).then((j) => j && setRecent(j.loops || [])).catch(() => {}); }, [active, loop, err]);
  const onLayersDone = (m) => {                                   // from the Layers tab: a template was picked, or a loop was rendered
    if (m?.__template) { setTpl({ ...m.__template, _n: Date.now() }); setBaseLoop(null); return; }
    setLoop(m); setExp(null);
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
  };
  const pickPreset = (p) => { setPreset(p.id); setMotion(p.motion); };

  const generate = useCallback(async () => {
    if (!still) return;
    setErr(''); setGen({ progress: 0, status: 'Starting…' });
    const prompt = `${LOCK}${motion}${TAIL}`;
    const aspect = await imageAspect(still.blob);
    const onEvent = (ev) => {
      if (ev.type === 'submitted') abort.current = ev.jobId;
      if (ev.type === 'progress') setGen((g) => ({ ...g, progress: ev.overall ?? (ev.value / Math.max(1, ev.max)) }));
      else if (ev.type === 'status') setGen((g) => ({ ...g, status: ev.text }));
    };
    try {
      const res = engine === 'h3'
        ? await generateH3(still.blob, { prompt, seconds: Math.min(7.3, seconds), aspect, megapixels: better ? 1.0 : 0.6, preset: better ? 'quality' : 'fast', seed: -1, lock_still: true, shift_video: 6,   // a little larger than before: the stabiliser crops the drift margin away; lower sigma shift = calmer camera
          music: 'No music.', soundscape: 'quiet room tone', coach: false }, [], onEvent, anchor ? still.blob : null)
        : await generateWan(still.blob, { prompt, seconds: 5, aspect, megapixels: better ? 0.6 : 0.4, lightning: true, smooth: true, seed: -1 }, [], anchor ? still.blob : null, onEvent);
      const blob = await (await fetch(res.url)).blob();
      const file = new File([blob], 'scene.mp4', { type: 'video/mp4' });
      setSrc({ blob: file, url: URL.createObjectURL(blob), name: 'Loop source' });
      setLoop(null); setExp(null);
      addAsset?.(blob, 'video', 'Loop source');
    } catch (e) { setErr(e.message); }
    setGen(null);
  }, [still, engine, motion, seconds, better, anchor, addAsset]);

  const make = async () => {
    if (!src) return;
    setErr(''); setMaking(true); setLoop(null); setExp(null);
    try {
      const fd = new FormData();
      fd.append('file', src.blob, 'clip.mp4'); fd.append('min_seconds', String(minLoop)); fd.append('blend_seconds', String(blend)); fd.append('stillness', String(hold / 100));
      const r = await fetch('/api/loop/make', { method: 'POST', body: fd });
      if (!r.ok) await jerr(r);
      setLoop(await r.json());
    } catch (e) { setErr(e.message); }
    setMaking(false);
  };

  const watchSeam = () => {
    const v = vid.current; if (!v) return;
    v.currentTime = Math.max(0, (v.duration || loop?.seconds || 4) - 1.5); v.muted = true; v.play();
  };

  const upscale = async () => {
    if (!loop) return;
    setErr(''); setUpscaling({ progress: 0, status: 'Starting…' });
    try {
      const blob = await (await fetch(loop.url)).blob();
      const scale = Math.max(1.5, Math.min(4, Math.round((1080 / Math.min(loop.height || 720, loop.width || 1280 )) * 100) / 100));
      const res = await runComfyTool('/api/tools/upscale', new File([blob], 'loop.mp4', { type: 'video/mp4' }), { scale }, (ev) => {
        if (ev.type === 'progress') setUpscaling((u) => ({ ...u, progress: ev.overall ?? (ev.value / Math.max(1, ev.max)) }));
        else if (ev.type === 'status') setUpscaling((u) => ({ ...u, status: ev.text }));
      });
      const up = await (await fetch(res.url)).blob();
      const fd = new FormData(); fd.append('file', up, 'loop_hd.mp4');
      const r = await fetch('/api/loop/import', { method: 'POST', body: fd });
      if (!r.ok) await jerr(r);
      const meta = await r.json();
      setLoop((l) => ({ ...l, ...meta, source_frames: l.source_frames, blend_seconds: l.blend_seconds, match: l.match, seam: l.seam }));
      addAsset?.(up, 'video', 'Loop (HD)');
    } catch (e) { setErr(e.message); }
    setUpscaling(null);
  };

  const exportLong = async () => {
    if (!loop) return;
    setErr(''); setExp({ status: 'working', text: 'Starting…' });
    try {
      const mins = custom ? Math.max(0.5, +custom) : minutes;
      const fd = new FormData();
      fd.append('loop_id', loop.id); fd.append('minutes', String(mins)); fd.append('match_audio', music && matchMusic ? 'true' : 'false'); fd.append('fade_out', String(fade));
      if (music) fd.append('audio', music, music.name);
      const r = await fetch('/api/loop/export', { method: 'POST', body: fd });
      if (!r.ok) await jerr(r);
      const { job_id } = await r.json();
      clearInterval(poll.current);
      poll.current = setInterval(async () => {
        try {
          const j = await (await fetch(`/api/jobs/${job_id}`)).json();
          if (j.status === 'done') {
            clearInterval(poll.current);
            let info = null; try { info = await (await fetch(`/api/loop/export_info/${job_id}`)).json(); } catch { /* optional */ }
            setExp({ status: 'done', url: `/api/video/${job_id}`, info });
          } else if (j.status === 'error' || j.status === 'cancelled') {
            clearInterval(poll.current); setExp(null); setErr(j.error || 'The export failed.');
          } else setExp({ status: 'working', text: j.status_text || 'Working…' });
        } catch { /* keep polling */ }
      }, 1500);
    } catch (e) { setErr(e.message); setExp(null); }
  };

  const rate = loop?.seam?.rating;
  const rateCls = rate === 'seamless' || rate === 'very good' ? 'good' : rate === 'check the seam' ? 'ok' : 'bad';
  const estUp = loop ? Math.max(1, Math.round((loop.frames || 100) * 3.5 / 60)) : 0;

  return (
    <div className="st-page ls-page">
      <div className="st-head">
        <div>
          <h2>🔁 Seamless Loop Studio</h2>
          <p>Make the calm, endlessly repeating scenes used for study, lofi and sleep videos. The end hands back to the start with no visible seam, so it can play for hours.</p>
        </div>
      </div>
      {err && <div className="error" onClick={() => setErr('')}>{err}</div>}

      {/* ------------------------------------------------------------ 1 */}
      <section className="st-card">
        <h3><span className="ls-n">1</span> Your scene</h3>
        <div className="ls-tabs">
          <button className={tab === 'picture' ? 'on' : ''} onClick={() => setTab('picture')}>✨ Animate a picture</button>
          <button className={tab === 'clip' ? 'on' : ''} onClick={() => setTab('clip')}>🎞️ I already have a clip</button>
          <button className="ls-more" onClick={() => setAdv((a) => !a)}>{adv || ['magic', 'layers', 'living'].includes(tab) ? 'Fewer options ▴' : 'More ways to make a loop ▾'}</button>
          {(adv || ['magic', 'layers', 'living'].includes(tab)) && (
            <>
          <button className={tab === 'magic' ? 'on' : ''} onClick={() => setTab('magic')}>✨ One-click loop (effects)</button>
          <button className={tab === 'layers' ? 'on' : ''} onClick={() => setTab('layers')}>🎨 Layers (picture + effects)</button>
          <button className={tab === 'living' ? 'on' : ''} onClick={() => setTab('living')}>🌫️ Living scene (fog + water)</button>
            </>
          )}
        </div>

        {clipTab && templates.length > 0 && (
          <div className="lb-tpl lb-tpl-top"><b>New here? Open a ready-made template</b>
            <div className="lb-tpl-row">{templates.map((t) => <button key={t.id} className="lb-card" onClick={() => { setTab('layers'); setTpl({ ...t, _n: Date.now() }); setBaseLoop(null); }}><img src={`/api/loop/templates/${t.id}/still`} alt={t.title} /><span><b>{t.icon} {t.title}</b><small>{t.blurb}</small></span></button>)}</div></div>
        )}

        {tab === 'picture' && (
          <>
            {!still ? (
              <DropZone accept="image" icon="🖼️" title="Drop the scene picture" hint="A calm, wide picture works best: a cozy room, a forest, a window, a seaside" assets={assets}
                onFile={(f) => setStill({ blob: f, url: URL.createObjectURL(f), name: f.name })} onAsset={(a) => setStill({ blob: a.blob, url: a.url, name: a.name })} />
            ) : (
              <div className="ls-row">
                <div className="ls-thumb"><img src={still.url} alt="scene" /><button onClick={() => setStill(null)}>Change picture</button></div>
                <div className="ls-form">
                  <label>Mood (picks the motion)</label>
                  <div className="ls-chips">{PRESETS.map((p) => <button key={p.id} className={preset === p.id ? 'on' : ''} onClick={() => pickPreset(p)}>{p.label}</button>)}</div>
                  <label>Motion (edit freely, keep it subtle)</label>
                  <textarea rows={3} value={motion} onChange={(e) => setMotion(e.target.value)} />
                  <div className="ls-grid">
                    <label>Engine
                      <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                        <option value="h3">MiniMax H3 (best detail, up to 7 s)</option>
                        <option value="wan">Wan 2.2 (5 s, very steady)</option>
                      </select>
                    </label>
                    {engine === 'h3' && <label>Length: {seconds.toFixed(1)} s<input type="range" min="4" max="7.3" step="0.1" value={seconds} onChange={(e) => setSeconds(+e.target.value)} /></label>}
                  </div>
                  <label className="ls-check"><input type="checkbox" checked={anchor} onChange={(e) => setAnchor(e.target.checked)} />
                    <span><b>Make it loop-friendly</b><small>The video starts and ends on your picture, so the motion naturally returns to where it began.</small></span></label>
                  <label className="ls-check"><input type="checkbox" checked={better} onChange={(e) => setBetter(e.target.checked)} />
                    <span><b>Better quality</b><small>Slower. Leave off to try ideas fast.</small></span></label>
                  {gen ? <GenProgress progress={gen.progress} status={gen.status} onCancel={() => { if (abort.current) cancelJob(abort.current); }} />
                    : <button className="st-cta" onClick={generate}>✨ Animate this picture</button>}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'magic' && <MagicLoop assets={assets} onLoop={onLayersDone} onError={setErr} />}

        {recent.length > 0 && (
          <details className="ls-recent" style={{ marginTop: 14 }}>
            <summary>Recent loops ({recent.length}): open one if a finished loop didn't show up</summary>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
              {recent.map((m) => (
                <button key={m.id} className="lb-card" style={{ width: 170 }} onClick={() => onLayersDone(m)}>
                  <video src={m.url} muted preload="metadata" style={{ width: '100%', borderRadius: 8, display: 'block' }} />
                  <span><b>{new Date((m.made || 0) * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</b><small>{m.seconds}s · {m.seam?.rating || ''}</small></span>
                </button>
              ))}
            </div>
          </details>
        )}

        {tab === 'living' && (
          <>
            <p className="st-lead ls-tip">Real-looking fog and moving water, drawn on your graphics card over a perfectly still picture. Trace where the water is, tune the look live, then render a loop that repeats with no seam.</p>
            <LivingScene assets={assets} onLoop={onLayersDone} onError={setErr} />
          </>
        )}

        {tab === 'layers' && (
          <>
            <p className="st-lead ls-tip">The After Effects way: a perfectly still picture underneath, animated effect layers on top, blended with screen, add or soft light. Nothing in the background can drift, so the loop is seamless by construction.</p>
            <LayerBuilder assets={assets} templates={templates} initial={tpl} baseLoop={baseLoop} onClearBase={() => setBaseLoop(null)} onLoop={onLayersDone} onError={setErr} />
          </>
        )}

        {tab === 'clip' && (
          <DropZone accept="video" icon="🎞️" title="Drop a clip" hint="Any short clip with calm, steady motion (3 to 30 seconds). A locked-off camera works best." assets={assets}
            onFile={(f) => { setSrc({ blob: f, url: URL.createObjectURL(f), name: f.name }); setLoop(null); setExp(null); }}
            onAsset={(a) => { setSrc({ blob: a.blob, url: a.url, name: a.name }); setLoop(null); setExp(null); }} />
        )}

        {src && (
          <div className="ls-src">
            <video src={src.url} muted loop autoPlay playsInline controls />
            <p className="st-hint">Your clip: <b>{src.name}</b></p>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------ 2 */}
      {(clipTab || loop) && (
      <section className={`st-card ${src || loop ? '' : 'ls-off'}`}>
        {clipTab ? <h3><span className="ls-n">2</span> Make it seamless</h3> : <h3><span className="ls-n">2</span> Your loop</h3>}
        {clipTab && (<>
        <p className="st-lead">Hoodsfield finds the point in your clip where it matches itself best and blends the join, so nothing jumps, fades twice or ghosts when it wraps around.</p>
        <div className="ls-grid">
          <label>Shortest loop: {minLoop} s<input type="range" min="3" max="12" step="0.5" value={minLoop} onChange={(e) => setMinLoop(+e.target.value)} /></label>
          <label>Blend length: {blend.toFixed(1)} s<input type="range" min="0.5" max="3" step="0.1" value={blend} onChange={(e) => setBlend(+e.target.value)} /></label>
          <label>Hold the picture still: {hold}%<input type="range" min="0" max="100" step="5" value={hold} onChange={(e) => setHold(+e.target.value)} />
            <small className="ls-sub">AI video can never hold perfectly still, and that is what makes a loop visibly dissolve. This steadies the picture and freezes everything that isn't meant to move, so only rain, mist, leaves and light keep moving.</small></label>
        </div>
        <div className="st-actions"><button className="st-cta" disabled={!src || making} onClick={make}>{making ? 'Finding the best loop…' : loop ? '↻ Make it again' : '🔁 Make the seamless loop'}</button></div>
        </>)}

        {loop && (
          <div className="ls-result" ref={resultRef}>
            <video ref={vid} src={loop.url} muted loop autoPlay playsInline controls />
            <div className="ls-stats">
              <span className={`ls-rate ${rateCls}`}>{rate === 'seamless' ? '✔ Seamless' : rate === 'very good' ? '✔ Very good seam' : rate === 'check the seam' ? '⚠ Check the seam' : '✖ Visible seam'}</span>
              <span>Loop {loop.seconds}s · {loop.frames} frames · {loop.width}×{loop.height}</span>
              {loop.blend_seconds && <span>Blend {loop.blend_seconds}s</span>}
              {loop.mode === 'still' && loop.frozen_pct != null && <span>🧊 {loop.frozen_pct}% of the picture held perfectly still</span>}
              {loop.mode === 'still' && loop.corrected_px > 0.5 && <span>🎯 drift corrected: {loop.corrected_px}px</span>}
            </div>
            {loop.mode === 'still' && (
              <div className="ls-mask">
                <button onClick={() => setShowMask((v) => !v)}>{showMask ? 'Hide' : 'Show'} what moves</button>
                {showMask && <img src={`/api/loop/mask/${loop.id}`} alt="white = moving, black = held still" />}
              </div>
            )}
            {(loop.jump_ranges || []).length > 0 && <p className="st-note">The source clip has sudden movement at {loop.jump_ranges.slice(0, 4).map((r) => `${r[0]}–${r[1]}s`).join(', ')} (something moved or changed quickly). Hoodsfield used the calmest stretch ({loop.used_s?.[0]}s to {loop.used_s?.[1]}s). For a longer, better loop, generate again with less movement.</p>}
            {(loop.mode === 'layers' || loop.mode === 'gpu') && <p className="st-ok">Built on an exact cycle, so the end is the start: seamless by construction.</p>}
            {rateCls !== 'good' && loop.mode !== 'layers' && loop.mode !== 'gpu' && <p className="st-note">Tip: ask for less movement, keep the camera locked off, and avoid lighting changes. Or make the blend longer and try again.</p>}
            <div className="st-actions">
              <button onClick={watchSeam}>👁 Watch the seam</button>
              <a className="ls-link" href={loop.url} download={`loop_${loop.id}.mp4`}>⬇ Download the loop</a>
              {loop.mode !== 'layers' && loop.mode !== 'gpu' && <button onClick={() => { setBaseLoop(loop); setTab('layers'); }}>🎨 Add effect layers on top</button>}
            </div>
            {(loop.height || 0) < 1000 && (
              <div className="ls-up">
                {upscaling ? <GenProgress progress={upscaling.progress} status={upscaling.status} />
                  : <button onClick={upscale}>⬆ Upscale the loop to 1080p <small>(about {estUp} min on a 16 GB card)</small></button>}
              </div>
            )}
          </div>
        )}
      </section>
      )}

      {/* ------------------------------------------------------------ 3 */}
      <section className={`st-card ${loop ? '' : 'ls-off'}`}>
        <h3><span className="ls-n">3</span> Export a long video</h3>
        <p className="st-lead">One video that repeats your loop for as long as you like. The picture is copied, not re-encoded, so even 3 hours takes seconds and stays seamless.</p>
        <label className="ls-lab">How long?</label>
        <div className="ls-chips">
          {LENGTHS.map(([t, v]) => <button key={v} className={!custom && minutes === v ? 'on' : ''} onClick={() => { setMinutes(v); setCustom(''); }}>{t}</button>)}
          <input className="ls-custom" placeholder="custom minutes" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ''))} />
        </div>
        <label className="ls-lab">Your music (optional)</label>
        <div className="ls-music">
          <input type="file" accept="audio/*,video/*" onChange={(e) => setMusic(e.target.files?.[0] || null)} />
          {music && <label className="ls-check"><input type="checkbox" checked={matchMusic} onChange={(e) => setMatchMusic(e.target.checked)} /><span><b>Make the video as long as the music</b></span></label>}
          {music && <label>Fade the music out over the last {fade}s<input type="range" min="0" max="15" step="1" value={fade} onChange={(e) => setFade(+e.target.value)} /></label>}
        </div>
        <div className="st-actions"><button className="st-cta" disabled={!loop || exp?.status === 'working'} onClick={exportLong}>{exp?.status === 'working' ? 'Building…' : '🎬 Export the long video'}</button>
          {exp?.status === 'working' && <span className="st-hint">{exp.text}</span>}</div>
        {exp?.status === 'done' && (
          <div className="ls-done">
            <p><b>Done.</b> {exp.info ? `${mmss(exp.info.seconds)} long · ${(exp.info.size / 1e6).toFixed(0)} MB · ${exp.info.repeats} repeats.` : ''}</p>
            <div className="st-actions"><a className="ls-link" href={exp.url} download>⬇ Download</a></div>
            {exp.info?.path && <p className="st-hint">Also saved to <code>{exp.info.path}</code></p>}
          </div>
        )}
      </section>

      <section className="st-card ls-tips">
        <h3>Tips for a clean loop</h3>
        <ul>
          <li>Keep the camera <b>locked off</b> and ask only for tiny motion: swaying leaves, rain, steam, flickering light.</li>
          <li>Avoid people walking through, fast movement and lighting changes; they are the things a viewer notices on repeat.</li>
          <li>Raise <b>Hold the picture still</b> if the background seems to breathe; lower it if something you wanted to move looks frozen.</li>
          <li>Leave "Make it loop-friendly" on: the video starts and ends on your picture.</li>
          <li>A longer loop is less obvious. Generate 7 s, or chain two clips in the Timeline and loop the result.</li>
          <li>Check the seam with <b>Watch the seam</b> before exporting.</li>
        </ul>
      </section>
    </div>
  );
}
