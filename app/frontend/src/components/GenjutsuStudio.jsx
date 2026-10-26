import GenProgress from './GenProgress.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { runComfyTool, generateFlux3, generateQwen21, qwen21Models, listLoras, faceMatch, faceSwap, runGenjutsu, runMotionControl, motionControlStatus, runFfmpegTool, runFfmpegMux, runFfmpegJoin, cancelJob } from '../api.js';
import { STYLE_PRESETS } from '../editTools.js';
import DropZone from './DropZone.jsx';
import LoraRows from './LoraRows.jsx';
import { CompareIfSame } from './BeforeAfter.jsx';
import { useToolMemory } from '../toolMemory.js';
import { poseKept } from '../cameraMatch.js';

// Genjutsu — local video-to-video. Edit the first frame with Flux 3 (the
// identity anchor), then LTX 2.3 re-renders the whole clip from the encoded
// source video so motion + camera carry over.

const MODES = {
  transfer: {
    label: '🧑 Swap the person', blurb: 'Put a different person into your video. The movement and the camera stay exactly as they were.',
    guide: { give: ['Your video', '🧑 A photo of the new person'], get: 'The same video with the new person', need: 'A photo is required', eg: 'Replace the woman in the clip with the woman in your photo.' },
    denoise: 0.85, refs: [{ label: 'New character', required: true }, { label: 'New setting (optional)', required: false }],
    textLabel: 'Which person to replace, and anything else', textReq: false, placeholder: 'e.g. the man on the left in the yellow cap',
    edit: (t, refs) => `Image 2 is the identity reference. Redraw image 1 so that the person in it is the person from image 2: reproduce her exact face, facial structure, hair colour and hairstyle, skin tone and apparent age. Keep image 1's pose, body position, framing, camera angle, clothing, lighting and background unchanged.${refs[1] ? ' Place them in the environment shown in image 3, matching lighting and perspective.' : ''}${t && !/\b(replace|swap|reference|photo|video|clip)\b/i.test(t) ? ' ' + t : ''}`,
    prompt: (t) => `${t ? t + '. ' : ''}The new character performs exactly the same movement and camera motion as the original footage.`,
  },
  swap: {
    label: '✏️ Change one thing', blurb: 'Change one detail, such as an outfit, a car, a product or the place, and keep everything else in the shot.',
    guide: { give: ['Your video', '✍️ One sentence: what to change'], get: 'The same video with that one thing changed', need: 'No photo needed (optional)', eg: 'Replace the red car with a vintage blue pickup truck.' },
    denoise: 0.7, refs: [{ label: 'Reference for the new element (optional)', required: false }],
    textLabel: 'What changes?', textReq: true, placeholder: 'e.g. replace the red car with a vintage blue pickup truck',
    edit: (t, refs) => `${t}.${refs[0] ? ' Use the object/person shown in image 2 as the replacement, matching its appearance exactly.' : ''} Match the original lighting, perspective and scale. Keep everything else identical.`,
    prompt: (t) => `${t}. Everything else in the shot, the movement and the camera stay the same.`,
  },
  control: {
    label: '🏗️ Rebuild the scene', blurb: 'Make a brand-new video that moves exactly like yours: new character, new place, new look. Only the movement is kept.',
    guide: { give: ['Your video\'s movement', '✍️ A description of the new video'], get: 'A new video that moves exactly like yours', need: 'No photo needed (optional)', eg: 'A knight in silver armour walks through a misty forest.' },
    denoise: 1, refs: [{ label: 'New character (optional)', required: false }, { label: 'New setting (optional)', required: false }],
    textLabel: 'Describe the NEW video', textReq: true, placeholder: 'e.g. a knight in silver armour walks through a misty forest, cinematic',
    edit: (t, refs) => `${refs[0] ? 'Replace the person in image 1 with the person from image 2, keeping image 2\'s face, hair and identity, preserving the pose and framing of image 1. ' : ''}${refs[1] ? 'Place them in the environment shown in the last reference image. ' : ''}${t}`,
    prompt: (t) => t,
  },
  restyle: {
    label: '🎨 Change the look', blurb: 'Keep the scene and the movement, but give it a new style: anime, film noir, claymation, oil painting and more.',
    guide: { give: ['Your video', '🎨 A style, picked or described'], get: 'The same scene in a new look', need: 'No photo needed', eg: 'Film noir, black and white, harsh shadows.' },
    denoise: 0.8, refs: [], textLabel: 'Describe the look (or pick a preset)', textReq: false,
    edit: (t, refs, style) => (style && /^Redraw/.test(style) ? style : `Redraw this image as ${style || t}. Keep the composition, subjects and poses identical.`),
    prompt: (t, style) => `${style || t}. The same motion and camera movement as the original footage.`,
  },
};

import { VIDEO_LOOKS, LOOK_GROUPS } from '../videoLooks.js';

function SliderRow({ label, badge, lo, hi, hint, children }) {
  return (
    <div className="gj-slider">
      <div className="gj-row"><span>{label}</span><b className="gj-badge">{badge}</b></div>
      {children}
      {(lo || hi) && <div className="gj-ends"><span>{lo}</span><span>{hi}</span></div>}
      {hint && <p className="gj-hint">{hint}</p>}
    </div>
  );
}

// Same inputs -> same seed: a repeated preview must not silently re-roll the identity transfer.
const hashSeed = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 2000000000; };

