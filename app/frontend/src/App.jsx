import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Studio } from './three/Studio.js';
import { withStill, withMotion, getGenre, getAutoPost, getAutoSound, focusLevel, scrubScript, setGenre } from './genreStore.js';
import {
  scarifyShot, makeScore, generateVideo, generateImage, generateI2V, generateKrea, generateFlux3, generateH3, generateWan, generateWanLong, wanModels, runFfmpegTool, finalizeVideo, cancelJob, checkHealth, quantizeFrames,
  listH3Models, mvAnalyze, mvScript, mvRender, describeImage, describeImagesStyle, listTextEncoders,
  transcribeStoryVideo, describeStoryVideo, describeStoryImages, writeStoryScript, parseStoryScript, listLooks,
} from './api.js';
import { saveProject, loadProject, autosaveProject, readAutosave, projectFromAutosave, clearAutosave } from './project.js';
import { resolveDisplayAsset } from './utils.js';
import {
  SCENE_VIDEO_DEFAULTS, LOCK_STILL_TEXT, sceneDescription, imageAspect, canvasFor, videoMeta, stillSizeFor, aspectRatio,
  h3LoraParams,
} from './h3.js';
import { toBackendEdl, buildEdl } from './mvEdit.js';

/** Genres whose camera look is a single pass over the finished cut (so every shot shares it and nothing is baked in twice). */
const ONCE_LOOKS = new Set(['tiktok', 'ugc', 'doorbell', 'babycam', 'trailcam']);
import Toolbar from './components/Toolbar.jsx';
import Inspector from './components/Inspector.jsx';
import Timeline from './components/Timeline.jsx';
import GeneratePanel from './components/GeneratePanel.jsx';
import SketchMode from './components/SketchMode.jsx';
import SketchPanel from './components/SketchPanel.jsx';
import KreaPanel from './components/KreaPanel.jsx';
import Flux3Panel, { FLUX_DEFAULTS } from './components/Flux3Panel.jsx';
import EditStudio from './components/EditStudio.jsx';
import VideoLab from './components/VideoLab.jsx';
import CharacterStudio from './components/CharacterStudio.jsx';
import GenjutsuStudio from './components/GenjutsuStudio.jsx';
import AdStudio from './components/AdStudio.jsx';
import Home from './components/Home.jsx';
import NavRail from './components/NavRail.jsx';
import ToolBanner from './components/ToolBanner.jsx';
import McpPage from './components/McpPage.jsx';
import JobsPanel from './components/JobsPanel.jsx';
import ModelManager from './components/ModelManager.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import LoopStudio from './components/LoopStudio.jsx';
import SetupBanner from './components/SetupBanner.jsx';
import Tour from './components/Tour.jsx';
import Explore from './components/Explore.jsx';
import VoiceStudio from './components/VoiceStudio.jsx';
import SceneComposer from './components/SceneComposer.jsx';
import QuickStart from './components/QuickStart.jsx';
import AssistantPanel from './components/AssistantPanel.jsx';
import { useSharedFeed, RemoteJobsPill } from './sharedFeed.jsx';
import AssistantAlerts from './assistantAlerts.jsx';
import { useSharedSession, SyncBadge } from './sharedSession.jsx';
import './voice.css';
import './explore.css';
import LipSyncStudio from './components/LipSyncStudio.jsx';
import TimelineEditor from './components/TimelineEditor.jsx';
import { newTimeline, clipFromAsset, addClipToTrack } from './timeline.js';
import { THEMES, applyTheme, getTheme } from './features.js';
import { pairWanLoras } from './components/WanOptions.jsx';
import { DEFAULT_RIG, withRig } from './cinema.js';
import Board from './components/Board.jsx';
import HistoryDock from './components/HistoryDock.jsx';
import MenuBar from './components/MenuBar.jsx';
import SceneDetail from './components/SceneDetail.jsx';
import MusicVideoPanel from './components/MusicVideoPanel.jsx';
import TikTokPanel from './components/TikTokPanel.jsx';
import PanelBoundary from './components/PanelBoundary.jsx';

const DEFAULTS = {
  prompt: '', negative: 'blurry, distorted, low quality, watermark',
  width: 768, height: 448, seconds: 4, fps: 24, steps: 8, cfg: 3.0,
  seed: -1, denoise: 0.75, depthFar: 25,
};

const SKETCH_DEFAULTS = {
  prompt: '', negative: 'blurry, distorted, low quality, watermark, text',
  checkpoint: '', controlnet: 'none', cnStrength: 0.8, cnEnd: 0.6,
  width: 1472, height: 1472, steps: 20, cfg: 7.0, seed: -1, denoise: 0.7,
  backend: 'sd', ggufModel: '', textEncoder: '', vae: '', enhancerStrength: 0,
  swapModel: '', faceRestoreModel: 'none', kreaStructureMode: 'img2img', refineDenoise: 0.90,
  sketchBlur: 4.5,
};

const KREA_DEFAULTS = {
  prompt: '',
  ggufModel: '', textEncoder: '', vae: '', enhancerStrength: 0,
  width: 1024, height: 1024, steps: 8, cfg: 1.0, seed: -1,
  swapModel: '', faceRestoreModel: 'none',
};

const FLUX_INIT = { ...FLUX_DEFAULTS, rig: DEFAULT_RIG, swapModel: '', faceRestoreModel: 'none' };

const MV_DEFAULTS = {
  step: 0,
  trackAssetId: null, analysis: null, range: null,
  castIds: [], styleIds: [],
  concept: '', style: '', lyrics: '', aspect: '9:16', nScenes: 8, frames: 124, preset: 'fast', useLlm: true, llmModel: '',
  script: null, scriptError: null,
  cut: { style: 'auto', seed: 1, pieces: [], musicGain: 1, clipGain: 0, fadeOut: 1, size: 'native' },
  finalAssetId: null,
};

const TK_DEFAULTS = {
  step: 0,
  sourceAssetIds: [], transcript: '', visualNotes: '',
  castIds: [],
  concept: '', style: '', aspect: '9:16', lengthPreset: '30s', nScenes: 6, frames: 124, useLlm: true, llmModel: '',
  realistic: true,
  script: null, scriptError: null,
  cut: { pieces: [], musicGain: 0.6, clipGain: 1, size: 'native', look: 'none' },
  scare: 'creepy',
  room: { messages: [], engine: '' },
  finalAssetId: null,
};

const uid = () => Math.random().toString(36).slice(2, 10);

/** Model/hardware selections are machine config, not project content — a new
 * or loaded project must never blank them: the panels only auto-pick defaults
 * once at app load, so a cleared value would leave the dropdown *displaying*
 * the first list entry (e.g. an LTX audio VAE) without it being re-picked. */
const MODEL_FIELDS = ['checkpoint', 'ggufModel', 'textEncoder', 'vae', 'swapModel', 'faceRestoreModel'];
const keepModels = (prev, next) => {
  const merged = { ...prev, ...next };
  for (const k of MODEL_FIELDS) if (k in prev && !next?.[k]) merged[k] = prev[k];
  // audio VAEs crash image VAEEncode — never restore one from a saved project
  if (/audio/i.test(merged.vae || '')) merged.vae = /audio/i.test(prev.vae || '') ? '' : prev.vae;
  return merged;
};

/** A fresh scene. `assetId` may be null (prompt-first scenes get a still later). */
const newScene = (assetId, x, y, extra = {}) => ({
  id: uid(), x, y, assetId, videoAssetId: null,
  title: '', stillPrompt: '', prompt: '', cast: [], styleRefs: [], aspect: '9:16', stillSeed: -1,
  seconds: 5, fps: 24, cfg: 3.0, loras: [],
  ...SCENE_VIDEO_DEFAULTS,
  gen: { phase: 'idle' },
  ...extra,
});

