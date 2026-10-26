import { useEffect, useState } from 'react';

// Waveform peaks, beat analysis and speech-to-text for Timeline clips.

const PEAKS_PER_SEC = 60;
const cache = new Map();          // assetId -> Promise<{peaks: Float32Array, dur}>
let ctx = null;

/** Peak amplitude per 1/60 s of an audio (or video) asset, decoded in the browser. null if it has no readable audio. */
export function getPeaks(asset) {
  if (!asset?.blob) return Promise.resolve(null);
  if (!cache.has(asset.id)) {
    cache.set(asset.id, (async () => {
      try {
        if (asset.blob.size > 90_000_000) return null;                      // do not decode huge files just for a picture
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        const buf = await ctx.decodeAudioData(await asset.blob.arrayBuffer());
        const ch = buf.getChannelData(0), n = Math.ceil(buf.duration * PEAKS_PER_SEC), step = Math.max(1, Math.floor(buf.sampleRate / PEAKS_PER_SEC));
        const peaks = new Float32Array(n);
        for (let i = 0; i < n; i++) { let m = 0; const a = i * step, b = Math.min(ch.length, a + step); for (let k = a; k < b; k += 4) { const v = Math.abs(ch[k]); if (v > m) m = v; } peaks[i] = m; }
        let top = 0; peaks.forEach((v) => { if (v > top) top = v; });
        if (top > 0) for (let i = 0; i < n; i++) peaks[i] /= top;
        return { peaks, dur: buf.duration };
      } catch { return null; }                                              // no audio track, or a format the browser cannot decode
    })());
  }
  return cache.get(asset.id);
}

export const PEAKS_RATE = PEAKS_PER_SEC;

/** React hook: the peaks of an asset once decoded. */
export function usePeaks(asset) {
  const [p, setP] = useState(null);
  useEffect(() => {
    let dead = false; setP(null);
    if (asset) getPeaks(asset).then((r) => { if (!dead) setP(r); });
    return () => { dead = true; };
  }, [asset?.id]);
  return p;
}

async function post(path, blob, name) {
  const fd = new FormData(); fd.append('file', blob, name || 'clip.bin');
  const r = await fetch(path, { method: 'POST', body: fd });
  if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch { /* plain text */ } throw new Error(d); }
  return r.json();
}

/** {bpm, beats[], downbeats[], duration} in seconds of the file. */
export const analyzeBeats = (asset) => post('/api/timeline/beats', asset.blob, asset.name);
/** {words:[{w,start,end}], language} */
export const transcribeWords = (asset) => post('/api/timeline/captions', asset.blob, asset.name);
