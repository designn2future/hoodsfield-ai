import GenProgress from './GenProgress.jsx';
import H3CoachPreview from './H3CoachPreview.jsx';
import React, { useEffect, useState } from 'react';
import PromptTimeline from './PromptTimeline.jsx';
import LoraRows from './LoraRows.jsx';
import MotionPicker from './MotionPicker.jsx';
import WanOptions from './WanOptions.jsx';
import { listLoras, listGgufModels, describeImage, qaAnalyze } from '../api.js';
import { durationOptions, H3_GRID_FALLBACK, RESOLUTIONS, ASPECTS, loadH3Loras, saveH3LoraDefault } from '../h3.js';

/** Lightbox opened by double-clicking a scene card: zoomed media + full options. */
export default function SceneDetail({
  scene, idx, asset, videoAsset, sketchSource, kreaSource, characters = [], styleRefs = [], h3Catalog, mvSections,
  onUpdate, onGenerate, onGenerateStill, onCancel, onDelete, onClose, onEditSketch, onEditKrea, onEditStudio, onVideoLab, onGenjutsu, onExtend, onFinalize, onRerenderFull, onLongShot, onRemix,
}) {
  const busy = scene.gen?.phase === 'run';
  const isH3 = (scene.engine || 'h3') === 'h3';
  const isWan = scene.engine === 'wan';
  const [tab, setTab] = useState(videoAsset ? 'video' : 'image');
  const [promptMode, setPromptMode] = useState('text');
  const [advanced, setAdvanced] = useState(false);
  const [loraOptions, setLoraOptions] = useState([]);
  const [ggufOptions, setGgufOptions] = useState([]);
  const [qa, setQa] = useState({ busy: false, res: null, error: null });
  const [describe, setDescribe] = useState({ busy: false, error: null, source: null });

  useEffect(() => {
    if (isH3) listLoras().then(setLoraOptions);
    if (!isH3 && !isWan) {
      listLoras().then(setLoraOptions);
      listGgufModels().then(setGgufOptions);
    }
  }, [isH3, isWan]);

  /** Image -> prompt: embedded ComfyUI/A1111 metadata first, else Ollama
   * Qwen-VL description. Lands in the STILL prompt (it describes the image). */
  const onDescribe = async (mode) => {
    if (!asset?.blob) return;
    setDescribe({ busy: true, error: null, source: null });
    try {
      const r = await describeImage(asset.blob, mode);
      onUpdate(scene.id, { stillPrompt: r.prompt });
      setDescribe({ busy: false, error: null, source: r.source === 'embedded' ? 'embedded ComfyUI prompt' : `described by ${r.model || 'Ollama'}` });
    } catch (e) {
      setDescribe({ busy: false, error: e.message, source: null });
    }
  };

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => { if (videoAsset) setTab('video'); }, [videoAsset?.id]);
  useEffect(() => { setQa({ busy: false, res: null, error: null }); }, [videoAsset?.id]);
  const runQa = async (vlm) => {
    setQa({ busy: true, res: null, error: null });
    try { setQa({ busy: false, res: await qaAnalyze(videoAsset.blob, { vlm }), error: null }); }
    catch (e) { setQa({ busy: false, res: null, error: e.message }); }
  };

  const set = (k, v) => onUpdate(scene.id, { [k]: v });
  const clipSecs = isH3 ? (scene.frames || 124) / 24 : isWan ? (scene.wanSeconds ?? 5) : scene.seconds;
  const durations = durationOptions(h3Catalog?.frame_grid || H3_GRID_FALLBACK);
  const cast = scene.cast || [];
  const toggleCast = (id) => set('cast', cast.includes(id) ? cast.filter((c) => c !== id) : [...cast, id]);
  const sceneStyleRefs = scene.styleRefs || [];
  const toggleStyleRef = (id) => set('styleRefs', sceneStyleRefs.includes(id) ? sceneStyleRefs.filter((c) => c !== id) : [...sceneStyleRefs, id]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="scene-detail glass" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sd-main">
          {(videoAsset || asset) && (
            <div className="sd-tabs">
              <button className={tab === 'image' ? 'active' : ''} onClick={() => setTab('image')}>Still</button>
              <button className={tab === 'video' ? 'active' : ''} disabled={!videoAsset} onClick={() => setTab('video')}>Video</button>
            </div>
          )}
          <div className="sd-media">
            {tab === 'video' && videoAsset ? (
              (videoAsset.kind === 'video' || String(videoAsset.mime || '').startsWith('video')) ? (
                <video src={videoAsset.url} controls autoPlay loop />
              ) : (
                <img src={videoAsset.url} alt="result" />
              )
            ) : asset ? (
              <img src={asset.url} alt="scene" />
            ) : (
              <div className="card-missing">
                <div>No still yet — write a still prompt and generate one.</div>
              </div>
            )}
          </div>
          {videoAsset?.meta?.seconds && (
            <div className="hint">Clip: {videoAsset.meta.seconds.toFixed(2)} s · {videoAsset.meta.width}×{videoAsset.meta.height} · seed {videoAsset.meta.seed}</div>
          )}
        </div>

        <div className="sd-side">
          <div className="sd-head">
            <span className="badge">{idx + 1}</span>
            <input className="sd-title" value={scene.title || ''} placeholder={`Scene ${idx + 1}`}
              onChange={(e) => set('title', e.target.value)} />
            <button className="xbtn" onClick={onClose}>✕</button>
          </div>
          {scene.location && <div className="hint">📍 {scene.location}{scene.timeOfDay ? ` · ${scene.timeOfDay}` : ''}</div>}

          {/* ------------------------------------------------ still */}
          <h4 className="sd-h">1 · Still (key frame)</h4>
          <div className="hint">Text-to-image first: signage, lettering and wardrobe come out legible here, and the clip inherits the frame exactly.</div>
          <textarea rows={4} value={scene.stillPrompt || ''} disabled={busy}
            placeholder="Prompt for the key frame — subject, wardrobe, location, light, lens, any on-screen text in quotes…"
            onChange={(e) => set('stillPrompt', e.target.value)} />
          {characters.length > 0 && (
            <div className="cast-pick">
              <span className="hint">Cast (faces pinned left→right):</span>
              {characters.map((c) => (
                <button key={c.id} className={`chip ${cast.includes(c.id) ? 'on' : ''}`} disabled={busy}
                  onClick={() => toggleCast(c.id)} title={c.meta?.description || c.name}>{c.meta?.name || c.name}</button>
              ))}
            </div>
          )}
          {mvSections?.length > 0 && (
            <div className="cast-pick">
              <label className="checkbox-label">
                <input type="checkbox" checked={!!scene.mv} disabled={busy}
                  onChange={(e) => set('mv', e.target.checked)} />
                Include in the music-video cut
              </label>
              <div className="hint">
                A shot only gets cross-cut into the final video if it's checked here AND scheduled into at
                least one song section below — a plain scene (like one made via Create → Empty Scene) is
                otherwise invisible to the auto-cut editor.
              </div>
              {scene.mv && (
                <div className="sec-toggle">
                  {mvSections.map((s, i) => {
                    const secIdx = i + 1;
                    const on = (scene.sections || []).includes(secIdx);
                    return (
                      <button key={i} className={`chip ${on ? 'on' : ''}`} disabled={busy}
                        onClick={() => {
                          const next = (on
                            ? (scene.sections || []).filter((x) => x !== secIdx)
                            : [...(scene.sections || []), secIdx]).sort((a, b) => a - b);
                          onUpdate(scene.id, {
                            sections: next,
                            section: next[0] ?? scene.section,
                            sectionLabel: next.length ? mvSections[next[0] - 1]?.label || '' : '',
                          });
                        }}>{s.label}</button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {styleRefs.length > 0 && (
            <div className="cast-pick">
              <span className="hint">Style / environment references:</span>
              <div className="styleref-pick">
                {styleRefs.map((s) => (
                  <button key={s.id} className={`styleref-thumb ${sceneStyleRefs.includes(s.id) ? 'on' : ''}`} disabled={busy}
                    onClick={() => toggleStyleRef(s.id)} title={s.name}>
                    <img src={s.url} alt="" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="grid2">
            <label>Aspect
              <select value={scene.aspect || '9:16'} disabled={busy} onChange={(e) => set('aspect', e.target.value)}>
                {ASPECTS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
            <label>Still seed (−1 = rnd)
              <input type="number" value={scene.stillSeed ?? -1} disabled={busy} onChange={(e) => set('stillSeed', +e.target.value)} />
            </label>
          </div>
          <div className="describe-row">
            <button className="primary-lite" disabled={busy || !(scene.stillPrompt || '').trim()}
              onClick={() => { setTab('image'); onGenerateStill(scene.id); }}
              title="Generate the key frame with the project's image engine (Engine menu: Flux 3 or Krea 2)">
              {asset ? '🎨 Regenerate still' : '🎨 Generate still'}
            </button>
            <button disabled={busy || describe.busy || !asset?.blob} onClick={() => onDescribe('auto')}
              title="Fill the still prompt from this image: embedded ComfyUI prompt, else the local vision model">
              {describe.busy ? '⏳' : '✨'}
            </button>
          </div>
          {describe.source && <div className="hint">Still prompt filled from {describe.source}.</div>}
          {describe.error && <div className="error">{describe.error}</div>}

          {/* ------------------------------------------------ video */}
          <h4 className="sd-h">2 · Video</h4>
          <label>Engine
            <select value={scene.engine || 'h3'} disabled={busy} onChange={(e) => set('engine', e.target.value)}>
              <option value="h3">MiniMax H3 — video + native audio (recommended)</option>
              <option value="wan">Wan 2.2 — silent, LoRA support, first/last frame</option>
              <option value="ltx">LTX 2.3 (legacy)</option>
            </select>
          </label>

          {scene.engine !== 'ltx' && (
            <label className="checkbox-label draft-toggle" title="Render a fast low-resolution preview first (Wan 0.15 MP, H3 fast preset at 0.25 MP). Approve it, then finalize.">
              <input type="checkbox" checked={!!scene.draft} disabled={busy} onChange={(e) => set('draft', e.target.checked)} />
              {scene.engine === 'wan'
                ? <span>⚡ Draft mode — <b>motion preview in ~1 min</b> (rough look, true motion; the full render is ~6 min)</span>
                : <span>⚡ Draft mode — quick low-res preview, finalize only the keepers</span>}
            </label>
          )}

          <div className="pt-head">
            <label>{isH3 ? 'Motion — what happens, camera, performance' : 'Prompt — motion, mood, style'}</label>
            <div className="pt-tabs">
              <button className={promptMode === 'text' ? 'active' : ''} onClick={() => setPromptMode('text')}>Text</button>
              <button className={promptMode === 'timeline' ? 'active' : ''}
                title="Shots: colour-coded time segments — each directs a slice of the clip"
                onClick={() => setPromptMode('timeline')}>Shots</button>
            </div>
          </div>
          {promptMode === 'timeline' ? (
            <PromptTimeline value={scene.prompt} seconds={clipSecs} fps={24}
              disabled={busy} onChange={(p) => set('prompt', p)} />
          ) : (
            <textarea rows={5} value={scene.prompt} disabled={busy}
              placeholder={isH3 ? 'e.g. slow push-in; she looks up from the plate, smiles at camera and nods…' : 'slow dolly-in, mist drifting between the mountains, cinematic…'}
              title={'Separate shots with | — each directs a slice of the clip.\n[2s] fixes a shot length, * marks a global anchor.'}
              onChange={(e) => set('prompt', e.target.value)} />
          )}

          {promptMode === 'text' && (
            <MotionPicker prompt={scene.prompt || ''} busy={busy} onChange={(p) => set('prompt', p)} />
          )}

          {isH3 ? (
            <>
              <label>Dialogue (optional, one line)
                <input value={scene.dialogue || ''} disabled={busy} placeholder='e.g. "Thank you, Narukami-kun."'
                  title="Spoken line — H3 lip-syncs it and voices it. Leave empty for a music-video clip."
                  onChange={(e) => set('dialogue', e.target.value)} />
              </label>
              <label>Soundscape (diegetic audio)
                <input value={scene.soundscape || ''} disabled={busy} placeholder="quiet restaurant ambience, utensils on the plate…"
                  onChange={(e) => set('soundscape', e.target.value)} />
              </label>
              <label>Music (non-diegetic)
                <input value={scene.music ?? 'No music.'} disabled={busy}
                  title='Keep "No music." for music-video clips — the real track is laid over the final cut.'
                  onChange={(e) => set('music', e.target.value)} />
              </label>
              <H3CoachPreview prompt={scene.prompt} soundscape={scene.soundscape} music={scene.music} seconds={(scene.frames || 124) / 24} hasImage={!!asset} lockStill={scene.lockStill !== false} />
              <div className="grid2">
                <label>Clip length
                  <select value={scene.frames || 124} disabled={busy} onChange={(e) => set('frames', +e.target.value)}>
                    {durations.map((d) => <option key={d.frames} value={d.frames}>{d.label} · {d.frames} f</option>)}
                  </select>
                  <span className="param-hint">H3's 17k+5 frame grid at 24 fps. Longer than the max spills out of VRAM on this GPU.</span>
                </label>
                <label>Quality
                  <select value={scene.preset || 'fast'} disabled={busy} onChange={(e) => set('preset', e.target.value)}>
                    <option value="fast">Fast — 4-step turbo</option>
                    <option value="quality">Quality — 8-step</option>
                  </select>
                  <span className="param-hint">Fast ≈ 2–3 min warm. Quality is ~2× slower with a cleaner audio floor.</span>
                </label>
                <label>Resolution
                  <select value={scene.megapixels ?? 0.4} disabled={busy} onChange={(e) => set('megapixels', +e.target.value)}>
                    {RESOLUTIONS.map((r) => <option key={r.mp} value={r.mp}>{r.label}</option>)}
                  </select>
                  <span className="param-hint">Canvas follows the still's aspect. Pixels move compute time, not VRAM.</span>
                </label>
                <label>Seed (−1 = rnd)
                  <input type="number" value={scene.seed ?? -1} disabled={busy} onChange={(e) => set('seed', +e.target.value)} />
                  <span className="param-hint">Gritty audio? Re-roll the seed.</span>
                </label>
              </div>
              <label className="checkbox-label">
                <input type="checkbox" checked={scene.lockStill !== false} disabled={busy}
                  onChange={(e) => set('lockStill', e.target.checked)} />
                Lock character &amp; set to the still (prepends the "use the provided image as the exact starting frame" instruction)
              </label>
              <button className="linkish" onClick={() => setAdvanced((a) => !a)}>{advanced ? '▾' : '▸'} Advanced</button>
              {advanced && (
                <div className="grid2">
                  <label>Video sigma shift
                    <input type="number" step={0.5} min={1} max={40} value={scene.shiftVideo ?? 12} disabled={busy}
                      onChange={(e) => set('shiftVideo', +e.target.value)} />
                    <span className="param-hint">12 = model default. Lower for tighter, less drifty motion.</span>
                  </label>
                  <label>Audio sigma shift
                    <input type="number" step={0.5} min={1} max={20} value={scene.shiftAudio ?? 3} disabled={busy}
                      onChange={(e) => set('shiftAudio', +e.target.value)} />
                  </label>
                  <label>Sampler
                    <select value={scene.sampler || ''} disabled={busy} onChange={(e) => set('sampler', e.target.value)}>
                      <option value="">auto (euler fast / res_multistep quality)</option>
                      <option value="euler">euler</option>
                      <option value="res_multistep">res_multistep</option>
                      <option value="dpmpp_2m">dpmpp_2m</option>
                    </select>
                  </label>
                  <label>Steps (Quality preset)
                    <input type="number" min={2} max={30} value={scene.steps ?? 8} disabled={busy}
                      onChange={(e) => set('steps', +e.target.value)} />
                  </label>
                </div>
              )}
              {advanced && (
                <div>
                  <LoraRows
                    label="MiniMax H3 LoRAs"
                    hint="Model-only LoRAs chained onto H3 before sampling. Must be trained for MiniMax H3 (LTX / Wan / Flux LoRAs will not load)."
                    loras={loadH3Loras(scene)}
                    setLoras={(fn) => set('h3Loras', fn(loadH3Loras(scene)))}
                    loraOptions={loraOptions} busy={busy} />
                  <button disabled={busy} onClick={() => saveH3LoraDefault(loadH3Loras(scene))}
                    title="New clips in any shot start with these LoRAs">Use these on every clip</button>
                </div>
              )}
            </>
          ) : isWan ? (
            <WanOptions scene={scene} set={set} busy={busy} stillPrompt={scene.stillPrompt} onLongShot={onLongShot} hasStill={!!asset} />
          ) : (
            <>
              <div className="grid2">
                <label>Duration (s)
                  <input type="number" min={0.5} max={8} step={0.5} value={scene.seconds} disabled={busy}
                    onChange={(e) => set('seconds', +e.target.value)} />
                </label>
                <label>FPS
                  <input type="number" min={8} max={30} value={scene.fps ?? 24} disabled={busy}
                    onChange={(e) => set('fps', +e.target.value)} />
                </label>
                <label>Steps
                  <input type="number" min={1} max={50} value={scene.steps} disabled={busy}
                    onChange={(e) => set('steps', +e.target.value)} />
                </label>
                <label>Seed (−1 = rnd)
                  <input type="number" value={scene.seed ?? -1} disabled={busy}
                    onChange={(e) => set('seed', +e.target.value)} />
                </label>
              </div>
              <label>Video model (GGUF)
                <select value={scene.ggufModel || ''} disabled={busy}
                  onChange={(e) => set('ggufModel', e.target.value)}>
                  <option value="">— workflow default (LTX 2.3 distilled Q3_K_M) —</option>
                  {ggufOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <LoraRows
                label="Video LoRAs"
                hint="Model-only LoRAs chained before sampling. No rows = the workflow's built-in motion LoRA."
                loras={scene.loras || []}
                setLoras={(fn) => set('loras', fn(scene.loras || []))}
                loraOptions={loraOptions} busy={busy} />
            </>
          )}

          <button className="primary" disabled={busy || !asset || !scene.prompt.trim()}
            title={!asset ? 'Generate a still first — the video starts from it' : ''}
            onClick={() => onGenerate(scene.id)}>
            {busy ? 'Working…' : videoAsset ? '↻ Regenerate video' : '▶ Generate video'}
          </button>

          {busy && (
            <>
              <GenProgress progress={(scene.gen.progress || 0)} status={scene.gen.status} onCancel={() => onCancel(scene)} cancelDisabled={!scene.gen.jobId} />
            </>
          )}
          {scene.gen?.phase === 'error' && <div className="error">{scene.gen.error}</div>}

          {videoAsset?.meta?.draft && !busy && (
            <div className="draft-card">
              {scene.engine === 'wan' ? (
                <>
                  <b>⚡ Motion preview.</b> The look is intentionally rough — judge the <i>movement and framing</i>. Like it? Render the real thing with the same seed.
                  <div className="row">
                    <button className="primary-lite" onClick={() => onRerenderFull(scene.id)}
                      title="Both Wan experts, same seed: the motion you approved at full quality (~6 min).">▶ Render full quality · same seed</button>
                  </div>
                </>
              ) : (
                <>
                  <b>⚡ This is a draft.</b> Happy with the motion? Finalize it, or re-render at full quality with the same seed.
                  <div className="row">
                    <button className="primary-lite" onClick={() => onFinalize(scene.id)}
                      title="Real-ESRGAN 2× upscale. ~1.4 s per frame; no re-generation, the motion you approved is kept.">⬆ Finalize · upscale 2×</button>
                    <button onClick={() => onRerenderFull(scene.id)} title="Same seed, draft mode off: a fresh full-quality render.">↻ Re-render full quality</button>
                  </div>
                </>
              )}
            </div>
          )}

          {videoAsset && !busy && (
            <div className={`qa-card ${qa.res?.verdict || ''}`}>
              <div className="row">
                <button disabled={qa.busy} onClick={() => runQa(false)} title="Instant checks: black, frozen, blurry, flicker, jump cuts.">🔍 Check quality</button>
                <button disabled={qa.busy} onClick={() => runQa(true)} title="Also asks the local vision model to look for anatomy / identity / warping problems (slow while ComfyUI holds the GPU).">🔍 + AI review</button>
                {qa.busy && <span className="hint">checking…</span>}
              </div>
              {qa.error && <div className="error">{qa.error}</div>}
              {qa.res && (
                <div className="qa-res">
                  <b>{qa.res.verdict === 'good' ? '✅' : qa.res.verdict === 'usable' ? '⚠️' : '❌'} {qa.res.score}/100 · {qa.res.verdict}</b>
                  {qa.res.issues.length === 0 && <span className="hint"> no problems found</span>}
                  <ul>{qa.res.issues.map((i, k) => <li key={k} className={i.severity}>{i.message}</li>)}</ul>
                  {qa.res.vlm?.score != null && <div className="hint">AI review: {qa.res.vlm.score}/10 ({qa.res.vlm.model})</div>}
                  {qa.res.vlm?.error && <div className="hint">AI review unavailable: {qa.res.vlm.error}</div>}
                </div>
              )}
            </div>
          )}

          <div className="sd-actions">
            {asset && (
              <button onClick={() => onRemix(asset)}
                title="Generate a new image from this one — opens it in the sketch pad as an img2img base.">
                🎨 New image from this image
              </button>
            )}
            {asset && onEditStudio && (
              <button onClick={() => onEditStudio(asset)} title="Inpaint, relight, try-on, restyle, change angle…">🪄 Edit image</button>
            )}
            {videoAsset && onVideoLab && (
              <button onClick={() => onVideoLab(videoAsset)} title="Upscale, slow-motion, cutout, reframe, reverse…">🧰 Video Lab</button>
            )}
            {videoAsset && onGenjutsu && (
              <button onClick={() => onGenjutsu(videoAsset)} title="Swap the cast/an object or restyle this clip, keeping its motion">🌀 Genjutsu</button>
            )}
            {videoAsset && onExtend && (
              <button onClick={() => onExtend(scene.id)} title="Take this clip's last frame as the first frame of a new scene — continue the shot">⏭ Extend clip</button>
            )}
            {sketchSource && (
              <button onClick={() => onEditSketch(sketchSource)} title="Reopen the source drawing in the sketch pad">✏️ Edit source sketch</button>
            )}
            {kreaSource && (
              <button onClick={() => onEditKrea(kreaSource)} title="Reopen in the Krea 2 panel">🖼️ Edit in Krea 2</button>
            )}
            {asset && <a className="dl" href={asset.url} download={`scene-${idx + 1}-still.png`}>Download still</a>}
            {videoAsset && <a className="dl" href={videoAsset.url} download={`scene-${idx + 1}-video.mp4`}>Download video</a>}
            <button className="danger" onClick={() => { onDelete(scene.id); onClose(); }}>Delete scene</button>
          </div>
        </div>
      </div>
    </div>
  );
}
