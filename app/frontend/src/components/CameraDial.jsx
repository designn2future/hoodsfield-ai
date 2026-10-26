import React, { useEffect, useRef, useState } from 'react';

const MODES = [
  {
    id: 'orbit', label: 'Orbit', hint: 'Sweep around the subject — drag any direction',
    icon: (
      <>
        <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2 3" />
        <path d="M12 4.5 L14.2 6 L13 8.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="1.3" fill="currentColor" />
      </>
    ),
  },
  {
    id: 'arc', label: 'Arc', hint: 'Flat sweep at a fixed height — drag left/right',
    icon: (
      <>
        <path d="M4 15 Q12 4 20 15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2 3" />
        <path d="M18.2 12.1 L20 15 L16.9 15.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="12" cy="16" r="1.2" fill="currentColor" />
      </>
    ),
  },
  {
    id: 'pan', label: 'Pan / Tilt', hint: 'Rotate the camera in place — drag any direction',
    icon: (
      <>
        <rect x="8" y="9" width="8" height="6" rx="1.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="12" cy="12" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5 8.5 Q3 12 5 15.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M19 8.5 Q21 12 19 15.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ),
  },
  {
    id: 'dolly', label: 'Dolly', hint: 'Push in / pull out — drag up/down',
    icon: (
      <>
        <rect x="7" y="7.5" width="7" height="5.5" rx="1.1" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M14.2 9 L17.3 10.3 L14.2 11.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="4" y1="18.5" x2="20" y2="18.5" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 2" />
        <path d="M6.3 20.2 L4 18.5 L6.3 16.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M17.7 20.2 L20 18.5 L17.7 16.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  {
    id: 'crane', label: 'Crane', hint: 'Raise / lower the camera — drag up/down',
    icon: (
      <>
        <rect x="8" y="4" width="8" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <line x1="12" y1="9.5" x2="12" y2="18.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9.2 11.8 L12 9 L14.8 11.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9.2 16.2 L12 19 L14.8 16.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
];

const RADIUS = 26; // px the nub can travel from center

/**
 * Radial camera-movement console: pick a movement type (orbit / arc / pan /
 * dolly / crane), then hold and drag the center joystick to drive the
 * studio camera live in that mode — a continuous analog input, not a click.
 * Releasing leaves the camera exactly where it was moved; capture it as a
 * keyframe from the Timeline as usual.
 */
export default function CameraDial({ studioRef }) {
  const [mode, setMode] = useState('orbit');
  const [nub, setNub] = useState({ x: 0, y: 0 });
  const baseRef = useRef(null);
  const dragRef = useRef(null); // {dx, dy} live deflection, or null when idle
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    let raf;
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const d = dragRef.current;
      if (d && (d.dx || d.dy)) studioRef?.current?.applyCameraMove(modeRef.current, d.dx, d.dy, dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [studioRef]);

  const startDrag = (e) => {
    e.preventDefault();
    const rect = baseRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const update = (clientX, clientY) => {
      let dx = clientX - cx, dy = clientY - cy;
      const mag = Math.hypot(dx, dy);
      if (mag > RADIUS) { dx = (dx / mag) * RADIUS; dy = (dy / mag) * RADIUS; }
      setNub({ x: dx, y: dy });
      dragRef.current = { dx: dx / RADIUS, dy: dy / RADIUS };
    };
    update(e.clientX, e.clientY);
    const move = (ev) => update(ev.clientX, ev.clientY);
    const up = () => {
      dragRef.current = null;
      setNub({ x: 0, y: 0 });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const active = MODES.find((m) => m.id === mode);
  const N = MODES.length;
  const OUTER_R = 48;

  return (
    <div className="camera-dial">
      <div className="cd-ring" style={{ width: OUTER_R * 2 + 34, height: OUTER_R * 2 + 34 }}>
        {MODES.map((m, i) => {
          const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(angle) * OUTER_R, y = Math.sin(angle) * OUTER_R;
          return (
            <button
              key={m.id}
              className={`cd-mode ${mode === m.id ? 'on' : ''}`}
              style={{ transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
              title={`${m.label} — ${m.hint}`}
              onClick={() => setMode(m.id)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18">{m.icon}</svg>
            </button>
          );
        })}
        <div ref={baseRef} className="cd-base" onPointerDown={startDrag} title={active.hint}>
          <div className="cd-nub" style={{ transform: `translate(calc(-50% + ${nub.x}px), calc(-50% + ${nub.y}px))` }}>
            <svg viewBox="0 0 24 24" width="20" height="20">{active.icon}</svg>
          </div>
        </div>
      </div>
      <div className="cd-label">{active.label}</div>
    </div>
  );
}