export default function App() {
  // ---- board / project state
  const [assets, setAssets] = useState([]);       // {id, kind, mime, name, blob, url, meta}
  const [scenes, setScenes] = useState([]);       // see newScene()
  const [projectName, setProjectName] = useState('');
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  // a refresh reopens the screen you were on (a #link in the address wins)
  const [overlay, setOverlay] = useState(() => ({ '#scene': 'scene', '#start': 'start', '#tk': 'tk', '#assistant': 'assistant', '#settings': 'settings', '#loop': 'loop' }[location.hash.split('?')[0]]
    || (() => { try { const v = localStorage.getItem('hf.screen'); return v === 'board' ? null : (v && v !== 'null' ? v : 'home'); } catch { return 'home'; } })()));   // the Board is "no overlay" (null)
  useEffect(() => { try { localStorage.setItem('hf.screen', overlay ?? 'board'); } catch { /* storage blocked */ } }, [overlay]);
  // any part of the app can open a page (and a Settings section): window.dispatchEvent(new CustomEvent('hf:open', { detail: { page: 'settings', section: 'claude' } }))
  useEffect(() => {
    const h = (e) => { setOverlay(e.detail.page); if (e.detail.section) setTimeout(() => window.dispatchEvent(new CustomEvent('hf:settings-section', { detail: e.detail.section })), 120); };
    window.addEventListener('hf:open', h);
    return () => window.removeEventListener('hf:open', h);
  }, []);
  const [theme, setThemeState] = useState(getTheme());
  const [runningJobs, setRunningJobs] = useState(0);
  const [timeline, setTimeline] = useState(newTimeline);   // null | 'sketch' | 'studio' | 'krea' | 'mv'
  const [detailId, setDetailId] = useState(null); // scene id opened in the lightbox
  const [health, setHealth] = useState(null);
  const [h3Catalog, setH3Catalog] = useState(null);
  const [looks, setLooks] = useState([]);
  // screen history: the Back button (and the phone's Back gesture) returns to where you came from
  const navStack = useRef([]);
  const goingBack = useRef(false);
  const [canBack, setCanBack] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);   // the Gallery side panel (reachable from every screen)
  const [layers, setLayers] = useState(0);            // open detail views (e.g. an image opened in Explore) that Back closes before leaving the screen
  useEffect(() => {
    const on = () => setLayers((window.__hfLayers || []).length);
    window.addEventListener('hf-layers', on);
    return () => window.removeEventListener('hf-layers', on);
  }, []);
  useEffect(() => {
    const st = navStack.current;
    if (goingBack.current) { goingBack.current = false; } else if (st[st.length - 1] !== overlay) {
      st.push(overlay); if (st.length > 30) st.shift();
      try { history.pushState({ hfNav: 1 }, ''); } catch { /* ignore */ }
    }
    setCanBack(st.length > 1);
  }, [overlay]);
  const goBack = useCallback(() => {
    const top = (window.__hfLayers || []).slice(-1)[0];
    if (top) { top(); return; }                      // one level at a time: close the open item first
    const st = navStack.current;
    if (st.length < 2) return;
    st.pop(); goingBack.current = true;
    setDetailId(null); setOverlay(st[st.length - 1]);
  }, []);
  useEffect(() => {
    const onPop = () => { if (window.__hfSkipPop) { window.__hfSkipPop = false; return; } if (navStack.current.length > 1) goBack(); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [goBack]);
  const lastSketch = useRef(null);                // {key, id} dedup for auto-saved sketches
  const scenesRef = useRef(scenes);
  const assetsRef = useRef(assets);
  scenesRef.current = scenes;
  assetsRef.current = assets;

  // ---- 3D studio state
  const mountRef = useRef(null);
  const studioRef = useRef(null);
  const [objects, setObjects] = useState([]);
  const [selected, setSelected] = useState(null);
  const [keyframes, setKeyframes] = useState([]);
  const [gizmoMode, setGizmoMode] = useState('translate');
  const [depthView, setDepthView] = useState(false);
  const [settings, setSettings] = useState(DEFAULTS);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [throughLens, setThroughLens] = useState(false);
  const [gen, setGen] = useState({ phase: 'idle', progress: 0, status: '', videoUrl: null, media: '', error: null });

  // ---- sketch state
  const sketchApi = useRef(null);
  const [sketchSettings, setSketchSettings] = useState(SKETCH_DEFAULTS);
  const [sketchLoras, setSketchLoras] = useState([]);   // [{id, name, strength}] — Krea 2 backend only
  const [sketchFaces, setSketchFaces] = useState([]);   // [{id, index, file}] — Krea 2 backend only
  const [genImg, setGenImg] = useState({ phase: 'idle', progress: 0, status: '', imageUrl: null, error: null });

  // ---- sketch live preview
  const [livePreview, setLivePreview] = useState(false);
  const [preview, setPreview] = useState({ url: null, updating: false });
  const previewTimer = useRef(null);
  const previewSeq = useRef(0);

  // ---- krea2 state
  const [kreaSettings, setKreaSettings] = useState(KREA_DEFAULTS);
  const [moodboard, setMoodboard] = useState([]);   // File[]
  const [faces, setFaces] = useState([]);           // [{id, index, file}]
  const [loras, setLoras] = useState([]);           // [{id, name, strength}]
  const [genKrea, setGenKrea] = useState({ phase: 'idle', progress: 0, status: '', imageUrl: null, error: null });

  // ---- flux 3 state (default image engine)
  const [fluxSettings, setFluxSettings] = useState(FLUX_INIT);
  const [fluxFaces, setFluxFaces] = useState([]);   // [{id, index, file}]
  const [fluxLoras, setFluxLoras] = useState([]);   // [{id, name, strength}]
  const [imageEngine, setImageEngine] = useState('flux3'); // scene stills: 'flux3' | 'krea2'
  const [lipIncoming, setLipIncoming] = useState(null);   // {asset, nonce} pushed into Lip-sync Studio
  const [editIncoming, setEditIncoming] = useState(null);  // {asset, nonce} pushed into Edit Studio
  const [labIncoming, setLabIncoming] = useState(null);    // {asset, nonce} pushed into Video Lab
  const [gjIncoming, setGjIncoming] = useState(null);     // {asset, nonce} pushed into Genjutsu

  // ---- music video state
  const [mv, setMv] = useState(MV_DEFAULTS);
  const [scriptBusy, setScriptBusy] = useState(false);
  const [batch, setBatch] = useState({ phase: 'idle', kind: '', done: 0, total: 0, current: '' });
  const batchAbort = useRef(false);
  const [renderState, setRenderState] = useState({ phase: 'idle', error: null });

  // ---- tiktok video state
  const [tk, setTk] = useState(TK_DEFAULTS);
  const [tkScriptBusy, setTkScriptBusy] = useState(false);
  const [tkAutoWrite, setTkAutoWrite] = useState(0);
  /** "Make a video": the idea + genre + length become a configured TikTok project, opened at the Script step with the script already being written. */
  const startVideo = ({ genreId, concept, lengthPreset, aspect, mode }) => {
    setGenre(genreId);
    const seconds = { '15s': 15, '30s': 30, '60s': 60, '3min': 180 }[lengthPreset] || 30;
    const nScenes = (t) => Math.max(3, Math.min(40, Math.round(seconds / ((t.frames || 124) / 24))));
    if (mode === 'room') {     // develop the story with the producer first; the first message is the idea
      setTk((t) => ({ ...t, concept, aspect, lengthPreset, nScenes: nScenes(t), step: 0, script: null, room: { messages: [{ role: 'user', content: concept }], engine: '', pending: true } }));
      setDetailId(null); setOverlay('tk');
      return;
    }
    setTk((t) => ({ ...t, concept, aspect, lengthPreset, nScenes: nScenes(t), step: 2, script: null }));
    setDetailId(null);
    setOverlay('tk');
    setTkAutoWrite((n) => n + 1);
  };
  const [tkTranscribeBusy, setTkTranscribeBusy] = useState(false);
  const [tkDescribeBusy, setTkDescribeBusy] = useState(false);
  const [tkRenderState, setTkRenderState] = useState({ phase: 'idle', error: null });

  // ---------------------------------------------------------------- assets

  const addAsset = useCallback((blob, kind, name, meta = null) => {
    const asset = {
      id: uid(), kind, name: name || kind,
      mime: blob.type || (kind === 'video' ? 'video/mp4' : 'application/octet-stream'),
      meta, blob, url: URL.createObjectURL(blob),
    };
    setAssets((a) => [...a, asset]);
    return asset;
  }, []);

  const addAssetFromUrl = useCallback(async (url, kind, name, meta = null) => {
    const blob = await (await fetch(url)).blob();
    return addAsset(blob, kind, name, meta);
  }, [addAsset]);

  /** Video asset with its real duration/size read back from the file. */
  const addVideoAssetFromUrl = useCallback(async (url, name, meta = {}) => {
    const blob = await (await fetch(url)).blob();
    const asset = addAsset(blob, 'video', name, meta);
    const m = await videoMeta(asset.url);
    const full = { ...meta, seconds: m.duration || meta.seconds, width: m.width || meta.width, height: m.height || meta.height };
    setAssets((a) => a.map((x) => (x.id === asset.id ? { ...x, meta: full } : x)));
    return { ...asset, meta: full };
  }, [addAsset]);

  const updateAssetMeta = (id, patch) =>
    setAssets((a) => a.map((x) => (x.id === id ? { ...x, meta: { ...(x.meta || {}), ...patch } } : x)));

  /** Swap an asset's underlying image in place (same id) — every scene that
   * already has this character selected in its cast keeps working, no need
   * to re-pick them scene by scene. */
  const replaceAssetBlob = (id, blob) =>
    setAssets((a) => a.map((x) => {
      if (x.id !== id) return x;
      URL.revokeObjectURL(x.url);
      return { ...x, blob, mime: blob.type || x.mime, url: URL.createObjectURL(blob) };
    }));

  const blobKey = (b) =>
    new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(b);
    });

  /** Keep the source drawing (+ its prompt/settings/LoRAs) alongside every generation. */
  const rememberSketch = useCallback(async (blob, settingsSnap, loras = []) => {
    const meta = { prompt: settingsSnap.prompt, settings: { ...settingsSnap }, loras: loras.map((l) => ({ ...l })) };
    const key = await blobKey(blob);
    if (lastSketch.current?.key === key) {
      setAssets((a) => a.map((x) => (x.id === lastSketch.current.id ? { ...x, meta } : x)));
      return lastSketch.current.id;
    }
    const asset = addAsset(blob, 'sketch', settingsSnap.prompt.slice(0, 40) || 'sketch', meta);
    lastSketch.current = { key, id: asset.id };
    return asset.id;
  }, [addAsset]);

  const editSketch = useCallback((asset) => {
    if (asset.meta?.settings) setSketchSettings((p) => ({ ...p, ...asset.meta.settings }));
    else if (asset.meta?.prompt != null) setSketchSettings((p) => ({ ...p, prompt: asset.meta.prompt }));
    if (asset.meta?.loras) setSketchLoras(asset.meta.loras.map((l) => ({ ...l })));
    previewSeq.current++;
    setPreview({ url: null, updating: false });
    sketchApi.current?.loadBlob(asset.blob);
    setDetailId(null);
    setOverlay('sketch');
  }, []);

  const restoreGeneration = useCallback((asset) => {
    const meta = asset.meta || {};
    if (meta.source === 'krea2') {
      if (meta.settings) setKreaSettings((p) => ({ ...p, ...meta.settings }));
      else if (meta.prompt != null) setKreaSettings((p) => ({ ...p, prompt: meta.prompt }));
      if (meta.loras) setLoras(meta.loras.map((l) => ({ ...l })));
      setDetailId(null);
      setOverlay('krea');
      return;
    }
    if (meta.settings) setSketchSettings((p) => ({ ...p, ...meta.settings }));
    else if (meta.prompt != null) setSketchSettings((p) => ({ ...p, prompt: meta.prompt }));
    if (meta.loras) setSketchLoras(meta.loras.map((l) => ({ ...l })));
    previewSeq.current++;
    setPreview({ url: null, updating: false });
    const source = assets.find((a) => a.id === meta.sourceSketchId);
    sketchApi.current?.loadBlob((source || asset).blob);
    setDetailId(null);
    setOverlay('sketch');
  }, [assets]);

  const remixImage = useCallback((asset) => {
    setSketchSettings((p) => ({
      ...p,
      sketchBlur: 0,
      ...(asset.meta?.prompt ? { prompt: asset.meta.prompt } : {}),
    }));
    previewSeq.current++;
    setPreview({ url: null, updating: false });
    sketchApi.current?.loadBlob(asset.blob);
    setDetailId(null);
    setOverlay('sketch');
  }, []);

  const editKrea = useCallback((asset) => {
    if (asset.meta?.settings) setKreaSettings((p) => ({ ...p, ...asset.meta.settings }));
    else if (asset.meta?.prompt != null) setKreaSettings((p) => ({ ...p, prompt: asset.meta.prompt }));
    if (asset.meta?.loras) setLoras(asset.meta.loras.map((l) => ({ ...l })));
    setDetailId(null);
    setOverlay('krea');
  }, []);

  const editFlux = useCallback((asset) => {
    if (asset.meta?.settings) setFluxSettings((p) => ({ ...p, ...asset.meta.settings, rig: { ...DEFAULT_RIG, ...(asset.meta.settings.rig || {}) } }));
    if (asset.meta?.loras) setFluxLoras(asset.meta.loras.map((l) => ({ ...l })));
    setDetailId(null);
    setOverlay('flux3');
  }, []);

  const deleteAsset = (id) => {
    setAssets((a) => a.filter((x) => x.id !== id));
    setScenes((s) => s.map((sc) => ({
      ...sc,
      assetId: sc.assetId === id ? null : sc.assetId,
      videoAssetId: sc.videoAssetId === id ? null : sc.videoAssetId,
      cast: sc.cast?.includes(id) ? sc.cast.filter((c) => c !== id) : sc.cast,
      styleRefs: sc.styleRefs?.includes(id) ? sc.styleRefs.filter((c) => c !== id) : sc.styleRefs,
    })));
    setMv((m) => ({
      ...m,
      trackAssetId: m.trackAssetId === id ? null : m.trackAssetId,
      analysis: m.trackAssetId === id ? null : m.analysis,
      castIds: m.castIds.filter((c) => c !== id),
      styleIds: m.styleIds.filter((c) => c !== id),
      finalAssetId: m.finalAssetId === id ? null : m.finalAssetId,
    }));
    setTk((m) => ({
      ...m,
      sourceAssetIds: m.sourceAssetIds.filter((c) => c !== id),
      castIds: m.castIds.filter((c) => c !== id),
      finalAssetId: m.finalAssetId === id ? null : m.finalAssetId,
    }));
  };

  // ---------------------------------------------------------------- scenes

  /** "Send to Timeline": put any video / image / audio from the Board or Gallery straight onto the timeline (video & images join the end of the main track). */
  const [tlNote, setTlNote] = useState(null);
  useEffect(() => { if (!tlNote) return undefined; const t = setTimeout(() => setTlNote(null), 7000); return () => clearTimeout(t); }, [tlNote]);
  const sendToTimeline = async (assetId) => {
    const a = assetsRef.current.find((k) => k.id === assetId);
    if (!a) { setTlNote({ text: 'That item is not available on this screen yet. Reload and try again.' }); return; }
    const isAud = a.kind === 'audio' || String(a.mime || '').startsWith('audio');
    const isImg = !isAud && !isVideoAsset(a);
    const secs = isImg ? 4 : await new Promise((res) => {
      if (a.meta?.seconds) { res(a.meta.seconds); return; }
      const el = document.createElement(isAud ? 'audio' : 'video');
      el.preload = 'metadata';
      el.onloadedmetadata = () => res(Number.isFinite(el.duration) ? el.duration : 4);
      el.onerror = () => res(4);
      el.src = a.url;
    });
    const track = isAud ? 'audio' : 'v1';
    const clip = clipFromAsset(a, track, 0, secs);
    setTimeline((tl) => addClipToTrack(tl, track, clip));
    setTlNote({ text: `Added “${(a.meta?.name || a.name || 'clip').slice(0, 40)}” to the Timeline`, open: true });
  };

  const isVideoAsset = (a) => !!a && (a.kind === 'video' || String(a.mime || '').startsWith('video'));

  /** A video dropped on the Board becomes a finished video scene: the clip plays on the card and in the detail view,
   * and its first frame is the scene's picture (a video can never be the "still" an <img> draws). */
  const videoToScene = async (a, x, y, extra = {}) => {
    let still = null;
    try { still = addAsset(await runFfmpegTool(a.blob, 'first_frame', {}), 'image', `${a.name || 'clip'} · first frame`, { source: 'video-frame' }); } catch { /* the clip still plays without a picture */ }
    const w = a.meta?.width, h = a.meta?.height;
    const aspect = w && h ? (w / h > 1.2 ? '16:9' : w / h < 0.8 ? '9:16' : '1:1') : (a.meta?.aspect || '9:16');
    const sc = newScene(still?.id || null, x, y, { title: a.name || '', stillPrompt: a.meta?.prompt || '', aspect, videoAssetId: a.id, ...extra });
    setScenes((cur) => [...cur, sc]);
    return sc;
  };

  const addSceneFromAsset = (assetId, x, y) => {
    const a = assets.find((k) => k.id === assetId);
    if (!a || a.kind === 'audio' || a.kind === 'styleref' || a.kind === 'storyref') return;
    if (isVideoAsset(a)) { videoToScene(a, x, y); return; }
    setScenes((s) => [...s, newScene(assetId, x, y, {
      stillPrompt: a.meta?.prompt || '', aspect: a.meta?.aspect || '9:16',
      ...(a.kind === 'character' ? { cast: [assetId] } : {}),
    })]);
  };

  /** A video whose file type came through generic (application/octet-stream) was invisible to the Timeline's Video tab and
   * drawn as a broken image elsewhere. Re-label it once, wherever it came from (phone, autosave, shared session). */
  useEffect(() => {
    const bad = (a) => a.kind === 'video' && !String(a.mime || '').startsWith('video');
    if (!assets.some(bad)) return;
    setAssets((cur) => cur.map((a) => {
      if (!bad(a)) return a;
      const blob = a.blob ? new Blob([a.blob], { type: 'video/mp4' }) : a.blob;
      return { ...a, mime: 'video/mp4', blob, url: blob ? URL.createObjectURL(blob) : a.url };
    }));
  }, [assets]);

  /** Repair scenes that an older build created with a VIDEO in the picture slot (they showed as a broken image and had no clip to open). */
  const repairedScenes = useRef(new Set());
  useEffect(() => {
    for (const sc of scenes) {
      const a = sc.assetId ? assets.find((k) => k.id === sc.assetId) : null;
      if (!a || !isVideoAsset(a) || repairedScenes.current.has(sc.id)) continue;
      repairedScenes.current.add(sc.id);
      (async () => {
        let still = null;
        try { still = addAsset(await runFfmpegTool(a.blob, 'first_frame', {}), 'image', `${a.name || 'clip'} · first frame`, { source: 'video-frame' }); } catch { /* keep going without a picture */ }
        setScenes((cur) => cur.map((x) => (x.id === sc.id && x.assetId === a.id ? { ...x, videoAssetId: x.videoAssetId || a.id, assetId: still?.id || null } : x)));
        window.__hfDirty = true;                 // share the repair with the other screens even though it happened right after load
      })();
    }
  }, [scenes, assets]);

  const boardCenter = () => ({
    x: (window.innerWidth / 2 - view.x) / view.k - 150 + Math.random() * 60,
    y: (window.innerHeight / 2 - view.y) / view.k - 120 + Math.random() * 60,
  });

  const addToBoardCenter = (assetId) => {
    const c = boardCenter();
    addSceneFromAsset(assetId, c.x, c.y);
  };

  /** Empty prompt-first scene: write a still prompt, generate the still, then the clip. */
  const addEmptyScene = () => {
    const c = boardCenter();
    const sc = newScene(null, c.x, c.y, { aspect: mv.aspect || '9:16' });
    setScenes((s) => [...s, sc]);
    setDetailId(sc.id);
  };

  const updateScene = (id, patch) =>
    setScenes((s) => s.map((sc) => (sc.id === id ? { ...sc, ...patch } : sc)));

  const moveScene = (id, x, y) => updateScene(id, { x, y });
  const deleteScene = (id) => setScenes((s) => s.filter((sc) => sc.id !== id));

  const characterAssets = assets.filter((a) => a.kind === 'character');
  const styleRefAssets = assets.filter((a) => a.kind === 'styleref');

  /** Krea 2 still for a scene: its still prompt, the scene's aspect, cast faces
   * pinned by ReActor (left→right), style/environment references as Krea 2's
   * own vision-conditioning moodboard (needs a bf16 text encoder — auto-picked
   * for this call only, the Krea panel's own setting is left alone), and the
   * Krea panel's model/LoRA choices. Resolves to the new asset (or throws). */
  const generateSceneStill = async (id) => {
    const scene = scenesRef.current.find((s) => s.id === id);
    if (!scene || !(scene.stillPrompt || '').trim()) return null;
    const setG = (g) => updateScene(id, { gen: g });
    setG({ phase: 'run', progress: 0, status: 'Still: submitting…' });
    let jobId = null;
    try {
      const { width, height } = stillSizeFor(scene.aspect || '9:16');
      const castAssets = (scene.cast || [])
        .map((cid) => assetsRef.current.find((a) => a.id === cid))
        .filter(Boolean);
      const faceEntries = castAssets.map((a, i) => ({ index: i, blob: a.blob }));
      const moodboardBlobs = (scene.styleRefs || [])
        .map((rid) => assetsRef.current.find((a) => a.id === rid))
        .filter(Boolean)
        .map((a) => a.blob);
      let textEncoder = kreaSettings.textEncoder || '';
      if (moodboardBlobs.length && imageEngine !== 'flux3') {
        // moodboard images need Krea2's vision path (TextEncodeKrea2), which
        // only a bf16/fp16 text encoder can run — an fp8 one silently can't.
        // Must also be a Qwen3-VL file specifically (Krea2's own text encoder
        // family) — ComfyUI's /api/text_encoders list is shared across every
        // model family installed, and a *plain* /bf16|fp16/ match can land on
        // an unrelated bf16 file from another pipeline (e.g. an LTX text/
        // embeddings connector), which ComfyUI then fails to load as a CLIP
        // model with an opaque "Expecting value" JSON error.
        const encoders = await listTextEncoders();
        const bf16 = encoders.find((e) => /qwen3vl/i.test(e) && /bf16|fp16/i.test(e));
        if (!bf16) throw new Error('Style/environment references need a Qwen3-VL bf16 text encoder installed in ComfyUI (none found) — remove the references or install one (e.g. qwen3vl_4b_bf16.safetensors).');
        textEncoder = bf16;
      }
      const scriptStyle = scene.mv ? mv.script?.style : scene.tk ? tk.script?.style : '';
      const stylePrompt = (scriptStyle && !scene.stillPrompt.includes(scriptStyle)) ? `, ${scriptStyle}` : '';
      let prompt = withStill(`${scene.stillPrompt.trim()}${stylePrompt}`);
      // Each still is generated fresh with no memory of other shots — face-swap
      // only replaces the face region, so hair/build/wardrobe only stay
      // consistent with the reference photo if restated here every time (same
      // safety net the AI director applies to its own shot lists).
      for (const a of castAssets) {
        const name = a.meta?.name;
        const desc = (a.meta?.description || '').trim();
        if (name && desc && !prompt.toLowerCase().includes(desc.slice(0, 20).toLowerCase())) {
          prompt = `${prompt} ${name}: ${desc}.`.trim();
        }
      }
      // Wardrobe lock: each shot is generated on its own, so the outfit is restated last (and strongly) every time.
      if (castAssets.some((a) => (a.meta?.outfit || '').trim())) {   // drop clothing the script improvised, so it can't fight the locked outfit
        prompt = prompt.replace(/\b(?:(?:a|an|her|his|the|grey|gray|red|black|dark|knit|woolen|wool|puffer|winter|green|blue|white|long|oversized)\s+){0,3}(?:beanie|hat|hoodie|parka|jacket|coat|dress|sweater|jeans|scarf|gloves|jumpsuit|t-shirt|shirt)\b/gi, 'her outfit').replace(/(her outfit[, ]*){2,}/gi, 'her outfit ');
      }
      for (const a of castAssets) {
        const outfit = (a.meta?.outfit || '').trim();
        if (a.meta?.name && outfit) prompt = `${prompt} ${a.meta.name} wears exactly this outfit in this shot, identical in every shot of the video, no other clothing or accessories on ${a.meta.name}: ${outfit}.`;
      }
      if (imageEngine === 'flux3') {
        // Flux 3: cast photos + style/environment refs become ReferenceLatent
        // inputs (character consistency without face-swap); the project-wide
        // Cinema rig acts as the DP for every still.
        // full-body views first: they are what pins the outfit (face-only views can't)
        const viewBlobs = castAssets.flatMap((a) => (a.meta?.refIds || [])
          .map((vid) => assetsRef.current.find((x) => x.id === vid)).filter(Boolean)
          .sort((x, y) => (/^Full body/i.test(y.meta?.view || '') ? 1 : 0) - (/^Full body/i.test(x.meta?.view || '') ? 1 : 0))
          .slice(0, 2).map((x) => x.blob));
        // location / prop continuity: another shot's still is passed as a reference, so the same room and objects come back (made first if it does not exist yet)
        let placeBlob = null;
        if (scene.refSceneId && scene.refSceneId !== id) {
          const rs = scenesRef.current.find((s) => s.id === scene.refSceneId);
          let ra = assetsRef.current.find((a) => a.id === rs?.assetId);
          if (rs && !ra) { setG({ phase: 'run', progress: 0, status: 'Still: making the reference shot first…' }); ra = await generateSceneStill(rs.id); setG({ phase: 'run', progress: 0, status: 'Still: submitting…' }); }
          if (ra) placeBlob = ra.blob;
        }
        const placeNote = placeBlob ? ' The last reference image shows the same location: keep exactly the same room, furniture, windows, lighting, colours and props (the same lamp, the same bookshelf) as in it, and change only what this shot asks for.' : '';
        const refBlobs = [...castAssets.map((a) => a.blob), ...viewBlobs, ...moodboardBlobs, ...(placeBlob ? [placeBlob] : [])];
        const refNote = scene.refNote
          ? scene.refNote
          : (refBlobs.length - (placeBlob ? 1 : 0)) > 0
          ? ` ${castAssets.length ? `Keep the exact face, hair, build and clothing (same outfit in every shot) of the ${castAssets.length === 1 ? 'person' : 'people'} shown in the first ${castAssets.length + viewBlobs.length} reference image${castAssets.length + viewBlobs.length === 1 ? '' : 's'} (extra views of the same ${castAssets.length === 1 ? 'person' : 'people'}).` : ''}${moodboardBlobs.length ? ' Match the style and environment of the remaining reference images.' : ''}${placeNote}`
          : placeNote;
        const fprompt = withRig(`${prompt}${refNote}`, fluxSettings.rig);
        const fres = await generateFlux3(
          {
            prompt: fprompt, width, height, steps: fluxSettings.steps, cfg: fluxSettings.cfg,
            seed: scene.stillSeed ?? -1, upsample: fluxSettings.upsample,
            swap_model: fluxSettings.swapModel || 'inswapper_128.onnx',
            face_restore_model: fluxSettings.faceRestoreModel || 'none',
          },
          refBlobs,
          fluxSettings.faceSwapScenes ? faceEntries : [],
          fluxLoras.filter((l) => l.name).map((l) => ({ name: l.name, strength: l.strength })),
          (ev) => {
            if (ev.type === 'submitted') jobId = ev.jobId;
            if (ev.type === 'progress') setG({ phase: 'run', jobId, progress: ev.max ? ev.value / ev.max : 0, status: `Still: sampling ${ev.value}/${ev.max}` });
            else if (ev.type === 'status') setG({ phase: 'run', jobId, progress: 0, status: `Still: ${ev.text}` });
          }
        );
        const fimg = await addAssetFromUrl(fres.url, 'image', scene.title || scene.stillPrompt.slice(0, 40), {
          prompt: fres.prompt || fprompt, source: 'flux3', sceneId: id, aspect: scene.aspect,
          settings: { ...fluxSettings, prompt, width, height, seed: fres.seed ?? scene.stillSeed },
          loras: fluxLoras.filter((l) => l.name).map((l) => ({ ...l })),
        });
        updateScene(id, { assetId: fimg.id, gen: { phase: 'idle' } });
        return fimg;
      }
      const result = await generateKrea(
        {
          prompt, width, height,
          steps: kreaSettings.steps, cfg: kreaSettings.cfg, seed: scene.stillSeed ?? -1,
          gguf_model: kreaSettings.ggufModel || '', text_encoder: textEncoder,
          vae: kreaSettings.vae || '', enhancer_strength: kreaSettings.enhancerStrength ?? 0,
          swap_model: kreaSettings.swapModel || 'inswapper_128.onnx',
          face_restore_model: kreaSettings.faceRestoreModel || 'none',
        },
        moodboardBlobs,
        faceEntries,
        loras.filter((l) => l.name).map((l) => ({ name: l.name, strength: l.strength })),
        (ev) => {
          if (ev.type === 'submitted') jobId = ev.jobId;
          if (ev.type === 'progress') setG({ phase: 'run', jobId, progress: ev.max ? ev.value / ev.max : 0, status: `Still: sampling ${ev.value}/${ev.max}` });
          else if (ev.type === 'status') setG({ phase: 'run', jobId, progress: 0, status: `Still: ${ev.text}` });
        }
      );
      const img = await addAssetFromUrl(result.url, 'image', scene.title || scene.stillPrompt.slice(0, 40), {
        prompt, source: 'krea2', sceneId: id, aspect: scene.aspect,
        settings: { ...kreaSettings, prompt, width, height, seed: result.seed ?? scene.stillSeed },
        loras: loras.filter((l) => l.name).map((l) => ({ ...l })),
      });
      updateScene(id, { assetId: img.id, gen: { phase: 'idle' } });
      return img;
    } catch (e) {
      setG(e.message === 'Cancelled' ? { phase: 'idle' } : { phase: 'error', error: e.message });
      throw e;
    }
  };

  /** Scene clip: MiniMax H3 from the still (default) or LTX 2.3 (legacy). */
  const generateScene = async (id) => {
    const scene = scenesRef.current.find((s) => s.id === id);
    const asset = resolveDisplayAsset(assetsRef.current.find((a) => a.id === scene?.assetId), assetsRef.current);
    if (!scene || !asset) return null;
    const setG = (g) => updateScene(id, { gen: g });
    setG({ phase: 'run', progress: 0, status: 'Uploading…' });
    let jobId = null;
    const onEvent = (ev) => {
      if (ev.type === 'submitted') jobId = ev.jobId;
      if (ev.type === 'progress') setG({ phase: 'run', jobId, progress: ev.max ? ev.value / ev.max : 0, status: `Sampling ${ev.value}/${ev.max}` });
      else if (ev.type === 'status') setG({ phase: 'run', jobId, progress: 0, status: ev.text });
    };
    try {
      let result, meta;
      if ((scene.engine || 'h3') === 'h3') {
        const ratio = await imageAspect(asset.url);
        const { width, height } = canvasFor(ratio, scene.draft ? Math.min(scene.megapixels ?? 0.4, 0.25) : (scene.megapixels ?? 0.4));
        const castNames = (scene.cast || []).map((cid) => assetsRef.current.find((a) => a.id === cid)?.meta?.name).filter(Boolean);
        const params = {
          description: sceneDescription(scene, castNames),
          soundscape: scene.soundscape || '',
          music: scene.music ?? 'No music.',
          frames: scene.frames || 124,
          width, height,
          seed: scene.seed ?? -1,
          preset: scene.draft ? 'fast' : (scene.preset || 'fast'),
          steps: scene.steps ?? 8,
          sampler: scene.sampler || '',
          shift_video: scene.shiftVideo ?? 12,
          shift_audio: scene.shiftAudio ?? 3,
          lock_still: scene.lockStill !== false,
          h3_loras: h3LoraParams(scene.h3Loras),
        };
        result = await generateH3(asset.blob, params, [], onEvent);
        meta = { source: 'h3', sceneId: id, seed: result.seed, settings: params, width, height, seconds: (scene.frames || 124) / 24, draft: !!scene.draft };
      } else if (scene.engine === 'wan') {
        const ratio = await imageAspect(asset.url);
        const cat = await wanModels();
        const pairs = pairWanLoras(cat?.loras || []);
        const chosen = (scene.wanLoras || []).map((l) => ({ p: pairs.find((x) => x.id === l.pair), s: l.strength })).filter((x) => x.p);
        const params = {
          prompt: withMotion([scene.stillPrompt?.trim(), scene.prompt?.trim()].filter(Boolean).join(' ')),
          seconds: scene.wanSeconds ?? 5, aspect: `${Math.round(ratio * 1000)}:1000`, megapixels: scene.draft ? Math.min(scene.wanMp ?? 0.4, 0.15) : (scene.wanMp ?? 0.4),
          seed: scene.seed ?? -1, lightning: scene.wanLightning !== false, smooth: scene.draft ? false : scene.wanSmooth !== false, single_expert: scene.draft ? 'high' : '',
        };
        result = await generateWan(asset.blob, params, chosen.map((x) => ({ high: x.p.high, low: x.p.low, strength: x.s })), null, onEvent);
        meta = { source: 'wan', sceneId: id, seed: result.seed, settings: params, seconds: params.seconds, draft: !!scene.draft };
      } else {
        const dims = await new Promise((res) => {
          const img = new Image();
          img.onload = () => {
            const scale = Math.min(1, 768 / Math.max(img.naturalWidth, img.naturalHeight));
            res({
              width: Math.max(64, Math.round((img.naturalWidth * scale) / 32) * 32),
              height: Math.max(64, Math.round((img.naturalHeight * scale) / 32) * 32),
            });
          };
          img.onerror = () => res({ width: 768, height: 448 });
          img.src = asset.url;
        });
        result = await generateI2V(
          asset.blob,
          {
            prompt: withMotion(scene.prompt), negative_prompt: DEFAULTS.negative,
            width: dims.width, height: dims.height,
            num_frames: quantizeFrames(scene.seconds, scene.fps ?? 24), fps: scene.fps ?? 24,
            steps: scene.steps, cfg: scene.cfg ?? 3.0, seed: scene.seed ?? -1,
            gguf_model: scene.ggufModel || '',
          },
          (scene.loras || []).filter((l) => l.name).map((l) => ({ name: l.name, strength: l.strength })),
          onEvent
        );
        meta = { source: 'ltx', sceneId: id, seed: result.seed, seconds: scene.seconds };
      }
      let clipUrl = result.url;
      const gn = getGenre();
      if (gn.post && (getAutoPost() || getAutoSound())) {     // the genre's finishing: camera look, then sound design that reacts to the footage's jolts
        try {
          let cur = await (await fetch(result.url)).blob();
          const seed = Math.floor(Math.random() * 999);
          if (getAutoPost() && !ONCE_LOOKS.has(gn.post)) {     // 'repost' looks (tiktok / ugc / doorbell) are applied once, to the whole cut, never baked into each clip
            setG({ phase: 'run', jobId, progress: 0.96, status: `Applying the ${gn.label} camera look…` });
            const o = gn.post_opts || {};
            cur = await runFfmpegTool(new File([cur], 'clip.mp4', { type: 'video/mp4' }), 'footage', { preset: gn.post, shake: o.shake, focus: focusLevel(o.focus), glitches: o.glitches, wear: o.wear, seed, audio: getAutoSound() ? 'degrade' : 'passthrough' });
            meta = { ...meta, genre: gn.id, camera_look: gn.post };
          }
          if (getAutoSound() && gn.sound_opts) {
            setG({ phase: 'run', jobId, progress: 0.98, status: 'Designing the sound…' });
            cur = await runFfmpegTool(new File([cur], 'clip.mp4', { type: 'video/mp4' }), 'sound', { ...gn.sound_opts, seed });
            meta = { ...meta, sound_design: true };
          }
          clipUrl = URL.createObjectURL(cur);
        } catch (e) { console.warn('genre finishing skipped:', e.message); }
      }
      const vid = await addVideoAssetFromUrl(clipUrl, `${scene.title || 'scene'} clip`, meta);
      updateScene(id, { videoAssetId: vid.id, gen: { phase: 'idle' } });
      return vid;
    } catch (e) {
      // user cancellation isn't a failure — just return to ready
      setG(e.message === 'Cancelled' ? { phase: 'idle' } : { phase: 'error', error: e.message });
      throw e;
    }
  };

  const safe = (fn) => (id) => fn(id).catch(() => {});

  // ---------------------------------------------------------------- music video

  const mvSetTrack = async (file) => {
    const analysis = await mvAnalyze(file);
    setMv((m) => {
      if (m.trackAssetId) setAssets((a) => a.filter((x) => x.id !== m.trackAssetId));
      return m;
    });
    const asset = addAsset(file, 'audio', file.name.replace(/\.[^.]+$/, ''), { analysis: { duration: analysis.duration, bpm: analysis.bpm } });
    setMv((m) => ({
      ...m, trackAssetId: asset.id, analysis,
      range: { start: 0, end: Math.round(analysis.duration * 10) / 10 },
      cut: { ...m.cut, pieces: [] },
    }));
  };

  const mvRemoveTrack = () => {
    if (mv.trackAssetId) deleteAsset(mv.trackAssetId);
    setMv((m) => ({ ...m, trackAssetId: null, analysis: null, range: null, cut: { ...m.cut, pieces: [] } }));
  };

  const mvAddCharacters = (files) => {
    const ids = files.map((f) => {
      const stem = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
      // ComfyUI/stock-photo filenames are often pure digits (e.g. "00000-565302792.png")
      // — that's not a usable character name, so leave it blank rather than silently
      // feeding "00000 565302792" into every prompt; the empty Name field's
      // placeholder makes it obvious it still needs to be typed in
      const looksLikeName = /[a-z]{2}/i.test(stem);
      return addAsset(f, 'character', stem || 'character', {
        name: looksLikeName ? stem.slice(0, 40) : '', description: '',
      }).id;
    });
    setMv((m) => ({ ...m, castIds: [...m.castIds, ...ids] }));
  };

  const mvDescribeCharacter = async (id) => {
    const a = assets.find((x) => x.id === id);
    if (!a) return;
    updateAssetMeta(id, { describing: true });
    try {
      const r = await describeImage(a.blob, 'vision');
      updateAssetMeta(id, { description: r.prompt, describing: false });
    } catch (e) {
      updateAssetMeta(id, { describing: false });
      alert(`Describe failed: ${e.message}`);
    }
  };

  /** Environment/mood-board reference images: kept as their own asset kind so
   * they're excluded from becoming board scenes, and used two ways — the raw
   * images condition Krea 2's own vision path (moodboard) when generating a
   * scene's still, and "Describe style" below folds them into the shared
   * Visual style text the director writes every scene against. */
  const mvAddStyleRefs = (files) => {
    const ids = files.map((f) => addAsset(f, 'styleref', f.name.replace(/\.[^.]+$/, '')).id);
    setMv((m) => ({ ...m, styleIds: [...m.styleIds, ...ids] }));
  };

  const mvRemoveStyleRef = (id) => deleteAsset(id);

  const [styleDescribeBusy, setStyleDescribeBusy] = useState(false);
  const [styleDescribeMsg, setStyleDescribeMsg] = useState('');

  const mvDescribeStyle = async () => {
    const blobs = mv.styleIds.map((sid) => assets.find((a) => a.id === sid)?.blob).filter(Boolean);
    if (!blobs.length) return;
    setStyleDescribeBusy(true);
    setStyleDescribeMsg('');
    try {
      const r = await describeImagesStyle(blobs);
      setMv((m) => ({ ...m, style: m.style.trim() ? `${m.style.trim().replace(/,\s*$/, '')}, ${r.style}` : r.style }));
      setStyleDescribeMsg(`✓ Added to Visual style, from ${blobs.length} reference${blobs.length > 1 ? 's' : ''} (${r.model}).`);
    } catch (e) {
      alert(`Describe failed: ${e.message}`);
    } finally {
      setStyleDescribeBusy(false);
    }
  };

  const mvWriteScript = async () => {
    if (!mv.analysis) return;
    setScriptBusy(true);
    setMv((m) => ({ ...m, scriptError: null }));
    try {
      const range = mv.range || { start: 0, end: mv.analysis.duration };
      // the director only needs to plan for the part of the song being edited
      const sections = (mv.analysis.sections || [])
        .filter((s) => s.end > range.start && s.start < range.end)
        .map((s) => ({ ...s, start: Math.max(s.start, range.start), end: Math.min(s.end, range.end) }));
      const analysis = { ...mv.analysis, duration: range.end - range.start, sections, beats: undefined, energy: undefined };
      const cast = mv.castIds.map((cid) => assets.find((a) => a.id === cid)).filter(Boolean)
        .map((a) => ({ name: a.meta?.name || a.name, description: a.meta?.description || '' }));
      const script = await mvScript({
        analysis, cast, concept: mv.concept, style: mv.style, lyrics: mv.lyrics, aspect: mv.aspect,
        n_scenes: mv.nScenes, max_seconds: mv.frames / 24, use_llm: mv.useLlm && !!health?.ollama, model: mv.llmModel || '',
        seed: Math.floor(Math.random() * 1e6),
      });
      // section indexes refer to the filtered list; map them back onto the full analysis
      const fullSections = mv.analysis.sections || [];
      const remap = sections.map((s) => fullSections.findIndex((f) => f.start <= s.start && f.end >= s.end) + 1);
      const remapIdx = (idx) => remap[idx - 1] || idx;
      script.scenes = script.scenes.map((s) => ({
        ...s, frames: s.frames || mv.frames,
        section: remapIdx(s.section),
        sections: (s.sections || [s.section]).map(remapIdx),
      }));
      script.setups = (script.setups || []).map((su) => ({ ...su, sections: (su.sections || []).map(remapIdx) }));
      setMv((m) => ({ ...m, script }));
    } catch (e) {
      setMv((m) => ({ ...m, scriptError: e.message }));
    } finally {
      setScriptBusy(false);
    }
  };

  /** Script scenes → board cards (only those not yet placed). */
  const mvScenesToBoard = () => {
    if (!mv.script) return;
    const castByName = new Map(mv.castIds.map((cid) => {
      const a = assets.find((x) => x.id === cid);
      return [((a?.meta?.name || a?.name || '')).toLowerCase(), cid];
    }));
    const existingMv = scenes.filter((s) => s.mv).length;
    const created = [];
    const script = { ...mv.script, scenes: mv.script.scenes.map((sc, i) => {
      if (sc.sceneId && scenes.some((s) => s.id === sc.sceneId)) return sc;
      const n = existingMv + created.length;
      const col = n % 4, row = Math.floor(n / 4);
      const scene = newScene(null, 40 + col * 340, 60 + row * 420, {
        mv: true, mvIndex: n, title: sc.title, location: sc.location, timeOfDay: sc.timeOfDay,
        section: sc.section, sections: sc.sections || [sc.section], sectionLabel: sc.sectionLabel, energy: sc.energy,
        setupId: sc.setupId, setupName: sc.setupName, shotSize: sc.shotSize, continuity: sc.continuity,
        stillPrompt: sc.stillPrompt, prompt: sc.motionPrompt, dialogue: sc.dialogue || '',
        soundscape: sc.soundscape || '', music: 'No music.',
        cast: (sc.characters || []).map((nm) => castByName.get(nm.toLowerCase())).filter(Boolean),
        styleRefs: [...mv.styleIds],
        aspect: mv.aspect, frames: sc.frames || mv.frames, preset: mv.preset,
      });
      created.push(scene);
      return { ...sc, sceneId: scene.id };
    }) };
    if (created.length) setScenes((s) => [...s, ...created]);
    setMv((m) => ({ ...m, script }));
    setView({ x: 20, y: 40, k: Math.min(1, (window.innerWidth - 60) / (4 * 340)) });
  };

  const focusScenes = () => setView({ x: 20, y: 40, k: Math.min(1, (window.innerWidth - 60) / (4 * 340)) });

  /** Sequential batch over the music-video / tiktok-video scenes (one GPU job at a time). */
  const runBatch = async (kind) => {
    batchAbort.current = false;
    const order = scenesRef.current.filter((s) => s.mv || s.tk)
      .sort((a, b) => (a.mv ? a.mvIndex ?? 0 : a.ttIndex ?? 0) - (b.mv ? b.mvIndex ?? 0 : b.ttIndex ?? 0));
    const steps = [];
    if (kind === 'stills' || kind === 'all') order.filter((s) => !s.assetId && (s.stillPrompt || '').trim()).forEach((s) => steps.push(['still', s.id]));
    if (kind === 'clips' || kind === 'all') order.filter((s) => !s.videoAssetId && (s.assetId || kind === 'all')).forEach((s) => steps.push(['clip', s.id]));
    if (!steps.length) return;
    setBatch({ phase: 'run', kind, done: 0, total: steps.length, current: '' });
    for (let i = 0; i < steps.length; i++) {
      if (batchAbort.current) break;
      const [what, id] = steps[i];
      const sc = scenesRef.current.find((s) => s.id === id);
      if (!sc) continue;
      setBatch({ phase: 'run', kind, done: i, total: steps.length, current: `${what}: ${sc.title || id}` });
      try {
        if (what === 'still') await generateSceneStill(id);
        else if (scenesRef.current.find((s) => s.id === id)?.assetId) await generateScene(id);
      } catch (e) {
        if (e.message === 'Cancelled') break;
        // errors are shown on the card; keep going with the rest
      }
    }
    setBatch({ phase: 'done', kind, done: steps.length, total: steps.length, current: '' });
  };

  const stopBatch = () => { batchAbort.current = true; };

  const mvRenderFinal = async () => {
    if (!(mv.cut.pieces || []).length) return;
    setRenderState({ phase: 'run', error: null });
    try {
      // The cached cut can go stale — it's a snapshot taken whenever "Build
      // cut"/"Reshuffle" last ran, so a clip regenerated afterward (same
      // scene, new videoAssetId) would otherwise render the OLD clip even
      // though the board/produce list already shows the new one. Rebuild
      // from each scene's CURRENT videoAssetId (same style/seed, so the
      // chosen arrangement/pacing stays the same) right before rendering.
      const order = scenesRef.current.filter((s) => s.mv).sort((a, b) => (a.mvIndex ?? 0) - (b.mvIndex ?? 0));
      const clipsForEdl = order
        .filter((s) => s.videoAssetId && assetsRef.current.find((a) => a.id === s.videoAssetId))
        .map((s) => {
          const v = assetsRef.current.find((a) => a.id === s.videoAssetId);
          return {
            sceneId: s.id, assetId: s.videoAssetId, duration: v?.meta?.seconds || (s.frames || 124) / 24,
            sections: s.sections || (s.section ? [s.section] : []), setupId: s.setupId || s.id, energy: s.energy,
          };
        });
      const pieces = buildEdl(mv.analysis, clipsForEdl, {
        style: mv.cut.style, seed: mv.cut.seed, start: mv.range?.start ?? 0, end: mv.range?.end ?? mv.analysis?.duration,
      });
      if (!pieces.length) throw new Error('No clips available to render.');
      setMv((m) => ({ ...m, cut: { ...m.cut, pieces } }));
      const ids = [...new Set(pieces.map((p) => p.assetId))];
      const clips = ids.map((id) => ({ id, blob: assets.find((a) => a.id === id)?.blob })).filter((c) => c.blob);
      const first = assets.find((a) => a.id === ids[0]);
      let width = first?.meta?.width || 0, height = first?.meta?.height || 0;
      if (!width || !height) {
        const m = await videoMeta(first.url);
        width = m.width; height = m.height;
      }
      const ratio = width / height || aspectRatio(mv.aspect);
      if (mv.cut.size === '1080') { const s = ratio >= 1 ? 1920 / width : 1920 / height; width = Math.round(width * s / 2) * 2; height = Math.round(height * s / 2) * 2; }
      if (mv.cut.size === '720') { const s = ratio >= 1 ? 1280 / width : 1280 / height; width = Math.round(width * s / 2) * 2; height = Math.round(height * s / 2) * 2; }
      const track = assets.find((a) => a.id === mv.trackAssetId);
      const blob = await mvRender({
        edl: toBackendEdl(pieces), clips, music: track?.blob ? new File([track.blob], `${track.name}.mp3`) : null,
        width, height, musicGain: mv.cut.musicGain, clipGain: mv.cut.clipGain,
        musicOffset: mv.range?.start ?? 0, fadeOut: mv.cut.fadeOut,
      });
      const asset = addAsset(blob, 'video', `${mv.script?.title || 'music video'} — final`, { source: 'final', pieces: pieces.length, width, height });
      setMv((m) => ({ ...m, finalAssetId: asset.id }));
      setRenderState({ phase: 'done', error: null });
    } catch (e) {
      setRenderState({ phase: 'error', error: e.message });
    }
  };

  // ---------------------------------------------------------------- tiktok video

  const tkAddSource = (files) => {
    const ids = files.map((f) => addAsset(f, 'storyref', f.name.replace(/\.[^.]+$/, '')).id);
    setTk((m) => ({ ...m, sourceAssetIds: [...m.sourceAssetIds, ...ids] }));
  };

  const tkRemoveSource = (id) => deleteAsset(id);

  /** Make a character's face once (a clean portrait from a description) so every shot can pin the same person. */
  const tkGenerateCharacter = async (name, description) => {
    const prompt = `A photorealistic portrait photograph of ${description.trim() || name}. Head and shoulders, looking at the camera with a calm neutral expression, plain softly lit background, natural skin texture and pores, sharp focus, a clear well-lit face.`;
    const res = await generateFlux3({ prompt, width: 832, height: 1024, steps: 8, cfg: 1, seed: -1 }, [], [], [], () => {});
    const asset = await addAssetFromUrl(res.url, 'character', name, { name: name.trim(), description: description.trim(), source: 'generated-character', refIds: [] });
    // character sheet: a full-body view so the outfit is pinned, not just the face
    try {
      const portrait = await (await fetch(res.url)).blob();
      const fb = await generateFlux3({ prompt: `Show the exact same person from image 1 as a full-body shot standing relaxed, head to toe, facing the camera, on a plain neutral light-grey studio background with soft even lighting. Keep the face, hair, skin tone, age identical to image 1. She/he wears: ${description.trim()}.`, width: 768, height: 1152, steps: 8, cfg: 1, seed: -1 }, [portrait], [], [], () => {});
      const body = await addAssetFromUrl(fb.url, 'image', `${name} · Full body front`, { characterId: asset.id, view: 'Full body front', source: 'flux3' });
      updateAssetMeta(asset.id, { refIds: [body.id] });
    } catch (e) { console.warn('full-body sheet failed:', e.message); }
    setTk((m) => ({ ...m, castIds: [...m.castIds, asset.id] }));
    return asset;
  };

  /** Attach the cast to every shot by name and clear their pictures and clips so the next run regenerates them with the same face. */
  const tkApplyCast = () => {
    const castByName = new Map(tk.castIds.map((cid) => {
      const a = assets.find((x) => x.id === cid);
      return [((a?.meta?.name || a?.name || '')).toLowerCase(), cid];
    }));
    const byId = new Map((tk.script?.scenes || []).map((sc) => [sc.sceneId, sc]));
    setScenes((cur) => cur.map((s) => {
      if (!s.tk) return s;
      const sc = byId.get(s.id);
      const cast = (sc?.characters || []).map((nm) => castByName.get(String(nm).toLowerCase())).filter(Boolean);
      return { ...s, cast, assetId: null, videoAssetId: null, gen: { phase: 'idle' } };
    }));
  };

  const tkAddCharacters = (files) => {
    const ids = files.map((f) => {
      const stem = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
      const looksLikeName = /[a-z]{2}/i.test(stem);
      return addAsset(f, 'character', stem || 'character', {
        name: looksLikeName ? stem.slice(0, 40) : '', description: '',
      }).id;
    });
    setTk((m) => ({ ...m, castIds: [...m.castIds, ...ids] }));
  };

  const tkTranscribe = async () => {
    const src = tk.sourceAssetIds.map((id) => assets.find((a) => a.id === id)).find((a) => a?.mime?.startsWith('video'));
    if (!src) return;
    setTkTranscribeBusy(true);
    try {
      const r = await transcribeStoryVideo(src.blob);
      setTk((m) => ({ ...m, transcript: r.text || '' }));
    } catch (e) {
      alert(`Transcribe failed: ${e.message}`);
    } finally {
      setTkTranscribeBusy(false);
    }
  };

  const tkDescribeSource = async () => {
    const srcs = tk.sourceAssetIds.map((id) => assets.find((a) => a.id === id)).filter(Boolean);
    const video = srcs.find((a) => a.mime?.startsWith('video'));
    const images = srcs.filter((a) => a.mime?.startsWith('image'));
    if (!video && !images.length) return;
    setTkDescribeBusy(true);
    try {
      const notes = [];
      if (video) notes.push((await describeStoryVideo(video.blob)).notes);
      if (images.length) notes.push((await describeStoryImages(images.map((a) => a.blob))).notes);
      setTk((m) => ({ ...m, visualNotes: [m.visualNotes.trim(), ...notes].filter(Boolean).join('\n\n') }));
    } catch (e) {
      alert(`Describe failed: ${e.message}`);
    } finally {
      setTkDescribeBusy(false);
    }
  };

  const tkWriteScript = async () => {
    setTkScriptBusy(true);
    setTk((m) => ({ ...m, scriptError: null }));
    try {
      const cast = tk.castIds.map((cid) => assets.find((a) => a.id === cid)).filter(Boolean)
        .map((a) => ({ name: a.meta?.name || a.name, description: a.meta?.description || '' }));
      const script = await writeStoryScript({
        source: { transcript: tk.transcript, visual_notes: tk.visualNotes }, cast,
        concept: tk.concept, style: tk.style, aspect: tk.aspect,
        n_scenes: tk.nScenes, max_seconds: tk.frames / 24, use_llm: tk.useLlm && !!health?.ollama, model: tk.llmModel || '',
        realistic: tk.realistic, scare: tk.scare || 'creepy', seed: Math.floor(Math.random() * 1e6),
      });
      script.scenes = scrubScript(script).scenes.map((s) => ({ ...s, frames: s.frames || tk.frames }));
      setTk((m) => ({ ...m, script }));
    } catch (e) {
      setTk((m) => ({ ...m, scriptError: e.message }));
    } finally {
      setTkScriptBusy(false);
    }
  };

  /** Make one shot scarier: its prompts get a specific, visible unsettling detail, and its still + clip are cleared so the next run regenerates them. */
  const tkScarify = async (sceneId) => {
    const order = [...scenesRef.current.filter((s) => s.tk)].sort((a, b) => (a.ttIndex ?? 0) - (b.ttIndex ?? 0));
    const i = order.findIndex((s) => s.id === sceneId);
    const s = order[i];
    if (!s) return;
    const r = await scarifyShot({ level: tk.scare === 'terrifying' ? 'terrifying' : 'creepy', title: s.title, still_prompt: s.stillPrompt, motion_prompt: s.prompt, previous: order[i - 1]?.title || '', next: order[i + 1]?.title || '' });
    updateScene(sceneId, { stillPrompt: r.still_prompt, prompt: r.motion_prompt || s.prompt, assetId: null, videoAssetId: null, gen: { phase: 'idle' } });
  };

  /** Throw away one shot's picture and clip and make its picture again (new random seed unless it has one set). */
  const tkRedoStill = async (id) => {
    updateScene(id, { assetId: null, videoAssetId: null, gen: { phase: 'idle' } });
    await new Promise((r) => setTimeout(r, 50));
    return generateSceneStill(id);
  };

  /** The line a shot is supposed to speak: its dialogue, else a quoted line in its soundscape. */
  const sceneLine = (sc) => {
    const q = (sc.soundscape || '').match(/["“]([^"”]{3,})["”]/);
    return ((sc.dialogue || '').trim() || (q ? q[1] : '')).replace(/^"|"$/g, '');
  };

  /** Regenerate a shot's clip until speech recognition hears its line (the video model only sometimes speaks off-screen lines). Every take stays in the gallery. */
  const tkRerollLine = async (id, maxTries = 5) => {
    const sc0 = scenesRef.current.find((s) => s.id === id);
    const line = sceneLine(sc0 || {});
    const want = line.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    if (!want.length) throw new Error('This shot has no spoken line to listen for.');
    let heard = '';
    for (let k = 1; k <= maxTries; k++) {
      await generateScene(id);
      const sc = scenesRef.current.find((s) => s.id === id);
      const a = assetsRef.current.find((x) => x.id === sc?.videoAssetId);
      if (!a) continue;
      const fd = new FormData(); fd.append('video', a.blob, 'clip.mp4');
      try {
        const r = await fetch('/api/story/transcribe', { method: 'POST', body: fd });
        heard = r.ok ? ((await r.json()).text || '') : '';
      } catch { heard = ''; }
      const hit = want.filter((w) => heard.toLowerCase().includes(w)).length / want.length;
      updateScene(id, { gen: { phase: 'idle', status: `take ${k}: heard "${heard.slice(0, 50)}"` } });
      if (hit >= 0.5) return { tries: k, heard };
    }
    return { tries: maxTries, heard, missed: true };
  };

  /** Generated soundtrack for the whole cut. */
  const tkMakeScore = (prompt, seconds) => makeScore(prompt, seconds);

  /** Add sound design (ambience, dread, jump scare...) to the finished video. */
  const tkFinalSound = async (opts) => {
    const fa = assetsRef.current.find((a) => a.id === tk.finalAssetId);
    if (!fa) throw new Error('Render the final video first');
    const out = await runFfmpegTool(new File([fa.blob], 'final.mp4', { type: 'video/mp4' }), 'sound', opts);
    const asset = addAsset(out, 'video', `${tk.script?.title || 'tiktok video'} - final + sound`, { source: 'final', sound_design: true });
    setTk((m) => ({ ...m, finalAssetId: asset.id }));
  };

  /** An already-written shot-by-shot script -> a flat scene list (no LLM call). */
  const tkParseScript = async (text) => {
    setTkScriptBusy(true);
    setTk((m) => ({ ...m, scriptError: null }));
    try {
      const script = await parseStoryScript({ text, max_seconds: tk.frames / 24, realistic: tk.realistic });
      script.scenes = scrubScript(script).scenes.map((s) => ({ ...s, frames: s.frames || tk.frames }));
      setTk((m) => ({ ...m, script }));
    } catch (e) {
      setTk((m) => ({ ...m, scriptError: e.message }));
    } finally {
      setTkScriptBusy(false);
    }
  };

  /** Split a shot into two (e.g. an imported shot describing more than one
   * moment/cut) — duplicates it right after itself; edit each half by hand. */
  const tkDuplicateScene = (id) => {
    setTk((m) => {
      if (!m.script) return m;
      const i = m.script.scenes.findIndex((s) => s.id === id);
      if (i < 0) return m;
      const copy = { ...m.script.scenes[i], id: `scene_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, sceneId: null };
      const scenes = [...m.script.scenes.slice(0, i + 1), copy, ...m.script.scenes.slice(i + 1)];
      return { ...m, script: { ...m.script, scenes } };
    });
  };

  const tkRemoveScene = (id) => {
    setTk((m) => (m.script ? { ...m, script: { ...m.script, scenes: m.script.scenes.filter((s) => s.id !== id) } } : m));
  };

  /** Script scenes → board cards (only those not yet placed). ttIndex always
   * mirrors each entry's position in tk.script.scenes (not creation-time
   * count), so splitting an already-placed shot in two (duplicate + edit,
   * see tkDuplicateScene) and re-adding inserts the new half where it
   * belongs in the story instead of appending it after every other scene —
   * and resyncs already-placed scenes too, since a split shifts them. */
  const tkScenesToBoard = () => {
    if (!tk.script) return;
    const castByName = new Map(tk.castIds.map((cid) => {
      const a = assets.find((x) => x.id === cid);
      return [((a?.meta?.name || a?.name || '')).toLowerCase(), cid];
    }));
    const created = [];
    const script = { ...tk.script, scenes: tk.script.scenes.map((sc, n) => {
      if (sc.sceneId && scenes.some((s) => s.id === sc.sceneId)) return sc;
      const col = n % 4, row = Math.floor(n / 4);
      const scene = newScene(null, 40 + col * 340, 60 + row * 420, {
        tk: true, ttIndex: n, title: sc.title, beat: sc.beat, continuity: sc.continuity,
        stillPrompt: sc.stillPrompt, prompt: sc.motionPrompt, dialogue: sc.dialogue || '',
        soundscape: sc.soundscape || '', music: 'No music.', narration: sc.narration || '', caption: sc.caption || '',
        cast: (sc.characters || []).map((nm) => castByName.get(nm.toLowerCase())).filter(Boolean),
        aspect: tk.aspect, frames: sc.frames || tk.frames,
      });
      created.push(scene);
      return { ...sc, sceneId: scene.id };
    }) };
    const indexOfSceneId = new Map(script.scenes.map((sc, n) => [sc.sceneId, n]));
    setScenes((s) => {
      const withNew = created.length ? [...s, ...created] : s;
      return withNew.map((sc) => {
        if (!sc.tk) return sc;
        const n = indexOfSceneId.get(sc.id);
        return n !== undefined && sc.ttIndex !== n ? { ...sc, ttIndex: n } : sc;
      });
    });
    setTk((m) => ({ ...m, script }));
    setView({ x: 20, y: 40, k: Math.min(1, (window.innerWidth - 60) / (4 * 340)) });
  };

  /** Simple sequential cut — every finished clip, full length, in script order (no beat-cutting). */
  const tkRenderFinal = async (musicFile) => {
    setTkRenderState({ phase: 'run', error: null });
    try {
      const order = scenesRef.current.filter((s) => s.tk).sort((a, b) => (a.ttIndex ?? 0) - (b.ttIndex ?? 0));
      const withVideo = order.filter((s) => s.videoAssetId && assetsRef.current.find((a) => a.id === s.videoAssetId));
      if (!withVideo.length) throw new Error('No clips available to render.');
      const pieces = [];
      let at = 0;
      for (const s of withVideo) {
        const v = assetsRef.current.find((a) => a.id === s.videoAssetId);
        const dur = v?.meta?.seconds || (s.frames || 124) / 24;
        pieces.push({ sceneId: s.id, assetId: s.videoAssetId, in: 0, out: dur, at, dur });
        at += dur;
      }
      setTk((m) => ({ ...m, cut: { ...m.cut, pieces } }));
      const clips = pieces.map((p) => ({ id: p.assetId, blob: assetsRef.current.find((a) => a.id === p.assetId)?.blob })).filter((c) => c.blob);
      const first = assetsRef.current.find((a) => a.id === pieces[0].assetId);
      let width = first?.meta?.width || 0, height = first?.meta?.height || 0;
      if (!width || !height) {
        const m = await videoMeta(first.url);
        width = m.width; height = m.height;
      }
      const ratio = width / height || aspectRatio(tk.aspect);
      if (tk.cut.size === '1080') { const s = ratio >= 1 ? 1920 / width : 1920 / height; width = Math.round(width * s / 2) * 2; height = Math.round(height * s / 2) * 2; }
      if (tk.cut.size === '720') { const s = ratio >= 1 ? 1280 / width : 1280 / height; width = Math.round(width * s / 2) * 2; height = Math.round(height * s / 2) * 2; }
      const blob = await mvRender({
        edl: toBackendEdl(pieces), clips, music: musicFile || null,
        width, height, musicGain: tk.cut.musicGain, clipGain: tk.cut.clipGain ?? 1, musicOffset: 0, fadeOut: 0,
        look: tk.cut.look || '',
      });
      let out = blob;
      const gn = getGenre();
      if (ONCE_LOOKS.has(gn.post) && getAutoPost()) {     // one continuous 'repost' pass over the whole cut: the same shake, exposure and compression across every cut, so it reads as a single take
        const o = gn.post_opts || {};
        // chaos per shot -> how hard the camera shakes at each moment of the cut (a short ramp at every cut so it does not step)
        const hasChaos = pieces.some((p) => scenesRef.current.find((s) => s.id === p.sceneId)?.chaos != null);
        const env = [];
        if (hasChaos) {
          for (const p of pieces) {
            const c = scenesRef.current.find((s) => s.id === p.sceneId)?.chaos;
            const m = (0.15 + 0.85 * ((c ?? 40) / 100)).toFixed(3);
            env.push(`${(p.at + 0.1).toFixed(2)}:${m}`, `${(p.at + p.dur - 0.1).toFixed(2)}:${m}`);
          }
        }
        out = await runFfmpegTool(new File([blob], 'cut.mp4', { type: 'video/mp4' }), 'footage',
          { preset: gn.post === 'doorbell' ? 'doorbellcam' : gn.post, shake: hasChaos ? 'blair witch' : o.shake, shake_env: env.join(','), focus: focusLevel(o.focus), glitches: o.glitches, wear: o.wear, seed: Math.floor(Math.random() * 999), audio: 'passthrough' });
      }
      const asset = addAsset(out, 'video', `${tk.script?.title || 'tiktok video'} — final`, { source: 'final', pieces: pieces.length, width, height, camera_look: ONCE_LOOKS.has(gn.post) && getAutoPost() ? gn.post : undefined });
      setTk((m) => ({ ...m, finalAssetId: asset.id }));
      setTkRenderState({ phase: 'done', error: null });
    } catch (e) {
      setTkRenderState({ phase: 'error', error: e.message });
    }
  };

  // ---------------------------------------------------------------- project save/load

  const projectFileRef = useRef(null);

  const onSave = (saveAs = false) => {
    let name = projectName;
    if (saveAs || !name) {
      name = window.prompt('Project name:', projectName || mv.script?.title || 'My project');
      if (name == null) return; // cancelled
      name = name.trim();
      setProjectName(name);
    }
    saveProject(
      {
        name, scenes, view, sketchSettings, kreaSettings, fluxSettings, fluxLoras, imageEngine, timeline, videoSettings: settings,
        sketchLoras, kreaLoras: loras, mv, tk,
      },
      assets
    );
  };

  /** A ready-made project (the reel's shots and captions on the Timeline) so a new user can explore without waiting for a render. */
  const onOpenDemo = async () => {
    try {
      const r = await fetch('/api/demo/project');
      if (!r.ok) throw new Error('The demo project is missing from this install.');
      applyProject(await loadProject(new File([await r.blob()], 'Hoodsfield demo.vstudio', { type: 'application/json' })));
      setOverlay('timeline');
    } catch (e) {
      alert(`Could not open the demo project: ${e.message}`);
    }
  };

  const onLoad = async (file) => {
    try {
      applyProject(await loadProject(file));
    } catch (e) {
      alert(`Could not open project: ${e.message}`);
    }
  };

  /** Put a loaded project (from a file or from the autosave) into the app. */
  const applyProject = (p) => {
    {
      assets.forEach((a) => URL.revokeObjectURL(a.url));
      lastSketch.current = null;
      setProjectName(p.name || '');
      setAssets(p.assets);
      setScenes(p.scenes.map((s) => ({ ...SCENE_VIDEO_DEFAULTS, cast: [], styleRefs: [], stillPrompt: '', ...s })));
      setView(p.view);
      if (p.sketchSettings) setSketchSettings((prev) => keepModels(prev, p.sketchSettings));
      if (p.kreaSettings) setKreaSettings((prev) => keepModels(prev, p.kreaSettings));
      if (p.fluxSettings) setFluxSettings((prev) => keepModels(prev, { ...FLUX_INIT, ...p.fluxSettings, rig: { ...DEFAULT_RIG, ...(p.fluxSettings.rig || {}) } }));
      if (p.fluxLoras) setFluxLoras(p.fluxLoras);
      if (p.imageEngine) setImageEngine(p.imageEngine);
      if (p.timeline) setTimeline({ ...newTimeline(), ...p.timeline });
      if (p.videoSettings) setSettings(p.videoSettings);
      if (p.sketchLoras?.length) setSketchLoras(p.sketchLoras);
      if (p.kreaLoras?.length) setLoras(p.kreaLoras);
      setMv(p.mv ? { ...MV_DEFAULTS, ...p.mv, cut: { ...MV_DEFAULTS.cut, ...(p.mv.cut || {}) } } : MV_DEFAULTS);
      setTk(p.tk ? { ...TK_DEFAULTS, ...p.tk, cut: { ...TK_DEFAULTS.cut, ...(p.tk.cut || {}) } } : TK_DEFAULTS);
    }
  };

  // ---- autosave: the whole session is kept in this browser every ~40 s while something has changed, so a refresh or a crash can't lose the work
  const snapRef = useRef(null);
  snapRef.current = { state: { name: projectName, scenes, view, sketchSettings, kreaSettings, fluxSettings, fluxLoras, imageEngine, timeline, videoSettings: settings, sketchLoras, kreaLoras: loras, mv, tk }, assets };
  const lastSig = useRef('');
  const [restoreOffer, setRestoreOffer] = useState(null);
  const [autosavedAt, setAutosavedAt] = useState(0);
  // ---- shared session: the PC holds one copy of the project; this screen follows it and pushes its own changes (phone <-> PC)
  const applyShared = useCallback((st, newAssets) => {
    setProjectName(st.name || '');
    setAssets(newAssets);
    setScenes((prev) => {
      const gen = new Map(prev.map((s) => [s.id, s.gen]));   // a render running on THIS screen keeps its progress
      return (st.scenes || []).map((s) => ({ ...SCENE_VIDEO_DEFAULTS, cast: [], styleRefs: [], stillPrompt: '', ...s, gen: gen.get(s.id) || { phase: 'idle' } }));
    });
    if (st.sketchSettings) setSketchSettings((prev) => keepModels(prev, st.sketchSettings));
    if (st.kreaSettings) setKreaSettings((prev) => keepModels(prev, st.kreaSettings));
    if (st.fluxSettings) setFluxSettings((prev) => keepModels(prev, { ...FLUX_INIT, ...st.fluxSettings, rig: { ...DEFAULT_RIG, ...(st.fluxSettings.rig || {}) } }));
    if (st.fluxLoras) setFluxLoras(st.fluxLoras);
    if (st.imageEngine) setImageEngine(st.imageEngine);
    if (st.timeline) setTimeline({ ...newTimeline(), ...st.timeline });
    if (st.videoSettings) setSettings(st.videoSettings);
    if (st.sketchLoras) setSketchLoras(st.sketchLoras);
    if (st.kreaLoras) setLoras(st.kreaLoras);
    setMv(st.mv ? { ...MV_DEFAULTS, ...st.mv, cut: { ...MV_DEFAULTS.cut, ...(st.mv.cut || {}) } } : MV_DEFAULTS);
    setTk(st.tk ? { ...TK_DEFAULTS, ...st.tk, cut: { ...TK_DEFAULTS.cut, ...(st.tk.cut || {}) } } : TK_DEFAULTS);
  }, []);
  const syncStatus = useSharedSession({ snapRef, applyShared });

  const hadContent = useRef(false);      // this page has held work: an emptied project must also empty the autosave, or a refresh would bring the old one back
  const autosaveChecked = useRef(false);
  const restoreLast = useCallback(async () => {
    const rec = await readAutosave();
    if (rec && (rec.assets?.length || rec.state?.scenes?.length)) applyProject(projectFromAutosave(rec));
  }, []);
  useEffect(() => {      // a refresh brings the last session straight back, unless another screen's session has already filled this one
    readAutosave().then((rec) => {
      autosaveChecked.current = true;
      if (!rec || !(rec.assets?.length || rec.state?.scenes?.length)) return;
      const s = snapRef.current;
      if (!s.assets.length && !(s.state.scenes || []).length) applyProject(projectFromAutosave(rec));
    });
  }, []);
  useEffect(() => {
    const save = async () => {
      if (!autosaveChecked.current) return;
      const { state, assets: as } = snapRef.current;
      if (!as.length && !(state.scenes || []).length) { if (hadContent.current) { hadContent.current = false; lastSig.current = ''; clearAutosave(); } return; }
      hadContent.current = true;
      const sig = [as.length, as.map((a) => a.id).join(','), JSON.stringify((state.scenes || []).map(({ gen, ...x }) => x)).length, JSON.stringify(state.tk || {}).length, JSON.stringify(state.mv || {}).length].join('|');
      if (sig === lastSig.current) return;
      try { await autosaveProject(state, as); lastSig.current = sig; setAutosavedAt(Date.now()); } catch (e) { console.warn('autosave failed:', e.message); }
    };
    const onHide = () => { if (document.visibilityState === 'hidden') save(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', save);
    const t = setInterval(save, 12000);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', save); };
  }, []);
  useEffect(() => {   // test hook: #autosavetest writes, reads back and verifies a tiny session
    if (location.hash !== '#autosavetest') return;
    (async () => {
      const blob = new Blob(['hello clip'], { type: 'video/mp4' });
      await autosaveProject({ name: 't', scenes: [{ id: 's1', gen: { phase: 'run' }, title: 'x' }], view: { x: 0, y: 0, k: 1 }, tk: { script: null, scriptError: 'e' } }, [{ id: 'a1', kind: 'video', mime: 'video/mp4', name: 'clip', meta: { describing: true, seconds: 4 }, blob }]);
      const rec = await readAutosave();
      const p = projectFromAutosave(rec);
      const txt = await (await fetch(p.assets[0].url)).text();
      document.title = `AS:${p.assets.length}:${txt}:${p.scenes[0].title}:${JSON.stringify(p.scenes[0].gen)}:${Object.keys(p.assets[0].meta).join(',')}`;
    })().catch((e) => { document.title = `AS-FAIL:${e.message}`; });
  }, []);
  useEffect(() => {   // closing or refreshing with work in the page: ask first
    const h = (e) => { const { state, assets: as } = snapRef.current; if (as.length || (state.scenes || []).length) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  const onNewProject = () => {
    if (scenes.length || assets.length) {
      const ok = window.confirm('Close the current project? Unsaved changes will be lost.\n(Use File → Save Project first if you want to keep it.)');
      if (!ok) return;
    }
    assets.forEach((a) => URL.revokeObjectURL(a.url));
    lastSketch.current = null;
    previewSeq.current++;
    setPreview({ url: null, updating: false });
    setProjectName('');
    setAssets([]);
    setScenes([]);
    setView({ x: 0, y: 0, k: 1 });
    setDetailId(null);
    setOverlay(null);
    setSettings(DEFAULTS);
    setSketchSettings((p) => keepModels(p, SKETCH_DEFAULTS));
    setKreaSettings((p) => keepModels(p, KREA_DEFAULTS));
    setFluxSettings((p) => keepModels(p, FLUX_INIT));
    setFluxLoras([]);
    setTimeline(newTimeline());
    setMoodboard([]);
    setFaces([]);
    setLoras([]);
    setSketchFaces([]);
    setSketchLoras([]);
    setMv(MV_DEFAULTS);
    setTk(TK_DEFAULTS);
    setRenderState({ phase: 'idle', error: null });
    setTkRenderState({ phase: 'idle', error: null });
  };

  const onClearScenes = () => {
    if (!window.confirm('Remove all scenes from the board? Gallery assets are kept.')) return;
    setScenes([]);
    setDetailId(null);
    setMv((m) => ({ ...m, script: m.script ? { ...m.script, scenes: m.script.scenes.map((s) => ({ ...s, sceneId: null })) } : null, cut: { ...m.cut, pieces: [] } }));
    setTk((m) => ({ ...m, script: m.script ? { ...m.script, scenes: m.script.scenes.map((s) => ({ ...s, sceneId: null })) } : null, cut: { ...m.cut, pieces: [] } }));
  };

  /** Drop gallery assets no scene (or the music-video / tiktok-video setup) references. */
  const onClearUnusedAssets = () => {
    const used = new Set();
    scenes.forEach((s) => {
      used.add(s.assetId); used.add(s.videoAssetId);
      (s.cast || []).forEach((c) => used.add(c));
      (s.styleRefs || []).forEach((c) => used.add(c));
    });
    used.add(mv.trackAssetId); mv.castIds.forEach((c) => used.add(c)); mv.styleIds.forEach((c) => used.add(c));
    used.add(mv.finalAssetId);
    tk.sourceAssetIds.forEach((c) => used.add(c)); tk.castIds.forEach((c) => used.add(c));
    used.add(tk.finalAssetId);
    assets.forEach((a) => { if (used.has(a.id) && a.meta?.sourceSketchId) used.add(a.meta.sourceSketchId); });
    const unused = assets.filter((a) => !used.has(a.id));
    if (!unused.length) return;
    if (!window.confirm(`Remove ${unused.length} gallery asset${unused.length > 1 ? 's' : ''} not used by any scene?`)) return;
    unused.forEach((a) => URL.revokeObjectURL(a.url));
    lastSketch.current = null;
    setAssets((a) => a.filter((x) => used.has(x.id)));
  };

  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== 's' && k !== 'o') return;
      const t = document.activeElement?.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA') return;
      e.preventDefault();
      if (k === 's') onSave(e.shiftKey); // Ctrl+Shift+S = Save As
      else projectFileRef.current?.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------------------------------------------------------------- 3D studio lifecycle

  useEffect(() => {
    const studio = new Studio(mountRef.current, {
      onSelect: setSelected, onObjects: setObjects, onKeyframes: setKeyframes,
    });
    studioRef.current = studio;
    setObjects([...studio.objects]);
    checkHealth().then(setHealth);
    listH3Models().then(setH3Catalog);
    listLooks().then(setLooks);
    const t = setInterval(() => checkHealth().then(setHealth), 30000);
    return () => { studio.dispose(); clearInterval(t); };
  }, []);

  useEffect(() => {
    const s = studioRef.current;
    if (!s) return;
    s.duration = settings.seconds;
    s.depthFar = settings.depthFar;
    s.depthPreview = depthView;
    s.shotCamera.aspect = settings.width / settings.height;
  }, [settings, depthView]);

  useEffect(() => {
    const s = studioRef.current;
    if (s) s.previewTime = playing || throughLens ? time : null;
  }, [time, playing, throughLens]);

  useEffect(() => {
    if (!playing) return;
    let raf, last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      setTime((t) => (t + dt) % settings.seconds);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, settings.seconds]);

  const numFrames = quantizeFrames(settings.seconds, settings.fps);

  const onGenerate = useCallback(async () => {
    const s = studioRef.current;
    if (!s) return;
    setPlaying(false);
    setGen({ phase: 'export', progress: 0, status: 'Rendering depth frames…', videoUrl: null, media: '', error: null });
    try {
      const blobs = await s.exportDepthFrames({
        width: settings.width, height: settings.height, numFrames, duration: settings.seconds,
        onProgress: (done, total) =>
          setGen((g) => ({ ...g, progress: done / total, status: `Rendering depth frames ${done}/${total}` })),
      });
      setGen((g) => ({ ...g, phase: 'run', progress: 0, status: 'Uploading to ComfyUI…' }));
      const result = await generateVideo(
        blobs,
        {
          prompt: settings.prompt, negative_prompt: settings.negative,
          width: settings.width, height: settings.height, num_frames: numFrames,
          fps: settings.fps, steps: settings.steps, cfg: settings.cfg,
          seed: settings.seed, denoise: settings.denoise,
        },
        (ev) => {
          if (ev.type === 'submitted') setGen((g) => ({ ...g, jobId: ev.jobId }));
          else if (ev.type === 'progress')
            setGen((g) => ({ ...g, progress: ev.max ? ev.value / ev.max : 0, status: `Sampling ${ev.value}/${ev.max}` }));
          else if (ev.type === 'status') setGen((g) => ({ ...g, status: ev.text }));
        }
      );
      setGen({ phase: 'done', progress: 1, status: 'Done', videoUrl: result.url, media: result.media, error: null });
      await addVideoAssetFromUrl(result.url, '3D scene video', { source: 'ltx-depth' });
    } catch (e) {
      if (e.message === 'Cancelled') setGen({ phase: 'idle', progress: 0, status: '', videoUrl: null, media: '', error: null });
      else setGen({ phase: 'error', progress: 0, status: '', videoUrl: null, media: '', error: e.message });
    }
  }, [settings, numFrames, addVideoAssetFromUrl]);

  const PREVIEW_SIZE = 256;

  const runPreview = useCallback(async () => {
    if (!sketchApi.current) return;
    const seq = ++previewSeq.current;
    setPreview((p) => ({ ...p, updating: true }));
    try {
      const blob = await sketchApi.current.getBlob();
      if (sketchSettings.backend === 'flux3') {
        const fprompt = withRig(`Turn this drawing into the finished image described here: ${sketchSettings.prompt.trim()}. Follow the drawing's composition, layout, proportions and shapes exactly; replace the linework with real materials, lighting and detail.`, fluxSettings.rig);
        const fres = await generateFlux3(
          { prompt: fprompt, steps: fluxSettings.steps, cfg: 1, seed: sketchSettings.seed, match_ref_size: true },
          [blob], [], [],
          (ev) => {
            if (ev.type === 'submitted') setGenImg((g) => ({ ...g, jobId: ev.jobId }));
            else if (ev.type === 'progress') setGenImg((g) => ({ ...g, progress: ev.max ? ev.value / ev.max : 0, status: `Sampling ${ev.value}/${ev.max}` }));
            else if (ev.type === 'status') setGenImg((g) => ({ ...g, status: ev.text }));
          }
        );
        setGenImg({ phase: 'done', progress: 1, status: 'Done', imageUrl: fres.url, error: null });
        const skId = await rememberSketch(blob, sketchSettings, sketchLoras);
        await addAssetFromUrl(fres.url, 'image', sketchSettings.prompt.slice(0, 40) || 'sketch image', {
          prompt: sketchSettings.prompt, sourceSketchId: skId, source: 'sketch_flux3',
          settings: { ...sketchSettings, seed: fres.seed ?? sketchSettings.seed },
        });
        return;
      }
      const result = await generateImage(
        blob,
        {
          prompt: sketchSettings.prompt, negative_prompt: sketchSettings.negative,
          width: PREVIEW_SIZE, height: PREVIEW_SIZE,
          steps: 4, cfg: sketchSettings.cfg, seed: sketchSettings.seed, denoise: sketchSettings.denoise,
          backend: 'krea2',
          gguf_model: sketchSettings.ggufModel || '', text_encoder: sketchSettings.textEncoder || '',
          vae: sketchSettings.vae || '', enhancer_strength: sketchSettings.enhancerStrength ?? 0,
          krea_structure_mode: 'two_pass',
          refine_denoise: sketchSettings.refineDenoise ?? 0.90,
          sketch_blur: sketchSettings.sketchBlur ?? 0,
        },
        [], [],
        () => {},
      );
      if (seq === previewSeq.current) setPreview({ url: result.url, updating: false });
    } catch {
      if (seq === previewSeq.current) setPreview((p) => ({ ...p, updating: false }));
    }
  }, [sketchSettings]);

  const scheduleLivePreview = useCallback(() => {
    if (!livePreview || sketchSettings.backend !== 'krea2') return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(runPreview, 700);
  }, [livePreview, sketchSettings.backend, runPreview]);

  const onGenerateImage = useCallback(async () => {
    if (!sketchApi.current) return;
    setGenImg({ phase: 'run', progress: 0, status: 'Uploading sketch…', imageUrl: null, error: null });
    try {
      const blob = await sketchApi.current.getBlob();
      const result = await generateImage(
        blob,
        {
          prompt: sketchSettings.prompt, negative_prompt: sketchSettings.negative,
          width: sketchSettings.width, height: sketchSettings.height,
          steps: sketchSettings.steps, cfg: sketchSettings.cfg,
          seed: sketchSettings.seed, denoise: sketchSettings.denoise,
          checkpoint: sketchSettings.checkpoint || '',
          controlnet: sketchSettings.controlnet || 'none',
          cn_strength: sketchSettings.cnStrength ?? 0.8,
          cn_end: sketchSettings.cnEnd ?? 0.6,
          backend: sketchSettings.backend || 'sd',
          gguf_model: sketchSettings.ggufModel || '', text_encoder: sketchSettings.textEncoder || '',
          vae: sketchSettings.vae || '', enhancer_strength: sketchSettings.enhancerStrength ?? 0,
          swap_model: sketchSettings.swapModel || 'inswapper_128.onnx',
          face_restore_model: sketchSettings.faceRestoreModel || 'none',
          krea_structure_mode: sketchSettings.kreaStructureMode || 'img2img',
          refine_denoise: sketchSettings.refineDenoise ?? 0.90,
          sketch_blur: sketchSettings.sketchBlur ?? 0,
        },
        sketchLoras.filter((l) => l.name).map((l) => ({ name: l.name, strength: l.strength })),
        sketchFaces.filter((f) => f.file).map((f) => ({ index: f.index, blob: f.file })),
        (ev) => {
          if (ev.type === 'submitted') setGenImg((g) => ({ ...g, jobId: ev.jobId }));
          else if (ev.type === 'progress')
            setGenImg((g) => ({ ...g, progress: ev.max ? ev.value / ev.max : 0, status: `Sampling ${ev.value}/${ev.max}` }));
          else if (ev.type === 'status') setGenImg((g) => ({ ...g, status: ev.text }));
        }
      );
      setGenImg({ phase: 'done', progress: 1, status: 'Done', imageUrl: result.url, error: null });
      const sketchAssetId = await rememberSketch(blob, sketchSettings, sketchLoras);
      await addAssetFromUrl(result.url, 'image', sketchSettings.prompt.slice(0, 40) || 'sketch image', {
        prompt: sketchSettings.prompt,
        sourceSketchId: sketchAssetId,
        source: sketchSettings.backend === 'krea2' ? 'sketch_krea2' : 'sketch_sd',
        settings: { ...sketchSettings, seed: result.seed ?? sketchSettings.seed },
        loras: sketchLoras.filter((l) => l.name).map((l) => ({ ...l })),
      });
    } catch (e) {
      if (e.message === 'Cancelled') setGenImg({ phase: 'idle', progress: 0, status: '', imageUrl: null, error: null });
      else setGenImg({ phase: 'error', progress: 0, status: '', imageUrl: null, error: e.message });
    }
  }, [sketchSettings, sketchLoras, sketchFaces, fluxSettings, addAssetFromUrl]);

  const onGenerateKrea = useCallback(async () => {
    setGenKrea({ phase: 'run', progress: 0, status: 'Uploading…', imageUrl: null, error: null });
    try {
      const result = await generateKrea(
        {
          prompt: kreaSettings.prompt,
          width: kreaSettings.width, height: kreaSettings.height,
          steps: kreaSettings.steps, cfg: kreaSettings.cfg, seed: kreaSettings.seed,
          gguf_model: kreaSettings.ggufModel || '', text_encoder: kreaSettings.textEncoder || '',
          vae: kreaSettings.vae || '', enhancer_strength: kreaSettings.enhancerStrength ?? 0,
          swap_model: kreaSettings.swapModel || 'inswapper_128.onnx',
          face_restore_model: kreaSettings.faceRestoreModel || 'none',
        },
        moodboard,
        faces.filter((f) => f.file).map((f) => ({ index: f.index, blob: f.file })),
        loras.filter((l) => l.name).map((l) => ({ name: l.name, strength: l.strength })),
        (ev) => {
          if (ev.type === 'submitted') setGenKrea((g) => ({ ...g, jobId: ev.jobId }));
          else if (ev.type === 'progress')
            setGenKrea((g) => ({ ...g, progress: ev.max ? ev.value / ev.max : 0, status: `Sampling ${ev.value}/${ev.max}` }));
          else if (ev.type === 'status') setGenKrea((g) => ({ ...g, status: ev.text }));
        }
      );
      setGenKrea({ phase: 'done', progress: 1, status: 'Done', imageUrl: result.url, error: null });
      await addAssetFromUrl(result.url, 'image', kreaSettings.prompt.slice(0, 40) || 'krea2 image', {
        prompt: kreaSettings.prompt,
        source: 'krea2',
        settings: { ...kreaSettings, seed: result.seed ?? kreaSettings.seed },
        loras: loras.filter((l) => l.name).map((l) => ({ ...l })),
      });
    } catch (e) {
      if (e.message === 'Cancelled') setGenKrea({ phase: 'idle', progress: 0, status: '', imageUrl: null, error: null });
      else setGenKrea({ phase: 'error', progress: 0, status: '', imageUrl: null, error: e.message });
    }
  }, [kreaSettings, moodboard, faces, loras, addAssetFromUrl]);

  /** Draft -> final: upscale the approved draft (+ smooth for Wan); the draft stays in the Gallery. */
  const finalizeScene = async (id) => {
    const sc = scenesRef.current.find((s) => s.id === id);
    const vid = assetsRef.current.find((a) => a.id === sc?.videoAssetId);
    if (!sc || !vid) return;
    const setG = (g) => updateScene(id, { gen: g });
    setG({ phase: 'run', progress: 0, status: 'Finalizing…' });
    let jobId = null;
    try {
      const res = await finalizeVideo(vid.blob, { scale: 2, smooth: sc.engine === 'wan' ? 2 : 1 }, (ev) => {
        if (ev.type === 'submitted') jobId = ev.jobId;
        if (ev.type === 'progress') setG({ phase: 'run', jobId, progress: ev.max ? ev.value / ev.max : 0, status: `Upscaling ${ev.value}/${ev.max}` });
        else if (ev.type === 'status') setG({ phase: 'run', jobId, progress: 0, status: ev.text });
      });
      const fin = await addVideoAssetFromUrl(res.url, `${sc.title || 'scene'} clip (final)`, { ...vid.meta, draft: false, finalOf: vid.id, source: vid.meta?.source });
      updateScene(id, { videoAssetId: fin.id, gen: { phase: 'idle' } });
    } catch (e) {
      setG(e.message === 'Cancelled' ? { phase: 'idle' } : { phase: 'error', error: e.message });
    }
  };

  /** Long shot: chain Wan segments into one clip (backend composite job). */
  const generateLongShot = async (id) => {
    const sc = scenesRef.current.find((s) => s.id === id);
    const asset = resolveDisplayAsset(assetsRef.current.find((a) => a.id === sc?.assetId), assetsRef.current);
    if (!sc || !asset) return;
    const setG = (g) => updateScene(id, { gen: g });
    setG({ phase: 'run', progress: 0, status: 'Planning the long shot…' });
    let jobId = null;
    try {
      const ratio = await imageAspect(asset.url);
      const res = await generateWanLong(asset.blob, {
        prompt: [sc.stillPrompt?.trim(), sc.prompt?.trim()].filter(Boolean).join(' '),
        total_seconds: sc.longSeconds ?? 12, segment_seconds: 4, aspect: `${Math.round(ratio * 1000)}:1000`,
        megapixels: sc.draft ? 0.15 : (sc.wanMp ?? 0.3), seed: sc.seed ?? -1, lightning: sc.wanLightning !== false,
        smooth: sc.draft ? false : sc.wanSmooth !== false,
      }, (ev) => {
        if (ev.type === 'submitted') jobId = ev.jobId;
        if (ev.type === 'progress') setG({ phase: 'run', jobId, progress: ev.max ? ev.value / ev.max : 0, status: 'Long shot' });
        else if (ev.type === 'status') setG({ phase: 'run', jobId, progress: 0, status: ev.text });
      });
      const vid = await addVideoAssetFromUrl(res.url, `${sc.title || 'scene'} long shot`, { source: 'wan-long', sceneId: id, seed: res.seed, draft: !!sc.draft });
      updateScene(id, { videoAssetId: vid.id, gen: { phase: 'idle' } });
    } catch (e) {
      setG(e.message === 'Cancelled' ? { phase: 'idle' } : { phase: 'error', error: e.message });
    }
  };

  /** Re-render the scene at full quality with the draft's seed. */
  const rerenderFull = (id) => {
    const sc = scenesRef.current.find((s) => s.id === id);
    const vid = assetsRef.current.find((a) => a.id === sc?.videoAssetId);
    updateScene(id, { draft: false, seed: vid?.meta?.seed ?? sc?.seed ?? -1 });
    setTimeout(() => generateScene(id).catch(() => {}), 80);   // wait for scenesRef to see draft:false
  };

  /** Extend: the clip's last frame becomes the first frame of a new scene to its right. */
  const extendScene = async (id) => {
    const sc = scenesRef.current.find((s) => s.id === id);
    const vid = assetsRef.current.find((a) => a.id === sc?.videoAssetId);
    if (!sc || !vid) return;
    await extendFrom(sc, vid);
  };

  /** Timeline -> the same Extend: a clip made by a scene extends that scene; a clip from anywhere else gets a scene of its own. */
  const extendAsset = async (assetId, place) => {
    const vid = assetsRef.current.find((a) => a.id === assetId);
    if (!vid?.blob) return;
    const sc = scenesRef.current.find((s) => s.videoAssetId === assetId);
    if (sc) await extendFrom(sc, vid, place);
    else {
      const c = boardCenter();
      await extendFrom({ title: (vid.name || 'clip').replace(/\.\w+$/, ''), stillPrompt: vid.meta?.prompt || '', aspect: vid.meta?.aspect || '16:9', x: c.x - 330, y: c.y }, vid, place);
    }
    setOverlay(null);                                    // show the board, where the new scene is waiting
  };

  const extendFrom = async (sc, vid, place) => {
    const blob = await runFfmpegTool(vid.blob, 'last_frame', {});
    const img = addAsset(blob, 'image', `${sc.title || 'scene'} · last frame`, { prompt: sc.stillPrompt, aspect: sc.aspect, source: 'extend' });
    const next = newScene(img.id, sc.x + 330, sc.y, {
      title: `${sc.title || 'Scene'} (cont.)`, stillPrompt: sc.stillPrompt, prompt: '', aspect: sc.aspect,
      cast: sc.cast, styleRefs: sc.styleRefs, frames: sc.frames, preset: sc.preset, megapixels: sc.megapixels,
      engine: sc.engine, lockStill: true, ...(place ? { placeAfter: place } : {}),
    });
    setScenes((s) => [...s, next]);
    setDetailId(next.id);
  };

  /** Explore -> "generate my own": a fresh prompt-first scene seeded with the (edited) prompt. */
  const exploreRecreate = (prompt, aspect) => {
    const c = boardCenter();
    const sc = newScene(null, c.x, c.y, { aspect: aspect === '9:16' ? '9:16' : '16:9', stillPrompt: prompt, prompt, title: prompt.slice(0, 32) });
    setScenes((s) => [...s, sc]);
    setOverlay(null);
    setDetailId(sc.id);
  };

  /** Explore (Originals) -> one shot of a film as a fresh board scene: still prompt + motion prompt. */
  const exploreRecreateShot = (still, motion, aspect) => {
    const c = boardCenter();
    const sc = newScene(null, c.x, c.y, { aspect: aspect === '16:9' ? '16:9' : '9:16', stillPrompt: still, prompt: motion, title: still.slice(0, 32) });
    setScenes((s) => [...s, sc]);
    setOverlay(null);
    setDetailId(sc.id);
  };

  /** Explore (Originals) -> the whole film's shot list as a row of scenes, ready to generate. */
  const exploreRecreateFilm = (film) => {
    const c = boardCenter();
    const made = film.shots.map((s, i) => newScene(null, c.x + i * 340 - ((film.shots.length - 1) * 170), c.y, {
      aspect: film.aspect === '16:9' ? '16:9' : '9:16', stillPrompt: s.prompt, prompt: s.motion, title: `${film.title} · ${s.n}`,
    }));
    setScenes((s) => [...s, ...made]);
    setOverlay(null);
    setDetailId(null);
  };

  /** Explore -> send the picked render into another tool (it lands in the Gallery first). */
  const exploreUse = async (item, target, prompt) => {
    const name = (item.title || 'explore').slice(0, 40);
    const meta = { source: 'explore', prompt };
    let asset;
    if (item.video) asset = await addVideoAssetFromUrl(item.mediaUrl, name, meta);
    else asset = addAsset(await (await fetch(item.mediaUrl)).blob(), 'image', name, meta);
    if (target === 'animate') {
      // the asset was only just added, so addSceneFromAsset (which looks it up in state) would not find it yet: build the scene here
      const c = boardCenter();
      if (item.video) {
        const vs = await videoToScene(asset, c.x, c.y, { title: name, stillPrompt: prompt || '' });
        setOverlay(null);
        setDetailId(vs.id);
        return;
      }
      let aspect = '9:16';
      try { const bm = await createImageBitmap(asset.blob); aspect = bm.width / bm.height > 1.2 ? '16:9' : bm.width / bm.height < 0.8 ? '9:16' : '1:1'; bm.close?.(); } catch { /* keep default */ }
      const sc = newScene(asset.id, c.x, c.y, { title: name, stillPrompt: prompt || '', aspect });
      setScenes((cur) => [...cur, sc]);
      setOverlay(null);
      setDetailId(sc.id);
    } else if (target === 'edit') openEditStudio(asset);                 // hand the picked image to the tool, not just open it
    else if (target === 'genjutsu') openGenjutsu(asset);
    else if (target === 'lipsync') { setLipIncoming({ asset, nonce: Math.random() }); navigate('lipsync'); }
    else navigate(target);
  };

  /** Home cards, rail and quick starts: an overlay id (null or board = the canvas) plus an optional action. */
  const navigate = (target, action) => {
    if (action === 'newScene') { setOverlay(null); addEmptyScene(); return; }
    setDetailId(null);
    setOverlay(target === 'board' ? null : target);
  };

  /** Ad Studio: product photo(s) become a style/reference asset; each shot becomes a board scene. */
  const createAdScenes = async ({ productBlobs, productName, shots, aspect, formatLabel }) => {
    const refIds = productBlobs.map((b, i) => addAsset(b, 'styleref', `${productName} — product ${i + 1}`, { role: 'product' }).id);
    const c = boardCenter();
    const created = shots.map((s, i) => newScene(null, c.x + i * 330 - ((shots.length - 1) * 165), c.y, {
      title: `${s.title}`, stillPrompt: s.still, prompt: s.motion, dialogue: s.dialogue || '', aspect,
      styleRefs: refIds, frames: 5 + 17 * Math.max(1, Math.round((s.seconds * 24 - 5) / 17)), lockStill: true, // H3's 17k+5 grid @ 24 fps
      refNote: ` The first reference image is the real product (${productName}): reproduce its exact shape, colors, label and logo. `,
    }));
    setScenes((cur) => [...cur, ...created]);
    setOverlay(null);
    setDetailId(created[0].id);
  };

  const openGenjutsu = useCallback((asset) => {
    if (asset) setGjIncoming({ asset, nonce: Math.random() });
    setDetailId(null);
    setOverlay('genjutsu');
  }, []);

  const openVideoLab = useCallback((asset) => {
    if (asset) setLabIncoming({ asset, nonce: Math.random() });
    setDetailId(null);
    setOverlay('lab');
  }, []);

  const openEditStudio = useCallback((asset) => {
    if (asset) setEditIncoming({ asset, nonce: Math.random() });
    setDetailId(null);
    setOverlay('edit');
  }, []);

  /** Flux 3 panel result -> Gallery asset (returned so the panel can re-use its blob). */
  const onFluxResult = useCallback(
    (url, meta) => addAssetFromUrl(url, 'image', (meta.prompt || 'flux3').slice(0, 40), meta),
    [addAssetFromUrl]
  );

  // pictures started on another screen (phone <-> PC) land in this gallery and in the Image Studio's results
  const remoteRunning = useSharedFeed(useCallback(async ({ jobId, url, title }) => {
    try {
      // the screen that started it normally hands the picture over through the shared session; only import it ourselves if that never happens
      await new Promise((r) => setTimeout(r, 8000));
      if (snapRef.current?.assets.some((a) => a.meta?.jobId === jobId)) return;
      const asset = await onFluxResult(url, { prompt: title || 'remote', source: 'remote', jobId });
      window.dispatchEvent(new CustomEvent('hf-remote-result', { detail: { jobId, url: asset.url, prompt: title, asset } }));
    } catch { /* the job is still in the Jobs list */ }
  }, [onFluxResult]));

  // dev-only hook so browser tests can seed the Gallery without a render
  useEffect(() => { if (import.meta.env.DEV) window.__hoods = { addAsset, addVideoAssetFromUrl, addVideoScene: (assetId) => { const sc = newScene(null, 120, 120, { videoAssetId: assetId, title: 'QA test' }); setScenes((x) => [...x, sc]); setDetailId(sc.id); } }; }, [addAsset, addVideoAssetFromUrl, setScenes]);

  useEffect(() => { if (tkAutoWrite) tkWriteScript(); }, [tkAutoWrite]); // eslint-disable-line react-hooks/exhaustive-deps

  const busy = gen.phase === 'export' || gen.phase === 'run';
  const busyImg = genImg.phase === 'run';
  const busyKrea = genKrea.phase === 'run';

  // ---------------------------------------------------------------- render

  return (
    <div className="shell">
      <AssistantAlerts inAssistant={overlay === 'assistant'} onOpen={(id) => { setOverlay('assistant'); if (id) setTimeout(() => window.dispatchEvent(new CustomEvent('hf-assistant-open', { detail: id })), 0); }} />
      <RemoteJobsPill running={remoteRunning} />
      <SyncBadge status={syncStatus} />
      <Board
        view={view} setView={setView} scenes={scenes} assets={assets} h3Grid={h3Catalog?.frame_grid}
        sections={mv.analysis?.sections}
        onDropAsset={addSceneFromAsset} onMoveScene={moveScene}
        onUpdateScene={updateScene} onGenerateScene={safe(generateScene)} onGenerateStill={safe(generateSceneStill)}
        onDeleteScene={deleteScene}
        onCancelScene={(scene) => cancelJob(scene.gen?.jobId)}
        onOpenDetail={setDetailId} onToTimeline={sendToTimeline}
        starts={[
          { icon: '🎞️', label: 'Empty scene', sub: 'prompt, still, clip', run: addEmptyScene },
          { icon: '🎵', label: 'Music video', sub: 'song in, video out', run: () => setOverlay('mv') },
          { icon: '📱', label: 'TikTok video', sub: 'idea to 9:16', run: () => setOverlay('tk') },
          { icon: '🛍️', label: 'Product ad', sub: 'link to storyboard', run: () => setOverlay('ads') },
          { icon: '⚡', label: 'Make an image', sub: 'Flux 3 in 5 s', run: () => setOverlay('flux3') },
        ]}
      />

      <MenuBar
        canBack={canBack || layers > 0} onBack={goBack} onRestoreLast={restoreLast} onToggleGallery={() => setGalleryOpen((o) => !o)} galleryCount={assets.length}
        health={health} projectName={projectName}
        hasScenes={scenes.length > 0} hasAssets={assets.length > 0}
        onNewProject={onNewProject}
        onSaveProject={() => onSave(false)}
        onSaveProjectAs={() => onSave(true)}
        onOpenFilePicker={() => projectFileRef.current?.click()}
        onCloseProject={onNewProject}
        onClearScenes={onClearScenes}
        onClearUnusedAssets={onClearUnusedAssets}
        onResetView={() => setView({ x: 0, y: 0, k: 1 })}
        onOpenSketch={() => setOverlay('sketch')}
        onOpenStudio={() => setOverlay('studio')}
        onOpenKrea={() => setOverlay('krea')}
        onOpenFlux={() => setOverlay('flux3')}
        onOpenAssistant={() => setOverlay('assistant')}
        onOpenEdit={() => openEditStudio(null)}
        onOpenLab={() => openVideoLab(null)}
        onOpenChars={() => setOverlay('chars')}
        onOpenGenjutsu={() => openGenjutsu(null)}
        onOpenAds={() => setOverlay('ads')}
        onOpenHome={() => setOverlay('home')}
        onOpenTimeline={() => setOverlay('timeline')}
        onOpenModels={() => setOverlay('models')}
        onOpenExplore={() => setOverlay('explore')}
        onOpenVoice={() => setOverlay('voice')}
        onStart={() => { setDetailId(null); setOverlay('start'); }}
        onOpenScene={() => setOverlay('scene')}
        onOpenLipSync={() => setOverlay('lipsync')}
        theme={theme} themes={THEMES} onSetTheme={(id) => setThemeState(applyTheme(id))}
        onOpenMcp={() => setOverlay('mcp')}
        onOpenSettings={() => setOverlay('settings')}
        onOpenLoop={() => setOverlay('loop')}
        onOpenDemo={onOpenDemo}
        imageEngine={imageEngine} onSetImageEngine={setImageEngine}
        onOpenMv={() => setOverlay('mv')}
        onOpenTk={() => setOverlay('tk')}
        onNewScene={addEmptyScene}
      />
      <input ref={projectFileRef} type="file" accept=".vstudio,application/json" hidden
        onChange={(e) => { if (e.target.files?.[0]) onLoad(e.target.files[0]); e.target.value = ''; }} />

      {tlNote && (
        <div className="tl-note" role="status">
          <span>{tlNote.text}</span>
          {tlNote.open && <button onClick={() => { setTlNote(null); setOverlay('timeline'); }}>Open Timeline</button>}
          <button className="x" onClick={() => setTlNote(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      <HistoryDock onToTimeline={sendToTimeline} panelOpen={galleryOpen} onPanelOpen={() => setGalleryOpen(true)} onPanelClose={() => setGalleryOpen(false)} assets={assets} onAddToBoard={addToBoardCenter} onDeleteAsset={deleteAsset}
        onEditSketch={editSketch} onEditKrea={editKrea} onEditFlux={editFlux} onEditStudio={openEditStudio} onVideoLab={openVideoLab} onGenjutsu={openGenjutsu} onRemix={remixImage}
        onRestore={restoreGeneration} onOpenMv={() => setOverlay('mv')}
        onUploadImages={(files) => files.forEach((f) => addAsset(f, 'image', f.name.replace(/\.[^.]+$/, '')))} />

      {(() => {
        if (!detailId) return null;
        const scene = scenes.find((s) => s.id === detailId);
        if (!scene) return null;
        const order = [...scenes].sort((a, b) => a.x - b.x || a.y - b.y);
        const rawAsset = assets.find((a) => a.id === scene.assetId);
        const asset = resolveDisplayAsset(rawAsset, assets);
        const sketchSource =
          rawAsset?.kind === 'sketch' ? rawAsset : assets.find((a) => a.id === rawAsset?.meta?.sourceSketchId);
        const kreaSource = asset?.meta?.source === 'krea2' && !asset?.meta?.sceneId ? asset : null;
        return (
          <SceneDetail
            scene={scene}
            idx={order.indexOf(scene)}
            asset={asset}
            videoAsset={assets.find((a) => a.id === scene.videoAssetId)}
            sketchSource={sketchSource}
            kreaSource={kreaSource}
            characters={characterAssets}
            styleRefs={styleRefAssets}
            h3Catalog={h3Catalog}
            mvSections={mv.analysis?.sections}
            onUpdate={updateScene}
            onGenerate={safe(generateScene)}
            onGenerateStill={safe(generateSceneStill)}
            onCancel={(s) => cancelJob(s.gen?.jobId)}
            onDelete={deleteScene}
            onClose={() => setDetailId(null)}
            onEditSketch={editSketch}
            onEditKrea={editKrea}
            onEditStudio={openEditStudio}
            onVideoLab={openVideoLab}
            onGenjutsu={openGenjutsu}
            onExtend={safe(extendScene)}
            onFinalize={finalizeScene}
            onRerenderFull={rerenderFull}
            onLongShot={safe(generateLongShot)}
            onRemix={remixImage}
          />
        );
      })()}

      {/* ---- Music video overlay (kept mounted so the wizard state survives) ---- */}
      <div className="overlay" style={overlay === 'mv' ? undefined : { display: 'none' }}>
        <button className="overlay-close glass" onClick={() => setOverlay(null)}>← Board</button>
        <div className="mv-shell">
          <MusicVideoPanel
            mv={mv} setMv={setMv} assets={assets} scenes={scenes} health={health} h3Catalog={h3Catalog}
            batch={batch} scriptBusy={scriptBusy} renderState={renderState}
            onSetTrack={mvSetTrack} onRemoveTrack={mvRemoveTrack}
            onAddCharacters={mvAddCharacters}
            onUpdateCharacter={updateAssetMeta}
            onReplaceCharacterPhoto={replaceAssetBlob}
            onRemoveCharacter={deleteAsset}
            onDescribeCharacter={mvDescribeCharacter}
            onAddStyleRefs={mvAddStyleRefs}
            onRemoveStyleRef={mvRemoveStyleRef}
            onDescribeStyle={mvDescribeStyle}
            styleDescribeBusy={styleDescribeBusy}
            styleDescribeMsg={styleDescribeMsg}
            onWriteScript={mvWriteScript}
            onScenesToBoard={mvScenesToBoard}
            onRunBatch={runBatch} onStopBatch={stopBatch}
            onRenderFinal={mvRenderFinal}
            onOpenDetail={(id) => { setOverlay(null); setDetailId(id); }}
            onFocusScenes={() => { setOverlay(null); focusScenes(); }}
          />
        </div>
      </div>

      {/* ---- TikTok video overlay (kept mounted so the wizard state survives) ---- */}
      <div className="overlay" style={overlay === 'tk' ? undefined : { display: 'none' }}>
        <button className="overlay-close glass" onClick={() => setOverlay(null)}>← Board</button>
        <div className="mv-shell">
          <PanelBoundary><TikTokPanel
            tk={tk} setTk={setTk} assets={assets} scenes={scenes} health={health} h3Catalog={h3Catalog} looks={looks}
            batch={batch} scriptBusy={tkScriptBusy} renderState={tkRenderState}
            onAddSource={tkAddSource} onRemoveSource={tkRemoveSource}
            onTranscribe={tkTranscribe} onDescribeSource={tkDescribeSource}
            transcribeBusy={tkTranscribeBusy} describeBusy={tkDescribeBusy}
            onAddCharacters={tkAddCharacters}
            onUpdateCharacter={updateAssetMeta}
            onReplaceCharacterPhoto={replaceAssetBlob}
            onRemoveCharacter={deleteAsset}
            onDescribeCharacter={mvDescribeCharacter}
            onWriteScript={tkWriteScript}
            onScarify={tkScarify} onMakeScore={tkMakeScore} onFinalSound={tkFinalSound} onUpdateScene={updateScene}
            onRerollLine={tkRerollLine} sceneLine={sceneLine} onRedoStill={tkRedoStill}
            onAddAsset={addAsset} onSetFinal={(id) => setTk((m) => ({ ...m, finalAssetId: id }))}
            onGenerateCharacter={tkGenerateCharacter} onApplyCast={tkApplyCast}
            onParseScript={tkParseScript}
            onDuplicateScene={tkDuplicateScene}
            onRemoveScene={tkRemoveScene}
            onScenesToBoard={tkScenesToBoard}
            onRunBatch={runBatch} onStopBatch={stopBatch}
            onRenderFinal={tkRenderFinal}
            onOpenDetail={(id) => { setOverlay(null); setDetailId(id); }}
            onFocusScenes={() => { setOverlay(null); focusScenes(); }}
          /></PanelBoundary>
        </div>
      </div>

      {/* ---- Sketch overlay (kept mounted so the drawing survives) ---- */}
      <div className="overlay" style={overlay === 'sketch' ? undefined : { display: 'none' }}>
        <button className="overlay-close glass" onClick={() => setOverlay(null)}>← Board</button>
        <div className="sketch-shell">
          <SketchMode active={overlay === 'sketch'} apiRef={sketchApi}
            onSaveSketch={(blob) => rememberSketch(blob, sketchSettings, sketchLoras)}
            onStrokeEnd={scheduleLivePreview} />
          <div className="float-panel glass">
            <SketchPanel settings={sketchSettings} setSettings={setSketchSettings}
              faces={sketchFaces} setFaces={setSketchFaces}
              loras={sketchLoras} setLoras={setSketchLoras}
              livePreview={livePreview} setLivePreview={setLivePreview} preview={preview}
              gen={genImg} busy={busyImg} onGenerate={onGenerateImage}
              onCancel={() => cancelJob(genImg.jobId)} />
          </div>
        </div>
      </div>

      <NavRail overlay={overlay} onGo={navigate} badges={{ jobs: runningJobs }} />

      {/* ---- Home ---- */}
      <div className="overlay home-overlay" style={overlay === 'home' ? undefined : { display: 'none' }}>
        <Home health={health} llm={!!health?.ollama} onNavigate={navigate} projectName={projectName} sceneCount={scenes.length} onStart={() => setOverlay('start')} onDemo={onOpenDemo} />
      </div>
      {restoreOffer && (
        <div className="restore-banner">
          <span>💾 Found an autosaved session from {new Date(restoreOffer.at).toLocaleString()} ({restoreOffer.rec.assets?.length || 0} images, clips and sounds).</span>
          <button className="primary" onClick={() => { applyProject(projectFromAutosave(restoreOffer.rec)); setRestoreOffer(null); }}>Restore it</button>
          <button onClick={() => setRestoreOffer(null)}>Not now</button>
        </div>
      )}
      <div className="overlay" style={overlay === 'start' ? undefined : { display: 'none' }}>
        {overlay === 'start' && <QuickStart onCreate={startVideo} onClose={() => setOverlay('home')} />}
      </div>
      <div className="overlay" style={overlay === 'mcp' ? undefined : { display: 'none' }}><McpPage /></div>
      <div className="overlay" style={overlay === 'loop' ? undefined : { display: 'none' }}><LoopStudio assets={assets} addAsset={addAsset} active={overlay === 'loop'} /></div>
      <div className="overlay" style={overlay === 'settings' ? undefined : { display: 'none' }}><SettingsPage active={overlay === 'settings'} /></div>
      <SetupBanner onOpen={() => setOverlay('settings')} />
      <Tour />
      <div className="overlay" style={overlay === 'models' ? undefined : { display: 'none' }}>
        <ModelManager active={overlay === 'models'} />
      </div>

      <div className="overlay has-banner" style={overlay === 'voice' ? undefined : { display: 'none' }}>
        <ToolBanner overlay="voice" />
        <VoiceStudio active={overlay === 'voice'} addAsset={addAsset} onUseInTimeline={() => setOverlay('timeline')} />
      </div>

      <div className="overlay" style={overlay === 'assistant' ? undefined : { display: 'none' }}>
        <AssistantPanel active={overlay === 'assistant'} assets={assets} />
      </div>

      <div className="overlay" style={overlay === 'explore' ? undefined : { display: 'none' }}>
        <Explore active={overlay === 'explore'} onRecreate={exploreRecreate} onUse={exploreUse} onRecreateShot={exploreRecreateShot} onRecreateFilm={exploreRecreateFilm} />
      </div>

      <div className="overlay" style={overlay === 'jobs' ? undefined : { display: 'none' }}>
        <JobsPanel active={overlay === 'jobs'} onCount={setRunningJobs}
          onUseJob={async (j) => {
            const blob = await (await fetch(`/api/jobs/${j.id}/media`)).blob();
            const isVideo = blob.type.startsWith('video');
            if (isVideo) await addVideoAssetFromUrl(URL.createObjectURL(blob), (j.title || 'job').slice(0, 40), { source: 'job', jobId: j.id });
            else addAsset(blob, 'image', (j.title || 'job').slice(0, 40), { source: 'job', jobId: j.id, prompt: j.title });
          }} />
      </div>

      {/* ---- Flux 3 overlay (kept mounted so results/refs survive) ---- */}
      <div className="overlay has-banner" style={overlay === 'flux3' ? undefined : { display: 'none' }}>
        <ToolBanner overlay="flux3" />
        <Flux3Panel
          settings={fluxSettings} setSettings={setFluxSettings} assets={assets}
          onResult={onFluxResult}
          faces={fluxFaces} setFaces={setFluxFaces} loras={fluxLoras} setLoras={setFluxLoras}
          active={overlay === 'flux3'}
          onAnimate={(a) => { const c = boardCenter(); addSceneFromAsset(a.id, c.x, c.y); setOverlay(null); }}
        />
      </div>

      {/* ---- Scene Composer overlay (3D blocking -> depth-controlled image) ---- */}
      <div className="overlay has-banner" style={overlay === 'scene' ? undefined : { display: 'none' }}>
        <ToolBanner overlay="scene" />
        <SceneComposer assets={assets} onResult={onFluxResult} active={overlay === 'scene'} />
      </div>

      {/* ---- Edit Studio overlay ---- */}
      <div className="overlay has-banner" style={overlay === 'edit' ? undefined : { display: 'none' }}>
        <ToolBanner overlay="edit" />
        <EditStudio assets={assets} onResult={onFluxResult} incoming={editIncoming} active={overlay === 'edit'} />
      </div>

      {/* ---- Timeline editor (kept mounted so playback state survives tab switches) ---- */}
      <div className="overlay" style={overlay === 'timeline' ? undefined : { display: 'none' }}>
        <TimelineEditor assets={assets} scenes={[...scenes].sort((a, b) => a.x - b.x || a.y - b.y)} timeline={timeline} setTimeline={setTimeline} addAsset={addAsset} looks={looks} active={overlay === 'timeline'} onExtend={(assetId, place) => extendAsset(assetId, place).catch(() => {})} onPlaced={(id) => updateScene(id, { placeAfter: null })} />
      </div>

      {/* ---- Lip-sync Studio overlay ---- */}
      <div className="overlay has-banner" style={overlay === 'lipsync' ? undefined : { display: 'none' }}>
        <ToolBanner overlay="lipsync" />
        <LipSyncStudio assets={assets} addAsset={addAsset} incoming={lipIncoming} />
      </div>

      {/* ---- Ad Studio overlay ---- */}
      <div className="overlay has-banner" style={overlay === 'ads' ? undefined : { display: 'none' }}>
        <ToolBanner overlay="ads" />
        <AdStudio onCreate={createAdScenes} />
      </div>

      {/* ---- Genjutsu overlay ---- */}
      <div className="overlay has-banner" style={overlay === 'genjutsu' ? undefined : { display: 'none' }}>
        <ToolBanner overlay="genjutsu" />
        <GenjutsuStudio assets={assets} addAsset={addAsset} incoming={gjIncoming} />
      </div>

      {/* ---- Character Studio overlay ---- */}
      <div className="overlay has-banner" style={overlay === 'chars' ? undefined : { display: 'none' }}>
        <ToolBanner overlay="chars" />
        <CharacterStudio assets={assets} addAsset={addAsset} updateAssetMeta={updateAssetMeta} />
      </div>

      {/* ---- Video Lab overlay ---- */}
      <div className="overlay has-banner" style={overlay === 'lab' ? undefined : { display: 'none' }}>
        <ToolBanner overlay="lab" />
        <VideoLab assets={assets} addAsset={addAsset} incoming={labIncoming} />
      </div>

      {/* ---- Krea 2 overlay ---- */}
      <div className="overlay" style={overlay === 'krea' ? undefined : { display: 'none' }}>
        <button className="overlay-close glass" onClick={() => setOverlay(null)}>← Board</button>
        <div className="sketch-shell">
          <div className="float-panel glass">
            <KreaPanel
              settings={kreaSettings} setSettings={setKreaSettings}
              moodboard={moodboard} setMoodboard={setMoodboard}
              faces={faces} setFaces={setFaces}
              loras={loras} setLoras={setLoras}
              gen={genKrea} busy={busyKrea} onGenerate={onGenerateKrea}
              onCancel={() => cancelJob(genKrea.jobId)}
            />
          </div>
        </div>
      </div>

      {/* ---- 3D studio overlay (kept mounted so the scene survives) ---- */}
      <div className="overlay" style={overlay === 'studio' ? undefined : { display: 'none' }}>
        <button className="overlay-close glass" onClick={() => setOverlay(null)}>← Board</button>
        <div className="studio-shell">
          <Toolbar
            gizmoMode={gizmoMode} depthView={depthView} hasSelection={!!selected} studioRef={studioRef}
            onAdd={(t) => studioRef.current?.addPrimitive(t)}
            onMode={(m) => { setGizmoMode(m); studioRef.current?.setGizmoMode(m); }}
            onDelete={() => studioRef.current?.deleteSelected()}
            onDepthView={() => setDepthView((v) => !v)}
          />
          <div className="viewport" ref={mountRef} />
          <aside className="side">
            <Inspector selected={selected} objects={objects}
              onPick={(o) => studioRef.current?.select(o)}
              onChange={() => setSelected((s) => s)} />
            <GeneratePanel settings={settings} setSettings={setSettings}
              numFrames={numFrames} gen={gen} busy={busy} onGenerate={onGenerate}
              onCancel={() => cancelJob(gen.jobId)} />
          </aside>
          <Timeline
            time={time} setTime={setTime} seconds={settings.seconds} keyframes={keyframes}
            playing={playing} setPlaying={setPlaying}
            throughLens={throughLens} setThroughLens={setThroughLens}
            onAddKeyframe={() => studioRef.current?.addKeyframe(time)}
            onDeleteKeyframe={(id) => studioRef.current?.deleteKeyframe(id)}
            onClear={() => studioRef.current?.clearKeyframes()}
            disabled={busy}
          />
        </div>
      </div>
    </div>
  );
}
