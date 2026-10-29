import React, { useRef, useState } from 'react';
import { AD_FORMATS, TONES } from '../adTemplates.js';

/** Ad Studio — product link / photo -> ad storyboard on the board. */
export default function AdStudio({ onCreate, characters = [] }) {
  const [presenter, setPresenter] = useState('');
  const [url, setUrl] = useState('');
  const [scrape, setScrape] = useState({ busy: false, error: '', data: null });
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [benefit, setBenefit] = useState('');
  const [problem, setProblem] = useState('');
  const [cta, setCta] = useState('Link in bio — go get yours.');
  const [format, setFormat] = useState('ugc');
  const [tone, setTone] = useState('energetic');
  const [aspect, setAspect] = useState('9:16');
  const [picked, setPicked] = useState([]);        // image URLs from the scrape
  const [uploads, setUploads] = useState([]);      // File[]
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);

  const fetchPage = async () => {
    setScrape({ busy: true, error: '', data: null });
    try {
      const fd = new FormData(); fd.append('url', url);
      const r = await fetch('/api/ads/scrape', { method: 'POST', body: fd });
      if (!r.ok) { let d = await r.text(); try { d = JSON.parse(d).detail || d; } catch {} throw new Error(d); }
      const d = await r.json();
      setScrape({ busy: false, error: '', data: d });
      setName((n) => n || d.title.split(/[|\-–—]/)[0].trim().slice(0, 60));
      setBrand((b) => b || d.brand);
      setBenefit((b) => b || (d.description.split(/(?<=[.!?])\s/)[0] || '').slice(0, 140));
      setPicked(d.images.slice(0, 1));
    } catch (e) { setScrape({ busy: false, error: e.message, data: null }); }
  };

  const togglePick = (u) => setPicked((p) => (p.includes(u) ? p.filter((x) => x !== u) : [...p, u].slice(0, 3)));

  const create = async () => {
    setBusy(true); setErr('');
    try {
      const blobs = [];
      for (const u of picked) {
        const r = await fetch(`/api/ads/image?u=${encodeURIComponent(u)}`);
        if (r.ok) blobs.push(await r.blob());
      }
      uploads.forEach((f) => blobs.push(f));
      if (!blobs.length) throw new Error('Add at least one product photo (pick one from the page or upload your own).');
      const p = { name: name.trim() || 'the product', brand, benefit: benefit.trim(), problem: problem.trim(), cta: cta.trim(), tone: TONES[tone] };
      const shots = AD_FORMATS[format].shots(p);
      await onCreate({ productBlobs: blobs, productName: p.name, shots, aspect, formatLabel: AD_FORMATS[format].label, presenterId: characters.some((c) => c.id === presenter) ? presenter : '' });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const F = AD_FORMATS[format];
  const shots = F.shots({ name: name || 'the product', brand, benefit, problem, cta, tone: TONES[tone] });
  const total = shots.reduce((t, x) => t + (x.seconds || 0), 0);
  const ASPECTS = [['9:16', 'Reels / Shorts'], ['16:9', 'YouTube'], ['1:1', 'Square post'], ['4:5', 'Insta feed']];
  return (
    <div className="edit-studio ad-studio ad2">
      <div className="ad-main">
        <div className="ad-source">
          <div className="ad-url">
            <span>🔗</span>
            <input placeholder="https://… product page (optional)" value={url} onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && url.trim() && fetchPage()} />
            <button disabled={!url.trim() || scrape.busy} onClick={fetchPage}>{scrape.busy ? '⏳ Fetching…' : 'Fetch assets'}</button>
          </div>
          <button className="ad-upload" onClick={() => fileRef.current?.click()}>＋ Upload product photo(s)<small>{uploads.length ? `${uploads.length} uploaded` : 'clean photo, plain background'}</small></button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { const added = [...e.target.files]; setUploads((u) => [...u, ...added]); e.target.value = ''; }} />
        </div>
        {scrape.error && <div className="error">{scrape.error}</div>}
        {scrape.data && <div className="hint">{scrape.data.title}{scrape.data.price ? ` · ${scrape.data.price}` : ''}</div>}
        {scrape.data?.images?.length > 0 && (
          <>
            <div className="ad-sec">Product photos from the page <small>pick up to 3, the first is the hero</small></div>
            <div className="ad-grid">
              {scrape.data.images.map((u) => (
                <button key={u} className={`ad-img ${picked.includes(u) ? 'on' : ''}`} onClick={() => togglePick(u)}>
                  <img src={`/api/ads/image?u=${encodeURIComponent(u)}`} alt="" loading="lazy" />
                  {picked.includes(u) && <span className="badge">{picked.indexOf(u) + 1}</span>}
                </button>
              ))}
            </div>
          </>
        )}

        <section className="ad-card">
          <header><h3>Product &amp; narrative parameters</h3><span>Ad Studio · product link → storyboard</span></header>
          <div className="ad-form">
            <label>Product name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. AeroBrew pour-over kettle" /></label>
            <label>Brand<input value={brand} onChange={(e) => setBrand(e.target.value)} /></label>
            <label>Main benefit (spoken in the ad)<input value={benefit} onChange={(e) => setBenefit(e.target.value)} placeholder="Makes café-quality coffee in two minutes." /></label>
            <label>Problem it solves (UGC)<input value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="Mornings were chaos without it." /></label>
            <label>Call to action<input value={cta} onChange={(e) => setCta(e.target.value)} /></label>
            <label>Tone &amp; delivery<select value={tone} onChange={(e) => setTone(e.target.value)}>{Object.entries(TONES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
          </div>
        </section>

        <div className="ad-sec">Commercial format archetype <small>Formula: Hook → Problem → Demo → Result → CTA</small></div>
        <div className="ad-formats">
          {Object.entries(AD_FORMATS).map(([k, v]) => (
            <button key={k} className={format === k ? 'on' : ''} onClick={() => setFormat(k)}>
              <b>{v.label}</b><small>{(v.blurb || '').split(/[.:]/)[0]}</small>
            </button>
          ))}
        </div>

        <section className="ad-card">
          <header><h3>Generated {shots.length}-shot storyboard flow</h3><span className="ad-total">Total: {total}s</span></header>
          <div className="ad-flow">
            {shots.map((sh, i) => (
              <div key={i} className="ad-shot">
                <div className="ad-n">{i + 1}</div>
                <div className="ad-sb">
                  <div className="ad-st"><b>{sh.title}</b><span>{sh.seconds}s</span></div>
                  {sh.dialogue && <div className="ad-dlg">“{sh.dialogue}”</div>}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <aside className="ad-insp">
        <h3>Directing inspector</h3>
        <div className="es-body">
          <div className="ad-sec" style={{ margin: 0 }}>Target aspect ratio</div>
          <div className="ad-ratios">
            {ASPECTS.map(([a, label]) => (
              <button key={a} className={aspect === a ? 'on' : ''} onClick={() => setAspect(a)}><b>{a}</b><small>{label}</small></button>
            ))}
          </div>
          {characters.length > 0 && (
            <>
              <div className="ad-sec" style={{ margin: '14px 0 6px' }}>Presenter <small>one of your characters in every shot. Make a character sheet first for the best result.</small></div>
              <div className="ad-ratios">
                <button className={!presenter ? 'on' : ''} onClick={() => setPresenter('')}><b>Anyone</b><small>generic</small></button>
                {characters.map((c) => (
                  <button key={c.id} className={presenter === c.id ? 'on' : ''} onClick={() => setPresenter(c.id)} title={c.meta?.name || c.name}>
                    <b>{(c.meta?.name || c.name).slice(0, 14)}</b><small>{(c.meta?.refIds || []).length} views</small>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="ad-sum">
            <div><span>Format</span><b>{F.label}</b></div>
            <div><span>Shots</span><b>{shots.length}</b></div>
            <div><span>Total length</span><b>{total}s</b></div>
            <div><span>Product photos</span><b>{picked.length + uploads.length || 'none yet'}</b></div>
          </div>
          <div className="hint">{F.blurb}</div>
        </div>
        <div className="es-foot">
          <button className="primary" disabled={busy} onClick={create}>{busy ? 'Building…' : '✨ Create storyboard on the board'}</button>
          <div className="hint">Each shot lands on the board as a scene: open it to generate the still (Flux 3 composes your product photo into the scene) and the video clip.</div>
          {err && <div className="error">{err}</div>}
        </div>
      </aside>
    </div>
  );
}
