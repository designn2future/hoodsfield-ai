import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../settings.css';

const jget = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText); return r.json(); };
const jsend = async (url, method, body) => {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return j;
};
const copy = (t) => { try { navigator.clipboard?.writeText(t); } catch { /* clipboard blocked */ } };

/** Open a page of the app from anywhere (Settings buttons, the Assistant, the setup banner). */
export const openPage = (page, section) => window.dispatchEvent(new CustomEvent('hf:open', { detail: { page, section } }));

function Toggle({ on, onChange, label, help }) {
  return (
    <label className="st-row st-toggle">
      <input type="checkbox" checked={!!on} onChange={(e) => onChange(e.target.checked)} />
      <span><b>{label}</b>{help && <small>{help}</small>}</span>
    </label>
  );
}

function Field({ f, value, onChange, extra }) {
  const kind = f.kind;
  const id = `st-${f.key}`;
  let input;
  if (kind === 'bool') return <Toggle on={value} onChange={onChange} label={f.label} help={f.help} />;
  if (kind.startsWith('select:')) {
    const opts = kind.slice(7).split('|');
    input = <select id={id} value={value ?? f.default} onChange={(e) => onChange(e.target.value)}>{opts.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
  } else if (kind === 'lines') {
    input = <textarea id={id} rows={2} value={value ?? ''} placeholder="one folder per line" onChange={(e) => onChange(e.target.value)} />;
  } else if (kind === 'int' || kind === 'float') {
    input = <input id={id} type="number" step={kind === 'int' ? 1 : 0.5} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  } else if (f.secret) {
    input = (
      <div className="st-inline">
        <input id={id} type="password" autoComplete="off" placeholder={f.secret_set ? 'saved on this PC, type to replace' : 'sk-ant-…'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        {f.secret_set && <button type="button" onClick={() => onChange('__clear__')}>Remove</button>}
      </div>
    );
  } else {
    input = <input id={id} type="text" spellCheck={false} value={value ?? ''} placeholder={String(f.default || '')} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className="st-row">
      <label htmlFor={id}><b>{f.label}</b>{f.help && <small>{f.help}</small>}</label>
      <div className="st-ctl">{input}{extra}</div>
    </div>
  );
}

const DOT = { ok: '#3ddc97', warn: '#ffb020', fail: '#ff5c5c', info: '#8b93a3' };

export default function SettingsPage({ active }) {
  const [data, setData] = useState(null);
  const local = data ? data.local !== false : true;
  const [draft, setDraft] = useState({});
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [restartKeys, setRestartKeys] = useState([]);
  const [claude, setClaude] = useState(null);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [health, setHealth] = useState(null);
  const [checking, setChecking] = useState(false);
  const [gpu, setGpu] = useState(null);
  const [skill, setSkill] = useState(null);
  const [remote, setRemote] = useState({ set: false, user: '' });
  const [rp, setRp] = useState({ user: '', pw: '', pw2: '' });
  const [diag, setDiag] = useState('');
  const [waiting, setWaiting] = useState(false);
  const root = useRef(null);
  const poll = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await jget('/api/settings');
      setData(d); setRestartKeys(d.restart_needed || []); setErr('');
    } catch (e) { setErr(e.message); }
  }, []);
  const loadClaude = useCallback(async (force = 0) => { try { setClaude(await jget(`/api/claude/status?force=${force}`)); } catch (e) { setClaude({ error: e.message }); } }, []);
  const loadGpu = useCallback(async () => { try { setGpu(await jget('/api/gpu/profile')); } catch { /* ComfyUI offline */ } }, []);
  const runCheck = useCallback(async () => {
    setChecking(true);
    try { setHealth(await jget('/api/health/check')); try { localStorage.setItem('hf_setup_seen', '1'); } catch { /* storage blocked */ } } catch (e) { setErr(e.message); }
    setChecking(false);
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    load(); loadClaude(0); loadGpu();
    jget('/api/settings/skill').then(setSkill).catch(() => {});
    jget('/api/settings/remote_password').then(setRemote).catch(() => {});
    return undefined;
  }, [active, load, loadClaude, loadGpu]);

  useEffect(() => {
    const h = (e) => { const el = root.current?.querySelector(`[data-sec="${e.detail}"]`); el?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    window.addEventListener('hf:settings-section', h);
    return () => window.removeEventListener('hf:settings-section', h);
  }, []);
  useEffect(() => () => clearInterval(poll.current), []);

  const fields = useMemo(() => Object.fromEntries((data?.fields || []).map((f) => [f.key, f])), [data]);
  const val = (k) => (k in draft ? draft[k] : fields[k]?.value);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = Object.keys(draft).length > 0;
  const F = (k, extra) => (fields[k] ? <Field key={k} f={fields[k]} value={val(k)} onChange={(v) => set(k, v)} extra={extra} /> : null);

  const save = async () => {
    setSaving(true); setErr(''); setMsg('');
    try {
      const r = await jsend('/api/settings', 'PUT', { values: draft });
      setDraft({}); setRestartKeys(r.restart_needed || []); setData((d) => ({ ...d, fields: r.fields }));
      setMsg(r.changed.length ? 'Saved.' + (r.restart ? ' Some changes apply after a restart.' : ' Applied now.') : 'Nothing changed.');
      loadClaude(1); loadGpu();
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  const restart = async () => {
    setErr('');
    try { await jsend('/api/system/restart', 'POST'); } catch (e) { setErr(e.message); return; }
    setWaiting(true);
    let tries = 0;
    clearInterval(poll.current);
    poll.current = setInterval(async () => {
      tries += 1;
      try { const r = await fetch('/api/health', { cache: 'no-store' }); if (r.ok && tries > 3) { clearInterval(poll.current); window.location.reload(); } } catch { /* still restarting */ }
      if (tries > 90) { clearInterval(poll.current); setWaiting(false); setErr('The studio did not come back. Start it again with Start_Hoodsfield.bat.'); }
    }, 2000);
  };

  const signIn = async () => {
    setErr('');
    try { await jsend('/api/claude/login', 'POST'); } catch (e) { setErr(e.message); return; }
    setMsg('A sign-in window opened. Finish signing in with your browser, then come back here.');
    let n = 0;
    clearInterval(poll.current);
    poll.current = setInterval(async () => {
      n += 1;
      try { const s = await jget('/api/claude/status?force=1'); setClaude(s); if (s.ready) { clearInterval(poll.current); setMsg('Connected.'); } } catch { /* retry */ }
      if (n > 60) clearInterval(poll.current);
    }, 3000);
  };
  const runTest = async () => {
    setTesting(true); setTest(null);
    try { setTest(await jsend('/api/claude/test', 'POST', { model: val('claude_model') })); } catch (e) { setTest({ ok: false, error: e.message }); }
    setTesting(false);
  };
  const signOut = async () => { try { await jsend('/api/claude/logout', 'POST'); } catch (e) { setErr(e.message); } loadClaude(1); setTest(null); };
  const detect = async () => { try { const r = await jget('/api/settings/detect_comfy'); if (r.path) set('comfy_root', r.path); else setErr('No ComfyUI folder found in the usual places. Type its path.'); } catch (e) { setErr(e.message); } };
  const installSkill = async () => { try { await jsend('/api/settings/skill', 'POST'); setSkill(await jget('/api/settings/skill')); setMsg('Skill installed for Claude Code.'); } catch (e) { setErr(e.message); } };
  const setRemotePw = async () => {
    if (rp.pw !== rp.pw2) { setErr('The two passwords do not match.'); return; }
    try { await jsend('/api/settings/remote_password', 'POST', { user: rp.user, password: rp.pw }); setRemote({ set: true, user: rp.user }); setRp({ user: '', pw: '', pw2: '' }); setMsg('Remote-access login saved.'); setErr(''); } catch (e) { setErr(e.message); }
  };
  const getDiag = async () => { try { const d = await jget('/api/diagnostics'); setDiag(d.text); copy(d.text); setMsg('Diagnostics copied to the clipboard.'); } catch (e) { setErr(e.message); } };

  const cs = claude || {};
  const apiMode = (val('claude_auth') || 'login') === 'api_key';
  let cstate = 'loading';
  if (claude) cstate = cs.error ? 'error' : !cs.installed ? 'missing' : cs.ready ? 'ready' : 'signedout';

  return (
    <div className="st-page" ref={root}>
      <div className="st-head">
        <div>
          <h2>⚙️ Settings</h2>
          <p>Everything you need to set up Hoodsfield lives here. Changes are saved on this PC.</p>
        </div>
        <div className="st-head-btns">
          <button onClick={getDiag} title="Copies a short report (versions, GPU, checks) you can paste into a bug report. No secrets.">Copy diagnostics</button>
          <span className="st-ver">v{data?.version || ''}</span>
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      {msg && !err && <div className="st-ok">{msg}</div>}
      {diag && <pre className="st-diag">{diag}</pre>}
      {!local && <div className="st-note">You are connected from another device. Sign-in, folders and passwords can only be changed on the PC itself.</div>}

      <nav className="st-nav">
        {[['claude', 'Claude'], ['check', 'Setup check'], ['comfy', 'ComfyUI & folders'], ['gpu', 'Graphics card'], ['llm', 'Local AI'], ['coach', 'H3 prompt coach'], ['remote', 'Remote access'], ['safety', 'Safety']].map(([id, t]) => (
          <button key={id} onClick={() => root.current?.querySelector(`[data-sec="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{t}</button>
        ))}
      </nav>

      {/* ---------------------------------------------------------------- Claude */}
      <section className="st-card" data-sec="claude">
        <h3>🤖 Claude</h3>
        <p className="st-lead">The <b>Assistant</b> (idea in, finished video out) and agent control use your own Claude account through the free Claude Code app. Everything else in Hoodsfield runs on your PC without any account, and Lite mode works with a local model if you skip this.</p>

        <div className={`st-status ${cstate}`}>
          <i />
          <div>
            {cstate === 'loading' && <b>Checking…</b>}
            {cstate === 'error' && <><b>Could not check</b><span>{cs.error}</span></>}
            {cstate === 'missing' && <><b>Claude Code is not installed</b><span>Hoodsfield could not find it on this PC.</span></>}
            {cstate === 'signedout' && <><b>{apiMode ? 'No API key saved' : 'Installed, but not signed in'}</b><span>{cs.version} · {apiMode ? 'paste a key below' : 'sign in with your Claude account to continue.'}</span></>}
            {cstate === 'ready' && <><b>Connected{cs.account ? ` as ${cs.account}` : ''}</b><span>{[cs.method, cs.plan && `plan: ${cs.plan}`, cs.version].filter(Boolean).join(' · ')}</span></>}
          </div>
          <button onClick={() => loadClaude(1)}>↻ Check again</button>
        </div>

        {cstate === 'missing' && (
          <div className="st-steps">
            <p><b>Install it in one step</b> (needs Node.js 18+, which Hoodsfield also uses). Open a terminal, paste, press Enter:</p>
            <div className="st-cmd"><code>{cs.install?.npm || 'npm install -g @anthropic-ai/claude-code'}</code><button onClick={() => copy(cs.install?.npm || 'npm install -g @anthropic-ai/claude-code')}>Copy</button></div>
            <p className="st-or">or, without Node, in PowerShell:</p>
            <div className="st-cmd"><code>{cs.install?.windows || 'irm https://claude.ai/install.ps1 | iex'}</code><button onClick={() => copy(cs.install?.windows || 'irm https://claude.ai/install.ps1 | iex')}>Copy</button></div>
            <p>Then click <b>Check again</b>. <a href={cs.install?.docs || 'https://docs.claude.com/en/docs/claude-code/setup'} target="_blank" rel="noreferrer">Full instructions ↗</a></p>
          </div>
        )}

        {cstate === 'signedout' && !apiMode && (
          <div className="st-steps">
            <button className="st-cta" disabled={!local} onClick={signIn}>Sign in with your Claude account</button>
            <p className="st-hint">A window opens and your browser asks you to approve. You need a Claude subscription (Pro or Max) or an Anthropic Console account.</p>
          </div>
        )}

        {cstate === 'ready' && (
          <div className="st-actions">
            <button disabled={testing} onClick={runTest}>{testing ? 'Testing…' : '▶ Test the connection'}</button>
            {!apiMode && <button disabled={!local} onClick={signOut}>Sign out</button>}
            {test && (test.ok
              ? <span className="st-pass">✔ Claude answered in {test.seconds}s ({test.model}). The Assistant is ready.</span>
              : <span className="st-fail">✖ {test.error}</span>)}
          </div>
        )}

        <div className="st-grid">
          {F('claude_auth')}
          {F('claude_model')}
          {apiMode && F('claude_api_key')}
        </div>
        <details className="st-adv"><summary>Advanced</summary>{F('claude_bin')}</details>
        <p className="st-hint">Using your own login means no API key sits on this PC and usage counts against your Claude plan, not a separate bill. The Assistant can only use Hoodsfield's tools and read files; it cannot run commands or edit files.</p>
      </section>

      {/* ---------------------------------------------------------------- health check */}
      <section className="st-card" data-sec="check">
        <h3>✅ Setup check</h3>
        <p className="st-lead">Tests ComfyUI, folders, the nodes and models each feature needs, your graphics card, memory, disk space, ffmpeg, Claude and the local AI.</p>
        <div className="st-actions"><button className="st-cta" disabled={checking} onClick={runCheck}>{checking ? 'Checking…' : health ? '↻ Run the check again' : 'Run the setup check'}</button>
          {health && <span className={health.ok ? 'st-pass' : 'st-fail'}>{health.summary.ok} OK · {health.summary.warn} to look at · {health.summary.fail} problem{health.summary.fail === 1 ? '' : 's'}</span>}</div>
        {health && (
          <ul className="st-checks">
            {health.checks.map((c) => (
              <li key={c.id}>
                <i style={{ background: DOT[c.status] }} title={c.status} />
                <div>
                  <b>{c.title}</b><span>{c.detail}</span>
                  {c.fix && <em>{c.fix}</em>}
                </div>
                {c.action === 'models' && <button onClick={() => openPage('models')}>Model manager</button>}
                {['claude', 'comfy', 'gpu', 'storage', 'llm'].includes(c.action) && <button onClick={() => root.current?.querySelector(`[data-sec="${c.action === 'storage' ? 'comfy' : c.action}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Open</button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------------- ComfyUI and folders */}
      <section className="st-card" data-sec="comfy">
        <h3>🧩 ComfyUI & folders</h3>
        {F('comfy_url')}
        {F('comfy_root', <button type="button" disabled={!local} onClick={detect}>Detect</button>)}
        {F('extra_model_dirs')}
        {F('comfy_launch_args')}
        {F('comfy_watchdog')}
        <h4>Storage</h4>
        {F('work_dir')}
        {F('output_dir')}
      </section>

      {/* ---------------------------------------------------------------- GPU */}
      <section className="st-card" data-sec="gpu">
        <h3>🎛️ Graphics card</h3>
        <p className="st-lead">
          {gpu?.gpu?.reachable
            ? <>Detected <b>{gpu.gpu.name}</b> with <b>{gpu.gpu.vram_gb} GB</b>. Recommended: <b>{gpu.profiles[gpu.detected]?.label}</b>.</>
            : 'Start ComfyUI to detect your card. You can still pick a profile by hand.'}
        </p>
        {F('gpu_profile')}
        {F('h3_max_frames')}
        {gpu && (
          <table className="st-prof">
            <thead><tr><th></th><th>Draft (new scenes)</th><th>Final shots</th><th>Longest clip</th></tr></thead>
            <tbody>
              {Object.entries(gpu.profiles).map(([k, p]) => (
                <tr key={k} className={k === gpu.active ? 'on' : ''}>
                  <td>{p.label}{k === gpu.detected ? ' ★' : ''}</td>
                  <td>{p.draft_preset} · {p.draft_mp} MP</td><td>{p.final_preset} · {p.final_mp} MP</td><td>{(p.h3_max_frames / 24).toFixed(1)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="st-hint">New scenes start with the draft values. For the shot you keep, switch it to Quality and the final size. The clip-length limit applies after a restart.</p>
        {gpu?.gpu?.reachable && gpu.setting !== gpu.detected && <div className="st-actions"><button onClick={() => set('gpu_profile', gpu.detected)}>Use the recommended profile ({gpu.profiles[gpu.detected]?.label})</button></div>}
      </section>

      {/* ---------------------------------------------------------------- local LLM */}
      <section className="st-card" data-sec="llm">
        <h3>🧠 Local AI (optional)</h3>
        <p className="st-lead">Ollama runs small language models on your PC for Lite mode, the AI director and image descriptions. Install it from ollama.com, then pull a model such as <code>qwen2.5:14b-instruct</code>.</p>
        {F('ollama_url')}{F('ollama_text_model')}{F('ollama_vision_model')}{F('lite_model')}
      </section>

      {/* ---------------------------------------------------------------- coach */}
      <section className="st-card" data-sec="coach">
        <h3>🎯 H3 prompt coach</h3>
        <p className="st-lead">MiniMax H3 makes picture and sound in one pass, so prompts work best as short production briefs. The coach keeps your words and adds camera, physics, audio and constraint lines. You can preview exactly what it adds next to the H3 prompt box.</p>
        {F('h3_coach')}{F('h3_coach_llm')}
        <div className="st-row">
          <label><b>Claude Code skill</b><small>Teaches Claude Code the same H3 prompting rules, so any agent session writes better H3 prompts.</small></label>
          <div className="st-ctl">
            {skill?.installed ? <span className="st-pass">✔ installed</span> : <button disabled={!local || !skill?.available} onClick={installSkill}>Install the skill</button>}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- remote */}
      <section className="st-card" data-sec="remote">
        <h3>🌐 Remote access</h3>
        <p className="st-lead">Off unless you start a tunnel with Remote_Access.bat. Phones and PCs on your own network are trusted; anything coming through the internet must sign in with this login.</p>
        <p className="st-hint">{remote.set ? `A login is set (user “${remote.user}”).` : 'No login set yet. Remote access stays locked until you set one.'}</p>
        <div className="st-grid">
          <input placeholder="username" value={rp.user} onChange={(e) => setRp({ ...rp, user: e.target.value })} disabled={!local} />
          <input type="password" autoComplete="new-password" placeholder="password (10+ characters)" value={rp.pw} onChange={(e) => setRp({ ...rp, pw: e.target.value })} disabled={!local} />
          <input type="password" autoComplete="new-password" placeholder="repeat password" value={rp.pw2} onChange={(e) => setRp({ ...rp, pw2: e.target.value })} disabled={!local} />
          <button disabled={!local || !rp.user || rp.pw.length < 10} onClick={setRemotePw}>{remote.set ? 'Change login' : 'Set login'}</button>
        </div>
      </section>

      {/* ---------------------------------------------------------------- safety */}
      <section className="st-card" data-sec="safety">
        <h3>🛡️ Safety</h3>
        {F('guard')}
        <details className="st-adv"><summary>Memory thresholds</summary>{F('guard_soft_gb')}{F('guard_gate_gb')}{F('guard_hard_gb')}</details>
      </section>

      <section className="st-card st-about">
        <h3>About</h3>
        <p>Hoodsfield is open source under the Apache-2.0 licence. It drives your own ComfyUI; model weights and ComfyUI nodes keep their own licences.</p>
        <p><a href="https://github.com/designn2future/hoodsfield-ai" target="_blank" rel="noreferrer">github.com/designn2future/hoodsfield-ai ↗</a> · settings file: <code>{data?.file}</code></p>
      </section>

      <div className={`st-bar ${dirty || restartKeys.length ? 'show' : ''}`}>
        {restartKeys.length > 0 && !dirty && <span className="st-restart">Some saved changes apply after a restart.</span>}
        {dirty && <span>{Object.keys(draft).length} unsaved change{Object.keys(draft).length === 1 ? '' : 's'}</span>}
        <span className="spacer" />
        {restartKeys.length > 0 && !dirty && <button disabled={!local || waiting} onClick={restart}>{waiting ? 'Restarting…' : '↻ Restart the studio'}</button>}
        {dirty && <button onClick={() => setDraft({})}>Discard</button>}
        {dirty && <button className="st-cta" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>}
      </div>
    </div>
  );
}