/** Mean absolute difference (0..1) between two images on a 64x36 grayscale grid. A "swap" that barely changed the frame failed. */
async function frameDiff(a, b) {
  const grid = async (blob) => {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    const out = new Float32Array(64 * 36);
    for (let i = 0; i < out.length; i += 1) out[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255;
    return out;
  };
  const [x, y] = await Promise.all([grid(a), grid(b)]);
  let t = 0; for (let i = 0; i < x.length; i += 1) t += Math.abs(x[i] - y[i]);
  return t / x.length;
}
const FACE_OK = 0.45;          // ArcFace cosine similarity at/above which the swapped-in person counts as the reference person
const FACE_GOOD = 0.6;        // good enough to stop looking

export default function GenjutsuStudio({ assets, addAsset, incoming, onEditFrame }) {
  const [big, setBig] = useState(null);             // url of a first-frame take shown full size
  const [source, setSource] = useState(null);       // {name, blob, url}
  const [meta, setMeta] = useState(null);           // {w, h, dur} read from the clip
  const [mode, setMode] = useState('transfer');
  const [text, setText] = useState('');
  const [style, setStyle] = useState('');
  const [look, setLook] = useState(null);         // chosen entry of VIDEO_LOOKS (Restyle)
  const [engine, setEngine] = useState('bold');    // Restyle: 'bold' = structure lock, 'gentle' = blend with the source
  const [refs, setRefs] = useState({});
  const [guide, setGuide] = useState(null);         // {blob, url, seed}
  const [takes, setTakes] = useState([]);           // every first-frame take made for the current inputs
  const [denoise, setDenoise] = useState(MODES.transfer.denoise);
  const [seconds, setSeconds] = useState(5);
  const [sel, setSel] = useState({ a: 0, b: 0 });   // region of the source clip to edit, in seconds
  const clipCache = useRef({ key: '', blob: null });
  const skipReset = useRef(false);               // set while restoring the last session, so the mode change does not wipe the restored inputs
  const MAXLEN = 8;
  const [steps, setSteps] = useState(8);
  const series = useRef({ raw: null, start: 0, end: 0, n: 0 });   // the parts rendered so far, joined (video only)
  const [cont, setCont] = useState(null);                         // {blob, url, n}: last frame of the previous part, used as the next part's first frame
  const [fgEngine, setFgEngine] = useState('face');      // first-frame method for a person swap: 'face' (face only) | 'qwen' (whole person + clothes)
  const [moveMode, setMoveMode] = useState('exact');   // Swap the person: 'exact' = Structure lock (copies the source's movement), 'blend' = partial re-render
  const [lockStr, setLockStr] = useState(1.3);                 // 1.3: with the speech driving the mouth, a tighter lock keeps the head where the original's is
  const [syncMouth, setSyncMouth] = useState(true);            // drive the new person's mouth from the clip's own audio (speech / rap)
  const [keepOutfit, setKeepOutfit] = useState(false);   // Qwen: keep the clothes already in the video instead of the reference's
  const [qwen, setQwen] = useState(null);
  const [loras, setLoras] = useState([]);                // video LoRAs chained onto the LTX model
  const [loraOptions, setLoraOptions] = useState([]);
  const [ph, setPh] = useState(0);                // playhead (seconds) of the source preview
  const trackRef = useRef(null);
  const [mp, setMp] = useState(0.3);
  const [seed, setSeed] = useState(-1);
  const [keepAudio, setKeepAudio] = useState(true);
  const [hold, setHold] = useState(8);
  const [ctrl, setCtrl] = useState(null);       // motion-control readiness {ready, lora, hint}
  const [run, setRun] = useState({ phase: 'idle', stage: '', progress: 0, status: '', jobId: null, error: null });
  const [result, setResult] = useState(null);
  const [rtxBusy, setRtxBusy] = useState(false);
  const [rtxErr, setRtxErr] = useState('');
  const fileRef = useRef(null);
  const refFile = useRef(null);
  const refSlot = useRef(0);
  const M = MODES[mode];
  const busy = run.phase === 'run';

  useEffect(() => {
    if (skipReset.current) { skipReset.current = false; setGuide(null); return; }
    setDenoise(MODES[mode].denoise); setGuide(null); setRefs({});
  }, [mode]);
  useEffect(() => { setGuide(null); }, [look?.id]);
  const inputKey = [source?.name, source?.blob?.size, mode, text.trim(), style, sel.a.toFixed(2), sel.b.toFixed(2), ...Object.keys(refs).sort().map((k) => `${k}:${refs[k]?.blob?.size}`)].join('|');
  useEffect(() => { setTakes([]); setGuide(null); }, [inputKey]);
  const bold = mode === 'restyle' && engine === 'bold' && !!look && !!ctrl?.ready;
  const lock = mode === 'transfer' && moveMode === 'exact' && !!ctrl?.ready;   // person swap that follows the source movement exactly
  const struct = bold || lock;                                                  // renders through Structure lock
  const lookPrompt = look ? `${look.prompt}${text.trim() ? `. ${text.trim()}` : ''}. The same motion and camera movement as the original footage.` : null;
  useEffect(() => { motionControlStatus().then(setCtrl); qwen21Models().then(setQwen); listLoras().then(setLoraOptions); }, []);
  useEffect(() => { if (incoming?.asset) pick(incoming.asset); }, [incoming?.nonce]);

  const pick = (a, keepSel = null) => {
    const url = a.url || URL.createObjectURL(a.blob);
    setSource({ id: a.id, name: a.name, blob: a.blob, url });
    setGuide(null); setResult(null); setMeta(null); setCont(null); series.current = { raw: null, start: 0, end: 0, n: 0 };
    const v = document.createElement('video');
    v.preload = 'metadata'; v.src = url;
    v.onloadedmetadata = () => {
      setMeta({ w: v.videoWidth, h: v.videoHeight, dur: v.duration });
      if (keepSel && keepSel.b > keepSel.a) {          // the region that was selected before the refresh
        const sa = Math.max(0, Math.min(keepSel.a, (v.duration || 0) - 0.5)); const sb = Math.max(sa + 0.5, Math.min(keepSel.b, v.duration || keepSel.b));
        setSel({ a: sa, b: sb }); setSeconds(Math.round((sb - sa) * 10) / 10);
        return;
      }
      const b = Math.min(v.duration || MAXLEN, MAXLEN);
      setSel({ a: 0, b }); setSeconds(Math.round(b * 10) / 10);
    };
  };
  const pickUpload = (f) => pick(addAsset(f, 'video', f.name, { source: 'upload' }));
  /** One click: NVIDIA RTX Video Super Resolution on the finished video (fast; sharpens and enlarges, keeps the audio). */
  const rtxUp = async () => {
    if (!result?.asset) return;
    setRtxBusy(true); setRtxErr('');
    try {
      const res = await runComfyTool('/api/tools/rtx_upscale', result.asset.blob, { scale: 2, quality: 'ULTRA' }, () => {});
      const blob = await (await fetch(res.url)).blob();
      const asset = addAsset(blob, 'video', `${result.asset.name} · RTX 2x`, { source: 'tool', tool: 'rtxup' });
      setResult({ url: asset.url, asset });
    } catch (e) { setRtxErr(e.message); }
    setRtxBusy(false);
  };   // an uploaded clip joins the Gallery, so it survives a refresh
  const refIds = Object.fromEntries(Object.entries(refs).filter(([, r]) => r?.assetId).map(([k, r]) => [k, r.assetId]));
  useToolMemory('genjutsu', {
    mode, text, style, lookId: look?.id || null, engine, moveMode, lockStr, syncMouth, denoise, seconds, sel, steps, mp, seed, keepAudio, hold, fgEngine, keepOutfit, loras,
    srcId: source?.id || null, refIds, needs: [source?.id, ...Object.values(refIds)].filter(Boolean),
  }, (sv, byId) => {
    if (sv.mode && sv.mode !== mode) skipReset.current = true;
    if (sv.mode) setMode(sv.mode);
    setText(sv.text || ''); setStyle(sv.style || '');
    setLook(sv.lookId ? (VIDEO_LOOKS.find((l) => l.id === sv.lookId) || null) : null);
    if (sv.engine) setEngine(sv.engine);
    if (sv.moveMode) setMoveMode(sv.moveMode);
    if (sv.lockStr != null) setLockStr(sv.lockStr);
    if (sv.syncMouth != null) setSyncMouth(sv.syncMouth);
    if (sv.denoise != null) setDenoise(sv.denoise);
    if (sv.steps != null) setSteps(sv.steps);
    if (sv.mp != null) setMp(sv.mp);
    if (sv.seed != null) setSeed(sv.seed);
    if (sv.keepAudio != null) setKeepAudio(sv.keepAudio);
    if (sv.hold != null) setHold(sv.hold);
    if (sv.fgEngine) setFgEngine(sv.fgEngine);
    if (sv.keepOutfit != null) setKeepOutfit(sv.keepOutfit);
    if (Array.isArray(sv.loras)) setLoras(sv.loras);
    const rr = {};
    Object.entries(sv.refIds || {}).forEach(([k, id]) => { const a = byId.get(id); if (a) rr[k] = { blob: a.blob, url: a.url, assetId: a.id }; });
    setRefs(rr);
    const sa = sv.srcId && byId.get(sv.srcId);
    if (sa) pick(sa, sv.sel);
    if (sv.seconds != null) setSeconds(sv.seconds);
  }, assets);
  const fullClip = !meta || (sel.a < 0.05 && sel.b > meta.dur - 0.05);
  const setRegion = (a, b) => {
    a = Math.max(0, Math.min(a, (meta?.dur || 0) - 0.5));
    b = Math.max(a + 0.5, Math.min(b, meta?.dur || b));
    if (b - a > MAXLEN) b = a + MAXLEN;
    setSel({ a, b }); setSeconds(Math.round((b - a) * 10) / 10);
    const vid = document.getElementById('gj-src'); if (vid) vid.currentTime = a;
  };
  const seek = (t) => { const vid = document.getElementById('gj-src'); if (vid) { vid.currentTime = t; setPh(t); } };
  /** Premiere-style scrubbing: drag a handle (start/end), the shaded range (move it), or the bar itself (playhead). */
  const drag = (kind) => (e) => {
    if (busy || !meta) return;
    e.preventDefault(); e.stopPropagation();
    const el = trackRef.current; if (!el) return;
    el.setPointerCapture?.(e.pointerId);
    const rect = el.getBoundingClientRect();
    const at = (ev) => Math.max(0, Math.min(meta.dur, ((ev.clientX - rect.left) / rect.width) * meta.dur));
    const t0 = at(e), a0 = sel.a, b0 = sel.b;
    const move = (ev) => {
      const t = at(ev);
      if (kind === 'a') { setRegion(Math.min(t, sel.b - 0.5), sel.b); seek(Math.min(t, sel.b - 0.5)); }
      else if (kind === 'b') { setRegion(sel.a, Math.max(t, sel.a + 0.5)); seek(Math.max(0, Math.max(t, sel.a + 0.5) - 0.05)); }
      else if (kind === 'r') { const len = b0 - a0; const a = Math.max(0, Math.min(meta.dur - len, a0 + (t - t0))); setRegion(a, a + len); seek(a); }
      else seek(t);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    if (kind === 'p') seek(t0);
  };
  /** Seamless extension: next part of the source, starting from the last frame of what was just rendered. */
  const continueNext = async () => {
    const sr = series.current;
    if (!sr.raw || !meta) return;
    try {
      setRun((r) => ({ ...r, phase: 'run', stage: 'Preparing', status: 'Taking the last frame of the video…' }));
      const frame = await runFfmpegTool(sr.raw, 'last_frame', {});
      const len = Math.min(sel.b - sel.a, MAXLEN);
      const a = sr.end;
      setRegion(a, Math.min(meta.dur, a + len));
      setCont({ blob: frame, url: URL.createObjectURL(frame), n: sr.n + 1 });
      setRun((r) => ({ ...r, phase: 'idle', status: '' }));
    } catch (e) { setRun((r) => ({ ...r, phase: 'error', error: e.message })); }
  };
  const canContinue = !!result && series.current.raw && meta && meta.dur - series.current.end >= 0.6 && !cont;
  /** The part of the source the user chose (the whole clip when nothing was narrowed). */
  const getClip = async () => {
    if (fullClip) return source.blob;
    const key = `${source.name}|${source.blob.size}|${sel.a.toFixed(2)}|${sel.b.toFixed(2)}`;
    if (clipCache.current.key === key) return clipCache.current.blob;
    setRun((r) => ({ ...r, phase: 'run', stage: 'Trimming', status: `Cutting ${sel.a.toFixed(1)}s – ${sel.b.toFixed(1)}s…` }));
    const blob = await runFfmpegTool(source.blob, 'trim', { start: sel.a.toFixed(2), end: sel.b.toFixed(2) });
    clipCache.current = { key, blob };
    return blob;
  };
  const videoAssets = assets.filter((a) => a.kind === 'video' || (a.mime || '').startsWith('video'));
  const imageAssets = assets.filter((a) => (a.mime || '').startsWith('image'));
  const missingRef = M.refs.some((r, i) => r.required && !refs[i]);
  const needText = M.textReq && !text.trim();
  const refBlobs = M.refs.map((_, i) => refs[i]?.blob).filter(Boolean);

  const onEvent = (stage) => (ev) => {
    if (ev.type === 'submitted') setRun((r) => ({ ...r, jobId: ev.jobId }));
    else if (ev.type === 'progress') setRun((r) => ({ ...r, stage, progress: ev.overall != null ? ev.overall : ev.max ? ev.value / ev.max : 0, status: `${stage}: ${ev.value}/${ev.max}${ev.overall != null ? ` · ${Math.round(ev.overall * 100)}% overall` : ''}` }));
    else if (ev.type === 'status') setRun((r) => ({ ...r, stage, status: `${stage}: ${ev.text}` }));
  };

  /** Step A — edit frame 1 with Flux 3 (skipped for Restyle with no preset: V2V alone). */
  const makeGuide = async (reroll = false) => {
    // already have a take for these exact inputs: show it again instead of re-rolling (use 'New take' to try another seed)
    if (!reroll && takes.length) { const t = guide || takes[0]; setGuide(t); return t.blob; }
    const takeSeed = hashSeed(inputKey) + takes.length;
    setRun({ phase: 'run', stage: 'First frame', progress: 0, status: 'Extracting first frame…', jobId: null, error: null });
    try {
      const clip = await getClip();
      const frame = await runFfmpegTool(clip, 'first_frame', {});
      const instruction = M.edit(text.trim(), M.refs.map((_, i) => refs[i]).filter(Boolean).length ? M.refs.map((_, i) => refs[i]) : [], style);
      let best = null;                     // best attempt so far: {blob, seed, sim, diff}
      const mustChange = mode === 'transfer' && refBlobs.length > 0;      // swapping in a reference person: verify her face really arrived
      // 1) Exact identity first: an image-edit model only blends in a reference face, so the face itself is swapped by a
      //    dedicated face-swap model, then Flux 3 restores skin detail around it.
      if (mustChange && fgEngine === 'face') {
        try {
          setRun((r) => ({ ...r, status: 'Swapping the face (exact identity)…' }));
          const swapped = await faceSwap(frame, refBlobs[0]);
          const polishPrompt = 'Enhance this portrait photo: restore sharp, natural skin texture, crisp eyes, eyelashes and lips on the face. Keep the person\'s face, expression, hair, pose, clothing and framing exactly the same. Photorealistic.';
          const res = await generateFlux3({ prompt: polishPrompt, steps: 8, cfg: 1, match_ref_size: true, seed: takeSeed }, [swapped], [], [], onEvent('Restoring detail'));
          const polished = await (await fetch(res.url)).blob();
          let sim = null;
          try { sim = (await faceMatch(refBlobs[0], polished)).sim; } catch { /* keep going */ }
          let useBlob = polished;
          if (sim == null || sim < FACE_OK) {   // the polish pass drifted the face: fall back to the raw swap
            try { const s0 = (await faceMatch(refBlobs[0], swapped)).sim; if (s0 != null && (sim == null || s0 > sim)) { useBlob = swapped; sim = s0; } } catch { /* keep polished */ }
          }
          best = { blob: useBlob, seed: takeSeed, sim, diff: await frameDiff(frame, useBlob), swapped: true };
        } catch (e) {
          setRun((r) => ({ ...r, status: `Face swap unavailable (${e.message}). Using the image model instead…` }));
        }
      }
      const useQwen = mustChange && fgEngine === 'qwen';
      const tries = useQwen ? 3 : mustChange && !best ? 4 : best ? 0 : 1;
      for (let attempt = 0; attempt < tries; attempt += 1) {
        const seedN = takeSeed + attempt * 7919;
        if (attempt) setRun((r) => ({ ...r, status: `Face match ${best?.sim != null ? `${Math.round(best.sim * 100)}%` : 'not found'}, pose kept ${Math.round((best?.kept || 0) * 100)}%: trying again (take ${attempt + 1}/${tries})…` }));
        const hint = text.trim();
        const names = /\b(left|right|middle|centre|center|front|back|man|woman|guy|girl|person|wearing|cap|hat|shirt|dress|jacket)\b/i.test(hint);   // the text says WHO to replace, not just a detail
        const qwenPrompt = `Edit image 1: replace ONLY ${names ? hint : 'the main person'} with the person from image 2, using image 2's face, hair and body${keepOutfit ? ', but keep the clothing from image 1' : ' and the clothes they are wearing in image 2'}. The new person must keep EXACTLY the same pose as the person they replace: the same head angle and gaze direction, the same arm and hand positions, the same body position, size and framing. Leave everyone else, the objects, the camera angle, the lighting and the background exactly as they are in image 1.${refs[1] ? ' Place them in the environment shown in image 3.' : ''}${hint && !names ? ' ' + hint : ''}`;
        const res = useQwen
          ? await generateQwen21({ prompt: qwenPrompt, steps: 25, cfg: 1, match_ref_size: true, seed: seedN }, [frame, ...refBlobs], [], onEvent('First frame (Qwen)'))
          : await generateFlux3(
            { prompt: instruction, steps: 8, cfg: 1, match_ref_size: true, seed: seedN },
            [frame, ...refBlobs], [], [], onEvent('First frame'));
        const cand = await (await fetch(res.url)).blob();
        let sim = null;
        if (mustChange) {
          setRun((r) => ({ ...r, status: 'Checking the face against your reference…' }));
          try { sim = (await faceMatch(refBlobs[0], cand)).sim; } catch { sim = null; }
        }
        const diff = await frameDiff(frame, cand);
        const kept = mustChange ? await poseKept(frame, cand) : 1;   // how much of the original pose/layout survived (the video follows the source's movement only if frame 1 starts from the same pose)
        const score = sim != null ? sim + 1.2 * kept : -1 + diff + kept;     // no face found: fall back to "did the frame change at all"
        if (!best || score > best.score) best = { blob: cand, seed: seedN, sim, diff, kept, score };
        if (!mustChange || (sim != null && sim >= FACE_GOOD && kept >= 0.7)) break;
      }
      const blob = best.blob; const usedSeed = best.seed; const diff = best.diff; const sim = best.sim;
      const take = { blob, url: URL.createObjectURL(blob), before: URL.createObjectURL(frame), seed: usedSeed, diff, sim, kept: best.kept };
      setTakes((t) => [...t, take]);
      setGuide(take);
      setRun((r) => ({ ...r, phase: 'idle', status: 'First frame ready' }));
      return blob;
    } catch (e) {
      setRun((r) => ({ ...r, phase: e.message === 'Cancelled' ? 'idle' : 'error', error: e.message }));
      return null;
    }
  };

  /** Step B — LTX video-to-video from the clip + guide frame. */
  const animate = async () => {
    let g = cont ? cont.blob : guide?.blob;
    if (!g && !cont && mode !== 'control' && !(mode === 'restyle' && !style && !text.trim())) g = await makeGuide();
    if (!g && !cont && mode === 'control' && (refs[0] || refs[1])) g = await makeGuide();
    setRun({ phase: 'run', stage: 'Re-animating', progress: 0, status: 'Submitting…', jobId: null, error: null });
    try {
      const clip = await getClip();
      const res = (mode === 'control' || struct)
        ? await runMotionControl(clip, g || null, { prompt: (lookPrompt || M.prompt(text.trim(), style)) + (lock && syncMouth ? ' They speak or sing with their mouth moving in time with the audio, keeping the same head direction, gaze and expression as the original footage.' : ''), seconds, megapixels: mp, seed, steps, control_strength: lock ? lockStr : bold ? 1.0 : denoise, ...(lock && ctrl?.modes?.includes('depth') ? { mode: 'depth' } : {}), ...(lock && syncMouth ? { audio_sync: true } : {}) }, onEvent('Re-animating'))
        : await runGenjutsu(clip, g || null, {
        prompt: lookPrompt || M.prompt(text.trim(), style), denoise, seconds, megapixels: mp, seed, steps,
        guide_strength: 1, guide_hold: cont ? 2 : hold,
      }, loras.filter((l) => l.name), onEvent('Re-animating'));
      const raw = await (await fetch(res.url)).blob();
      const prev = series.current;
      if (cont && prev.raw) {
        setRun((r) => ({ ...r, stage: 'Joining', status: 'Joining the new part onto the video…' }));
        series.current = { raw: await runFfmpegJoin(prev.raw, raw), start: prev.start, end: sel.b, n: prev.n + 1 };
      } else series.current = { raw, start: sel.a, end: sel.b, n: 1 };
      const sr = series.current;
      let blob = sr.raw;
      if (keepAudio) {
        try { blob = await runFfmpegMux(blob, sr.n === 1 ? clip : await runFfmpegTool(source.blob, 'trim', { start: sr.start.toFixed(2), end: sr.end.toFixed(2) })); }
        catch { /* keep generated audio */ }
      }
      setCont(null);
      const asset = addAsset(blob, 'video', `${source.name.replace(/\.[^.]+$/, '')} · ${M.label.replace(/^\S+\s/, '')}${sr.n > 1 ? ` · ${sr.n} parts` : ''}`, { source: 'genjutsu', mode, seed: res.seed });
      setResult({ url: asset.url, asset });
      setRun((r) => ({ ...r, phase: 'done', status: 'Done' }));
    } catch (e) {
      setRun((r) => ({ ...r, phase: e.message === 'Cancelled' ? 'idle' : 'error', error: e.message }));
    }
  };

  return (
    <div className="edit-studio video-lab">
      {big && (
        <div className="gj-big" onClick={() => setBig(null)}>
          <img src={big} alt="" />
          <span>Tap anywhere to close</span>
        </div>
      )}
      <div className="es-stage">
        {!source ? (
          <DropZone accept="video" icon="🌀" title="Drop the clip to transform" assets={assets}
            onFile={pickUpload} onAsset={(a) => pick(a)} />
        ) : (
          <div className="gj-monitor">
          <div className="gj-bar">
            <span className="gj-file"><i />{source.name}</span>
            {meta && <><span>{meta.w}×{meta.h}</span><span>{meta.dur ? `${meta.dur.toFixed(1)} s` : ''}</span></>}
            <span className="gj-mode">{M.label.replace(/^\S+\s/, '')}</span>
          </div>
          <div className="vl-compare">
            <figure><figcaption>Source clip</figcaption><video id="gj-src" src={source.url} controls loop muted
                onTimeUpdate={(e) => { const v = e.currentTarget; setPh(v.currentTime); if (!fullClip && !v.paused && v.currentTime >= sel.b) v.currentTime = sel.a; }} /></figure>
            <figure>
              <figcaption>{result ? 'Result' : guide ? 'New first frame' : 'Result appears here'}</figcaption>
              {result ? <video src={result.url} controls loop autoPlay /> : guide ? (guide.before ? <CompareIfSame before={guide.before} after={guide.url} beforeLabel="Original" afterLabel="New" onZoom={() => setBig(guide.url)}><img src={guide.url} alt="" style={{ cursor: 'zoom-in' }} title="Click to enlarge" onClick={() => setBig(guide.url)} /></CompareIfSame> : <img src={guide.url} alt="" style={{ cursor: 'zoom-in' }} title="Click to enlarge" onClick={() => setBig(guide.url)} />) : <div className="es-empty" style={{ padding: 40 }}>—</div>}
              {result && <div className="row"><a className="dl" href={result.url} download="genjutsu.mp4">⬇ Download</a>
                <button disabled={rtxBusy} onClick={rtxUp} title="NVIDIA RTX Video Super Resolution: 2× bigger and sharper in about a minute. Sharpens what is there; does not add new detail.">{rtxBusy ? '⚡ Enlarging…' : '⚡ Sharpen ×2 (RTX)'}</button></div>}
              {rtxErr && <div className="error">{rtxErr}</div>}
            </figure>
          </div>
          </div>
        )}
        {!source && <div className="gj-chips"><span>MP4 · MOV · WEBM</span><span>Best under 8 s</span><span>Local · zero-cost GPU</span></div>}
        {source && meta && meta.dur > 0.6 && (
          <div className="gj-region">
            <span>Region to edit <b>{sel.a.toFixed(1)}s → {sel.b.toFixed(1)}s</b> · {(sel.b - sel.a).toFixed(1)}s of {meta.dur.toFixed(1)}s{meta.dur > MAXLEN ? ` (max ${MAXLEN}s at once)` : ''}</span>
            <div className="gj-track" ref={trackRef} onPointerDown={drag('p')}>
              <div className="gj-dim" style={{ left: 0, width: `${(sel.a / meta.dur) * 100}%` }} />
              <div className="gj-dim" style={{ right: 0, width: `${(1 - sel.b / meta.dur) * 100}%` }} />
              <div className="gj-sel" style={{ left: `${(sel.a / meta.dur) * 100}%`, width: `${((sel.b - sel.a) / meta.dur) * 100}%` }} onPointerDown={drag('r')} title="Drag to slide the whole region" />
              <div className="gj-h gj-ha" style={{ left: `${(sel.a / meta.dur) * 100}%` }} onPointerDown={drag('a')} title="Drag: start" />
              <div className="gj-h gj-hb" style={{ left: `${(sel.b / meta.dur) * 100}%` }} onPointerDown={drag('b')} title="Drag: end" />
              <div className="gj-play" style={{ left: `${(ph / meta.dur) * 100}%` }} />
            </div>
            <div className="gj-marks">
              <button disabled={busy} onClick={() => setRegion(Math.min(ph, sel.b - 0.5), sel.b)} title="Start the region at the playhead (like pressing I)">[ Set start here</button>
              <button disabled={busy} onClick={() => setRegion(sel.a, Math.max(ph, sel.a + 0.5))} title="End the region at the playhead (like pressing O)">Set end here ]</button>
              <small>Playhead {ph.toFixed(1)}s</small>
              {!fullClip && <button disabled={busy} onClick={() => setRegion(0, meta.dur)}>Reset</button>}
            </div>
          </div>
        )}
        {canContinue && (
          <div className="gj-cont">
            <button disabled={busy} onClick={continueNext}>➕ Continue with the next part ({series.current.end.toFixed(1)}s → {Math.min(meta.dur, series.current.end + Math.min(sel.b - sel.a, MAXLEN)).toFixed(1)}s)</button>
            <small>Starts from this video's last frame and joins on seamlessly. Uses the same settings; change the region or prompt first if you like.</small>
          </div>
        )}
        {cont && (
          <div className="gj-cont">
            <img src={cont.url} alt="" onClick={() => setBig(cont.url)} style={{ height: 64, borderRadius: 6, cursor: 'zoom-in' }} />
            <span>Part {cont.n}: starts from the last frame of the previous part. Press ✨ Transform clip to render and join it on.</span>
            <button disabled={busy} onClick={() => setCont(null)}>Cancel continuation</button>
          </div>
        )}
        {guide && guide.sim != null && guide.sim < FACE_OK && (
          <div className="error" style={{ maxWidth: 720 }}>The reference person did not carry over cleanly (face match {Math.round(guide.sim * 100)}%). Try “New take”, or use a reference photo with a larger, front-facing face, or a clip where the face is visible.</div>
        )}
        {takes.length > 0 && (
          <div className="gj-takes">
            <span>First-frame takes <small>click to choose the one that gets animated</small></span>
            {takes.map((t, i) => (
              <button key={i} className={guide?.url === t.url ? 'on' : ''} onClick={() => setGuide(t)} title={`seed ${t.seed}${t.sim != null ? ` · face match ${Math.round(t.sim * 100)}%` : ''}${t.kept != null ? ` · pose kept ${Math.round(t.kept * 100)}%` : ''} · change ${((t.diff || 0) * 100).toFixed(1)}%`}>
                <img src={t.url} alt="" /><em>{i + 1}{t.sim != null ? ` · ${Math.round(t.sim * 100)}%` : ''}</em>
                <span role="button" className="gj-zoom" title="View larger" onClick={(e) => { e.stopPropagation(); setBig(t.url); }}>🔍</span>
              </button>
            ))}
          </div>
        )}
        {source && <div className="es-bar"><button onClick={() => fileRef.current?.click()}>Change clip</button></div>}
        <input ref={fileRef} type="file" accept="video/*" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) pickUpload(f); e.target.value = ''; }} />
      </div>

      <div className="es-side glass gj-panel">
        <h3>Genjutsu — video to video<small className="gj-count">{Object.keys(MODES).length} modes</small></h3>
        <div className="es-body">
        <div className="seg" style={{ flexDirection: 'column' }}>
          {Object.entries(MODES).map(([k, v]) => (
            <button key={k} className={mode === k ? 'active' : ''} disabled={busy} onClick={() => setMode(k)}>{v.label}</button>
          ))}
        </div>
        <div className="gj-guide">
          <p>{M.blurb}</p>
          <div className="gj-flow">
            <span><i>🎬</i>{M.guide.give[0]}</span><b>+</b><span>{M.guide.give[1]}</span><b>→</b><span className="get"><i>✨</i>{M.guide.get}</span>
          </div>
          <small><em>{M.guide.need}</em> · Example: “{M.guide.eg}”</small>
        </div>

        {M.refs.map((slot, i) => (
          <div key={i}>
            <label>{slot.label}{slot.required ? ' *' : ''}</label>
            <div className="row">
              {refs[i] && <span className="ref-chip"><img src={refs[i].url} alt="" /><button className="x" onClick={() => setRefs((r) => { const n = { ...r }; delete n[i]; return n; })}>×</button></span>}
              <button disabled={busy} onClick={() => { refSlot.current = i; refFile.current?.click(); }}>＋ Choose</button>
              {imageAssets.length > 0 && (
                <select value="" disabled={busy} onChange={(e) => { const a = assets.find((x) => x.id === e.target.value); if (a) setRefs((r) => ({ ...r, [i]: { blob: a.blob, url: a.url, assetId: a.id } })); }}>
                  <option value="">Gallery…</option>
                  {imageAssets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
            </div>
          </div>
        ))}
        <input ref={refFile} type="file" accept="image/*" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) { const na = addAsset(f, 'image', f.name, { source: 'upload' }); setRefs((r) => ({ ...r, [refSlot.current]: { blob: f, url: na.url, assetId: na.id } })); } e.target.value = ''; }} />

        {mode === 'restyle' && (
          <div className="lk-wrap">
            <div className="gj-sec">Stylization rigor<small>how far the look is rebuilt</small></div>
            <div className="lk-engine">
              <button className={engine === 'bold' ? 'on' : ''} disabled={busy} onClick={() => setEngine('bold')}
                title="Rebuilds colours, lighting and materials from scratch and only keeps the clip's edges and motion. Strongest looks.">
                🔥 Bold <em className="gj-def">DEFAULT</em><small>rebuilds the look</small></button>
              <button className={engine === 'gentle' ? 'on' : ''} disabled={busy} onClick={() => setEngine('gentle')}
                title="Blends the new look into the original footage. Keeps its colours and lighting; subtler.">
                🌱 Gentle <small>keeps source colours</small></button>
            </div>
            {engine === 'bold' && ctrl && !ctrl.ready && <div className="error">Bold needs the Union-Control LoRA ({ctrl.hint || 'not found'}); falling back to Gentle.</div>}
            {LOOK_GROUPS.map((g) => (
              <div key={g} className="lk-group">
                <div className="lk-gname">{g}</div>
                <div className="lk-chips">
                  {VIDEO_LOOKS.filter((l) => l.group === g).map((l) => (
                    <button key={l.id} className={`lk-chip ${look?.id === l.id ? 'on' : ''}`} disabled={busy}
                      onClick={() => { if (look?.id === l.id) { setLook(null); setStyle(''); } else { setLook(l); setStyle(l.edit); } }}>
                      <span>{l.emoji}</span> {l.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {look && <div className="hint">Look: <b>{look.label}</b>. Add anything specific below (optional), or leave it blank.</div>}
          </div>
        )}
        <label>{M.textLabel}</label>
        <textarea rows={3} value={text} disabled={busy} placeholder={M.placeholder || ''} onChange={(e) => setText(e.target.value)} />

        {mode === 'control' ? (
          <SliderRow label="Control strength" badge={denoise.toFixed(2)} lo="Loose" hi="Locked to edges" hint="How tightly the new video follows the source edges. 1.0 is the trained default.">
            <input type="range" min={0.4} max={1.5} step={0.05} value={denoise} disabled={busy} onChange={(e) => setDenoise(+e.target.value)} />
            {ctrl && !ctrl.ready && <span className="error" style={{ display: 'block' }}>{ctrl.hint || 'Union-Control LoRA not found'}</span>}
          </SliderRow>
        ) : struct ? null : (
        <SliderRow label="Creative freedom" badge={`${Math.round(denoise * 100)}%`} lo="Low · stays glued to source" hi="High · radical swaps">
          <input type="range" min={0.3} max={1} step={0.05} value={denoise} disabled={busy} onChange={(e) => setDenoise(+e.target.value)} />
        </SliderRow>
        )}
        {mode === 'transfer' && (
          <div className="gj-fg">
            <label>Movement (how closely the new person copies your video)</label>
            <div className="f3-engine">
              <button className={moveMode === 'exact' ? 'on' : ''} disabled={busy} onClick={() => setMoveMode('exact')}
                title="Locks the new video to the edges and motion of your clip (Structure lock)."><b>🎯 Follow exactly</b><small>Copies every move and the camera (uses a depth map of your clip). Best for keeping the original movement.</small></button>
              <button className={moveMode === 'blend' ? 'on' : ''} disabled={busy} onClick={() => setMoveMode('blend')}
                title="Re-renders part of the way from your clip. Looser, the movement can drift."><b>🌱 Blend</b><small>Looser. The movement can change.</small></button>
            </div>
            {moveMode === 'exact' && ctrl && !ctrl.ready && <div className="error">Following exactly needs the Union-Control LoRA ({ctrl.hint || 'not found'}); using Blend instead.</div>}
            {lock && (
              <label className="gj-check" title="Uses the clip's own audio to drive the new person's mouth, so they rap or talk like the original. Needs a clip with sound."><input type="checkbox" checked={syncMouth} disabled={busy} onChange={(e) => { setSyncMouth(e.target.checked); if (e.target.checked && lockStr < 1.3) setLockStr(1.3); }} /> Match the mouth to the original audio (rapping / talking)</label>
            )}
            {lock && (
              <SliderRow label="How tightly" badge={lockStr.toFixed(2)} lo="Looser" hi="Locked to your clip" hint="1.0 is the trained default. With the mouth following the audio, 1.3 keeps the head pointing where the original's does; if she turns to face the camera, go higher. Lower it if the picture looks stiff.">
                <input type="range" min={0.6} max={1.5} step={0.05} value={lockStr} disabled={busy} onChange={(e) => setLockStr(+e.target.value)} />
              </SliderRow>
            )}
          </div>
        )}
        {mode === 'transfer' && (
          <div className="gj-fg">
            <label>First-frame method (how the new person is put in)</label>
            <div className="f3-engine">
              <button className={fgEngine === 'face' ? 'on' : ''} disabled={busy} onClick={() => setFgEngine('face')}><b>🙂 Face swap</b><small>Exact face. Keeps the clothes from the video.</small></button>
              <button className={fgEngine === 'qwen' ? 'on' : ''} disabled={busy || (qwen && !qwen.ready)} onClick={() => setFgEngine('qwen')}
                title={qwen && !qwen.ready ? 'Qwen Image 2.1 models were not found in ComfyUI' : ''}><b>✦ Qwen Image</b><small>Whole person: face, hair, body and clothes. Slower.</small></button>
            </div>
            {fgEngine === 'qwen' && <label className="gj-check"><input type="checkbox" checked={keepOutfit} disabled={busy} onChange={(e) => setKeepOutfit(e.target.checked)} /> Keep the clothes from the video</label>}
          </div>
        )}
        {!(mode === 'control' || struct) && (
          <LoraRows loras={loras} setLoras={setLoras} loraOptions={loraOptions} busy={busy} label="Video LoRAs"
            hint="LTX video LoRAs chained onto the model for the re-render (character, style, motion). Not used by Structure lock." />
        )}
        {mode !== 'control' && !struct && (
          <SliderRow label="New-look hold" badge={`${hold} frames`} hint="How many opening frames are the edited first frame, held still, before your clip's movement resumes. Higher = the new person lasts longer, but the first part of the video freezes for that long. For the new person to last the whole video without freezing, use Movement: Follow exactly instead.">
            <input type="range" min={0} max={48} step={4} value={hold} disabled={busy} onChange={(e) => setHold(+e.target.value)} />
          </SliderRow>
        )}
        <div className="grid2">
          <label>Max length (s)
            <input type="number" min={1} max={8} step={0.5} value={seconds} disabled={busy} onChange={(e) => setSeconds(+e.target.value)} />
          </label>
          <label>Steps
            <input type="number" min={4} max={24} step={1} value={steps} disabled={busy} onChange={(e) => setSteps(Math.max(4, Math.min(24, +e.target.value || 8)))} title="More steps = cleaner fast motion, slower. 8 is the default." />
          </label>
          <label>Resolution
            <select value={mp} disabled={busy} onChange={(e) => setMp(+e.target.value)}>
              <option value={0.2}>Draft 0.2 MP</option><option value={0.3}>Standard 0.3 MP</option><option value={0.45}>High 0.45 MP</option><option value={0.7}>Very high 0.7 MP (slower)</option><option value={0.98}>720p-class 0.98 MP (slowest, may run out of memory)</option>
            </select>
          </label>
          <label>Seed (−1 = rnd)
            <input type="number" value={seed} disabled={busy} onChange={(e) => setSeed(+e.target.value)} />
          </label>
          <label className="checkbox-label" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={keepAudio} disabled={busy} onChange={(e) => setKeepAudio(e.target.checked)} /> Keep original audio
          </label>
        </div>

        </div>
        <div className="es-foot">
        <div className="gj-est"><span>Est. time ≈ {Math.max(1, Math.round((90 + 55 * seconds) * (mp / 0.3) / 60))} min</span><b>Local · zero-cost GPU</b></div>
        <div className="row">
          <button disabled={busy || !source || missingRef || needText} onClick={() => makeGuide(takes.length > 0)}
            title={takes.length ? 'Try another take: a new random first frame from the same inputs' : 'Preview the edited first frame before committing to the slow video render'}>
            {takes.length ? '🎲 New take' : '👁 Preview first frame'}</button>
        </div>
        <button className="primary" disabled={busy || !source || missingRef || needText} onClick={animate}>
          {busy ? `${run.stage}…` : !source ? 'Pick a clip first' : missingRef ? 'Add the photo above, or pick another mode' : needText ? 'Describe the change' : '✨ Transform clip'}
        </button>
        {busy && (
          <>
            <GenProgress progress={run.progress} status={run.status} onCancel={() => cancelJob(run.jobId)} cancelDisabled={!run.jobId} />
          </>
        )}
        {run.phase === 'error' && <div className="error">{run.error}</div>}
        </div>
      </div>
    </div>
  );
}
