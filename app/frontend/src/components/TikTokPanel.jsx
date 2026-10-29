import React, { useEffect, useRef, useState } from 'react';
import { durationOptions, H3_GRID_FALLBACK, ASPECTS } from '../h3.js';
import { SEG_COLORS } from './PromptTimeline.jsx';

const STEP_HELP = [
  'Step 1 of 5 · Your story. Chat with the producer in the Story Room to shape it, then press “Write the shot list”. Or just type the idea below and skip ahead. A reference video is optional.',
  "Step 2 of 5 · Cast. Who's in it? Add a character with a reference photo so their face stays the same in every shot. You can skip this if the video has no recognisable faces.",
  'Step 3 of 5 · Script. The AI director turns your idea into a list of shots. Read it, change anything you like, then add the scenes to the board.',
  'Step 4 of 5 · Produce. This makes a picture for every shot, then animates each one into a clip. It takes a while, so you can leave it running.',
  'Step 5 of 5 · Cut & render. Joins the clips into your finished video. Add music if you want, then render.',
];
const STEPS = ['1 · Story', '2 · Cast', '3 · Script', '4 · Produce', '5 · Cut & Render'];
const LENGTH_PRESETS = [
  { id: '15s', label: '~15s (TikTok short)', seconds: 15 },
  { id: '30s', label: '~30s', seconds: 30 },
  { id: '60s', label: '~60s', seconds: 60 },
  { id: '3min', label: '~3 min', seconds: 180 },
];
const BEAT_LABEL = { hook: 'HOOK', build: 'build', payoff: 'PAYOFF', cta: 'CTA' };

import { useGenre } from '../genreStore.js';
import { storyIdeas, listScripts, getScript } from '../api.js';
import StoryRoom from './StoryRoom.jsx';
import ChaosCutPanel from './ChaosCutPanel.jsx';

