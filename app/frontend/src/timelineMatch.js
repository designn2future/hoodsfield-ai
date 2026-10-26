// Shot-matching colour: measure how bright / contrasty / tinted a clip is and work out a per-channel gain + offset that
// pulls another clip towards it (mean and spread of each RGB channel, the classic Reinhard transfer, kept gentle).

const SZ = 64;

function frameAt(asset, t) {
  return new Promise((resolve) => {
    const draw = (el) => {
      try {
        const c = document.createElement('canvas'); c.width = SZ; c.height = SZ;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(el, 0, 0, SZ, SZ);
        resolve(g.getImageData(0, 0, SZ, SZ).data);
      } catch { resolve(null); }
    };
    if (asset.mime?.startsWith('image') || asset.kind === 'image') {
      const im = new Image(); im.onload = () => draw(im); im.onerror = () => resolve(null); im.src = asset.url; return;
    }
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = asset.url;
    const fail = setTimeout(() => resolve(null), 8000);
    v.onloadeddata = () => { v.currentTime = Math.max(0, Math.min(t, (v.duration || t + 1) - 0.05)); };
    v.onseeked = () => { clearTimeout(fail); draw(v); };
    v.onerror = () => { clearTimeout(fail); resolve(null); };
  });
}

/** {m:[r,g,b], s:[r,g,b]} in 0..1 over three frames spread through the part of the clip that is used. null if unreadable. */
export async function clipStats(asset, clip) {
  const a = clip.in || 0, b = clip.out || a + 1;
  const ts = [0.2, 0.5, 0.8].map((f) => a + (b - a) * f);
  let n = 0; const sum = [0, 0, 0], sq = [0, 0, 0];
  for (const t of ts) {
    const d = await frameAt(asset, t); if (!d) continue;
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) { const v = d[i + k] / 255; sum[k] += v; sq[k] += v * v; }
    n += d.length / 4;
  }
  if (!n) return null;
  const m = sum.map((x) => x / n);
  return { m, s: sq.map((x, k) => Math.sqrt(Math.max(1e-6, x / n - m[k] * m[k]))) };
}

const r4 = (x) => Math.round(x * 10000) / 10000;

/** The correction that makes `src` look like `ref`: out = gain * in + offset, per channel (0..1). The gain is limited so a flat or noisy clip is not blown out. */
export function computeMatch(src, ref) {
  const gain = [], off = [];
  for (let k = 0; k < 3; k++) {
    const g = Math.max(0.7, Math.min(1.45, ref.s[k] / src.s[k]));
    gain.push(r4(g)); off.push(r4(Math.max(-0.35, Math.min(0.35, ref.m[k] - g * src.m[k]))));
  }
  return { g: gain, o: off };
}

/** The correction eased towards "no change" by `amt` (0..1). */
export function mixMatch(m, amt = 1) {
  const a = Math.max(0, Math.min(1, amt));
  return { g: m.g.map((x) => 1 + (x - 1) * a), o: m.o.map((x) => x * a) };
}
