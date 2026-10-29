import { isViewOnly, VIEW_ONLY_MSG } from './viewOnly.js';
import { getGenre } from './genreStore.js';
/** Backend API client: submit depth frames + params, stream progress via SSE. */

export async function generateVideo(blobs, params, onEvent) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) fd.append(k, String(v));
  blobs.forEach((b, i) =>
    fd.append('frames', b, `frame_${String(i).padStart(5, '0')}.png`)
  );
  return submitAndStream('/api/generate', fd, onEvent);
}

/** Sketch-to-image: one PNG drawing + prompt. `loraEntries`/`faceEntries` only
 * apply when params.backend === 'krea2' (ignored server-side otherwise).
 * Resolves to the result image URL. */
export async function generateImage(sketchBlob, params, loraEntries, faceEntries, onEvent) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) fd.append(k, String(v));
  fd.append('sketch', sketchBlob, 'sketch.png');
  faceEntries.forEach((f) => {
    fd.append('face_indices', String(f.index));
    fd.append('face_images', f.blob, `face_${f.index}.png`);
  });
  loraEntries.forEach((l) => {
    fd.append('lora_names', l.name);
    fd.append('lora_strengths', String(l.strength));
  });
  return submitAndStream('/api/generate_image', fd, onEvent);
}

/** ids of jobs this screen started itself (the shared feed skips those; they are handled by their own request) */
export const localJobs = new Set();