export default function TikTokPanel({
  tk, setTk, assets, scenes, health, h3Catalog, looks, batch, scriptBusy, renderState,
  onAddSource, onRemoveSource, onTranscribe, onDescribeSource, transcribeBusy, describeBusy,
  onAddCharacters, onUpdateCharacter, onReplaceCharacterPhoto, onRemoveCharacter, onDescribeCharacter,
  onWriteScript, onParseScript, onDuplicateScene, onRemoveScene,
  onScarify, onMakeScore, onFinalSound, onGenerateCharacter, onApplyCast,
  onScenesToBoard, onRunBatch, onStopBatch, onRenderFinal, onOpenDetail, onFocusScenes, onUpdateScene, onAddAsset, onSetFinal, onRerollLine, sceneLine, onRedoStill,
}) {
  const { genre } = useGenre();
  const [ideas, setIdeas] = useState([]);
  const [ideasBusy, setIdeasBusy] = useState(false);
  const getIdeas = async () => { setIdeasBusy(true); const r = await storyIdeas(genre.id, tk.concept || '', 6); setIdeas(r.ideas || []); setIdeasBusy(false); };
  const step = tk.step || 0;
  const setStep = (s) => setTk((m) => ({ ...m, step: s }));
  const patch = (p) => setTk((m) => ({ ...m, ...p }));
  const videoRef = useRef(null);
  const imagesRef = useRef(null);
  const castRef = useRef(null);
  const replacePhotoRef = useRef(null);
  const musicRef = useRef(null);
  const [replaceTargetId, setReplaceTargetId] = useState(null);
  const [musicFile, setMusicFile] = useState(null);
  const [pasteText, setPasteText] = useState('');
  const [inbox, setInbox] = useState([]);
  useEffect(() => { if (step === 2) listScripts().then(setInbox); }, [step]);
  const [busyFx, setBusyFx] = useState({});
  const [mk, setMk] = useState({ name: '', description: '', busy: false, error: '' });
  const [scorePrompt, setScorePrompt] = useState('');
  const [scoreBusy, setScoreBusy] = useState(false);
  const [fx, setFx] = useState({ ambience: 'wind', unease: 'medium', scare: -1, flaws: 'off' });
  const [fxBusy, setFxBusy] = useState(false);
  const [fxMsg, setFxMsg] = useState('');

  const sources = tk.sourceAssetIds.map((id) => assets.find((a) => a.id === id)).filter(Boolean);
  const sourceVideo = sources.find((a) => a.mime?.startsWith('video'));
  const sourceImages = sources.filter((a) => a.mime?.startsWith('image'));
  const cast = tk.castIds.map((id) => assets.find((a) => a.id === id)).filter(Boolean);
  const durations = durationOptions(h3Catalog?.frame_grid || H3_GRID_FALLBACK);
  const llmOk = !!health?.ollama;

  const order = [...scenes.filter((s) => s.tk)].sort((a, b) => (a.ttIndex ?? 0) - (b.ttIndex ?? 0));
  const withVideo = order.filter((s) => s.videoAssetId && assets.find((a) => a.id === s.videoAssetId));
  const stillsMissing = order.filter((s) => !s.assetId).length;
  const clipsMissing = order.filter((s) => !s.videoAssetId).length;
  const finalAsset = assets.find((a) => a.id === tk.finalAssetId);

  const applyLengthPreset = (id) => {
    const preset = LENGTH_PRESETS.find((p) => p.id === id) || LENGTH_PRESETS[1];
    const clipSeconds = (tk.frames || 124) / 24;
    const n = Math.max(3, Math.min(40, Math.round(preset.seconds / clipSeconds)));
    patch({ lengthPreset: id, nScenes: n });
  };

  return (
    <section className="mv-panel">
      <header className="mv-head">
        <h2>📱 TikTok Video</h2>
        <div className="mv-steps">
          {STEPS.map((s, i) => (
            <button key={s} className={`mv-step ${step === i ? 'active' : ''} ${i < step ? 'done' : ''}`} onClick={() => setStep(i)}>{s}</button>
          ))}
        </div>
      </header>

      {/* ------------------------------------------------------------ 1 STORY */}
      <div className="tk-guide">{STEP_HELP[step]}{step === 0 && genre.id !== 'cinematic' ? ` Genre: ${genre.icon} ${genre.label} (change it in the top bar).` : ''}</div>

      {step === 0 && (
        <div className="mv-body">
          <StoryRoom tk={tk} setTk={setTk} onScript={onParseScript} goScript={() => setStep(2)} />
          <label><b>What's the video about?</b>
            <textarea rows={4} value={tk.concept} placeholder={'e.g. "Mia films a camping trip at a lake. At night something knocks on the inside of her tent."'}
              onChange={(e) => patch({ concept: e.target.value })} />
          </label>
          <div className="row">
            <button disabled={ideasBusy} onClick={getIdeas}>{ideasBusy ? '⏳ Thinking…' : '💡 Give me ideas'}</button>
          </div>
          {ideas.length > 0 && (
            <div className="tk-ideas">
              {ideas.map((i, n) => <button key={n} onClick={() => patch({ concept: i.title ? `${i.title}: ${i.concept}` : i.concept })}>{i.title ? <b>{i.title}: </b> : null}{i.concept}</button>)}
            </div>
          )}
          <details className="tk-ref">
            <summary>I already have a video or photos to retell (optional)</summary>
          <div className="hint">
            Feed it an existing video and/or photos that carry the story you want retold. The narration
            gets transcribed (local speech-to-text) and the frames/photos get described (local vision
            model) so the director has real material to work from — or skip this and just type a concept.
          </div>
          <div className="row">
            <button onClick={() => videoRef.current?.click()}>🎬 {sourceVideo ? 'Replace' : 'Add'} reference video</button>
            <input ref={videoRef} type="file" accept="video/*" hidden
              onChange={(e) => { if (e.target.files?.[0]) onAddSource([e.target.files[0]]); e.target.value = ''; }} />
            <button onClick={() => imagesRef.current?.click()}>🖼️ Add reference photo(s)</button>
            <input ref={imagesRef} type="file" accept="image/*" multiple hidden
              onChange={(e) => { if (e.target.files?.length) onAddSource([...e.target.files]); e.target.value = ''; }} />
          </div>
          {sourceVideo && (
            <div className="mv-track-meta">
              <video src={sourceVideo.url} controls className="mv-audio" style={{ maxHeight: 200 }} />
              <div className="row">
                <button className="xbtn" onClick={() => onRemoveSource(sourceVideo.id)}>✕ Remove video</button>
              </div>
            </div>
          )}
          {sourceImages.length > 0 && (
            <div className="styleref-grid">
              {sourceImages.map((s) => (
                <div key={s.id} className="styleref-card">
                  <img src={s.url} alt="" />
                  <button className="xbtn thumb-x" onClick={() => onRemoveSource(s.id)}>✕</button>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <button disabled={!sourceVideo || transcribeBusy} title={sourceVideo ? 'Transcribe the video\'s narration locally (faster-whisper)' : 'Add a reference video first'}
              onClick={onTranscribe}>{transcribeBusy ? '⏳ Transcribing…' : '🎙️ Transcribe narration'}</button>
            <button disabled={(!sourceVideo && !sourceImages.length) || !llmOk || describeBusy}
              title={llmOk ? 'Describe the content (subjects/actions/setting) with the local vision model' : 'Start Ollama (with a qwen-vl model) to auto-describe'}
              onClick={onDescribeSource}>{describeBusy ? '⏳ Describing…' : '👁 Describe content'}</button>
          </div>
          <label>Transcript (editable)
            <textarea rows={3} value={tk.transcript} placeholder="Transcribed narration appears here — edit freely"
              onChange={(e) => patch({ transcript: e.target.value })} />
          </label>
          <label>Visual content notes (editable)
            <textarea rows={3} value={tk.visualNotes} placeholder="What's shown in the video/photos — subjects, actions, setting"
              onChange={(e) => patch({ visualNotes: e.target.value })} />
          </label>
          </details>
          <label>Visual style
            <textarea rows={2} value={tk.style} placeholder="e.g. bright natural light, handheld, warm color grade"
              onChange={(e) => patch({ style: e.target.value })} />
          </label>
          <div className="grid2">
            <label>Aspect
              <select value={tk.aspect} onChange={(e) => patch({ aspect: e.target.value })}>
                {ASPECTS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </label>
            <label>Target length
              <select value={tk.lengthPreset} onChange={(e) => applyLengthPreset(e.target.value)}>
                {LENGTH_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label>Scenes
              <input type="number" min={1} max={40} value={tk.nScenes} onChange={(e) => patch({ nScenes: Math.max(1, +e.target.value) })} />
            </label>
            <label>Clip length
              <select value={tk.frames} onChange={(e) => patch({ frames: +e.target.value })}>
                {durations.map((d) => <option key={d.frames} value={d.frames}>{d.label}</option>)}
              </select>
            </label>
          </div>
          <label className="checkbox-label">
            <input type="checkbox" checked={tk.realistic} onChange={(e) => patch({ realistic: e.target.checked })} />
            Realistic look (avoid AI/cartoon aesthetic)
            <span className="param-hint">Forces photoreal, real-camera language and forbids caption-overlay/emoji text in every generated shot — on regardless of what the concept says, unless you uncheck it.</span>
          </label>
          <button className="primary" onClick={() => setStep(1)}>Next: Cast →</button>
        </div>
      )}

      {/* ------------------------------------------------------------ 2 CAST */}
      {step === 1 && (
        <div className="mv-body">
          <div className="hint">Optional character photos. Each becomes a face reference pinned onto the stills (ReActor), and a description the director writes for.</div>
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
          <div className="tk-fx">
            <h4 className="sd-h">🧑 Create a character from a description</h4>
            <div className="hint">No photo? Describe them once. The studio makes their face and pins the same face onto every shot, so Mia is the same person throughout. The name must match the name in your script.</div>
            {(tk.script?.scenes || []).flatMap((s) => s.characters || []).filter((n, i, a) => a.indexOf(n) === i && !cast.some((c) => (c.meta?.name || '').toLowerCase() === String(n).toLowerCase())).length > 0 && (
              <div className="tk-ideas">
                {(tk.script?.scenes || []).flatMap((s) => s.characters || []).filter((n, i, a) => a.indexOf(n) === i && !cast.some((c) => (c.meta?.name || '').toLowerCase() === String(n).toLowerCase())).map((n) => (
                  <button key={n} onClick={() => setMk((m) => ({ ...m, name: n }))}>＋ {n} (from your script)</button>
                ))}
              </div>
            )}
            <input value={mk.name} placeholder="Name, exactly as in the script (e.g. Mia)" onChange={(e) => setMk({ ...mk, name: e.target.value })} />
            <textarea rows={2} value={mk.description} placeholder="Look: age, build, hair, wardrobe (e.g. a nervous woman in her twenties with messy brown hair in a green hoodie)" onChange={(e) => setMk({ ...mk, description: e.target.value })} />
            <button disabled={mk.busy || !mk.name.trim() || !mk.description.trim()} onClick={async () => {
              setMk((m) => ({ ...m, busy: true, error: '' }));
              try { await onGenerateCharacter(mk.name, mk.description); setMk({ name: '', description: '', busy: false, error: '' }); }
              catch (e) { setMk((m) => ({ ...m, busy: false, error: e.message })); }
            }}>{mk.busy ? '⏳ Making the face…' : '🎨 Make this character'}</button>
            {mk.error && <div className="error">{mk.error}</div>}
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
                  <div className="row">
                    <label className="btn-like" title="A clean 8-15 s recording of her voice. It is saved to the voice library as this character's voice.">
                      🎤 {c.meta?.voiceId ? 'Replace voice sample' : 'Add voice sample'}
                      <input type="file" accept="audio/*,video/*" hidden onChange={async (e) => {
                        const f = e.target.files?.[0]; e.target.value = '';
                        if (!f) return;
                        try {
                          const fd = new FormData(); fd.append('name', c.meta?.name || 'character'); fd.append('file', f);
                          const r = await fetch('/api/tts/voices', { method: 'POST', body: fd });
                          if (!r.ok) throw new Error((await r.text()).slice(0, 160));
                          const d = await r.json();
                          onUpdateCharacter(c.id, { voiceId: d.id, voiceSeconds: d.seconds });
                        } catch (err) { setFxMsg(`Voice sample failed: ${err.message}`); }
                      }} />
                    </label>
                    {c.meta?.voiceId && <span className="hint">🎤 voice saved ({c.meta.voiceSeconds}s) as {c.meta.voiceId}</span>}
                  </div>
                  <input value={c.meta?.outfit || ''} placeholder="Outfit, worn in EVERY shot (e.g. grey puffer parka, black sweater, jeans)" title="Locked into every picture so her clothes never change between shots"
                    onChange={(e) => onUpdateCharacter(c.id, { outfit: e.target.value })} />
                  <textarea rows={3} value={c.meta?.description || ''} placeholder="Look, wardrobe, vibe… (or describe with the vision model)"
                    onChange={(e) => onUpdateCharacter(c.id, { description: e.target.value })} />
                  <div className="row">
                    <button title="Swap this photo for a different one"
                      onClick={() => { setReplaceTargetId(c.id); replacePhotoRef.current?.click(); }}>🔄 Replace photo</button>
                    <button disabled={!llmOk || c.meta?.describing} title={llmOk ? 'Describe with the local Ollama vision model' : 'Start Ollama (with a qwen-vl model) to auto-describe'}
                      onClick={() => onDescribeCharacter(c.id)}>{c.meta?.describing ? '⏳' : '👁 Describe'}</button>
                    <button className="danger" onClick={() => onRemoveCharacter(c.id)}>Remove</button>
                  </div>
                </div>
              );
            })}
            {!cast.length && <div className="hint">No characters yet — optional, the director can invent a subject.</div>}
          </div>
          <button className="primary" onClick={() => setStep(2)}>Next: Script →</button>
        </div>
      )}

      {/* ------------------------------------------------------------ 3 SCRIPT */}
      {step === 2 && (
        <div className="mv-body">
          <div className="hint">The director (local Ollama model) writes a hook-first scene list from the story material above. Edit anything before adding scenes to the board.</div>
          <label className="checkbox-label">
            <input type="checkbox" checked={tk.useLlm && llmOk} disabled={!llmOk} onChange={(e) => patch({ useLlm: e.target.checked })} />
            Use the LLM director {llmOk ? `(${health.ollama_text_model || 'Ollama'})` : '— Ollama not running; the template writer will be used'}
          </label>
          {llmOk && (health.ollama_models || []).length > 1 && (
            <label>Director model
              <select value={tk.llmModel || ''} onChange={(e) => patch({ llmModel: e.target.value })}>
                <option value="">auto ({health.ollama_text_model})</option>
                {health.ollama_models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          )}
          {inbox.length > 0 && (
            <div className="tk-fx">
              <h4 className="sd-h">📥 Scripts waiting in your inbox</h4>
              <div className="hint">Scripts written for you outside the app (for example written in another tool) show up here. Click one to load it as your script.</div>
              {inbox.map((sc) => (
                <button key={sc.name} disabled={scriptBusy} onClick={async () => { const d = await getScript(sc.name); setPasteText(d.text); onParseScript(d.text); }}>
                  📄 {sc.title} <small>· {sc.shots} shots</small>
                </button>
              ))}
            </div>
          )}
          <label>How scary?
            <select value={tk.scare || 'creepy'} onChange={(e) => patch({ scare: e.target.value })}>
              <option value="subtle">Subtle: uneasy, deniable, nothing confirmed</option>
              <option value="creepy">Creepy: steady escalation, a figure glimpsed late</option>
              <option value="terrifying">Terrifying: escalating threat, a real jump-scare moment</option>
              <option value="off">Don't add scare rules</option>
            </select>
            <span className="param-hint">Makes the writer put something specific and unsettling in the picture of every shot after the first (a figure in the background, a face in the window, an open door), closer each time.</span>
          </label>
          <button className="primary" disabled={scriptBusy} onClick={onWriteScript}>
            {scriptBusy ? '⏳ Writing…' : tk.script ? '✍️ Rewrite script' : '✍️ Write script'}
          </button>

          <h4 className="sd-h" style={{ marginTop: 18 }}>— or paste a script you already wrote —</h4>
          <div className="hint">
            Format: <code>## SHOT N — Title (mm:ss–mm:ss)</code> headings, each with{' '}
            <code>**[VISUAL]**</code>/<code>**[VOICEOVER]**</code>/<code>**[SFX]**</code> blocks, or the richer <code>**[STILL]**</code>/<code>**[MOTION]**</code>/<code>**[DIALOGUE]**</code>/<code>**[CHARACTERS]**</code>/<code>**[BEAT]**</code> (a{' '}
            <code>**[COLOR GRADE]**</code> blockquote before shot 1 is picked up as the shared style). No
            LLM call — parsed exactly as written. <code>[TEXT ON SCREEN]</code> lines are dropped; the
            realism/no-overlay rules above are still applied to every shot. Still and motion prompts both
            start from the same <code>[VISUAL]</code> text — trim the still prompt down to one frozen
            moment for the best key frame.
          </div>
          <textarea rows={6} value={pasteText} placeholder="Paste your full script here…"
            onChange={(e) => setPasteText(e.target.value)} />
          <button disabled={scriptBusy || !pasteText.trim()} onClick={() => onParseScript(pasteText)}>
            {scriptBusy ? '⏳ Parsing…' : '📋 Parse pasted script'}
          </button>
          {tk.scriptError && <div className="error">{tk.scriptError}</div>}
          {tk.script && (
            <>
              <div className="mv-script-head">
                <b>{tk.script.title}</b>
                <span className="hint">{tk.script.scenes.length} scenes · written by {tk.script.source === 'ollama' ? tk.script.model : 'template'}</span>
              </div>
              {tk.script.warning && <div className="hint pt-warn">{tk.script.warning}</div>}
              {tk.script.style && <div className="hint">Style: {tk.script.style}</div>}
              {tk.script.scenes.map((sc, i) => (
                <div key={sc.id} className="shot-card" style={{ borderLeftColor: SEG_COLORS[i % SEG_COLORS.length] }}>
                  <div className="row">
                    <span className="chip on">{BEAT_LABEL[sc.beat] || sc.beat}</span>
                    <input className="ss-title" value={sc.title} onChange={(e) => patchScene(sc.id, { title: e.target.value })} />
                    <select value={sc.frames} onChange={(e) => patchScene(sc.id, { frames: +e.target.value, seconds: +e.target.value / 24 })}>
                      {durations.map((d) => <option key={d.frames} value={d.frames}>{d.label}</option>)}
                    </select>
                    <span className="hint">{sc.sceneId ? '· on board' : ''}</span>
                    <button className="xbtn" title="Split this shot in two — duplicates it so you can trim each half separately (e.g. a shot describing more than one moment/cut)"
                      onClick={() => onDuplicateScene(sc.id)}>⧉</button>
                    <button className="xbtn" title="Remove this shot" onClick={() => onRemoveScene(sc.id)}>✕</button>
                  </div>
                  <label>Still prompt
                    <textarea rows={3} value={sc.stillPrompt} onChange={(e) => patchScene(sc.id, { stillPrompt: e.target.value })} />
                  </label>
                  <label>Motion prompt
                    <textarea rows={2} value={sc.motionPrompt} onChange={(e) => patchScene(sc.id, { motionPrompt: e.target.value })} />
                  </label>
                  <div className="grid2">
                    <label>Dialogue
                      <input value={sc.dialogue || ''} onChange={(e) => patchScene(sc.id, { dialogue: e.target.value })} />
                    </label>
                    <label>Soundscape
                      <input value={sc.soundscape || ''} onChange={(e) => patchScene(sc.id, { soundscape: e.target.value })} />
                    </label>
                  </div>
                  {sc.narration && (
                    <label>Narration / voiceover <span className="param-hint">(reference only — not sent to generation; no TTS in this app)</span>
                      <textarea rows={2} value={sc.narration} onChange={(e) => patchScene(sc.id, { narration: e.target.value })} />
                    </label>
                  )}
                </div>
              ))}
              <button className="primary" disabled={!tk.script.scenes.length} onClick={() => { onScenesToBoard(); setStep(3); }}>
                ＋ Add {tk.script.scenes.filter((s) => !s.sceneId).length || tk.script.scenes.length} scene{tk.script.scenes.length > 1 ? 's' : ''} to the board →
              </button>
            </>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------ 4 PRODUCE */}
      {step === 3 && (
        <div className="mv-body">
          <div className="hint">Stills first (Krea 2, faces pinned), then clips (MiniMax H3, starting from each still). Runs one job at a time; you can keep editing cards on the board meanwhile.</div>
          {!order.length && <div className="hint">No TikTok scenes on the board yet — write a script (step 3) and add it.</div>}
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
          {onUpdateScene && order.length > 1 && (
            <div className="row">
              <button title="Ramp the camera chaos from calm in the first shot to frantic in the last, so the video builds like a real emergency"
                onClick={() => order.forEach((s, i) => onUpdateScene(s.id, { chaos: Math.round(15 + 85 * (i / (order.length - 1)) ** 1.3) }))}>📈 Escalate chaos (calm → frantic)</button>
              <button title="Reset every shot to a medium amount of camera movement" onClick={() => order.forEach((s) => onUpdateScene(s.id, { chaos: 40 }))}>Reset chaos</button>
            </div>
          )}
          {batch.phase === 'run' && <div className="hint">{batch.kind} {batch.done + 1}/{batch.total} — {batch.current}</div>}
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
                    <div className="hint">{BEAT_LABEL[s.beat] || ''} · {((s.frames || 124) / 24).toFixed(1)} s · {s.preset || 'fast'}</div>
                    {s.narration && <div className="hint">🎙️ {s.narration}</div>}
                    {onUpdateScene && order.length > 1 && (
                      <label className="chaos-row" title="Make this shot's picture from another shot's picture, so the same room, lamp and props appear again. If that shot has no picture yet it is made first.">
                        <span>Same room as</span>
                        <select value={s.refSceneId || ''} onChange={(e) => onUpdateScene(s.id, { refSceneId: e.target.value || null })}>
                          <option value="">— none —</option>
                          {order.filter((o) => o.id !== s.id).map((o) => <option key={o.id} value={o.id}>{order.indexOf(o) + 1}. {o.title || 'shot'}</option>)}
                        </select>
                      </label>
                    )}
                    {onUpdateScene && (
                      <label className="chaos-row" title="How frantic the camera is in this shot: low = calm and steady, high = panicked, whipping around. It changes the next clip you generate and the shake in the final cut.">
                        <span>Chaos</span>
                        <input type="range" min={0} max={100} step={5} value={s.chaos ?? 40} onChange={(e) => onUpdateScene(s.id, { chaos: +e.target.value })} />
                        <b>{s.chaos ?? 40}</b>
                      </label>
                    )}
                    <div className="produce-status">
                      <span className={still ? 'ok' : ''}>{still ? '✓ still' : '○ still'}</span>
                      <span className={vid ? 'ok' : ''}>{vid ? '✓ clip' : '○ clip'}</span>
                      {s.gen?.phase === 'run' && <span className="run">⏳ {s.gen.status}</span>}
                      {s.gen?.phase === 'error' && <span className="err" title={s.gen.error}>✕ {s.gen.error?.slice(0, 60)}</span>}
                    </div>
                  </div>
                  <button onClick={() => onOpenDetail(s.id)}>Open</button>
                  {onRedoStill && still && (
                    <button disabled={!!busyFx[s.id] || s.gen?.phase === 'run'} title="Throw away this shot's picture and clip and make the picture again (use after changing 'Same room as')"
                      onClick={async () => { setBusyFx((b) => ({ ...b, [s.id]: true })); try { await onRedoStill(s.id); } finally { setBusyFx((b) => ({ ...b, [s.id]: false })); } }}>
                      {busyFx[s.id] ? '⏳' : '🎨 Redo picture'}
                    </button>
                  )}
                  {onRerollLine && vid && sceneLine?.(s) && (
                    <button disabled={!!busyFx[s.id] || s.gen?.phase === 'run'} title={`Regenerate this clip until speech recognition hears the line “${sceneLine(s)}” (up to 5 tries; every take stays in the gallery)`}
                      onClick={async () => { setBusyFx((b) => ({ ...b, [s.id]: true })); try { await onRerollLine(s.id, 5); } finally { setBusyFx((b) => ({ ...b, [s.id]: false })); } }}>
                      {busyFx[s.id] ? '⏳' : '🎲 Re-roll until the line is heard'}
                    </button>
                  )}
                  <button disabled={!!busyFx[s.id] || s.gen?.phase === 'run'} title="Rewrite this shot so it contains a visible, specific unsettling detail. Its picture and clip are cleared so you can regenerate them."
                    onClick={async () => { setBusyFx((b) => ({ ...b, [s.id]: true })); try { await onScarify(s.id); } finally { setBusyFx((b) => ({ ...b, [s.id]: false })); } }}>
                    {busyFx[s.id] ? '⏳' : '😱 Scarier'}
                  </button>
                </div>
              );
            })}
          </div>
          {(() => {
            const scriptNames = [...new Set((tk.script?.scenes || []).flatMap((x) => x.characters || []))];
            const have = cast.map((c) => (c.meta?.name || '').trim().toLowerCase());
            const dupes = have.filter((n, i) => n && have.indexOf(n) !== i);
            const stray = cast.filter((c) => !scriptNames.some((n) => String(n).toLowerCase() === (c.meta?.name || '').trim().toLowerCase())).map((c) => c.meta?.name || 'unnamed');
            if (!scriptNames.length || (!stray.length && !dupes.length)) return null;
            return <div className="hint pt-warn">⚠ Your script's character{scriptNames.length > 1 ? 's are' : ' is'} <b>{scriptNames.join(', ')}</b>. {stray.length ? `These cast cards match no one in it and will be ignored: ${stray.join(', ')}. Rename them in the Cast step to match.` : ''} {dupes.length ? 'Two cards share a name: remove the one you do not want.' : ''}</div>;
          })()}
          {order.length > 0 && cast.length > 0 && (
            <button title="Pins your cast's faces onto every shot and clears all pictures and clips so they regenerate with them. Your old images stay in the Gallery."
              disabled={batch.phase === 'run'} onClick={() => { if (window.confirm('Redo every picture and clip with your cast attached? The current ones stay in your Gallery.')) onApplyCast(); }}>
              👤 Apply my cast to every shot (redo pictures &amp; clips)
            </button>
          )}
          {order.length > 0 && <button onClick={onFocusScenes}>🗺 Show scenes on board</button>}
          <button className="primary" disabled={!withVideo.length} onClick={() => setStep(4)}>
            Next: Cut &amp; Render ({withVideo.length} clip{withVideo.length === 1 ? '' : 's'} ready) →
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------ 5 CUT */}
      {step === 4 && (
        <div className="mv-body">
          <div className="hint">A straight sequential cut, in script order — every finished clip, full length, no beat-cutting. Add optional background music, then render.</div>
          <div className="grid2">
            <label>Output size
              <select value={tk.cut.size} onChange={(e) => patch({ cut: { ...tk.cut, size: e.target.value } })}>
                <option value="native">Native clip size (sharpest)</option>
                <option value="1080">1080 class (upscaled)</option>
                <option value="720">720 class</option>
              </select>
            </label>
            <label>Color grade
              <select value={tk.cut.look || 'none'} onChange={(e) => patch({ cut: { ...tk.cut, look: e.target.value } })}>
                {looks.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <span className="param-hint">Applied once to the whole finished cut, so every scene shares one consistent look no matter how the individual generations drifted.</span>
            </label>
            <label>Clip audio (voices + sound design)
              <input type="number" step={0.05} min={0} max={2} value={tk.cut.clipGain ?? 1} onChange={(e) => patch({ cut: { ...tk.cut, clipGain: +e.target.value } })} />
              <span className="param-hint">1 = keep the sound from each clip. 0 mutes it (the video will have no voices).</span>
            </label>
            <label>Music gain
              <input type="number" step={0.05} min={0} max={2} value={tk.cut.musicGain} onChange={(e) => patch({ cut: { ...tk.cut, musicGain: +e.target.value } })} />
            </label>
          </div>
          <div className="row">
            <button onClick={() => musicRef.current?.click()}>🎵 {musicFile ? 'Replace' : 'Add'} background music (optional)</button>
            <input ref={musicRef} type="file" accept="audio/*" hidden
              onChange={(e) => { if (e.target.files?.[0]) setMusicFile(e.target.files[0]); e.target.value = ''; }} />
            {musicFile && <><span className="hint">{musicFile.name}</span><button className="xbtn" onClick={() => setMusicFile(null)}>✕</button></>}
          </div>
          <div className="tk-fx">
            <h4 className="sd-h">🎼 Soundtrack (optional)</h4>
            <div className="hint">Found footage often has no score, so keep it low and sparse. Generated locally (about a minute); it becomes the background music above.</div>
            <textarea rows={2} value={scorePrompt} placeholder="describe the sound, e.g. sparse low dread drone, distant detuned piano, slow heartbeat, no melody" onChange={(e) => setScorePrompt(e.target.value)} />
            <div className="row">
              <button disabled={scoreBusy} onClick={async () => {
                setScoreBusy(true);
                try {
                  const secs = Math.max(10, withVideo.reduce((a, s) => a + (assets.find((x) => x.id === s.videoAssetId)?.meta?.seconds || (s.frames || 124) / 24), 0));
                  const blob = await onMakeScore(scorePrompt || genre.score_prompt || 'sparse low dread drone, distant detuned piano notes, slow heartbeat pulse, unsettling, no melody', secs);
                  setMusicFile(new File([blob], 'generated-score.wav', { type: 'audio/wav' }));
                } catch (e) { setFxMsg(e.message); } finally { setScoreBusy(false); }
              }}>{scoreBusy ? '⏳ Generating…' : '🎼 Generate soundtrack'}</button>
              {musicFile && <span className="hint">Using: {musicFile.name}</span>}
            </div>
          </div>
          <div className="produce-list">
            {order.map((s, i) => {
              const vid = assets.find((a) => a.id === s.videoAssetId);
              return (
                <div key={s.id} className="edl-row" style={{ borderLeftColor: SEG_COLORS[i % SEG_COLORS.length] }}>
                  <span className="edl-t">{i + 1}.</span>
                  <span className="edl-n">{s.title || 'scene'}</span>
                  <span className="hint">{vid ? `${(vid.meta?.seconds || (s.frames || 124) / 24).toFixed(1)} s` : 'no clip yet'}</span>
                </div>
              );
            })}
          </div>
          <button className="primary" disabled={!withVideo.length || renderState.phase === 'run'}
            onClick={() => onRenderFinal(musicFile)}>
            {renderState.phase === 'run' ? '⏳ Rendering…' : '🎬 Render final video'}
          </button>
          {renderState.error && <div className="error">{renderState.error}</div>}
          {onAddAsset && <ChaosCutPanel order={order} assets={assets} onAddAsset={onAddAsset} onSetFinal={onSetFinal} />}
          {finalAsset && (
            <div className="tk-fx">
              <h4 className="sd-h">😱 Add scares and sound to the finished video</h4>
              <div className="hint">Adds ambience, a creeping drone, distant knocks, and (optionally) a jump scare to the final cut. It keeps the sound already in your clips. Run it again with different settings and you get a new version.</div>
              <div className="grid2">
                <label>Ambience
                  <select value={fx.ambience} onChange={(e) => setFx({ ...fx, ambience: e.target.value })}>
                    {['forest night (AI)', 'city night (AI)', 'lake night (AI)', 'basement (AI)', 'car interior', 'wind', 'room tone', 'house at night', 'hospital hum', 'none'].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </label>
                <label>Dread
                  <select value={fx.unease} onChange={(e) => setFx({ ...fx, unease: e.target.value })}>
                    {['low', 'medium', 'high', 'rising', 'none'].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </label>
                <label title="The human errors of someone filming: a hand covering the microphone (muffled), scrapes and brushes, wind buffeting it, loud sounds distorting. Real recordings are full of these.">Mic mishaps
                  <select value={fx.flaws} onChange={(e) => setFx({ ...fx, flaws: e.target.value })}>
                    {['off', 'some', 'a lot'].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </label>
                <label>Jump scare at (seconds, -1 = none)
                  <input type="number" min={-1} step={0.5} value={fx.scare} onChange={(e) => setFx({ ...fx, scare: +e.target.value })} />
                </label>
              </div>
              <button disabled={fxBusy} onClick={async () => {
                setFxBusy(true); setFxMsg('');
                try { await onFinalSound({ ...fx, bumps: 'on', breathing: 'scared', keep_original: 'on', cheap_mic: 'on', seed: Math.floor(Math.random() * 999) }); setFxMsg('Done. The video below now has the new sound.'); }
                catch (e) { setFxMsg(e.message); } finally { setFxBusy(false); }
              }}>{fxBusy ? '⏳ Designing the sound…' : '🎧 Add this sound to the final video'}</button>
              {fxMsg && <div className="hint">{fxMsg}</div>}
            </div>
          )}
          {finalAsset && (
            <div className="final-out">
              <video src={finalAsset.url} controls />
              <a className="dl" href={finalAsset.url} download={`${(tk.script?.title || 'tiktok-video').replace(/[^\w\- ]+/g, '')}.mp4`}>Download final video</a>
            </div>
          )}
        </div>
      )}
    </section>
  );

  function patchScene(id, p) {
    setTk((m) => ({ ...m, script: { ...m.script, scenes: m.script.scenes.map((s) => (s.id === id ? { ...s, ...p } : s)) } }));
  }
}
