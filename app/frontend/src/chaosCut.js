// Chaos cut: the fast, chaotic found-footage finish (see backend/chaos_cut.py). Thin client + the voice-bed recipes.
import { generateH3, generateFlux3 } from './api.js';

/** Overlapping family voices, from relaxed chatter to everyone screaming. The video model speaks them; only the sound is used. */
export const VOICE_BEDS = [
  { mood: 'calm', text: "Two or three family members talking casually over each other inside a car, a woman and a man chatting in relaxed normal voices, a boy asking a question, a girl groaning 'ugh', ordinary relaxed family conversation, steady car engine and road roar" },
  { mood: 'uneasy', text: "A family talking low and nervous in a car, overlapping murmurs: a woman asking 'what is that?', a man saying 'it's probably a plane', a boy saying 'it's getting closer', a girl whispering, tense overlapping voices, steady car engine and road roar" },
  { mood: 'alarm', text: "Several people shouting over each other at the same time in a panic inside a car: a woman yelling 'Rick! Rick!', a man yelling 'Hold on!', a boy yelling, a girl screaming, voices overlapping and talking over each other, car engine noise" },
  { mood: 'alarm2', text: "A frightened family all talking and shouting at once inside a car, a woman yelling 'What is that?!', a man shouting 'I don't know!', a boy shouting 'Mom!', a girl yelling 'Dad, drive!', overlapping panicked voices, car engine noise" },
  { mood: 'scream', text: "The whole family screaming at the top of their lungs at the same time inside a car, a woman shrieking, a girl screaming, a boy crying out 'Mom!', a man yelling 'Oh my God!', chaotic overlapping, distorted" },
  { mood: 'scream2', text: "Terrified family screaming and sobbing inside a stopped car, several voices overlapping, a woman screaming 'Rick!', a girl shrieking, a boy yelling 'Dad!', a man shouting, chaotic and loud, distorted" },
];

async function json(res) {
  if (!res.ok) { let d = await res.text(); try { d = JSON.parse(d).detail || d; } catch { /* plain text */ } throw new Error(d); }
  return res.json();
}

export async function chaosAnalyze(blob) {
  const fd = new FormData();
  fd.append('file', blob, 'clip.mp4');
  return json(await fetch('/api/tools/chaos_analyze', { method: 'POST', body: fd }));
}

export async function chaosPlan(analyses, opts) {
  return json(await fetch('/api/tools/chaos_plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ analyses, opts }) }));
}

/** plan + the clip blobs (plan.segments[].clip indexes into `clips`) + voice beds [{mood, blob}] -> {blob, seed, score, seconds}. */
export async function chaosCut(plan, clips, beds, avatar) {
  const fd = new FormData();
  fd.append('plan', JSON.stringify(plan));
  clips.forEach((b, i) => fd.append('clips', b, `clip${i}.mp4`));
  beds.forEach((b) => fd.append('beds', b.blob, `${b.mood}.mp4`));
  fd.append('bed_names', beds.map((b) => b.mood).join(','));
  if (avatar) fd.append('avatar', avatar, 'avatar.png');
  const res = await fetch('/api/tools/chaos_cut', { method: 'POST', body: fd });
  if (!res.ok) { let d = await res.text(); try { d = JSON.parse(d).detail || d; } catch { /* plain text */ } throw new Error(d); }
  let score = null;
  try { score = JSON.parse(res.headers.get('X-Chaos-Score') || 'null'); } catch { /* header missing */ }
  return { blob: await res.blob(), seed: res.headers.get('X-Chaos-Seed'), score, seconds: res.headers.get('X-Chaos-Seconds'), length: res.headers.get('X-Chaos-Length') };
}

/** Write a finished video to the Hoodsfield_Output folder on disk. Resolves {path, bytes}. */
export async function saveOutput(blob, name) {
  const fd = new FormData();
  fd.append('file', blob, 'out.mp4');
  fd.append('name', name);
  return json(await fetch('/api/tools/save_output', { method: 'POST', body: fd }));
}

/** A fictional commenter's profile picture for the 'reply to a comment' bubble (Flux 3, square). Resolves a PNG blob. */
export async function makeAvatar(onEvent) {
  const prompt = 'square profile picture of a friendly young woman in her mid twenties, casual phone selfie, head and shoulders, natural window light, slightly messy hair, relaxed smile, simple indoor background, looks like an ordinary social media profile photo';
  const r = await generateFlux3({ prompt, width: 512, height: 512, steps: 8, cfg: 1, seed: -1, upsample: false, swap_model: 'inswapper_128.onnx', face_restore_model: 'none' }, [], [], [], onEvent || (() => {}));
  return (await fetch(r.url)).blob();
}

/** One voice bed: a quick low-resolution clip whose only purpose is its audio. */
export async function makeVoiceBed(stillBlob, bed, onEvent) {
  const params = {
    description: 'A dark handheld camcorder point of view through the windshield of a 1980s car on an empty night highway, the camera shakes, no face visible, one continuous take.',
    soundscape: bed.text, music: 'No music.', frames: 107, megapixels: 0.12, preset: 'fast', seed: -1, lock_still: true,
  };
  const r = await generateH3(stillBlob, params, [], onEvent);
  return (await fetch(r.url)).blob();
}