async function submitAndStream(endpoint, fd, onEvent) {
  if (isViewOnly()) throw new Error(VIEW_ONLY_MSG);
  const res = await fetch(endpoint, { method: 'POST', body: fd });
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch {}
    throw new Error(`Generate failed (${res.status}): ${detail}`);
  }
  const { job_id, seed } = await res.json();
  localJobs.add(job_id);
  onEvent?.({ type: 'submitted', jobId: job_id });
  onEvent?.({ type: 'status', text: `Job ${job_id} submitted (seed ${seed})` });

  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/events/${job_id}`);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      onEvent?.(ev);
      if (ev.type === 'done') { es.close(); resolve({ url: ev.url, media: ev.media || '', seed }); }
      else if (ev.type === 'error') { es.close(); reject(new Error(ev.text)); }
    };
    // The live stream can drop for a second (long renders, a phone sleeping, a busy server). The job keeps running on the
    // backend, so instead of failing, ask for its status until it finishes.
    let polled = false;
    es.onerror = () => {
      es.close();
      if (polled) return;
      polled = true;
      onEvent?.({ type: 'status', text: 'Live connection dropped; still waiting for the result…' });
      let misses = 0;
      const tick = async () => {
        try {
          const r = await fetch(`/api/jobs/${job_id}`);
          if (!r.ok) throw new Error(String(r.status));
          misses = 0;
          const j = await r.json();
          if (j.status === 'done') return resolve({ url: `/api/jobs/${job_id}/media`, media: '', seed });
          if (j.status === 'error' || j.status === 'cancelled') return reject(new Error(j.error || (j.status === 'cancelled' ? 'Cancelled' : 'Job failed')));
          onEvent?.({ type: 'status', text: j.status_text || 'Working…' });
        } catch {
          misses += 1;
          if (misses > 40) return reject(new Error('Lost connection to backend'));
        }
        setTimeout(tick, 3000);
      };
      tick();
    };
  });
}

/** Storyboard scene image + prompt -> video. `loraEntries` is
 * [{name, strength}] — replaces the workflow's built-in video LoRA when
 * non-empty; pass [] to keep the built-in default. Resolves {url, media}. */
export async function generateI2V(imageBlob, params, loraEntries, onEvent) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) fd.append(k, String(v));
  (loraEntries || []).forEach((l) => {
    fd.append('lora_names', l.name);
    fd.append('lora_strengths', String(l.strength));
  });
  fd.append('image', imageBlob, 'scene.png');
  return submitAndStream('/api/generate_i2v', fd, onEvent);
}

/** Krea 2 (native) text-to-image. `moodboardBlobs` are style/subject reference
 * images (unbounded). `faceEntries` is [{index, blob}] — index = which
 * detected face (0 = leftmost) that entry's face image should replace.
 * `loraEntries` is [{name, strength}], chained onto model+clip before sampling. */
export async function generateKrea(params, moodboardBlobs, faceEntries, loraEntries, onEvent) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) fd.append(k, String(v));
  moodboardBlobs.forEach((b, i) => fd.append('moodboard', b, `mood_${i}.png`));
  faceEntries.forEach((f) => {
    fd.append('face_indices', String(f.index));
    fd.append('face_images', f.blob, `face_${f.index}.png`);
  });
  loraEntries.forEach((l) => {
    fd.append('lora_names', l.name);
    fd.append('lora_strengths', String(l.strength));
  });
  return submitAndStream('/api/generate_krea', fd, onEvent);
}

/** Flux 3 Klein text-to-image / reference-guided edit. `refBlobs` = reference
 * images (each chained on via ReferenceLatent — edit, restyle, character
 * consistency). `matchRefSize` sizes the canvas from the first reference.
 * Resolves {url, media, seed, prompt} — `prompt` is the final text actually
 * used (the upsampled one when `upsample` is set). */
export async function generateFlux3(params, refBlobs, faceEntries, loraEntries, onEvent, maskBlob) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') fd.append(k, String(v));
  (refBlobs || []).forEach((b, i) => fd.append('refs', b, `ref_${i}.png`));
  if (maskBlob) fd.append('mask', maskBlob, 'mask.png');
  (faceEntries || []).forEach((f) => {
    fd.append('face_indices', String(f.index));
    fd.append('face_images', f.blob, `face_${f.index}.png`);
  });
  (loraEntries || []).forEach((l) => {
    fd.append('lora_names', l.name);
    fd.append('lora_strengths', String(l.strength));
  });
  const res = await submitAndStream('/api/generate_flux3', fd, onEvent);
  return res;
}

export async function flux3Models() {
  try {
    const r = await fetch('/api/flux3/models');
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** Expand a short idea into a dense caption with BFL's Qwen3.5 upsampler. */
export async function flux3Upsample(prompt, width, height) {
  const fd = new FormData();
  fd.append('prompt', prompt); fd.append('width', String(width)); fd.append('height', String(height));
  const r = await fetch('/api/flux3/upsample', { method: 'POST', body: fd });
  if (!r.ok) {
    let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch {}
    throw new Error(d);
  }
  return (await r.json()).prompt;
}

/** Studio tools that run as ComfyUI jobs (upscale / interpolate / remove_bg):
 * resolves {url, media} like every other generator. */
export async function runComfyTool(endpoint, fileBlob, fields, onEvent, extraFiles) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) if (v != null && v !== '') fd.append(k, String(v));
  fd.append('file', fileBlob, fileBlob.name || (fileBlob.type?.startsWith('video') ? 'in.mp4' : 'in.png'));
  for (const [k, b] of Object.entries(extraFiles || {})) fd.append(k, b, `${k}.png`);
  return submitAndStream(endpoint, fd, onEvent);
}

/** Instant ffmpeg ops (reverse, speed, trim, reframe, frames, gif…) -> Blob. */
export async function runFfmpegTool(fileBlob, op, fields) {
  const fd = new FormData();
  fd.append('op', op);
  for (const [k, v] of Object.entries(fields || {})) if (v != null && v !== '') fd.append(k, String(v));
  fd.append('file', fileBlob, fileBlob.name || 'in.mp4');
  const r = await fetch(op === 'sound' ? '/api/tools/sound' : '/api/tools/ffmpeg', { method: 'POST', body: fd });
  if (!r.ok) {
    let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch {}
    throw new Error(d);
  }
  return r.blob();
}

/** Genjutsu video-to-video: source clip + optional edited first frame (guide). */
export async function runGenjutsu(videoBlob, guideBlob, fields, loraEntries, onEvent) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) if (v != null && v !== '') fd.append(k, String(v));
  (loraEntries || []).forEach((l) => { fd.append('lora_names', l.name); fd.append('lora_strengths', String(l.strength === '' ? 1 : l.strength)); });
  fd.append('video', videoBlob, videoBlob.name || 'clip.mp4');
  if (guideBlob) fd.append('guide', guideBlob, 'guide.png');
  return submitAndStream('/api/genjutsu', fd, onEvent);
}

/** Structure-locked motion control (LTX 2.3 Union-Control IC-LoRA): control clip + optional first-frame image. */
export async function runMotionControl(videoBlob, guideBlob, fields, onEvent) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) if (v != null && v !== '') fd.append(k, String(v));
  fd.append('video', videoBlob, videoBlob.name || 'clip.mp4');
  if (guideBlob) fd.append('guide', guideBlob, 'guide.png');
  return submitAndStream('/api/motion_control', fd, onEvent);
}

/** Lip-sync: face still + speech clip -> talking video (LTX audio-to-video). */
export async function runLipSync(imageBlob, audioBlob, fields, onEvent) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) if (v != null && v !== '') fd.append(k, String(v));
  fd.append('image', imageBlob, 'face.png');
  fd.append('audio', audioBlob, audioBlob.name || 'speech.wav');
  return submitAndStream('/api/lipsync', fd, onEvent);
}

export async function motionControlStatus() {
  try { const r = await fetch('/api/motion_control/status'); return r.ok ? await r.json() : null; } catch { return null; }
}

export async function runFfmpegMux(videoBlob, audioSourceBlob) {
  const fd = new FormData();
  fd.append('op', 'mux_audio');
  fd.append('file', videoBlob, 'v.mp4');
  fd.append('aux', audioSourceBlob, audioSourceBlob.name || 'a.mp4');
  const r = await fetch('/api/tools/ffmpeg', { method: 'POST', body: fd });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch {} throw new Error(d); }
  return r.blob();
}

/** Seamless continuation: append `nextBlob` (which starts on the frame `prevBlob` ended on) to `prevBlob`; video only. */
export async function runFfmpegJoin(prevBlob, nextBlob) {
  const fd = new FormData();
  fd.append('op', 'join');
  fd.append('file', prevBlob, 'a.mp4');
  fd.append('aux', nextBlob, 'b.mp4');
  const r = await fetch('/api/tools/ffmpeg', { method: 'POST', body: fd });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch {} throw new Error(d); }
  return r.blob();
}

/** Draft -> final: upscale (+ optional RIFE smoothing) of an approved draft clip, one ComfyUI job. */
export async function finalizeVideo(videoBlob, { scale = 2, smooth = 1 } = {}, onEvent) {
  return runComfyTool('/api/tools/finalize', videoBlob, { scale, smooth }, onEvent);
}

export async function toolModels() {
  try { const r = await fetch('/api/tools/models'); return r.ok ? await r.json() : null; } catch { return null; }
}

/** Wan 2.2 video (silent, LoRA-capable). `imageBlob` = start frame (null = text-to-video),
 * `lastBlob` = optional end frame. `loraPairs` = [{high, low, strength}]. Resolves {url, media, seed}. */
export async function generateWan(imageBlob, params, loraPairs, lastBlob, onEvent) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') fd.append(k, String(v));
  (loraPairs || []).forEach((l) => {
    fd.append('lora_names_high', l.high); fd.append('lora_names_low', l.low); fd.append('lora_strengths', String(l.strength));
  });
  if (imageBlob) fd.append('image', imageBlob, 'start.png');
  if (lastBlob) fd.append('last_image', lastBlob, 'end.png');
  return submitAndStream('/api/generate_wan', fd, onEvent);
}

/** Long shot: chains Wan segments (last frame -> next start, original still as identity anchor). */
export async function generateWanLong(imageBlob, params, onEvent) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') fd.append(k, String(v));
  fd.append('image', imageBlob, 'start.png');
  return submitAndStream('/api/wan/long', fd, onEvent);
}

export async function wanModels() {
  try { const r = await fetch('/api/wan/models'); return r.ok ? await r.json() : null; } catch { return null; }
}

export async function wanEnhancePrompt({ still, motion, camera, seconds }) {
  const fd = new FormData();
  fd.append('still', still || ''); fd.append('motion', motion || ''); fd.append('camera', camera || ''); fd.append('seconds', String(seconds || 5));
  const r = await fetch('/api/wan/enhance_prompt', { method: 'POST', body: fd });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch {} throw new Error(d); }
  return (await r.json()).prompt;
}

/** MiniMax H3 video (native audio). `imageBlob` = scene still (first frame)
 * or null for text/reference-to-video; `refBlobs` = character/object
 * reference images (<Picture 1>…, only used when no still is given).
 * Resolves {url, media, seed}. */
export async function generateH3(imageBlob, params, refBlobs, onEvent, lastBlob) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, String(x)));
    else if (v != null) fd.append(k, String(v));
  }
  if (imageBlob) fd.append('image', imageBlob, 'scene.png');
  if (lastBlob) fd.append('last_image', lastBlob, 'last.png');
  (refBlobs || []).forEach((b, i) => fd.append('ref_images', b, `ref_${i}.png`));
  return submitAndStream('/api/generate_h3', fd, onEvent);
}

export async function listH3Models() {
  try {
    const r = await fetch('/api/h3/models');
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function jsonOrThrow(res) {
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

/** Music track -> beat grid / sections / energy. */
export async function mvAnalyze(file) {
  const fd = new FormData();
  fd.append('track', file, file.name || 'track.mp3');
  return jsonOrThrow(await fetch('/api/mv/analyze', { method: 'POST', body: fd }));
}

/** Song analysis + cast + concept -> shot list (Ollama, or template fallback). */
export async function mvScript(body) {
  return jsonOrThrow(await fetch('/api/mv/script', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ genre: getGenre().id, ...body }),
  }));
}

/** Cut list + clips (+ music) -> final mp4 Blob. `clips` = [{id, blob}]. */
export async function mvRender({ edl, clips, music, width, height, musicGain = 1, clipGain = 0, musicOffset = 0, fadeOut = 0, look = '' }) {
  const fd = new FormData();
  fd.append('edl', JSON.stringify(edl));
  fd.append('width', String(width));
  fd.append('height', String(height));
  fd.append('music_gain', String(musicGain));
  fd.append('clip_gain', String(clipGain));
  fd.append('music_offset', String(musicOffset));
  fd.append('fade_out', String(fadeOut));
  if (look) fd.append('look', look);
  if (music) fd.append('music', music, music.name || 'music.mp3');
  clips.forEach((c) => fd.append('clips', c.blob, `${c.id}.mp4`));
  const res = await fetch('/api/mv/render', { method: 'POST', body: fd });
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.blob();
}

/** Reference video -> narration transcript (local faster-whisper). */
export async function transcribeStoryVideo(videoBlob) {
  const fd = new FormData();
  fd.append('video', videoBlob, videoBlob.name || 'reference.mp4');
  return jsonOrThrow(await fetch('/api/story/transcribe', { method: 'POST', body: fd }));
}

/** Reference video -> story content notes (subjects/actions/setting, not style). */
export async function describeStoryVideo(videoBlob, frames = 6) {
  const fd = new FormData();
  fd.append('frames', String(frames));
  fd.append('video', videoBlob, videoBlob.name || 'reference.mp4');
  return jsonOrThrow(await fetch('/api/story/describe_video', { method: 'POST', body: fd }));
}

/** Reference jpgs -> story content notes (subjects/actions/setting, not style). */
export async function describeStoryImages(files) {
  const fd = new FormData();
  files.forEach((f, i) => fd.append('images', f, f.name || `ref_${i}.jpg`));
  return jsonOrThrow(await fetch('/api/story/describe_images', { method: 'POST', body: fd }));
}

/** Story material + cast + concept -> flat ordered scene list (Ollama, or template fallback). */
export async function writeStoryScript(body) {
  return jsonOrThrow(await fetch('/api/story/script', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ genre: getGenre().id, ...body }),
  }));
}

/** An already-written shot-by-shot script -> a flat scene list (no LLM call). */
export async function parseStoryScript(body) {
  return jsonOrThrow(await fetch('/api/story/parse_script', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ genre: getGenre().id, ...body }),
  }));
}

/** Post-process color-grade presets available to renderFinalCut's `look` param. */
export async function listLooks() {
  try {
    const r = await fetch('/api/looks');
    return (await r.json()).looks || [];
  } catch {
    return [];
  }
}

/** Environment/mood-board reference images -> a shared style paragraph, via the
 * local Ollama vision model. Resolves {style, model, images_analyzed}. */
export async function describeImagesStyle(files) {
  const fd = new FormData();
  files.forEach((f, i) => fd.append('images', f, f.name || `ref_${i}.png`));
  const res = await fetch('/api/describe_images_style', { method: 'POST', body: fd });
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

export async function llmStatus() {
  try {
    const r = await fetch('/api/llm/status');
    return await r.json();
  } catch {
    return { ok: false, models: [] };
  }
}

/** Cancel a running/queued generation. Fire-and-forget: the job's SSE stream
 * delivers the terminal "Cancelled" event, so callers just await that. */
export async function cancelJob(jobId) {
  if (!jobId) return;
  try { await fetch(`/api/cancel/${jobId}`, { method: 'POST' }); } catch {}
}

/** Image -> generation prompt. Tries the ComfyUI/A1111 prompt embedded in
 * PNG metadata first; falls back to a local Ollama Qwen-VL description.
 * mode='vision' forces the vision model. Resolves {prompt, source, model?}. */
export async function describeImage(imageBlob, mode = 'auto') {
  const fd = new FormData();
  fd.append('mode', mode);
  fd.append('image', imageBlob, 'image.png');
  const res = await fetch('/api/describe_image', { method: 'POST', body: fd });
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

/** Reference video (mp4 etc.) -> transferable aesthetic/style descriptors via
 * the local Ollama vision model. Resolves {style, model, frames_analyzed}. */
export async function describeVideo(videoBlob, frames = 6) {
  const fd = new FormData();
  fd.append('frames', String(frames));
  fd.append('video', videoBlob, videoBlob.name || 'reference.mp4');
  const res = await fetch('/api/describe_video', { method: 'POST', body: fd });
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

export async function listControlnets() {
  try {
    const r = await fetch('/api/controlnets');
    const d = await r.json();
    return d.controlnets || [];
  } catch {
    return [];
  }
}

export async function listCheckpoints() {
  try {
    const r = await fetch('/api/models');
    const d = await r.json();
    return d.checkpoints || [];
  } catch {
    return [];
  }
}

export async function listGgufModels() {
  try {
    const r = await fetch('/api/gguf_models');
    const d = await r.json();
    return d.gguf_models || [];
  } catch {
    return [];
  }
}

export async function listTextEncoders() {
  try {
    const r = await fetch('/api/text_encoders');
    const d = await r.json();
    return d.text_encoders || [];
  } catch {
    return [];
  }
}

export async function listVaes() {
  try {
    const r = await fetch('/api/vaes');
    const d = await r.json();
    return d.vaes || [];
  } catch {
    return [];
  }
}

/** {lora file name: model family} — flux3, krea2, qwen, zimage, ltx, wan, minimax_h3, sdxl or unknown. */
export async function listLoraFamilies() {
  try { const r = await fetch('/api/loras/info'); return r.ok ? (await r.json()).families || {} : {}; } catch { return {}; }
}

export async function listLoras() {
  try {
    const r = await fetch('/api/loras');
    const d = await r.json();
    return d.loras || [];
  } catch {
    return [];
  }
}

export async function listFaceSwapModels() {
  try {
    const r = await fetch('/api/face_swap_models');
    const d = await r.json();
    return { swapModels: d.swap_models || [], faceRestoreModels: d.face_restore_models || [] };
  } catch {
    return { swapModels: [], faceRestoreModels: [] };
  }
}

export async function checkHealth() {
  try {
    const r = await fetch('/api/health');
    return await r.json();
  } catch {
    return { ok: false, comfy_reachable: false };
  }
}

/** LTX wants frame counts of the form 8n + 1. */
export function quantizeFrames(seconds, fps) {
  const raw = Math.max(9, Math.round(seconds * fps));
  return Math.max(9, Math.round((raw - 1) / 8) * 8 + 1);
}

/** Auto-QA: heuristic checks (+ optional local vision model) on a rendered clip. */
export async function qaAnalyze(blob, { vlm = false } = {}) {
  const fd = new FormData();
  fd.append('file', blob, 'clip.mp4');
  fd.append('vlm', vlm ? '1' : '0');
  const r = await fetch('/api/qa/analyze', { method: 'POST', body: fd });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch {} throw new Error(d); }
  return r.json();
}


/** ArcFace similarity between the face in `ref` and the best face in `cand` (0..1; same person is usually above 0.35). */
export async function faceMatch(refBlob, candBlob) {
  const fd = new FormData();
  fd.append('ref', refBlob, 'ref.png');
  fd.append('cand', candBlob, 'cand.png');
  const r = await fetch('/api/face/match', { method: 'POST', body: fd });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}


/** Exact-identity face swap (InSwapper): the reference face onto the biggest face in `targetBlob`. Throws if either has no face. */
export async function faceSwap(targetBlob, refBlob, { pick = 'largest', mask = null } = {}) {
  const fd = new FormData();
  fd.append('target', targetBlob, 'target.png');
  fd.append('ref', refBlob, 'ref.png');
  if (mask) fd.append('mask', mask, 'mask.png');
  const r = await fetch(`/api/face/swap?pick=${pick}`, { method: 'POST', body: fd });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* text */ } throw new Error(d); }
  return r.blob();
}


/** Qwen Image 2.1: text-to-image, or edit / multi-reference when `refBlobs` is non-empty. */
export async function generateQwen21(params, refBlobs, loraEntries, onEvent) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') fd.append(k, String(v));
  (refBlobs || []).forEach((b, i) => fd.append('refs', b, `ref_${i}.png`));
  (loraEntries || []).forEach((l) => { fd.append('lora_names', l.name); fd.append('lora_strengths', String(l.strength)); });
  return submitAndStream('/api/generate_qwen21', fd, onEvent);
}

export async function qwen21Models() {
  try { const r = await fetch('/api/qwen21/models'); return r.ok ? await r.json() : null; } catch { return null; }
}


/** 3D scene layout -> image: the depth render of the user's blocking steers Qwen Image 2.1 (Fun-Controlnet-Union). */
export async function generateScene(params, controlBlob, refBlobs, onEvent) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') fd.append(k, String(v));
  fd.append('control', controlBlob, 'depth.png');
  (refBlobs || []).forEach((b, i) => fd.append('refs', b, `ref_${i}.png`));
  return submitAndStream('/api/scene/generate', fd, onEvent);
}

/** Stage directions -> pose plan from a local LLM, or {plan: null} when none is running (the browser then parses it itself). */
export async function directScene(text, cast) {
  try {
    const r = await fetch('/api/scene/direct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, cast }) });
    if (!r.ok) return { plan: null, reason: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) { return { plan: null, reason: e.message }; }
}

export async function sceneStatus() {
  try { const r = await fetch('/api/scene/status'); return r.ok ? await r.json() : null; } catch { return null; }
}

/** Photo -> {fov_x, depth_png (base64), objects:[{label, box:[x0,y0,x1,y1] 0..1, near}]} */
export async function analyzeScene(imageBlob) {
  const fd = new FormData();
  fd.append('image', imageBlob, 'scene.png');
  const r = await fetch('/api/scene/analyze', { method: 'POST', body: fd });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* text */ } throw new Error(d); }
  return r.json();
}


/** Saved Scene Composer scenes (stored on disk by the backend). */
export async function listScenes() { try { const r = await fetch('/api/scene/saves'); return r.ok ? (await r.json()).scenes : []; } catch { return []; } }
export async function saveScene(name, state, thumb) {
  const r = await fetch(`/api/scene/saves/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, thumb }) });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* text */ } throw new Error(d); }
  return r.json();
}
export async function openScene(name) { const r = await fetch(`/api/scene/saves/${encodeURIComponent(name)}`); if (!r.ok) throw new Error('Could not open that scene'); return r.json(); }
export async function deleteScene(name) { await fetch(`/api/scene/saves/${encodeURIComponent(name)}`, { method: 'DELETE' }); }


