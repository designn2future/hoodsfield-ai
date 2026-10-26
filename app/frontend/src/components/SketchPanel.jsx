import GenProgress from './GenProgress.jsx';
import React, { useEffect, useState } from 'react';
import {
  listCheckpoints, listControlnets, listGgufModels, listTextEncoders, listVaes, listFaceSwapModels, listLoras,
} from '../api.js';
import { pickDefault } from '../utils.js';
import LoraRows from './LoraRows.jsx';
import FaceSwapRows from './FaceSwapRows.jsx';

const snap64 = (n) => Math.max(256, Math.round(n / 64) * 64);
const isBf16 = (name) => /bf16|fp16/i.test(name);
// ComfyUI's KSampler hard-rejects denoise outside [0,1] (a whole-request 502,
// not a friendly message) — clamp on blur the same way width/height snap.
const clampDenoise = (n) => Math.max(0, Math.min(1, n));

export default function SketchPanel({
  settings, setSettings, faces, setFaces, loras, setLoras,
  livePreview, setLivePreview, preview, gen, busy, onGenerate, onCancel,
}) {
  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));
  const [checkpoints, setCheckpoints] = useState([]);
  const [controlnets, setControlnets] = useState([]);
  const [ggufModels, setGgufModels] = useState([]);
  const [textEncoders, setTextEncoders] = useState([]);
  const [vaes, setVaes] = useState([]);
  const [swapModels, setSwapModels] = useState([]);
  const [faceRestoreModels, setFaceRestoreModels] = useState([]);
  const [loraOptions, setLoraOptions] = useState([]);

  useEffect(() => {
    listCheckpoints().then((c) => {
      setCheckpoints(c);
      if (c.length && !settings.checkpoint) set('checkpoint', c[0]);
    });
    listControlnets().then(setControlnets);
    listGgufModels().then((m) => {
      setGgufModels(m);
      // this pipeline is Krea-2-only; plain m[0] can land on a video GGUF
      // (e.g. an LTX file sorting first) and crash sampling with a
      // text-embedding size mismatch
      if (m.length && !settings.ggufModel) set('ggufModel', pickDefault(m, /krea/i));
    });
    listTextEncoders().then((t) => {
      setTextEncoders(t);
      if (t.length && !settings.textEncoder) set('textEncoder', pickDefault(t, /qwen3vl_4b/i));
    });
    listVaes().then((v) => {
      setVaes(v);
      // re-pick when unset OR the saved value is no longer offered (e.g. an
      // audio VAE picked before /api/vaes filtered those out)
      if (v.length && (!settings.vae || !v.includes(settings.vae))) set('vae', pickDefault(v, /qwen_image_vae/i));
    });
    listFaceSwapModels().then(({ swapModels, faceRestoreModels }) => {
      setSwapModels(swapModels);
      setFaceRestoreModels(faceRestoreModels);
      if (swapModels.length && !settings.swapModel) set('swapModel', swapModels[0]);
    });
    listLoras().then(setLoraOptions);
  }, []);

  const usingCN = settings.controlnet && settings.controlnet !== 'none';
  const usingKrea = settings.backend === 'krea2';
  const usingFlux = settings.backend === 'flux3';

  return (
    <section className="panel gen">
      <h3>Sketch → Image</h3>
      <div className="hint">
        Draw the composition on the canvas; the prompt describes what it becomes.
        Lower denoise sticks closer to your sketch.
      </div>

      <label>Prompt</label>
      <textarea rows={3} value={settings.prompt} disabled={busy}
        placeholder="e.g. a lighthouse on a cliff at sunset, oil painting"
        onChange={(e) => set('prompt', e.target.value)} />

      {!usingKrea && !usingFlux && (
        <>
          <label>Negative prompt</label>
          <textarea rows={1} value={settings.negative} disabled={busy}
            onChange={(e) => set('negative', e.target.value)} />
        </>
      )}

      <label>Backend</label>
      <select value={settings.backend || 'sd'} disabled={busy}
        onChange={(e) => {
          const isKrea = e.target.value === 'krea2' || e.target.value === 'flux3';
          // Krea 2 is a turbo/distilled model — SD's cfg=7 default causes latent
          // divergence (solid black/broken output) on it. Reset to sane defaults
          // per backend, same pattern as the ControlNet switch below resetting denoise.
          // Krea 2's denoise default (0.4) is also lower than SD's (0.7) — confirmed
          // empirically that Krea 2's flow-matching schedule preserves less sketch
          // structure than SD does at the same numeric denoise.
          setSettings((s) => ({
            ...s, backend: e.target.value,
            cfg: isKrea ? 1.0 : 7.0, steps: isKrea ? 8 : 20, denoise: isKrea ? 0.4 : 0.7,
          }));
        }}>
        <option value="sd">SD / SDXL checkpoint</option>
        <option value="flux3">⚡ Flux 3 (fast — sketch becomes a reference)</option>
        <option value="krea2">Krea 2 (native, LoRA + face-swap)</option>
      </select>

      {usingFlux ? (
        <div className="hint">
          Flux 3 Klein reads your drawing as a reference image and re-renders it as described in the prompt
          (~5 s). Composition, layout and shapes follow the sketch; no denoise slider needed. Describe the
          material and style in the prompt ("photograph", "oil painting", "3D render"…). Models, LoRAs and
          the Cinema rig live in the Flux 3 Image Studio.
        </div>
      ) : usingKrea ? (
        <>
          <label>Model — GGUF or safetensors (from ComfyUI)</label>
          <select value={settings.ggufModel || ''} disabled={busy || !ggufModels.length}
            onChange={(e) => set('ggufModel', e.target.value)}>
            {!ggufModels.length && <option value="">— none found / ComfyUI offline —</option>}
            {ggufModels.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>

          <label>Text encoder</label>
          <select value={settings.textEncoder || ''} disabled={busy || !textEncoders.length}
            onChange={(e) => set('textEncoder', e.target.value)}>
            {!textEncoders.length && <option value="">— none found / ComfyUI offline —</option>}
            {textEncoders.map((t) => (
              <option key={t} value={t}>{t}{isBf16(t) ? ' (bf16)' : ' (fp8)'}</option>
            ))}
          </select>

          <label>VAE</label>
          <select value={settings.vae || ''} disabled={busy || !vaes.length}
            onChange={(e) => set('vae', e.target.value)}>
            {!vaes.length && <option value="">— none found / ComfyUI offline —</option>}
            {vaes.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>

          <label title="Optional prompt-adherence booster (ComfyUI-Krea2T-Enhancer). 0 = off.">
            Enhancer strength ({(settings.enhancerStrength ?? 0).toFixed(2)})
          </label>
          <input type="range" min={0} max={2} step={0.05} value={settings.enhancerStrength ?? 0}
            disabled={busy} onChange={(e) => set('enhancerStrength', +e.target.value)} />

          <label>Structure mode</label>
          <select value={settings.kreaStructureMode || 'img2img'} disabled={busy}
            onChange={(e) => set('kreaStructureMode', e.target.value)}>
            <option value="img2img">img2img (denoise knob)</option>
            <option value="reference">Vision reference (full denoise)</option>
            <option value="two_pass">Two-pass (compose, then refine)</option>
          </select>
          {settings.kreaStructureMode === 'reference' && (
            <div className="hint">Sketch is fed as a semantic reference through Krea 2's own vision-conditioning
              path — in practice this also inherits the sketch's rendering style onto the subject and doesn't
              lock framing precisely. The Denoise slider below is ignored in this mode (always runs at full
              denoise).</div>
          )}
          {settings.kreaStructureMode === 'img2img' && (
            <div className="hint">Sketch is noised and partially denoised — the Denoise slider below controls
              composition vs. realism, the same shared-knob trade-off as the SD path without ControlNet.</div>
          )}
          {settings.kreaStructureMode === 'two_pass' && (
            <>
              <div className="hint">Pass 1 uses the Denoise slider below (low, e.g. 0.4) to lock in composition
                — it'll look sketch-like. Pass 2 refines that result at Refine denoise (higher) to remove the
                sketchy look, using pass 1's shading/proportions as a starting point instead of bare linework.</div>
              <label>Refine denoise ({(settings.refineDenoise ?? 0.90).toFixed(2)})</label>
              <input type="range" min={0.3} max={0.9} step={0.05} value={settings.refineDenoise ?? 0.90}
                disabled={busy} onChange={(e) => set('refineDenoise', +e.target.value)} />
            </>
          )}

          <label title="Softens the sketch's crisp linework into gradients before it's encoded, so the sampler treats it as a compositional hint rather than literal content to preserve. 0 = off.">
            Sketch blur ({(settings.sketchBlur ?? 0).toFixed(1)}px)
          </label>
          <input type="range" min={0} max={12} step={0.5} value={settings.sketchBlur ?? 0}
            disabled={busy} onChange={(e) => set('sketchBlur', +e.target.value)} />

          <label className="checkbox-label">
            <input type="checkbox" checked={livePreview} onChange={(e) => setLivePreview(e.target.checked)} />
            ⚡ Live preview (low-res, auto-updates ~0.7s after you pause drawing)
          </label>
          {livePreview && (
            <div className="live-preview">
              {preview?.url ? (
                <img className="result" src={preview.url} alt="Live preview" />
              ) : (
                <div className="hint">Draw a stroke to see a preview.</div>
              )}
              {preview?.updating && <div className="hint">Updating…</div>}
            </div>
          )}
        </>
      ) : (
        <>
          <label>Model checkpoint (from ComfyUI)</label>
          <select value={settings.checkpoint || ''} disabled={busy || !checkpoints.length}
            onChange={(e) => set('checkpoint', e.target.value)}>
            {!checkpoints.length && <option value="">— none found / ComfyUI offline —</option>}
            {checkpoints.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>

          <label>Structure control</label>
          <select value={settings.controlnet || 'none'} disabled={busy}
            onChange={(e) => setSettings((s) => ({ ...s, controlnet: e.target.value, denoise: e.target.value !== 'none' ? 1.0 : 0.7 }))}>
            <option value="none">img2img (no ControlNet installed)</option>
            {controlnets.map((c) => <option key={c} value={c}>ControlNet: {c}</option>)}
          </select>
          {usingCN ? (
            <div className="hint">Sketch = structure, full denoise = full realism. Strength: how strictly lines are followed.</div>
          ) : (
            <div className="hint">No ControlNet: composition and realism share the denoise knob. For doodle → realistic, install a scribble ControlNet (e.g. MistoLine).</div>
          )}
          {usingCN && (
            <div className="grid2">
              <label>Control strength
                <input type="number" step={0.05} min={0.1} max={1.5} value={settings.cnStrength ?? 0.8} disabled={busy}
                  onChange={(e) => set('cnStrength', +e.target.value)} />
              </label>
              <label title="Stop the ControlNet after this fraction of steps. Composition locks in early — lower = much faster, ~0.5–0.6 is usually free.">
                Control end %
                <input type="number" step={0.05} min={0.2} max={1} value={settings.cnEnd ?? 0.6} disabled={busy}
                  onChange={(e) => set('cnEnd', +e.target.value)} />
              </label>
            </div>
          )}
        </>
      )}

      <div className="grid2">
        <label>Width
          <input type="number" step={64} min={256} max={1536} value={settings.width} disabled={busy}
            onChange={(e) => set('width', +e.target.value)}
            onBlur={(e) => set('width', snap64(+e.target.value))} />
        </label>
        <label>Height
          <input type="number" step={64} min={256} max={1536} value={settings.height} disabled={busy}
            onChange={(e) => set('height', +e.target.value)}
            onBlur={(e) => set('height', snap64(+e.target.value))} />
        </label>
        <label>Steps
          <input type="number" min={1} max={60} value={settings.steps} disabled={busy}
            onChange={(e) => set('steps', +e.target.value)} />
        </label>
        <label>CFG
          <input type="number" step={0.5} min={1} max={15} value={settings.cfg} disabled={busy}
            onChange={(e) => set('cfg', +e.target.value)} />
        </label>
        <label>Denoise
          <input type="number" step={0.05} min={0.1} max={1} value={settings.denoise} disabled={busy}
            onChange={(e) => set('denoise', +e.target.value)}
            onBlur={(e) => set('denoise', clampDenoise(+e.target.value))} />
        </label>
        <label>Seed (−1 = rnd)
          <input type="number" value={settings.seed} disabled={busy}
            onChange={(e) => set('seed', +e.target.value)} />
        </label>
      </div>

      {usingKrea && (
        <>
          <LoraRows loras={loras} setLoras={setLoras} loraOptions={loraOptions} busy={busy} />
          <FaceSwapRows
            faces={faces} setFaces={setFaces}
            swapModels={swapModels} faceRestoreModels={faceRestoreModels}
            swapModel={settings.swapModel} faceRestoreModel={settings.faceRestoreModel}
            onSwapModelChange={(v) => set('swapModel', v)}
            onFaceRestoreModelChange={(v) => set('faceRestoreModel', v)}
            busy={busy}
          />
        </>
      )}

      <button className="primary" onClick={onGenerate}
        disabled={busy || !settings.prompt.trim() || (usingKrea && (faces.some((f) => !f.file) || loras.some((l) => !l.name)))}>
        {busy ? 'Working…' : '🎨 Generate image'}
      </button>

      {(busy || gen.phase === 'done') && (
        <>
          <GenProgress progress={gen.progress} status={gen.status} onCancel={busy ? onCancel : undefined} cancelDisabled={!gen.jobId} running={busy} />
        </>
      )}
      {gen.phase === 'error' && <div className="error">{gen.error}</div>}
      {gen.imageUrl && (
        <>
          <img className="result" src={gen.imageUrl} alt="Generated result" />
          <a className="dl" href={gen.imageUrl} download="sketch_image.png">Download image</a>
        </>
      )}
    </section>
  );
}
