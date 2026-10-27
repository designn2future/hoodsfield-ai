import './pollingShim.js';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/geist';
import './styles.css';
import './home.css';
import './cinema.css';
import './phone.css';
import './assistant.css';
import { applyTheme, getTheme } from './features.js';
import { SCENE_VIDEO_DEFAULTS } from './h3.js';

applyTheme(getTheme());

// new scenes start with the draft quality that suits this PC's graphics card (Settings -> Graphics card)
const profile = fetch('/api/gpu/profile').then((r) => (r.ok ? r.json() : null)).then((g) => {
  if (g?.profile) { SCENE_VIDEO_DEFAULTS.preset = g.profile.draft_preset; SCENE_VIDEO_DEFAULTS.megapixels = g.profile.draft_mp; }
  window.__hfProfile = g;
}).catch(() => {});
Promise.race([profile, new Promise((r) => setTimeout(r, 1500))]).then(() => createRoot(document.getElementById('root')).render(<App />));