/** Video ideas for a genre (curated, plus fresh ones from the local LLM when it is running). */
export async function storyIdeas(genre, hint = '', n = 6) {
  try {
    const r = await fetch('/api/story/ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ genre, hint, n }) });
    return r.ok ? await r.json() : { ideas: [] };
  } catch { return { ideas: [] }; }
}


/** Rewrite one shot's prompts so it contains a visible, specific unsettling detail. */
export async function scarifyShot(body) {
  const r = await fetch('/api/story/scarify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ genre: getGenre().id, ...body }) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/** A generated soundtrack bed (Stable Audio, local), looped to `seconds`. Returns a WAV Blob. */
export async function makeScore(prompt, seconds, seed = 7) {
  const fd = new FormData();
  fd.append('prompt', prompt); fd.append('seconds', String(seconds)); fd.append('seed', String(seed));
  const r = await fetch('/api/tools/score', { method: 'POST', body: fd });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* text */ } throw new Error(d); }
  return r.blob();
}


/** Script inbox: scripts written outside the app (e.g. co-written with Claude) that can be loaded into the Script step. */
export async function listScripts() { try { const r = await fetch('/api/scripts'); return r.ok ? (await r.json()).scripts : []; } catch { return []; } }
export async function getScript(name) { const r = await fetch(`/api/scripts/${encodeURIComponent(name)}`); if (!r.ok) throw new Error('Could not open that script'); return r.json(); }


// ---- Story Room (in-app writing partner)
const sr = async (path, body, method = 'POST') => {
  const r = await fetch(`/api/storyroom/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* text */ } throw new Error(d); }
  return r.json();
};
export const storyRoomStatus = async () => { try { return await sr('status', null, 'GET'); } catch { return null; } };
export const storyRoomSetKey = (key) => sr('key', { key });
export const storyRoomForgetKey = () => sr('key', null, 'DELETE');
export const storyRoomSetModel = (model) => sr('model', { model });
export const storyRoomChat = (body) => sr('chat', body);
export const storyRoomScript = (body) => sr('script', body);

/** Body pose(s) in a photo -> {width, height, poses:[{image, world, box}]} (people ordered left to right). */
export async function readPhotoPose(file, maxPeople = 6) {
  const fd = new FormData();
  fd.append('file', file, file.name || 'photo.png');
  fd.append('max_people', String(maxPeople));
  const r = await fetch('/api/scene/pose', { method: 'POST', body: fd });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* plain text */ } throw new Error(d); }
  return r.json();
}

/** Voiceover: say `text` in the voice `voiceId` (a /api/tts/voices id, e.g. "u:Stella.wav"). Resolves {blob, job}. */
export async function speakText(text, voiceId, onStatus) {
  const fd = new FormData();
  fd.append('text', text); fd.append('voice', voiceId);
  const r = await fetch('/api/tts/speak', { method: 'POST', body: fd });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* plain text */ } throw new Error(d); }
  const { job_id } = await r.json();
  for (;;) {
    await new Promise((res) => setTimeout(res, 2500));
    const j = await (await fetch(`/api/jobs/${job_id}`)).json();
    if (j.status === 'done') break;
    if (j.status === 'error' || j.status === 'cancelled') throw new Error(j.error || 'The voice failed');
    onStatus?.(j.status_text || 'Speaking…');
  }
  return { blob: await (await fetch(`/api/tts/audio/${job_id}`)).blob(), job: job_id };
}
