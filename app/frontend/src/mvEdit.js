/**
 * Beat-aligned auto-cut: turn generated shot clips + a song analysis into an
 * edit decision list. Every cut lands on a beat; cut length follows the
 * section's energy (choruses cut fast, verses breathe); a shot is picked
 * from the setups scheduled for the current section (a setup's shots recur
 * across every section it's scheduled in — the cross-cutting a real music
 * video edit does), preferring a DIFFERENT SETUP than the immediately
 * preceding cut so the edit actually interweaves rather than lingering, and
 * each clip is consumed progressively so repeated uses show a later moment
 * of it rather than a random re-scrub.
 */

/** Small seeded PRNG (mulberry32) so a cut can be reproduced/reshuffled. */
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a += 0x6D2B79F5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CUT_BEATS = {
  fast: [1, 2],
  medium: [2, 4],
  slow: [4, 8],
};

function beatsForEnergy(style, energy, bpm) {
  if (style !== 'auto') return CUT_BEATS[style] || CUT_BEATS.medium;
  const fastTempo = bpm > 140;
  if (energy >= 0.75) return fastTempo ? [2, 2, 4] : [1, 2, 2];
  if (energy >= 0.45) return fastTempo ? [4, 4, 8] : [2, 4, 4];
  return fastTempo ? [8, 8] : [4, 8];
}

/**
 * @param analysis  backend /api/mv/analyze result
 * @param clips     [{sceneId, assetId, duration, sections (1-based array|null), setupId, energy}]
 * @param opts      {style:'auto'|'fast'|'medium'|'slow', seed, start, end, progressive:true}
 * @returns [{sceneId, assetId, in, out, at, dur, section, setupId}]
 */
export function buildEdl(analysis, clips, opts = {}) {
  const usable = clips.filter((c) => c.duration > 0.3);
  if (!usable.length || !analysis?.duration) return [];
  const style = opts.style || 'auto';
  const rand = rng(opts.seed ?? 1);
  const start = Math.max(0, opts.start ?? 0);
  const end = Math.min(analysis.duration, opts.end ?? analysis.duration);
  const sections = analysis.sections || [];
  const bpm = analysis.bpm || 120;

  // beat grid within the range; synthesize one if the tracker gave nothing
  let beats = (analysis.beats || []).filter((t) => t >= start && t <= end);
  if (beats.length < 3) {
    const step = 60 / bpm;
    beats = [];
    for (let t = start; t <= end; t += step) beats.push(t);
  }
  if (beats[0] > start + 0.05) beats.unshift(start);
  if (beats[beats.length - 1] < end - 0.05) beats.push(end);
  const downbeats = new Set((analysis.downbeats || []).map((t) => t.toFixed(3)));

  const sectionAt = (t) => {
    const i = sections.findIndex((s) => t >= s.start && t < s.end);
    return i >= 0 ? i + 1 : null;
  };
  const cursor = new Map(usable.map((c) => [c.sceneId, 0]));
  const uses = new Map(usable.map((c) => [c.sceneId, 0]));
  const pieces = [];
  let i = 0;
  let last = null;
  let lastSetup = null;
  while (i < beats.length - 1) {
    const t = beats[i];
    const secIdx = sectionAt(t);
    const energy = secIdx ? (sections[secIdx - 1].energy ?? 0.5) : 0.5;
    const choices = beatsForEnergy(style, energy, bpm);
    let nBeats = choices[Math.floor(rand() * choices.length)];
    // long cuts should start on a downbeat; if we're off the bar, shorten to reach one
    if (nBeats >= 4 && !downbeats.has(t.toFixed(3))) {
      const next = beats.slice(i + 1, i + 4).findIndex((b) => downbeats.has(b.toFixed(3)));
      if (next >= 0) nBeats = next + 1;
    }
    const j = Math.min(beats.length - 1, i + nBeats);
    let dur = beats[j] - t;
    if (dur <= 0.05) { i = j; continue; }

    // candidates: shots from setups scheduled for this section — a setup can
    // be scheduled for several sections, which is the actual cross-cutting
    // (its shots recur later in the song, intercut with other setups' shots
    // in between). Prefer a different SETUP than the previous cut first (the
    // interweave), falling back to just a different clip, then anything.
    const inSection = (c) => (c.sections || []).includes(secIdx);
    let pool = usable.filter((c) => inSection(c) && c.setupId !== lastSetup);
    if (!pool.length) pool = usable.filter((c) => inSection(c) && c.sceneId !== last);
    if (!pool.length) pool = usable.filter((c) => inSection(c));
    if (!pool.length) pool = usable.filter((c) => c.sceneId !== last);
    if (!pool.length) pool = usable;
    // prefer the least-used, with a little randomness
    const minUse = Math.min(...pool.map((c) => uses.get(c.sceneId)));
    const fresh = pool.filter((c) => uses.get(c.sceneId) <= minUse + 1);
    const clip = fresh[Math.floor(rand() * fresh.length)];

    dur = Math.min(dur, clip.duration);
    let inPt;
    if (opts.progressive === false) {
      inPt = rand() * Math.max(0, clip.duration - dur);
    } else {
      inPt = cursor.get(clip.sceneId);
      if (inPt + dur > clip.duration + 1e-3) inPt = rand() * Math.max(0, clip.duration - dur) * 0.3;
      cursor.set(clip.sceneId, inPt + dur);
    }
    pieces.push({
      sceneId: clip.sceneId, assetId: clip.assetId, setupId: clip.setupId ?? clip.sceneId,
      in: round3(inPt), out: round3(inPt + dur), at: round3(t), dur: round3(dur), section: secIdx,
    });
    uses.set(clip.sceneId, uses.get(clip.sceneId) + 1);
    last = clip.sceneId;
    lastSetup = clip.setupId ?? clip.sceneId;
    i = j;
  }
  return pieces;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

export const edlDuration = (pieces) => round3(pieces.reduce((a, p) => a + p.dur, 0));

/** Backend EDL shape: clip = asset id, in/out seconds. */
export const toBackendEdl = (pieces) => pieces.map((p) => ({ clip: p.assetId, in: p.in, out: p.out }));
