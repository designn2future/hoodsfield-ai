import React, { useEffect, useState } from 'react';
import { useGenre } from '../genreStore.js';
import { VOICE_BEDS, chaosAnalyze, chaosPlan, chaosCut, makeVoiceBed, makeAvatar, saveOutput } from '../chaosCut.js';

/** The fast, chaotic found-footage finish: trims every shot around its line and away from model glitches, accelerates the pace, escalates the camera shake,
 *  layers overlapping family voices, adds mic mishaps and builds the level to a climax. Needs finished clips (and, for the crowd, voice beds). */
export default function ChaosCutPanel({ order, assets, onAddAsset, onSetFinal }) {
  const [opts, setOpts] = useState({ profile: 'panic', pace: 'fast', crowd: 'a lot', flaws: 'a lot', ambience: 'car interior', auto_seed: 4, voice: '', exaggeration: 0.4 });
  const [voices, setVoices] = useState([]);
  const { genre } = useGenre();
  const LOOK_OF = { doorbell: 'doorbellcam', babycam: 'babycam', trailcam: 'trailcam', ugc: 'ugc', tiktok: 'tiktok' };
  const [scareAt, setScareAt] = useState(-1);
  useEffect(() => { fetch('/api/tts/voices').then((r) => (r.ok ? r.json() : null)).then((d) => d && setVoices(d.voices || [])).catch(() => {}); }, []);
  const setProfile = (p) => setOpts((o) => (p === 'vlog' || p === 'cam'
    ? { ...o, profile: p, pace: 'relaxed', crowd: 'off', flaws: 'off', ambience: 'none', auto_seed: 2 }
    : { ...o, profile: p, pace: 'fast', crowd: 'a lot', flaws: 'a lot', ambience: 'car interior', auto_seed: 4 }));
  const [plan, setPlan] = useState(null);
  const [clips, setClips] = useState([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [bedMsg, setBedMsg] = useState('');
  const [replyHeader, setReplyHeader] = useState('Reply to a comment');

  const scenes = order.filter((s) => s.videoAssetId && assets.find((a) => a.id === s.videoAssetId));
  const bedAssets = assets.filter((a) => a.meta?.voiceBed);
  const haveBeds = VOICE_BEDS.filter((b) => bedAssets.some((a) => a.meta.voiceBed === b.mood));
  const set = (k, v) => setOpts((o) => ({ ...o, [k]: v }));
  const avatarAsset = assets.filter((a) => a.meta?.avatar).slice(-1)[0];
  const hasReply = scenes.some((s) => /(^|\|\|)\s*reply:/i.test(s.caption || ''));

  const doAvatar = async () => {
    setBusy('avatar'); setMsg('Making a profile picture for the commenter…');
    try {
      const blob = await makeAvatar((ev) => { if (ev.type === 'progress' && ev.max) setMsg(`Commenter photo: sampling ${ev.value}/${ev.max}`); });
      onAddAsset(blob, 'image', 'comment avatar', { avatar: true });
      setMsg('Commenter photo ready — it will sit in the circle of the reply bubble.');
    } catch (e) { setMsg(e.message); } finally { setBusy(''); }
  };

  // drop a shot from the plan (its voice-over moves to the next shot so the line is not lost)
  const dropSeg = (i) => setPlan((p) => {
    const segs = p.segments.slice();
    const gone = segs.splice(i, 1)[0];
    if (gone?.narration && segs[i]) segs[i] = { ...segs[i], narration: `${gone.narration} ${segs[i].narration || ''}`.trim() };
    return { ...p, segments: segs };
  });

  const makeBeds = async () => {
    const still = assets.find((a) => a.id === order.find((s) => s.assetId)?.assetId);
    if (!still) { setBedMsg('Make at least one still first (the beds borrow its aspect).'); return; }
    setBusy('beds');
    try {
      for (const b of VOICE_BEDS) {
        if (bedAssets.some((a) => a.meta.voiceBed === b.mood)) continue;
        setBedMsg(`Generating the “${b.mood}” voices… (about 1½ min each)`);
        const blob = await makeVoiceBed(still.blob, b, (ev) => { if (ev.type === 'progress' && ev.max) setBedMsg(`“${b.mood}” voices: sampling ${ev.value}/${ev.max}`); });
        onAddAsset(blob, 'video', `voice bed · ${b.mood}`, { voiceBed: b.mood });
      }
      setBedMsg('All six voice beds are ready.');
    } catch (e) { setBedMsg(e.message); } finally { setBusy(''); }
  };

  const doPlan = async () => {
    setBusy('plan'); setMsg(''); setPlan(null);
    try {
      const blobs = scenes.map((s) => assets.find((a) => a.id === s.videoAssetId).blob);
      const analyses = [];
      for (let i = 0; i < blobs.length; i++) { setMsg(`Listening to and measuring clip ${i + 1}/${blobs.length}…`); analyses.push(await chaosAnalyze(blobs[i])); }
      const p = await chaosPlan(analyses, { ...opts, beats: scenes.map((s) => s.beat || ''), ...(LOOK_OF[genre.post] && opts.profile === 'cam' ? { look: LOOK_OF[genre.post] } : {}) });
      // shots whose Chaos slider was set keep the user's value
      p.segments = p.segments.map((sg) => ({ ...sg, ...(scenes[sg.clip]?.chaos != null ? { chaos: scenes[sg.clip].chaos / 100 } : {}), narration: scenes[sg.clip]?.narration || '', caption: scenes[sg.clip]?.caption || '' }));
      const glitches = analyses.map((a, i) => (a.glitch_at ? `${scenes[i].title || `shot ${i + 1}`}: model glitch at ${a.glitch_at}s (trimmed off)` : null)).filter(Boolean);
      setClips(blobs); setPlan(p);
      setMsg(`Planned ${p.segments.length} shots, ${p.total}s.${glitches.length ? ` ${glitches.join(' · ')}` : ''}`);
    } catch (e) { setMsg(e.message); } finally { setBusy(''); }
  };

  const patchSeg = (i, k, v) => setPlan((p) => ({ ...p, segments: p.segments.map((s, j) => (j === i ? { ...s, [k]: v } : s)) }));

  const doBuild = async () => {
    setBusy('build'); setMsg('Building the cut (trims, camera chaos, crowd, mic mishaps, loudness build) — about half a minute…');
    try {
      const beds = haveBeds.map((b) => ({ mood: b.mood, blob: bedAssets.find((a) => a.meta.voiceBed === b.mood).blob }));
      const p = { ...plan, flaws: opts.flaws, ambience: opts.ambience, auto_seed: +opts.auto_seed, voice: opts.voice, exaggeration: +opts.exaggeration, reply_header: replyHeader, scare_at: +scareAt };   // not `crowd`: the plan already holds the placed crowd beds
      const total = p.segments.reduce((a, s) => a + (+s.out - +s.in), 0);
      if (opts.crowd === 'off' || !beds.length) p.crowd = [];
      const r = await chaosCut({ ...p, total }, clips, beds, hasReply ? avatarAsset?.blob : null);
      const asset = onAddAsset(r.blob, 'video', 'chaos cut', { source: 'final', chaosCut: true, seed: r.seed });
      onSetFinal(asset.id);
      let saved = '';
      try { const sv = await saveOutput(r.blob, 'chaos_cut'); saved = ` Saved as a file: ${sv.path}`; } catch (e) { saved = ` (could not save a file: ${e.message})`; }
      setMsg(`Done: ${(+r.length).toFixed(1)}s, best of ${opts.auto_seed} audio takes (seed ${r.seed}${r.score ? `, ${r.score.drops} level drops` : ''}). It is now the final video below.${saved}`);
    } catch (e) { setMsg(e.message); } finally { setBusy(''); }
  };

  if (!scenes.length) return null;
  return (
    <div className="tk-fx chaos-panel">
      <h4 className="sd-h">🎞️ Chaos cut — fast, chaotic, real-feeling finish</h4>
      <div className="hint">Short shots that get shorter, trimmed around each spoken line and away from the video model’s glitchy last second; camera shake that follows each shot’s Chaos level; other people talking, then shouting, then screaming over the main line; muffled-mic moments and distortion; the level builds to the climax. It renders several random audio takes and keeps the cleanest.</div>
      <div className="grid2">
        <label>Style
          <select value={opts.profile} onChange={(e) => setProfile(e.target.value)}>
            <option value="panic">Panic — frantic, crowd screaming (car chase, UFO)</option>
            <option value="vlog">Vlog — calm, deadpan voice-over, one small event (apartment)</option>
            <option value="cam">Fixed camera — doorbell / security cam: locked-off, timestamps, quiet</option>
          </select>
        </label>
        <label>Pace
          <select value={opts.pace} onChange={(e) => set('pace', e.target.value)}>{['relaxed', 'fast', 'very fast'].map((o) => <option key={o}>{o}</option>)}</select>
        </label>
        <label>Crowd voices
          <select value={opts.crowd} onChange={(e) => set('crowd', e.target.value)}>{['off', 'some', 'a lot'].map((o) => <option key={o}>{o}</option>)}</select>
        </label>
        <label>Mic mishaps (covered mic, scrapes, wind, overload)
          <select value={opts.flaws} onChange={(e) => set('flaws', e.target.value)}>{['off', 'some', 'a lot'].map((o) => <option key={o}>{o}</option>)}</select>
        </label>
        <label>Ambience bed
          <select value={opts.ambience} onChange={(e) => set('ambience', e.target.value)}>{['car interior', 'wind', 'room tone', 'house at night', 'hospital hum', 'none'].map((o) => <option key={o}>{o}</option>)}</select>
        </label>
        <label>Narration voice (speaks each shot's voice-over line)
          <select value={opts.voice} onChange={(e) => set('voice', e.target.value)}>
            <option value="">— no narration —</option>
            {voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.source === 'yours' ? ' (yours)' : ''}</option>)}
          </select>
        </label>
        {opts.voice && <label>Voice expressiveness
          <input type="range" min={0.2} max={0.9} step={0.05} value={opts.exaggeration} onChange={(e) => set('exaggeration', +e.target.value)} />
          <audio controls src={`/api/tts/voices/${encodeURIComponent(opts.voice)}/audio`} style={{ height: 28, maxWidth: '100%' }} />
        </label>}
        <label title="A short audio sting (a swell, a held breath of silence, then a hit) at this second of the cut. -1 = none. Put it on the payoff.">Jump-scare sting at (seconds, -1 = none)
          <input type="number" step={0.5} min={-1} value={scareAt} onChange={(e) => setScareAt(e.target.value)} />
        </label>
        <label>Audio takes to try (keeps the best)
          <input type="number" min={1} max={8} value={opts.auto_seed} onChange={(e) => set('auto_seed', e.target.value)} />
        </label>
      </div>
      {opts.crowd !== 'off' && (
        <div className="row">
          <span className="hint">{haveBeds.length}/{VOICE_BEDS.length} voice beds ready</span>
          <button disabled={!!busy || haveBeds.length === VOICE_BEDS.length} onClick={makeBeds}>{busy === 'beds' ? '⏳ Generating…' : '🎙 Generate the voice beds'}</button>
          {bedMsg && <span className="hint">{bedMsg}</span>}
        </div>
      )}
      {hasReply && (
        <div className="row">
          <span className="hint">Reply bubble:</span>
          <input type="text" value={replyHeader} style={{ minWidth: 220 }} onChange={(e) => setReplyHeader(e.target.value)} title="The small grey line at the top of the bubble, e.g. “Reply to maddie.k's comment”" />
          {avatarAsset && <img src={avatarAsset.url} alt="" style={{ width: 34, height: 34, borderRadius: '50%', objectFit: 'cover' }} />}
          <button disabled={!!busy} onClick={doAvatar}>{busy === 'avatar' ? '⏳ Making…' : avatarAsset ? '🔄 New commenter photo' : '🧑 Make a commenter photo'}</button>
        </div>
      )}
      <div className="row">
        <button disabled={!!busy} onClick={doPlan}>{busy === 'plan' ? '⏳ Planning…' : '🧮 Plan the cut'}</button>
        {plan && <button className="primary" disabled={!!busy} onClick={doBuild}>{busy === 'build' ? '⏳ Building…' : '🎞️ Build the chaos cut'}</button>}
      </div>
      {plan && (
        <div className="produce-list">
          {plan.segments.map((s, i) => (
            <div key={i} className="edl-row">
              <span className="edl-t">{i + 1}.</span>
              <span className="edl-n">{scenes[s.clip]?.title || `shot ${s.clip + 1}`}</span>
              <label className="mini">in <input type="number" step={0.05} min={0} value={s.in} onChange={(e) => patchSeg(i, 'in', +e.target.value)} /></label>
              <label className="mini">out <input type="number" step={0.05} min={0} value={s.out} onChange={(e) => patchSeg(i, 'out', +e.target.value)} /></label>
              <label className="mini">chaos <input type="number" step={0.05} min={0} max={1} value={s.chaos} onChange={(e) => patchSeg(i, 'chaos', +e.target.value)} /></label>
              <label className="mini">gain dB <input type="number" step={0.5} value={s.gain} onChange={(e) => patchSeg(i, 'gain', +e.target.value)} /></label>
              <button className="xbtn" title="Drop this shot from the cut (its voice-over moves to the next shot)" onClick={() => dropSeg(i)}>✕ drop</button>
              <label className="mini wide">voice-over <input type="text" value={s.narration || ''} placeholder="(none)" onChange={(e) => patchSeg(i, 'narration', e.target.value)} /></label>
              <label className="mini wide">caption <input type="text" value={s.caption || ''} placeholder="(none; start with reply: for a comment bubble)" onChange={(e) => patchSeg(i, 'caption', e.target.value)} /></label>
            </div>
          ))}
        </div>
      )}
      {msg && <div className="hint">{msg}</div>}
    </div>
  );
}
