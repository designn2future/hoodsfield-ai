import React from 'react';
import { RAIL } from '../features.js';

// Line icons (24x24, stroke) in the style of the Stitch redesign; the emoji in RAIL stays as the fallback for unknown tools.
const P = {
  Home: 'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10',
  Assistant: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z',
  Image: 'M4 5h16v14H4zM4 16l4.5-4.5 4 4 3-3L20 16M9 9.5h.01',
  Edit: 'm4 20 9.5-9.5M13.5 10.5l2-2M15 5l.7 1.6L17.3 7.3 15.7 8l-.7 1.6-.7-1.6-1.6-.7 1.6-.7zM19 12l.5 1.1 1.1.4-1.1.5-.5 1.1-.5-1.1-1.1-.5 1.1-.4z',
  Cast: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19c.5-3 2.7-4.5 5.5-4.5s5 1.5 5.5 4.5M16.5 11a2.5 2.5 0 1 0 0-5M17 14.7c2 .3 3.2 1.7 3.5 4.3',
  Scene: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5 12 12l8-4.5M12 12v9',
  Genjutsu: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  Lab: 'M9.5 3.5h5M10.5 3.5v6L5 19a1.5 1.5 0 0 0 1.3 2.2h11.4A1.5 1.5 0 0 0 19 19l-5.5-9.5v-6M8 15h8',
  Talk: 'M4 5.5h16v10H12l-5 4v-4H4z',
  Ads: 'M4 10v4h3l7 4V6l-7 4zM17.5 9a4 4 0 0 1 0 6',
  Board: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  Timeline: 'M3.5 6h17v12h-17zM8 6v12M16 6v12M3.5 10h4.5M3.5 14h4.5M16 10h4.5M16 14h4.5',
  Voice: 'M12 14.5a3 3 0 0 0 3-3v-5a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zM6 11.5a6 6 0 0 0 12 0M12 17.5V21M9 21h6',
  Explore: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5z',
  Jobs: 'M3.5 8.5h17v10h-17zM8.5 8.5V6a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v2.5M3.5 13h17',
};

export function RailIcon({ label, fallback }) {
  const d = P[label];
  if (!d) return <span className="rail-ico">{fallback}</span>;
  return (
    <svg className="rail-svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** Persistent left rail — one click between every tool. `null` overlay = the board. */
export default function NavRail({ overlay, onGo, badges = {} }) {
  return (
    <nav className="navrail" aria-label="Tools">
      {RAIL.map((r) => (
        <button key={r.label} className={`rail-btn ${(overlay ?? null) === r.overlay ? 'on' : ''}`} onClick={() => onGo(r.overlay)} title={r.label}>
          <RailIcon label={r.ico || r.label} fallback={r.icon} />
          {badges[r.overlay] > 0 && <span className="badge">{badges[r.overlay]}</span>}
          <span className="rail-lbl">{r.label}</span>
        </button>
      ))}
    </nav>
  );
}
