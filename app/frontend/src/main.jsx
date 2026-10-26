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

applyTheme(getTheme());

createRoot(document.getElementById('root')).render(<App />);
