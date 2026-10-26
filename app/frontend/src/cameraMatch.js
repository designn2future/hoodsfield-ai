import { useEffect, useState } from 'react';

/** Did the camera stay put between two pictures? Compares the edge structure (where the lines and outlines are) block by
 * block on a small grid. A changed character, outfit or colour only spoils the blocks it covers; a moved, zoomed or
 * re-angled camera spoils nearly all of them. Used to show the before/after slider only when it is meaningful. */
const N = 96, B = 6, S = N / B;            // 96x96 working grid, 6x6 blocks of 16 px
const NCC_OK = 0.4;                         // a block "matches" above this correlation of its edge map
const SHARE_OK = 0.5;                       // enough of the picture must match for the camera to count as unchanged
const cache = new Map();

const load = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });

function edgeMap(img) {
  const c = document.createElement('canvas'); c.width = N; c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, N, N);
  const d = g.getImageData(0, 0, N, N).data;
  const l = new Float32Array(N * N);
  for (let i = 0; i < l.length; i += 1) l[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
  const e = new Float32Array(N * N);
  for (let y = 1; y < N - 1; y += 1) for (let x = 1; x < N - 1; x += 1) {
    const gx = l[y * N + x + 1] - l[y * N + x - 1], gy = l[(y + 1) * N + x] - l[(y - 1) * N + x];
    e[y * N + x] = Math.hypot(gx, gy);
  }
  return e;
}

export async function sameCamera(beforeUrl, afterUrl) {
  const key = `${beforeUrl}|${afterUrl}`;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const [a, b] = await Promise.all([load(beforeUrl), load(afterUrl)]);
    const ra = a.naturalWidth / a.naturalHeight, rb = b.naturalWidth / b.naturalHeight;
    if (Math.abs(ra - rb) / ra > 0.08) return { same: false, share: 0 };          // a different shape of picture is a different shot
    const ea = edgeMap(a), eb = edgeMap(b);
    let counted = 0, matched = 0;
    for (let by = 0; by < B; by += 1) for (let bx = 0; bx < B; bx += 1) {
      let sa = 0, sb = 0, n = 0;
      for (let y = by * S; y < (by + 1) * S; y += 1) for (let x = bx * S; x < (bx + 1) * S; x += 1) { sa += ea[y * N + x]; sb += eb[y * N + x]; n += 1; }
      const ma = sa / n, mb = sb / n;
      let cov = 0, va = 0, vb = 0;
      for (let y = by * S; y < (by + 1) * S; y += 1) for (let x = bx * S; x < (bx + 1) * S; x += 1) {
        const da = ea[y * N + x] - ma, db = eb[y * N + x] - mb;
        cov += da * db; va += da * da; vb += db * db;
      }
      if (va < 1e-3 || vb < 1e-3 || ma < 1 || mb < 1) continue;                    // a flat block says nothing about the camera
      counted += 1;
      if (cov / Math.sqrt(va * vb) >= NCC_OK) matched += 1;
    }
    const share = counted ? matched / counted : 0;
    return { same: counted >= 6 && share >= SHARE_OK, share };
  })().catch(() => ({ same: null, share: 0 }));
  cache.set(key, p);
  return p;
}

/** null while checking (or if it could not be checked), then true/false. */
export function useSameCamera(before, after) {
  const [same, setSame] = useState(null);
  useEffect(() => {
    let live = true;
    setSame(null);
    if (before && after) sameCamera(before, after).then((r) => { if (live) setSame(r.same); });
    return () => { live = false; };
  }, [before, after]);
  return same;
}

/** How much of the original picture's layout survives in an edited copy, 0..1: the share of 12x6 blocks whose edge pattern still
 * lines up. Used to rank first-frame takes, since a take that moves the pose makes the video drift away from the source's movement. */
export async function poseKept(aBlob, bBlob) {
  const W = 192, H = 108, BX = 12, BY = 6;
  const edge = async (blob) => {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const l = new Float32Array(W * H);
    for (let i = 0; i < l.length; i += 1) l[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
    const e = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y += 1) for (let x = 1; x < W - 1; x += 1) e[y * W + x] = Math.hypot(l[y * W + x + 1] - l[y * W + x - 1], l[(y + 1) * W + x] - l[(y - 1) * W + x]);
    return e;
  };
  const [a, b] = await Promise.all([edge(aBlob), edge(bBlob)]);
  const sw = W / BX, sh = H / BY;
  let counted = 0, ok = 0;
  for (let by = 0; by < BY; by += 1) for (let bx = 0; bx < BX; bx += 1) {
    let ma = 0, mb = 0, n = 0;
    for (let y = by * sh; y < (by + 1) * sh; y += 1) for (let x = bx * sw; x < (bx + 1) * sw; x += 1) { ma += a[y * W + x]; mb += b[y * W + x]; n += 1; }
    ma /= n; mb /= n;
    let cov = 0, va = 0, vb = 0;
    for (let y = by * sh; y < (by + 1) * sh; y += 1) for (let x = bx * sw; x < (bx + 1) * sw; x += 1) { const da = a[y * W + x] - ma, db = b[y * W + x] - mb; cov += da * db; va += da * da; vb += db * db; }
    if (va < 1e-3 || vb < 1e-3 || ma < 1 || mb < 1) continue;
    counted += 1;
    if (cov / Math.sqrt(va * vb) >= 0.4) ok += 1;
  }
  return counted ? ok / counted : 0;
}
