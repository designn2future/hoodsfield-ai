import React, { useEffect, useMemo, useRef, useState } from 'react';
import { durationOptions, H3_GRID_FALLBACK, ASPECTS } from '../h3.js';
import { buildEdl, edlDuration } from '../mvEdit.js';
import { SEG_COLORS } from './PromptTimeline.jsx';

const STEPS = ['1 · Track', '2 · Cast', '3 · Script', '4 · Produce', '5 · Cut & Render'];
const SECTION_COLORS = { intro: '#4f8edc', verse: '#5cb85c', build: '#d6b25b', chorus: '#e07b3a', bridge: '#b05bd6', outro: '#5bc9d6', song: '#7d8fd0' };
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** Energy curve + beats + sections, drawn on a canvas; optional pieces overlay. */
function TrackStrip({ analysis, range, pieces, sceneIndex, onRange }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !analysis) return;
    const W = c.clientWidth, H = 64;
    c.width = W * devicePixelRatio; c.height = H * devicePixelRatio;
    const g = c.getContext('2d');
    g.scale(devicePixelRatio, devicePixelRatio);
    g.clearRect(0, 0, W, H);
    const dur = analysis.duration;
    const x = (t) => (t / dur) * W;
    // sections
    for (const s of analysis.sections || []) {
      g.fillStyle = (SECTION_COLORS[s.label] || '#7d8fd0') + '33';
      g.fillRect(x(s.start), 0, x(s.end) - x(s.start), H);
    }
    // pieces overlay (final cut) — colour by scene index
    if (pieces?.length) {
      for (const p of pieces) {
        g.fillStyle = SEG_COLORS[(sceneIndex.get(p.sceneId) ?? 0) % SEG_COLORS.length] + 'aa';
        g.fillRect(x(p.at), 34, Math.max(1, x(p.at + p.dur) - x(p.at) - 1), 26);
      }
    }
    // energy
    const e = analysis.energy || [];
    g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#14e8ff'; g.lineWidth = 1;
    g.beginPath();
    e.forEach((v, i) => {
      const px = (i / e.length) * W, py = 32 - v * 28;
      i ? g.lineTo(px, py) : g.moveTo(px, py);
    });
    g.stroke();
    // beats / downbeats
    g.fillStyle = 'rgba(255,255,255,0.18)';
    for (const b of analysis.beats || []) g.fillRect(x(b), 30, 1, 4);
    g.fillStyle = 'rgba(255,255,255,0.5)';
    for (const b of analysis.downbeats || []) g.fillRect(x(b), 28, 1, 8);
    // range mask
    if (range) {
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(0, 0, x(range.start), H);
      g.fillRect(x(range.end), 0, W - x(range.end), H);
    }
  }, [analysis, range, pieces, sceneIndex]);

  const drag = (e) => {
    if (!onRange || !analysis) return;
    const rect = ref.current.getBoundingClientRect();
    const toT = (cx) => Math.max(0, Math.min(analysis.duration, ((cx - rect.left) / rect.width) * analysis.duration));
    const t0 = toT(e.clientX);
    const move = (ev) => {
      const t1 = toT(ev.clientX);
      if (Math.abs(t1 - t0) > 0.5) onRange({ start: Math.min(t0, t1), end: Math.max(t0, t1) });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return <canvas ref={ref} className="track-strip" onPointerDown={drag} title={onRange ? 'Drag to limit the edit to part of the song' : ''} />;
}

export default function MusicVideoPanel({
  mv, setMv, assets, scenes, health, h3Catalog, batch, scriptBusy, renderState,
  onSetTrack, onRemoveTrack, onAddCharacters, onUpdateCharacter, onReplaceCharacterPhoto, onRemoveCharacter, onDescribeCharacter,
  onAddStyleRefs, onRemoveStyleRef, onDescribeStyle, styleDescribeBusy, styleDescribeMsg,
  onWriteScript, onScenesToBoard, onRunBatch, onStopBatch, onRenderFinal, onOpenDetail, onFocusScenes,
}) {
  const step = mv.step || 0;
  const setStep = (s) => setMv((m) => ({ ...m, step: s }));
  const patch = (p) => setMv((m) => ({ ...m, ...p }));
  const trackRef = useRef(null);
  const castRef = useRef(null);
  const replacePhotoRef = useRef(null);
  const [replaceTargetId, setReplaceTargetId] = useState(null);
  const styleRef = useRef(null);
  const track = assets.find((a) => a.id === mv.trackAssetId);
  const analysis = mv.analysis;
  const cast = mv.castIds.map((id) => assets.find((a) => a.id === id)).filter(Boolean);
  const styleRefs = mv.styleIds.map((id) => assets.find((a) => a.id === id)).filter(Boolean);
  const mvScenes = scenes.filter((s) => s.mv);
  const order = [...mvScenes].sort((a, b) => (a.mvIndex ?? 0) - (b.mvIndex ?? 0));
  // colour by SETUP, not by individual shot — so a setup's shots (and its
  // later recurrences elsewhere in the song) all read as the same colour,
  // which is what actually shows the cross-cutting on the strip/legend
  const setupOrder = useMemo(() => [...new Set(order.map((s) => s.setupId || s.id))], [order]);
  const setupIndex = useMemo(() => new Map(setupOrder.map((id, i) => [id, i])), [setupOrder]);
  const sceneIndex = useMemo(
    () => new Map(order.map((s) => [s.id, setupIndex.get(s.setupId || s.id) ?? 0])),
    [order, setupIndex]
  );
  const setupGroups = useMemo(() => {
    const groups = new Map();
    for (const s of order) {
      const key = s.setupId || s.id;
      if (!groups.has(key)) groups.set(key, { id: key, name: s.setupName || s.title || 'Scene', color: SEG_COLORS[setupIndex.get(key) % SEG_COLORS.length], scenes: [] });
      groups.get(key).scenes.push(s);
    }
    return [...groups.values()];
  }, [order, setupIndex]);
  const durations = durationOptions(h3Catalog?.frame_grid || H3_GRID_FALLBACK);
  const llmOk = !!health?.ollama;

  // Estimated per-character screen time in the eventual auto-cut, computed
  // from the SCRIPT's planned shot lengths (not real clips — nothing has
  // been generated yet) so imbalances like "too much of character A, not
  // enough of B" show up before any GPU time is spent, not after.
  const screenTime = useMemo(() => {
    const shots = mv.script?.scenes;
    if (!shots?.length || !analysis) return null;
    const clips = shots.map((sc) => ({
      sceneId: sc.id, assetId: sc.id, duration: (sc.frames || mv.frames) / 24,
      sections: sc.sections || (sc.section ? [sc.section] : []), setupId: sc.setupId || sc.id, energy: sc.energy,
    }));
    const pieces = buildEdl(analysis, clips, {
      style: mv.cut.style, seed: mv.cut.seed, start: mv.range?.start ?? 0, end: mv.range?.end ?? analysis.duration,
    });
    if (!pieces.length) return null;
    const byId = new Map(shots.map((sc) => [sc.id, sc]));
    const totals = new Map();
    let untagged = 0, total = 0;
    for (const p of pieces) {
      total += p.dur;
      const names = byId.get(p.sceneId)?.characters;
      if (!names?.length) { untagged += p.dur; continue; }
      for (const nm of names) totals.set(nm, (totals.get(nm) || 0) + p.dur);
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    return { ranked, untagged, total };
  }, [mv.script, mv.cut.style, mv.cut.seed, mv.range, analysis, mv.frames]);
  const [trackBusy, setTrackBusy] = useState(false);
  const [trackErr, setTrackErr] = useState('');

  const withVideo = order.filter((s) => s.videoAssetId && assets.find((a) => a.id === s.videoAssetId));
  const stillsMissing = order.filter((s) => !s.assetId).length;
  const clipsMissing = order.filter((s) => !s.videoAssetId).length;

  const pickTrack = async (file) => {
    setTrackBusy(true); setTrackErr('');
    try { await onSetTrack(file); } catch (e) { setTrackErr(e.message); } finally { setTrackBusy(false); }
  };

  const buildCut = (seed = mv.cut.seed) => {
    const clips = withVideo.map((s) => {
      const v = assets.find((a) => a.id === s.videoAssetId);
      return {
        sceneId: s.id, assetId: s.videoAssetId, duration: v?.meta?.seconds || (s.frames || 124) / 24,
        sections: s.sections || (s.section ? [s.section] : []), setupId: s.setupId || s.id, energy: s.energy,
      };
    });
    const pieces = buildEdl(analysis, clips, { style: mv.cut.style, seed, start: mv.range?.start ?? 0, end: mv.range?.end ?? analysis?.duration });
    patch({ cut: { ...mv.cut, seed, pieces } });
  };

  const finalAsset = assets.find((a) => a.id === mv.finalAssetId);
  const cutTotal = edlDuration(mv.cut.pieces || []);

  return (
    <section className="mv-panel">
      <header className="mv-head">
        <h2>🎵 Music Video</h2>
        <div className="mv-steps">
          {STEPS.map((s, i) => (
            <button key={s} className={`mv-step ${step === i ? 'active' : ''} ${i < step ? 'done' : ''}`} onClick={() => setStep(i)}>{s}</button>
          ))}
        </div>
      </header>

      {/* ------------------------------------------------------------ 1 TRACK */}
      {step === 0 && (
        <div className="mv-body">
          <div className="hint">Drop in the song. It's beat-tracked and split into sections so the director can plan scenes and the editor can cut on the beat.</div>
          <div className="row">
            <button disabled={trackBusy} onClick={() => trackRef.current?.click()}>{trackBusy ? '⏳ Analyzing…' : track ? '🎵 Replace track' : '🎵 Choose track'}</button>
            <input ref={trackRef} type="file" accept="audio/*,video/mp4" hidden
              onChange={(e) => { if (e.target.files?.[0]) pickTrack(e.target.files[0]); e.target.value = ''; }} />
            {track && <button className="danger" onClick={onRemoveTrack}>Remove</button>}
          </div>
          {trackErr && <div className="error">{trackErr}</div>}
          {track && analysis && (
            <>
              <div className="mv-track-meta">
                <b>{track.name}</b> · {fmt(analysis.duration)} · {Math.round(analysis.bpm)} BPM · {analysis.beats?.length} beats · {(analysis.sections || []).length} sections
              </div>
              <audio src={track.url} controls className="mv-audio" />
              <TrackStrip analysis={analysis} range={mv.range} sceneIndex={sceneIndex}
                onRange={(r) => patch({ range: { start: Math.round(r.start * 10) / 10, end: Math.round(r.end * 10) / 10 } })} />
              <div className="sec-list">
                {(analysis.sections || []).map((s, i) => (
                  <span key={i} className="sec-chip-wrap">
                    <span className="sec-chip-top">
                      <span className="sec-idx">{i + 1}</span>
                      <input className="chip sec-chip-input" style={{ borderColor: SECTION_COLORS[s.label] || '#7d8fd0' }}
                        size={Math.max(6, s.label.length + 1)}
                        title={`energy ${s.energy} — rename this section; every scene card's section badge updates to match`}
                        value={s.label}
                        onChange={(e) => patch({
                          analysis: {
                            ...analysis,
                            sections: analysis.sections.map((sec, si) => (si === i ? { ...sec, label: e.target.value } : sec)),
                          },
                        })} />
                    </span>
                    <span className="sec-time">{fmt(s.start)}–{fmt(s.end)}</span>
                  </span>
                ))}
              </div>
              <div className="grid2">
                <label>Edit from (s)
                  <input type="number" min={0} max={analysis.duration} step={0.1} value={mv.range?.start ?? 0}
                    onChange={(e) => patch({ range: { ...mv.range, start: Math.max(0, +e.target.value) } })} />
                </label>
                <label>to (s)
                  <input type="number" min={0} max={analysis.duration} step={0.1} value={mv.range?.end ?? analysis.duration}
                    onChange={(e) => patch({ range: { ...mv.range, end: Math.min(analysis.duration, +e.target.value) } })} />
                  <span className="param-hint">Tip: start with the first 30–60 s — every clip is a few minutes of GPU time.</span>
                </label>
              </div>
              <button className="primary" onClick={() => setStep(1)}>Next: Cast →</button>
            </>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------ 2 CAST */}
      {step === 1 && (
        <div className="mv-body">
          <div className="hint">Character photos. Each becomes a face reference pinned onto the stills (ReActor), and a description the director writes for. Clear, front-facing faces work best.</div>
          <div className="row">
            <button onClick={() => castRef.current?.click()}>👤 Add character image(s)</button>
            <input ref={castRef} type="file" accept="image/*" multiple hidden
              onChange={(e) => { if (e.target.files?.length) onAddCharacters([...e.target.files]); e.target.value = ''; }} />
            <input ref={replacePhotoRef} type="file" accept="image/*" hidden
              onChange={(e) => {
                if (e.target.files?.[0] && replaceTargetId) onReplaceCharacterPhoto(replaceTargetId, e.target.files[0]);
                e.target.value = ''; setReplaceTargetId(null);
              }} />
          </div>
          <div className="cast-grid">
            {cast.map((c) => {
              const noName = !c.meta?.name?.trim();
              return (
                <div key={c.id} className={`cast-card glass ${noName ? 'warn' : ''}`}>
                  <img src={c.url} alt={c.meta?.name} />
                  <input value={c.meta?.name || ''} placeholder="Name — required" className={noName ? 'warn' : ''}
                    onChange={(e) => onUpdateCharacter(c.id, { name: e.target.value })} />
                  {noName && <div className="hint pt-warn">⚠ Needs a name — the director won't recognize this character without one.</div>}
                  <textarea rows={3} value={c.meta?.description || ''} placeholder="Look, wardrobe, vibe… (or describe with the vision model)"
                    onChange={(e) => onUpdateCharacter(c.id, { description: e.target.value })} />
                  <div className="row">
                    <button title="Swap this photo for a different one — keeps the name/description and every scene that already has them cast"
                      onClick={() => { setReplaceTargetId(c.id); replacePhotoRef.current?.click(); }}>🔄 Replace photo</button>
                    <button disabled={!llmOk || c.meta?.describing} title={llmOk ? 'Describe with the local Ollama vision model' : 'Start Ollama (with a qwen-vl model) to auto-describe'}
                      onClick={() => onDescribeCharacter(c.id)}>{c.meta?.describing ? '⏳' : '👁 Describe'}</button>
                    <button className="danger" onClick={() => onRemoveCharacter(c.id)}>Remove</button>
                  </div>
                </div>
              );
            })}
            {!cast.length && <div className="hint">No characters yet — optional, the director can invent a performer.</div>}
          </div>

          <h4 className="sd-h" style={{ marginTop: 18 }}>Style &amp; environment references</h4>
          <div className="hint">
            Images that represent the look — location, palette, lighting, production design. These
            condition every still directly (Krea 2's own image-reference path) and can be summarized
            into the Visual style text in the next step.
          </div>
          <div className="row">
            <button onClick={() => styleRef.current?.click()}>🖼️ Add style / environment image(s)</button>
            <input ref={styleRef} type="file" accept="image/*" multiple hidden
              onChange={(e) => { if (e.target.files?.length) onAddStyleRefs([...e.target.files]); e.target.value = ''; }} />
          </div>
          <div className="styleref-grid">
            {styleRefs.map((s) => (
              <div key={s.id} className="styleref-card">
                <img src={s.url} alt="" />
                <button className="xbtn thumb-x" onClick={() => onRemoveStyleRef(s.id)}>✕</button>
              </div>
            ))}
            {!styleRefs.length && <div className="hint">None yet — optional, the director falls back to the Visual style text alone.</div>}
          </div>

          <button className="primary" onClick={() => setStep(2)}>Next: Script →</button>
        </div>
      )}

      {/* ------------------------------------------------------------ 3 SCRIPT */}
      {step === 2 && (
        <div className="mv-body">
          <div className="hint">The director (local Ollama model) writes a shot list across the song's sections: a still prompt and a motion prompt per scene. Edit anything before adding the scenes to the board.</div>
          <label>Concept / story
            <textarea rows={3} value={mv.concept} placeholder="e.g. a late-night drive through the city after a breakup; she's letting go, the city is glowing…"
              onChange={(e) => patch({ concept: e.target.value })} />
          </label>
          <label>Visual style
            <textarea rows={2} value={mv.style} placeholder="e.g. 35mm film, teal-and-amber grade, neon reflections, shallow depth of field"
              onChange={(e) => patch({ style: e.target.value })} />
          </label>
          {styleRefs.length > 0 && (
            <div className="row">
              <button disabled={!llmOk || styleDescribeBusy}
                title={llmOk ? `Describe the ${styleRefs.length} style/environment reference(s) with the vision model and append to the text above` : 'Start Ollama (with a qwen-vl model) to auto-describe'}
                onClick={onDescribeStyle}>
                {styleDescribeBusy ? '⏳ Describing…' : `👁 Describe ${styleRefs.length} reference${styleRefs.length > 1 ? 's' : ''} → style text`}
              </button>
            </div>
          )}
          {styleDescribeMsg && <div className="hint">{styleDescribeMsg}</div>}
          <label>Lyrics / themes (optional)
            <textarea rows={3} value={mv.lyrics} placeholder="Paste lyrics or key lines — the director places matching imagery"
              onChange={(e) => patch({ lyrics: e.target.value })} />
            <span className="param-hint">
              Multiple singers? Label who sings what (e.g. "[Verse 1: The Weeknd]" / "[Verse 2: Playboi Carti]")
              and the director will give that performer a lip-synced close-up singing their own line during that
              part — without a label it can't tell who's singing and won't guess.
            </span>
          </label>
          <div className="grid2">
            <label>Aspect
              <select value={mv.aspect} onChange={(e) => patch({ aspect: e.target.value })}>
                {ASPECTS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
            <label>Scenes
              <input type="number" min={1} max={40} value={mv.nScenes} onChange={(e) => patch({ nScenes: Math.max(1, +e.target.value) })} />
              <span className="param-hint">Each scene = one still + one clip. 6–12 is plenty for a 60 s cut.</span>
            </label>
            <label>Clip length
              <select value={mv.frames} onChange={(e) => patch({ frames: +e.target.value })}>
                {durations.map((d) => <option key={d.frames} value={d.frames}>{d.label}</option>)}
              </select>
            </label>
            <label>Quality
              <select value={mv.preset} onChange={(e) => patch({ preset: e.target.value })}>
                <option value="fast">Fast — 4-step</option>
                <option value="quality">Quality — 8-step</option>
              </select>
            </label>
          </div>
          <label className="checkbox-label">
            <input type="checkbox" checked={mv.useLlm && llmOk} disabled={!llmOk} onChange={(e) => patch({ useLlm: e.target.checked })} />
            Use the LLM director {llmOk ? `(${health.ollama_text_model || 'Ollama'})` : '— Ollama not running; the template writer will be used'}
          </label>
          {llmOk && (health.ollama_models || []).length > 1 && (
            <label>Director model
              <select value={mv.llmModel || ''} onChange={(e) => patch({ llmModel: e.target.value })}>
                <option value="">auto ({health.ollama_text_model})</option>
                {health.ollama_models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          )}
          <button className="primary" disabled={!analysis || scriptBusy} onClick={onWriteScript}>
            {scriptBusy ? '⏳ Writing…' : mv.script ? '✍️ Rewrite script' : '✍️ Write script'}
          </button>
          {!analysis && <div className="hint">Add a track first (step 1).</div>}
          {mv.scriptError && <div className="error">{mv.scriptError}</div>}
          {mv.script && (
            <>
              <div className="mv-script-head">
                <b>{mv.script.title}</b>
                <span className="hint">
                  {(mv.script.setups || []).length} setup{(mv.script.setups || []).length === 1 ? '' : 's'} · {mv.script.scenes.length} shots · written by {mv.script.source === 'ollama' ? mv.script.model : 'template'}
                </span>
              </div>
              {mv.script.warning && <div className="hint pt-warn">{mv.script.warning}</div>}
              {screenTime && (
                <div className="setup-card glass">
                  <div className="hint">
                    Estimated screen time in the eventual cut (from planned shot lengths — nothing generated yet;
                    edit sections/shots below and this updates):
                  </div>
                  <div className="pt-strip" style={{ height: 14, cursor: 'default' }}>
                    {screenTime.ranked.map(([name, secs], i) => (
                      <div key={name} style={{ flexGrow: secs, background: SEG_COLORS[i % SEG_COLORS.length] }}
                        title={`${name}: ${secs.toFixed(1)}s (${Math.round(100 * secs / screenTime.total)}%)`} />
                    ))}
                    {screenTime.untagged > 0.05 && (
                      <div style={{ flexGrow: screenTime.untagged, background: '#3a3f52' }}
                        title={`No named cast: ${screenTime.untagged.toFixed(1)}s`} />
                    )}
                  </div>
                  <div className="legend">
                    {screenTime.ranked.map(([name, secs], i) => (
                      <span key={name} className="chip" style={{ borderColor: SEG_COLORS[i % SEG_COLORS.length] }}>
                        {name} · {secs.toFixed(1)}s · {Math.round(100 * secs / screenTime.total)}%
                      </span>
                    ))}
                    {screenTime.untagged > 0.05 && (
                      <span className="chip" style={{ borderColor: '#3a3f52' }}>
                        no named cast · {screenTime.untagged.toFixed(1)}s · {Math.round(100 * screenTime.untagged / screenTime.total)}%
                      </span>
                    )}
                  </div>
                </div>
              )}
              {mv.script.style && <div className="hint">Style: {mv.script.style}</div>}
              <div className="hint">
                Each SETUP is a recurring location/look — tick which song sections it returns in (that's the
                cross-cutting: a setup's shots get intercut with other setups' whenever they share a section).
                Its SHOTS are the coverage of that one setup (wide/medium/close-up/insert…).
              </div>
              {(mv.script.setups || []).map((su, gi) => (
                <div key={su.id} className="setup-card glass" style={{ borderLeftColor: SEG_COLORS[gi % SEG_COLORS.length] }}>
                  <div className="row">
                    <input className="ss-title" value={su.name} onChange={(e) => patchSetup(su.id, { name: e.target.value })} />
                    <button className="xbtn" title="Remove this setup and all its shots" onClick={() => removeSetup(su.id)}>✕</button>
                  </div>
                  <div className="grid2">
                    <label>Location
                      <input value={su.location} onChange={(e) => patchSetup(su.id, { location: e.target.value })} />
                    </label>
                    <label>Time of day / light
                      <input value={su.timeOfDay} onChange={(e) => patchSetup(su.id, { timeOfDay: e.target.value })} />
                    </label>
                  </div>
                  <label>Continuity (repeated in every shot below so independent generations still match)
                    <input value={su.continuity} onChange={(e) => patchSetup(su.id, { continuity: e.target.value })} />
                  </label>
                  <label className="pt-label">Appears in sections (tick 2+ so this setup recurs / cross-cuts)</label>
                  <div className="sec-toggle">
                    {(analysis?.sections || []).map((s, j) => (
                      <button key={j} className={`chip ${su.sections.includes(j + 1) ? 'on' : ''}`}
                        onClick={() => toggleSetupSection(su.id, j + 1)}>{j + 1} {s.label}</button>
                    ))}
                  </div>
                  <div className="hint">{(su.characters || []).join(', ') || 'no named cast'}</div>

                  {mv.script.scenes.filter((sc) => sc.setupId === su.id).map((sc) => (
                    <div key={sc.id} className="shot-card">
                      <div className="row">
                        <select className="shot-size" value={sc.shotSize} onChange={(e) => patchShot(sc.id, { shotSize: e.target.value })}>
                          {['wide', 'medium', 'close-up', 'insert', 'over-the-shoulder', 'pov'].map((sz) => <option key={sz} value={sz}>{sz}</option>)}
                        </select>
                        <select value={sc.frames} onChange={(e) => patchShot(sc.id, { frames: +e.target.value, seconds: +e.target.value / 24 })}>
                          {durations.map((d) => <option key={d.frames} value={d.frames}>{d.label}</option>)}
                        </select>
                        <span className="hint">{sc.sceneId ? '· on board' : ''}</span>
                        <button className="xbtn" onClick={() => removeShot(sc.id)}>✕</button>
                      </div>
                      <label>Still prompt
                        <textarea rows={3} value={sc.stillPrompt} onChange={(e) => patchShot(sc.id, { stillPrompt: e.target.value })} />
                      </label>
                      <label>Motion prompt
                        <textarea rows={2} value={sc.motionPrompt} onChange={(e) => patchShot(sc.id, { motionPrompt: e.target.value })} />
                      </label>
                      <div className="grid2">
                        <label>Dialogue
                          <input value={sc.dialogue || ''} onChange={(e) => patchShot(sc.id, { dialogue: e.target.value })} />
                        </label>
                        <label>Soundscape
                          <input value={sc.soundscape || ''} onChange={(e) => patchShot(sc.id, { soundscape: e.target.value })} />
                        </label>
                      </div>
                    </div>
                  ))}
                  <button onClick={() => addShotToSetup(su.id)}>＋ Add shot to this setup</button>
                </div>
              ))}
              <button className="primary" disabled={!mv.script.scenes.length} onClick={() => { onScenesToBoard(); setStep(3); }}>
                ＋ Add {mv.script.scenes.filter((s) => !s.sceneId).length || mv.script.scenes.length} shot{mv.script.scenes.length > 1 ? 's' : ''} to the board →
              </button>
            </>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------ 4 PRODUCE */}
      {step === 3 && (
        <div className="mv-body">
          <div className="hint">Stills first (Krea 2, faces pinned), then clips (MiniMax H3, starting from each still). Runs one job at a time; you can keep editing cards on the board meanwhile.</div>
          {!order.length && <div className="hint">No music-video scenes on the board yet — write a script (step 3) and add it.</div>}
          <div className="row">
            <button className="primary-lite" disabled={batch.phase === 'run' || !stillsMissing} onClick={() => onRunBatch('stills')}>
              🎨 Generate {stillsMissing} missing still{stillsMissing === 1 ? '' : 's'}
            </button>
            <button className="primary-lite" disabled={batch.phase === 'run' || !order.filter((s) => s.assetId && !s.videoAssetId).length} onClick={() => onRunBatch('clips')}>
              🎬 Generate {order.filter((s) => s.assetId && !s.videoAssetId).length} missing clip{clipsMissing === 1 ? '' : 's'}
            </button>
            <button disabled={batch.phase === 'run' || !order.length} onClick={() => onRunBatch('all')} title="Stills for scenes without one, then clips for scenes without one">▶ Everything</button>
            {batch.phase === 'run' && <button className="cancel-btn" onClick={onStopBatch}>■ Stop after this</button>}
          </div>
          {batch.phase === 'run' && (
            <div className="hint">{batch.kind} {batch.done + 1}/{batch.total} — {batch.current}</div>
          )}
          {batch.phase === 'done' && <div className="hint">Batch finished.</div>}
          <div className="produce-list">
            {order.map((s, i) => {
              const still = assets.find((a) => a.id === s.assetId);
              const vid = assets.find((a) => a.id === s.videoAssetId);
              return (
                <div key={s.id} className={`produce-row ${s.gen?.phase === 'run' ? 'busy' : ''}`} style={{ borderLeftColor: SEG_COLORS[i % SEG_COLORS.length] }}>
                  <div className="produce-thumb" onClick={() => onOpenDetail(s.id)} title="Open">
                    {vid ? <video src={vid.url} muted loop autoPlay /> : still ? <img src={still.url} alt="" /> : <span>—</span>}
                  </div>
                  <div className="produce-info">
                    <b>{i + 1}. {s.title || `Scene ${i + 1}`}</b>
                    <div className="hint">{s.sectionLabel || (s.section ? `section ${s.section}` : '')} · {((s.frames || 124) / 24).toFixed(1)} s · {s.preset || 'fast'}</div>
                    <div className="produce-status">
                      <span className={still ? 'ok' : ''}>{still ? '✓ still' : '○ still'}</span>
                      <span className={vid ? 'ok' : ''}>{vid ? '✓ clip' : '○ clip'}</span>
                      {s.gen?.phase === 'run' && <span className="run">⏳ {s.gen.status}</span>}
                      {s.gen?.phase === 'error' && <span className="err" title={s.gen.error}>✕ {s.gen.error?.slice(0, 60)}</span>}
                    </div>
                  </div>
                  <button onClick={() => onOpenDetail(s.id)}>Open</button>
                </div>
              );
            })}
          </div>
          {order.length > 0 && <button onClick={onFocusScenes}>🗺 Show scenes on board</button>}
          <button className="primary" disabled={!withVideo.length} onClick={() => { setStep(4); if (!mv.cut.pieces?.length) setTimeout(() => buildCut(), 0); }}>
            Next: Cut &amp; Render ({withVideo.length} clip{withVideo.length === 1 ? '' : 's'} ready) →
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------ 5 CUT */}
      {step === 4 && (
        <div className="mv-body">
          <div className="hint">Every cut lands on a beat. Choruses cut fast, verses breathe, each clip is consumed progressively so repeats show a different moment. Reshuffle until it feels right, then render.</div>
          {!analysis && <div className="error">No track analysis — go back to step 1.</div>}
          <div className="grid2">
            <label>Cut style
              <select value={mv.cut.style} onChange={(e) => { patch({ cut: { ...mv.cut, style: e.target.value } }); }}>
                <option value="auto">Auto — follows section energy</option>
                <option value="fast">Fast — 1–2 beats</option>
                <option value="medium">Medium — 2–4 beats</option>
                <option value="slow">Slow — 4–8 beats</option>
              </select>
            </label>
            <label>Output size
              <select value={mv.cut.size} onChange={(e) => patch({ cut: { ...mv.cut, size: e.target.value } })}>
                <option value="native">Native clip size (sharpest)</option>
                <option value="1080">1080 class (upscaled)</option>
                <option value="720">720 class</option>
              </select>
            </label>
            <label>Music gain
              <input type="number" step={0.05} min={0} max={2} value={mv.cut.musicGain} onChange={(e) => patch({ cut: { ...mv.cut, musicGain: +e.target.value } })} />
            </label>
            <label>Clip audio under music
              <input type="number" step={0.05} min={0} max={1} value={mv.cut.clipGain} onChange={(e) => patch({ cut: { ...mv.cut, clipGain: +e.target.value } })} />
              <span className="param-hint">0 = music only. 0.15–0.3 keeps H3's ambience/foley faintly under the track.</span>
            </label>
            <label>Fade out (s)
              <input type="number" step={0.5} min={0} max={10} value={mv.cut.fadeOut} onChange={(e) => patch({ cut: { ...mv.cut, fadeOut: +e.target.value } })} />
            </label>
          </div>
          <div className="row">
            <button className="primary-lite" disabled={!withVideo.length || !analysis} onClick={() => buildCut(mv.cut.seed)}>✂️ Build cut</button>
            <button disabled={!withVideo.length || !analysis} onClick={() => buildCut((mv.cut.seed || 1) + 1)}>🎲 Reshuffle</button>
            <span className="hint">{(mv.cut.pieces || []).length} cuts · {cutTotal.toFixed(1)} s · seed {mv.cut.seed}</span>
          </div>
          {analysis && <TrackStrip analysis={analysis} range={mv.range} pieces={mv.cut.pieces} sceneIndex={sceneIndex} />}
          <div className="hint">Colour = setup — the same colour returning later means that setup is being cross-cut back in, not repeated in place.</div>
          <div className="legend">
            {setupGroups.map((g) => (
              <span key={g.id} className="chip" style={{ borderColor: g.color }}>
                {g.name} · {g.scenes.length} shot{g.scenes.length > 1 ? 's' : ''}
                {g.scenes.some((s) => !s.videoAssetId) ? ` (${g.scenes.filter((s) => !s.videoAssetId).length} missing)` : ''}
              </span>
            ))}
          </div>
          <div className="edl-list">
            {(mv.cut.pieces || []).map((p, i) => {
              const s = scenes.find((x) => x.id === p.sceneId);
              const idx = sceneIndex.get(p.sceneId) ?? 0;
              return (
                <div key={i} className="edl-row" style={{ borderLeftColor: SEG_COLORS[idx % SEG_COLORS.length] }}>
                  <span className="edl-t">{fmt(p.at)}</span>
                  <span className="edl-n">{s?.setupName || s?.title || 'scene'}{s?.shotSize ? ` — ${s.shotSize}` : ''}</span>
                  <span className="hint">{p.in.toFixed(2)}→{p.out.toFixed(2)} s · {p.dur.toFixed(2)} s</span>
                </div>
              );
            })}
          </div>
          <button className="primary" disabled={!(mv.cut.pieces || []).length || renderState.phase === 'run'}
            onClick={() => onRenderFinal()}>
            {renderState.phase === 'run' ? '⏳ Rendering…' : '🎬 Render final video'}
          </button>
          {renderState.error && <div className="error">{renderState.error}</div>}
          {finalAsset && (
            <div className="final-out">
              <video src={finalAsset.url} controls />
              <a className="dl" href={finalAsset.url} download={`${(mv.script?.title || 'music-video').replace(/[^\w\- ]+/g, '')}.mp4`}>Download final video</a>
            </div>
          )}
        </div>
      )}
    </section>
  );

  function patchShot(id, p) {
    setMv((m) => ({ ...m, script: { ...m.script, scenes: m.script.scenes.map((s) => (s.id === id ? { ...s, ...p } : s)) } }));
  }

  function removeShot(id) {
    setMv((m) => {
      const removed = m.script.scenes.find((s) => s.id === id);
      const remaining = m.script.scenes.filter((s) => s.id !== id);
      let setups = m.script.setups || [];
      if (removed) {
        setups = setups
          .map((su) => (su.id === removed.setupId ? { ...su, shotIds: su.shotIds.filter((sid) => sid !== id) } : su))
          .filter((su) => su.shotIds.length > 0);
      }
      return { ...m, script: { ...m.script, scenes: remaining, setups } };
    });
  }

  function patchSetup(id, p) {
    setMv((m) => ({ ...m, script: { ...m.script, setups: (m.script.setups || []).map((su) => (su.id === id ? { ...su, ...p } : su)) } }));
  }

  function toggleSetupSection(setupId, secIdx) {
    setMv((m) => {
      const setups = (m.script.setups || []).map((su) => {
        if (su.id !== setupId) return su;
        const has = su.sections.includes(secIdx);
        const sections = (has ? su.sections.filter((s) => s !== secIdx) : [...su.sections, secIdx]).sort((a, b) => a - b);
        const sectionLabels = sections.map((si) => analysis?.sections?.[si - 1]?.label || '');
        return { ...su, sections, sectionLabels };
      });
      const su = setups.find((x) => x.id === setupId);
      const scenes = m.script.scenes.map((sc) => (
        sc.setupId === setupId
          ? { ...sc, sections: su.sections, section: su.sections[0] ?? sc.section, sectionLabel: su.sectionLabels[0] ?? sc.sectionLabel }
          : sc
      ));
      return { ...m, script: { ...m.script, setups, scenes } };
    });
  }

  function removeSetup(setupId) {
    setMv((m) => ({
      ...m,
      script: {
        ...m.script,
        setups: (m.script.setups || []).filter((su) => su.id !== setupId),
        scenes: m.script.scenes.filter((sc) => sc.setupId !== setupId),
      },
    }));
  }

  function addShotToSetup(setupId) {
    setMv((m) => {
      const su = (m.script.setups || []).find((x) => x.id === setupId);
      if (!su) return m;
      const id = `shot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const newShot = {
        id, title: `${su.name} — new shot`, setupId, setupName: su.name, shotSize: 'medium',
        sections: su.sections, section: su.sections[0] ?? 1, sectionLabel: su.sectionLabels?.[0] || '',
        location: su.location, timeOfDay: su.timeOfDay, characters: su.characters, continuity: su.continuity,
        stillPrompt: su.continuity || '', motionPrompt: '', dialogue: '', soundscape: '',
        frames: m.frames, seconds: m.frames / 24, energy: 0.5,
      };
      return {
        ...m,
        script: {
          ...m.script,
          setups: (m.script.setups || []).map((x) => (x.id === setupId ? { ...x, shotIds: [...x.shotIds, id] } : x)),
          scenes: [...m.script.scenes, newShot],
        },
      };
    });
  }
}
