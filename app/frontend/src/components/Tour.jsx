import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import '../tour.css';

const KEY = 'hf_tour_seen';
const seen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return true; } };
const mark = () => { try { localStorage.setItem(KEY, '1'); } catch { /* storage blocked */ } };

export const openTour = () => window.dispatchEvent(new Event('hf-tour'));

// `rail` = the title of the left-rail button to point at (null = a general step).
const STEPS = [
  { icon: '👋', title: 'Welcome to Hoodsfield', text: 'A film studio that runs on your own computer. Make images, characters, videos, loops, voices and ads without sending anything to the cloud. This 1-minute tour points at each tool on the left.' },
  { rail: 'Home', icon: '🏠', title: 'Home', text: 'Your starting point: ready-made workflows and examples of what each tool can do. The "✨ Make a video" button at the top answers three questions and writes you a finished script.' },
  { rail: 'Assistant', icon: '🤖', title: 'Assistant', text: 'Tell it your idea in plain words. It plans the scenes and sets the other tools up for you.' },
  { rail: 'Make Image', icon: '⚡', title: 'Make Image', text: 'Type what you want and get a photoreal still in seconds. Add reference pictures and pick a real camera, lens and light.' },
  { rail: 'Edit Image', icon: '🪄', title: 'Edit Image', text: 'Change a picture you already have. Remove things, swap outfits or backgrounds, relight, or restyle it, using a simple brush.' },
  { rail: 'Characters', icon: '🧬', title: 'Characters', text: 'Drop in one photo of a person and get a full set of views (front, side, back, expressions) so the same person stays the same in every scene.' },
  { rail: '3D Shot', icon: '🎥', title: '3D Shot', text: 'Place the camera, people and props in a small 3D set, then generate an image that follows your exact framing.' },
  { rail: 'Edit Video', icon: '🌀', title: 'Edit Video', text: 'Start from a video you already have. Swap the person, change one detail or give it a new look while the original movement stays.' },
  { rail: 'Loops', icon: '🔁', title: 'Loops', text: 'Animate one picture into a calm clip that repeats with no visible seam, then export hours of it for study, lofi or sleep videos.' },
  { rail: 'Finish', icon: '🧰', title: 'Finish', text: 'Polish a clip: sharpen it, slow it down, cut out the background, change the size, or turn it into a GIF.' },
  { rail: 'Lip-sync', icon: '🗣️', title: 'Lip-sync', text: 'Make a portrait talk. Add or record speech and the lips follow the voice.' },
  { rail: 'Ads', icon: '🛍️', title: 'Ads', text: 'Paste a product page and get an ad storyboard (unboxing, hero shot, how-to) with your product in every shot.' },
  { rail: 'Board', icon: '🗂️', title: 'Board', text: 'Every scene, still and clip lives on one canvas. Drag to reorder, regenerate any shot, and render when ready.' },
  { rail: 'Timeline', icon: '🎞️', title: 'Timeline', text: 'Cut it all together: trim, add music and captions, set the colour look, and export your video.' },
  { rail: 'Voice', icon: '🎙️', title: 'Voice', text: 'Write a line and hear it in a natural voice, or clone a reference voice. Send it straight to the timeline or to Lip-sync.' },
  { rail: 'Explore', icon: '🧭', title: 'Explore and Jobs', text: 'Explore is your gallery of everything you have made. Jobs shows what is rendering right now.' },
  { icon: '✅', title: 'You are ready', text: 'Not sure where to begin? Press "✨ Make a video" at the top, or open Make Image and type an idea. You can replay this tour from the "Tour" button at the top.' },
];

export default function Tour() {
  const [step, setStep] = useState(-1);                 // -1 = closed
  const [rect, setRect] = useState(null);
  const s = step >= 0 ? STEPS[step] : null;

  useEffect(() => {
    const open = () => setStep(0);
    window.addEventListener('hf-tour', open);
    const t = seen() ? null : setTimeout(() => setStep(0), 1800);          // first visit only (per browser)
    return () => { window.removeEventListener('hf-tour', open); if (t) clearTimeout(t); };
  }, []);

  const measure = useCallback(() => {
    if (!s?.rail) { setRect(null); return; }
    const el = [...document.querySelectorAll('.rail-btn')].find((b) => b.getAttribute('title') === s.rail);
    if (!el) { setRect(null); return; }
    el.scrollIntoView?.({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [s]);
  useLayoutEffect(() => { measure(); }, [measure]);
  useEffect(() => { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }, [measure]);

  const close = useCallback(() => { mark(); setStep(-1); }, []);
  const next = useCallback(() => (step >= STEPS.length - 1 ? close() : setStep(step + 1)), [step, close]);
  const back = useCallback(() => setStep((v) => Math.max(0, v - 1)), []);
  useEffect(() => {
    if (step < 0) return undefined;
    const k = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight' || e.key === 'Enter') next(); else if (e.key === 'ArrowLeft') back(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [step, close, next, back]);

  if (!s) return null;
  const wide = typeof window !== 'undefined' && window.innerWidth > 820;
  const cardStyle = wide && rect
    ? { top: Math.max(12, Math.min(window.innerHeight - 250, rect.top + rect.height / 2 - 110)), left: rect.left + rect.width + 18 }
    : undefined;
  return (
    <div className="tour" role="dialog" aria-label="Tour of Hoodsfield">
      <div className="tour-dim" onClick={close} />
      {rect && <div className="tour-ring" style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }} />}
      <div className={`tour-card ${cardStyle ? '' : 'center'}`} style={cardStyle}>
        <div className="tour-ico">{s.icon}</div>
        <h3>{s.title}</h3>
        <p>{s.text}</p>
        <div className="tour-nav">
          <span className="tour-count">{step + 1} / {STEPS.length}</span>
          <button className="tour-skip" onClick={close}>{step >= STEPS.length - 1 ? 'Close' : 'Skip tour'}</button>
          {step > 0 && <button className="tour-back" onClick={back}>Back</button>}
          <button className="tour-next" onClick={next}>{step === 0 ? 'Start the tour' : step >= STEPS.length - 1 ? 'Finish' : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}
