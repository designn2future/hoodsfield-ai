import { useGenre } from '../genreStore.js';
import React, { useEffect, useRef, useState } from 'react';

/** App-style top menu bar: File / Edit / View / Create dropdowns, app title
 * on the left, backend health on the right. */
export default function MenuBar({
  canBack, onBack, onRestoreLast, onToggleGallery, galleryCount,
  health, projectName, hasScenes, hasAssets,
  onNewProject, onSaveProject, onSaveProjectAs, onOpenFilePicker, onCloseProject,
  onClearScenes, onClearUnusedAssets, onResetView,
  onOpenSketch, onOpenStudio, onOpenKrea, onOpenFlux, onOpenAssistant, onOpenEdit, onOpenLab, onOpenChars, onOpenGenjutsu, onOpenAds, onOpenLipSync, onOpenHome, onOpenTimeline, onOpenModels, onOpenExplore, onOpenVoice, onOpenScene, onOpenMcp, onOpenSettings, onOpenDemo, onOpenLoop, onOpenMv, onOpenTk, onNewScene,
  imageEngine, onSetImageEngine, theme, onSetTheme, themes = [], onStart,
}) {
  const { genre, defs, autoPost, autoSound, focusMode, setGenre, setAutoPost, setAutoSound, setFocusMode } = useGenre();
  const [open, setOpen] = useState(null); // menu name or null
  const barRef = useRef(null);
  const [claude, setClaude] = useState(null);
  useEffect(() => {
    let on = true;
    const load = () => fetch('/api/claude/status').then((r) => (r.ok ? r.json() : null)).then((j) => on && setClaude(j)).catch(() => {});
    load(); const t = setInterval(load, 90000);
    return () => { on = false; clearInterval(t); };
  }, []);

  // Click-away / Escape close the open menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!barRef.current?.contains(e.target)) setOpen(null); };
    const onKey = (e) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const menus = [
    {
      name: 'File',
      items: [
        { label: 'New Project', action: onNewProject },
        { label: 'Open Project…', shortcut: 'Ctrl+O', action: onOpenFilePicker },
        { label: '🎞️ Open the demo project', action: onOpenDemo },
        { label: 'Save Project', shortcut: 'Ctrl+S', action: onSaveProject },
        { label: 'Save Project As…', shortcut: 'Ctrl+Shift+S', action: onSaveProjectAs },
        { label: 'Restore Last Session (autosave)', action: onRestoreLast },
        'sep',
        { label: 'Close Project', action: onCloseProject },
      ],
    },
    {
      name: 'Edit',
      items: [
        { label: 'Remove All Scenes', danger: true, disabled: !hasScenes, action: onClearScenes },
        { label: 'Clear Unused Gallery Assets', danger: true, disabled: !hasAssets, action: onClearUnusedAssets },
      ],
    },
    {
      name: 'Engine',
      items: [
        { label: `${imageEngine === 'flux3' ? '● ' : '○ '}Flux 3 — scene stills (fast, references)`, action: () => onSetImageEngine('flux3') },
        { label: `${imageEngine === 'krea2' ? '● ' : '○ '}Krea 2 — scene stills`, action: () => onSetImageEngine('krea2') },
      ],
    },
    {
      name: 'View',
      items: [
        { label: '🏠 Home', action: onOpenHome },
        { label: 'Reset Board View', action: onResetView },
        'sep',
        { label: '⚙️ Settings…', action: onOpenSettings },
        { label: '🤖 Agent / MCP setup', action: onOpenMcp },
        'sep',
        ...themes.map((t) => ({ label: `${theme === t.id ? '● ' : '○ '}Theme — ${t.label}`, action: () => onSetTheme(t.id) })),
      ],
    },
    {
      name: 'Create',
      items: [
        { label: '🤖 Assistant (idea → finished video)', action: onOpenAssistant },
        { label: '🎵 Music Video…', action: onOpenMv },
        { label: '📱 TikTok Video…', action: onOpenTk },
        { label: '🎞️ Empty Scene (prompt → still → clip)', action: onNewScene },
        { label: '🔁 Seamless Loops (study / lofi videos)', action: onOpenLoop },
        'sep',
        { label: '⚡ Flux 3 Image Studio', action: onOpenFlux },
        { label: '🪄 Edit Studio (inpaint, relight, try-on…)', action: onOpenEdit },
        { label: '🎞️ Timeline editor (cut, caption, mix)', action: onOpenTimeline },
        { label: '🧭 Explore & remix', action: onOpenExplore },
        { label: '🎥 Scene Composer (3D shot blocking)', action: onOpenScene },
        { label: '🎙️ Voiceover (Chatterbox)', action: onOpenVoice },
        { label: '🧰 Model manager', action: onOpenModels },
        { label: '🗣️ Lip-sync Studio (make a face talk)', action: onOpenLipSync },
        { label: '🛍️ Ad Studio (product link → ad)', action: onOpenAds },
        { label: '🌀 Genjutsu (motion transfer · object swap · restyle)', action: onOpenGenjutsu },
        { label: '🧬 Character Studio (consistent characters)', action: onOpenChars },
        { label: '🧰 Video Lab (upscale, slow-mo, cutout, reframe…)', action: onOpenLab },
        { label: '🖼️ Krea 2 image', action: onOpenKrea },
        { label: '✏️ Sketch', action: onOpenSketch },
        { label: '🎬 3D Studio', action: onOpenStudio },
      ],
    },
  ];

  return (
    <div className="menubar" ref={barRef}>
      {canBack && <button className="mb-back" onClick={onBack} title="Back to the previous screen">←<b> Back</b></button>}
      <span className="logo">Hoods<b>field</b></span>
      {projectName && <span className="proj-name" title="Current project — File → Save Project As… to rename">{projectName}</span>}
      {menus.map((m) => (
        <div key={m.name} className="menu">
          <button
            className={`menu-btn ${open === m.name ? 'open' : ''}`}
            onPointerDown={(e) => { e.preventDefault(); setOpen(open === m.name ? null : m.name); }}
            onPointerEnter={() => open && setOpen(m.name)}
          >
            {m.name}
          </button>
          {open === m.name && (
            <div className="menu-drop glass">
              {m.items.map((it, i) =>
                it === 'sep' ? (
                  <div key={i} className="menu-sep" />
                ) : (
                  <button key={it.label} className={`menu-item ${it.danger ? 'danger' : ''}`}
                    disabled={it.disabled}
                    onClick={() => { setOpen(null); it.action(); }}>
                    <span>{it.label}</span>
                    {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
      <span className="spacer" />
      <span className="mb-quick">
        <button onClick={onOpenExplore} title="Explore & remix">🧭<b> Explore</b></button>
        <button onClick={onOpenAssistant} title="Assistant">🤖<b> Assistant</b></button>
      </span>
      {onToggleGallery && <button className="mb-gal" onClick={onToggleGallery} title="Open the Gallery: every image, clip and sound you have made">Gallery{galleryCount ? <small>{galleryCount}</small> : null}</button>}
      {onStart &&<button className="mk-btn" onClick={onStart} title="Start here: answer three questions and get a finished video script">✨ Make a video</button>}
      <span className="genre-pick" title={genre.id === 'cinematic' ? 'Genre: sets the camera look, prompts and the AI director for everything you make' : genre.blurb}>
        <span>🎬</span>
        <select value={genre.id} onChange={(e) => setGenre(e.target.value)}>
          {(defs.length ? defs : [genre]).map((g) => <option key={g.id} value={g.id}>{g.icon} {g.label}</option>)}
        </select>
        {genre.post && (
          <label title="Automatically give every finished clip this camera's look (shake, focus hunting, tape wear, REC overlay, cheap-mic audio)">
            <input type="checkbox" checked={autoPost} onChange={(e) => setAutoPost(e.target.checked)} /> look
          </label>
        )}
        {genre.post && (
          <label title="How much the camera blurs in and out of focus. 'genre' = this camera's own habit. Off also keeps it out of the prompts, so the AI doesn't generate it either.">
            focus <select value={focusMode} onChange={(e) => setFocusMode(e.target.value)}>
              <option value="genre">genre default</option><option value="off">off (steady)</option><option value="some">some</option><option value="a lot">a lot</option>
            </select>
          </label>
        )}
        {genre.post && (
          <label title="Designs sound for each clip separately. It restarts at every cut, so it can feel jumpy; the continuous version is in Cut & Render, on the finished video.">
            <input type="checkbox" checked={autoSound} onChange={(e) => setAutoSound(e.target.checked)} /> sound
          </label>
        )}
      </span>
      {claude && (
        <span className={`health clickable ${claude.ready ? 'ok' : 'dim'}`} onClick={onOpenSettings}
          title={claude.ready ? `Claude connected${claude.account ? ' as ' + claude.account : ''}. Click for settings.` : `${claude.message || 'Claude is not connected.'} Click to set it up (the Assistant needs it; Lite mode does not).`}>
          {claude.ready ? 'Claude ●' : 'Claude ○'}
        </span>
      )}
      {onOpenSettings && <button className="mb-gal mb-gear" onClick={onOpenSettings} title="Settings" aria-label="Settings">⚙️</button>}
      {health && (
        <>
          <span className={`health ${health.ollama ? 'ok' : 'dim'}`}
            title={health.ollama ? `Ollama up — director: ${health.ollama_text_model || '?'}` : 'Ollama not reachable — the LLM director and image descriptions are unavailable (template writer still works)'}>
            {health.ollama ? 'LLM ●' : 'LLM ○'}
          </span>
          <span className={`health ${health.mock || health.comfy_reachable ? 'ok' : 'bad'}`}>
            {health.mock ? 'Mock' : health.comfy_reachable ? 'ComfyUI ●' : 'ComfyUI ○'}
          </span>
        </>
      )}
    </div>
  );
}
