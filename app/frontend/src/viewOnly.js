// View-only mode, per device: this screen can browse everything (Explore, results, the live project) but it never writes the shared
// project and cannot start generations, so a second phone can look around without disturbing the PC.
const KEY = 'hf-viewonly';
export const isViewOnly = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
export const setViewOnly = (on) => {
  try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('hf-viewonly', { detail: on }));
};
export const VIEW_ONLY_MSG = 'This device is in view-only mode. Tap "View-only" at the bottom of the screen to turn it off and generate.';
