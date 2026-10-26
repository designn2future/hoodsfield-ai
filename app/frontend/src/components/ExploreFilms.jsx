import React, { useEffect, useRef, useState } from 'react';
import '../films.css';

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** "Hoodsfield Originals": finished, titled short films made with this app, plus a shot-by-shot breakdown to remix. */
export default function ExploreFilms({ active, onRecreateShot, onRecreateFilm }) {
  const [films, setFilms] = useState([]);
  const [wip, setWip] = useState([]);
  const [idx, setIdx] = useState(0);
  const [open, setOpen] = useState(null);     // film being watched
  const [tab, setTab] = useState('shots');
  const vid = useRef(null);

  useEffect(() => {
    // re-read every time the page is opened, so films that finished while the app was open appear without a hard refresh
    const q = `?t=${Date.now()}`;
    fetch(`/showcase/films.json${q}`).then((r) => (r.ok ? r.json() : [])).then((a) => Array.isArray(a) && setFilms(a)).catch(() => {});
    fetch(`/showcase/films_wip.json${q}`).then((r) => (r.ok ? r.json() : [])).then((a) => Array.isArray(a) && setWip(a)).catch(() => {});
  }, [active]);
  useEffect(() => {
    if (films.length + wip.length < 2 || open) return undefined;
    const t = setInterval(() => setIdx((i) => (i + 1) % Math.max(1, films.length + wip.length)), 9000);
    return () => clearInterval(t);
  }, [films.length, wip.length, open]);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // finished films win; films still rendering show as "in production" with their key art and shot list
  const done = new Set(films.map((x) => x.id));
  const pending = wip.filter((w) => !done.has(w.id)).map((w) => ({ ...w, poster: w.art, video: null, seconds: 0, inProd: true }));
  const all = [...films, ...pending];
  if (!all.length) return null;
  const f = all[Math.min(idx, all.length - 1)];
  const vertical = f.aspect === '9:16';

  return (
    <section className="fx">
      <div className="fx-head"><span className="eyebrow">Hoodsfield Originals</span><span className="fx-sub">Finished short films, made start to finish on this machine</span></div>
      <div className="fx-hero" key={f.id}>
        <div className="fx-bg" style={{ backgroundImage: `url(/showcase/${f.poster})` }} />
        <div className="fx-copy">
          <span className="fx-badge">{f.inProd ? 'IN PRODUCTION' : 'HOODSFIELD · ORIGINAL'}</span>
          <h2>{f.title}</h2>
          <p>{f.tagline}</p>
          <div className="fx-meta"><span>{f.genre}</span>{!f.inProd && <span>{fmt(f.seconds)}</span>}<span>{f.aspect}</span><span>{f.shots.length} shots</span></div>
          {f.inProd && <div className="fx-prog"><div style={{ width: `${(f.rendered / f.shots.length) * 100}%` }} /><span>{f.rendered} of {f.shots.length} shots rendered locally. Playback unlocks when the cut is finished.</span></div>}
          <div className="fx-cta">
            <button className="fx-watch" onClick={() => { setOpen(f); setTab('shots'); }}>{f.inProd ? '☰ Shot list & notes' : '▶ Watch & explore'}</button>
            <button className="fx-ghost" onClick={() => onRecreateFilm(f)}>✦ Make my own version</button>
          </div>
          <div className="fx-dots">
            {all.map((x, i) => (
              <button key={x.id} className={i === idx ? 'on' : ''} onClick={() => setIdx(i)}>{x.title}</button>
            ))}
          </div>
        </div>
        <button className={`fx-phone ${vertical ? '' : 'wide'}`} onClick={() => { setOpen(f); setTab('shots'); }} aria-label={`Watch ${f.title}`}>
          {f.video
            ? <video src={`/showcase/${f.video}`} poster={`/showcase/${f.poster}`} muted loop autoPlay playsInline />
            : <img src={`/showcase/${f.poster}`} alt="" />}
          <span className="fx-play">{f.inProd ? '⏳' : '▶'}</span>
        </button>
      </div>

      {open && (
        <div className="xp-modal" onClick={() => setOpen(null)}>
          <div className="xp-sheet fx-sheet" style={{ '--h': 190 }} onClick={(e) => e.stopPropagation()}>
            <button className="xp-x" onClick={() => setOpen(null)} aria-label="Close">✕</button>
            <div className="xp-stage fx-stage">
              {open.video
                ? <video ref={vid} key={open.id} src={`/showcase/${open.video}`} poster={`/showcase/${open.poster}`} controls autoPlay loop playsInline />
                : <div className="fx-wipart"><img src={`/showcase/${open.poster}`} alt="" /><span>In production · {open.rendered}/{open.shots.length} shots</span></div>}
            </div>
            <div className="xp-side">
              <div className="xp-badges"><span className="xp-chip">{open.genre}</span><span className="xp-chip dim">{open.inProd ? 'in production' : `${fmt(open.seconds)} · ${open.aspect}`}</span></div>
              <h2>{open.title}</h2>
              <p className="fx-tag">{open.tagline}</p>
              <div className="fx-tabs">
                <button className={tab === 'shots' ? 'on' : ''} onClick={() => setTab('shots')}>Shot by shot</button>
                <button className={tab === 'tips' ? 'on' : ''} onClick={() => setTab('tips')}>Producer notes</button>
                <button className={tab === 'sound' ? 'on' : ''} onClick={() => setTab('sound')}>Sound</button>
              </div>
              {tab === 'shots' && (
                <div className="fx-shots">
                  {open.shots.map((s) => (
                    <div key={s.n} className="fx-shot">
                      <div className="fx-n">{s.n}</div>
                      <div className="fx-st">
                        <div className="fx-cap">“{s.caption}”</div>
                        <div className="fx-p">{s.prompt}</div>
                        <div className="fx-m">🎥 {s.motion}</div>
                        <button onClick={() => { onRecreateShot(s.prompt, s.motion, open.aspect); setOpen(null); }}>✦ Remix this shot</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {tab === 'tips' && (
                <ul className="fx-tips">{open.tips.map((t) => <li key={t}>{t}</li>)}
                  <li>Every shot is a 4-second Wan 2.2 clip from a Flux 3 still, upscaled 2x, cut with 0.4 s dissolves, graded and captioned. Nothing was touched up by hand.</li>
                </ul>
              )}
              {tab === 'sound' && (
                <div className="fx-sound"><p>The score was generated locally with Stable Audio Open:</p><blockquote>{open.score}</blockquote></div>
              )}
              <button className="xp-go" onClick={() => { onRecreateFilm(open); setOpen(null); }}>✦ Make my own version on the board</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
