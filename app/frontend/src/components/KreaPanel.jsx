import GenProgress from './GenProgress.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { listGgufModels, listTextEncoders, listVaes, listFaceSwapModels, listLoras, describeVideo } from '../api.js';
import LoraRows from './LoraRows.jsx';
import FaceSwapRows from './FaceSwapRows.jsx';
import { pickDefault } from '../utils.js';

const snap64 = (n) => Math.max(256, Math.round(n / 64) * 64);
const isBf16 = (name) => /bf16|fp16/i.test(name);

export default function KreaPanel({
  settings, setSettings, moodboard, setMoodboard, faces, setFaces, loras, setLoras, gen, busy, onGenerate, onCancel,
}) {
  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));
  const [ggufModels, setGgufModels] = useState([]);
  const [textEncoders, setTextEncoders] = useState([]);
  const [vaes, setVaes] = useState([]);
  const [swapModels, setSwapModels] = useState([]);
  const [faceRestoreModels, setFaceRestoreModels] = useState([]);
  const [loraOptions, setLoraOptions] = useState([]);
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleError, setStyleError] = useState('');
  const styleVideoRef = useRef(null);

  /** Reference video -> aesthetic descriptors appended to the prompt, so the
   * subject stays yours and the video only contributes the look. */
  const analyzeStyleVideo = async (file) => {
    setStyleBusy(true);
    setStyleError('');
    try {
      const { style } = await describeVideo(file);
      setSettings((s) => ({
        ...s,
        prompt: s.prompt.trim()
          ? `${s.prompt.trim().replace(/,\s*$/, '')}, ${style}`
          : style,
      }));
    } catch (e) {
      setStyleError(`Video style analysis failed: ${e.message}`);
    } finally {
      setStyleBusy(false);
    }
  };

  useEffect(() => {
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

  const usingBf16 = isBf16(settings.textEncoder || '');

  const addMoodboardFiles = (fileList) => {
    setMoodboard((m) => [...m, ...Array.from(fileList)]);
  };
  const removeMoodboard = (i) => setMoodboard((m) => m.filter((_, idx) => idx !== i));

  return (
    <section className="panel gen">
      <h3>Krea 2</h3>
      <div className="hint">
        Native Krea 2 (Qwen3-VL text conditioning). Add moodboard references for
        style/subject guidance, and face-swap rows to pin specific faces onto
        specific people (0 = leftmost in the output).
      </div>

      <label>Prompt</label>
      <textarea rows={3} value={settings.prompt} disabled={busy}
        placeholder="e.g. two friends at a rooftop cafe at golden hour"
        onChange={(e) => set('prompt', e.target.value)} />
      <button disabled={busy || styleBusy}
        title="Pick a reference video (e.g. a music video) — samples frames, analyzes the color grade / lighting / lens / mood with the local vision model, and appends the style descriptors to the prompt"
        onClick={() => styleVideoRef.current?.click()}>
        {styleBusy ? '⏳ Analyzing video aesthetics…' : '🎞️ Style from reference video'}
      </button>
      <input ref={styleVideoRef} type="file" accept="video/*" hidden
        onChange={(e) => { if (e.target.files?.[0]) analyzeStyleVideo(e.target.files[0]); e.target.value = ''; }} />
      {styleError && <div className="error">{styleError}</div>}

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
          <option key={t} value={t}>{t}{isBf16(t) ? ' (supports moodboard)' : ' (text-only)'}</option>
        ))}
      </select>
      {moodboard.length > 0 && !usingBf16 && (
        <div className="error">
          Moodboard images need a bf16/fp16 text encoder — the FP8 one can't run the
          vision path. Pick a bf16 encoder above or remove the reference images.
        </div>
      )}

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
          <input type="number" step={0.1} min={0.5} max={15} value={settings.cfg} disabled={busy}
            onChange={(e) => set('cfg', +e.target.value)} />
        </label>
        <label>Seed (−1 = rnd)
          <input type="number" value={settings.seed} disabled={busy}
            onChange={(e) => set('seed', +e.target.value)} />
        </label>
      </div>

      <label>Moodboard references</label>
      <div className="hint">Unlimited reference images blended via Krea 2's own vision-conditioning path.</div>
      {moodboard.map((f, i) => (
        <div className="grid2" key={i}>
          <span>{f.name}</span>
          <button onClick={() => removeMoodboard(i)} disabled={busy}>Remove</button>
        </div>
      ))}
      <input type="file" accept="image/*" multiple disabled={busy}
        onChange={(e) => { if (e.target.files?.length) addMoodboardFiles(e.target.files); e.target.value = ''; }} />

      <LoraRows loras={loras} setLoras={setLoras} loraOptions={loraOptions} busy={busy} />

      <FaceSwapRows
        faces={faces} setFaces={setFaces}
        swapModels={swapModels} faceRestoreModels={faceRestoreModels}
        swapModel={settings.swapModel} faceRestoreModel={settings.faceRestoreModel}
        onSwapModelChange={(v) => set('swapModel', v)}
        onFaceRestoreModelChange={(v) => set('faceRestoreModel', v)}
        busy={busy}
      />

      <button className="primary" onClick={onGenerate}
        disabled={busy || !settings.prompt.trim() || faces.some((f) => !f.file) || loras.some((l) => !l.name)}>
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
          <a className="dl" href={gen.imageUrl} download="krea2_image.png">Download image</a>
        </>
      )}
    </section>
  );
}
