import React, { useEffect, useMemo, useRef, useState } from 'react';
import GenProgress from './GenProgress.jsx';
import { SceneStage } from '../three/SceneStage.js';
import { PROPS, PROP_TYPES, PROP_CATS } from '../three/props.js';
import { OUTFITS, skinsEnabled } from '../three/skins.js';
import { CINE, CINE_GROUPS, CINE_BY_ID, cinePrompt, applyCinematic, previewAll } from '../cinematic.js';
import { fitPose, SKELETON, figuresLeftToRight, placeFromPhoto } from '../three/poseFit.js';
import { POSES, HAND_POSES, BODY_SLIDERS, HAIR_STYLES } from '../three/Figure.js';
import { useGenre } from '../genreStore.js';
import { ARM_ACTIONS, LEG_ACTIONS } from '../limbs.js';
import { buildFromAnalysis } from '../sceneImport.js';
import { readPhotoPose, generateScene, generateFlux3, faceSwap, faceMatch, analyzeScene, sceneStatus, cancelJob, directScene, listScenes, saveScene, openScene, deleteScene } from '../api.js';
import { parseDirection, applyPlan, autoFrame } from '../directScene.js';

// Scene Composer — block a shot in 3D (camera, lens, people, props), then Qwen Image 2.1 renders it with the depth of your
// layout as a hard constraint. Drop a photo to rebuild its layout in 3D first, move things, and generate again.

const SIZES = {
  '16:9': [1344, 768], '9:16': [768, 1344], '1:1': [1024, 1024], '4:3': [1216, 912], '3:4': [912, 1216], '2.39:1': [1536, 640],
};
const snap = (s) => (s && s !== 'camera'
  ? { id: s.id, kind: s.kind, label: s.label, color: s.color, note: s.note, pose: s.fig?.poseName, height: s.fig?.build.height, build: s.fig ? { ...s.fig.build } : null, hands: s.fig?.hands }
  : s);
const LOOKS = {
  photo: ['Photoreal', 'A candid, ultra-realistic photograph taken with a full-frame camera. Real human skin with pores and natural imperfections, real fabric clothing with folds and texture, a fully detailed real-world environment, natural light, subtle film grain. Not a render, not CGI, not a mannequin.'],
  cinematic: ['Cinematic film still', 'A still frame from a high-budget feature film, anamorphic lens, cinematic colour grading, moody practical lighting, real actors in real wardrobe, a lived-in set with rich background detail and depth, subtle film grain.'],
  editorial: ['Editorial', 'A professional editorial photograph with studio-quality lighting, sharp focus, real people with natural skin texture, styled wardrobe, premium magazine look.'],
  doc: ['Documentary', 'A documentary-style photograph in available light, candid real people in a real environment, natural colours, slightly imperfect framing.'],
};
const SETTINGS = {
  Bedroom: 'a lived-in bedroom with an unmade bed, a bedside lamp, curtains, framed pictures on the wall and clothes draped over a chair',
  'Living room': 'a cosy living room with a sofa, a coffee table, bookshelves, a rug, warm lamps and a window with daylight',
  Kitchen: 'a home kitchen with wooden cabinets, a counter with dishes and fruit, a stove and a window above the sink',
  Office: 'a modern office with desks, monitors, glass partitions, plants and fluorescent ceiling lights',
  'City street': 'a city street at night with wet asphalt, neon shop signs, parked cars and glowing windows',
  Alley: 'a narrow rain-soaked back alley with brick walls, fire escapes, steam from a grate and a single lamp',
  Forest: 'a misty forest with tall trees, ferns, dappled sunlight and a dirt path',
  Beach: 'a beach at golden hour with soft waves, wet sand, driftwood and a glowing horizon',
  Cafe: 'a busy cafe interior with small tables, a coffee bar, hanging lights, chalkboard menus and other customers softly out of focus',
  Warehouse: 'a dim industrial warehouse with concrete floor, steel shelving, wooden crates and shafts of light from high windows',
  'Subway platform': 'an underground subway platform with tiled walls, a yellow safety line, overhead lights and a train in the distance',
};
const AUTOSAVE = 'hoodsfield.scene.autosave.v1';
const blobToData = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
const jointHint = (j) => {
  const n = j.name;
  if (j.mode === 'translate') {
    if (/^(hand|foot)/.test(n)) return `drag the arrows to place the ${n.startsWith('hand') ? 'hand' : 'foot'}; the ${n.startsWith('hand') ? 'arm' : 'leg'} bends to follow.`;
    if (/^(fore|shin)/.test(n)) return `drag to swing the ${n.startsWith('fore') ? 'elbow' : 'knee'} around; the ${n.startsWith('fore') ? 'hand' : 'foot'} stays where it is.`;
    return 'drag to shift the body; both feet stay planted.';
  }
  if (/^(hand|foot)/.test(n)) return `drag the rings to turn the ${n.startsWith('hand') ? 'hand' : 'foot'}.`;
  return 'drag the rings to bend or twist this joint.';
};
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

export default function SceneComposer({ assets = [], onResult, active = true }) {
  const mount = useRef(null);
  const stageRef = useRef(null);
  const fileRef = useRef(null);
  const refFileRef = useRef(null);
  const [items, setItems] = useState([]);
  const [joint, setJoint] = useState(null);
  const [atLimit, setAtLimit] = useState(false);
  const [limits, setLimits] = useState(true);
  const [bodyText, setBodyText] = useState(true);
  const [dir, setDir] = useState({ text: '', busy: false, msg: '' });
  const [look, setLook] = useState('photo');
  const [cineId, setCineId] = useState('');
  const [cineMsg, setCineMsg] = useState('');
  const [poseImp, setPoseImp] = useState(null);   // {busy, error, url, poses, targets, mirror, faceCam}
  const poseFile = useRef(null);
  const [dropHot, setDropHot] = useState(false);
  const [poseLib, setPoseLib] = useState(() => { try { return JSON.parse(localStorage.getItem('hfPoseLib') || '[]'); } catch { return []; } });
  const savePoseLib = (list) => { setPoseLib(list); try { localStorage.setItem('hfPoseLib', JSON.stringify(list)); } catch { /* storage full: the library just will not persist */ } };
  const poseCanvas = useRef(null);
  const [cineGrid, setCineGrid] = useState(null);   // {busy, done, total, items:[{preset,url}]}
  const [setting, setSetting] = useState('');
  const [lockEnd, setLockEnd] = useState(0.7);
  const [anat, setAnat] = useState(false);
  const [realistic, setRealistic] = useState(() => skinsEnabled());
  const [picker, setPicker] = useState(false);
  const [lockFaces, setLockFaces] = useState(true);
  const { genre } = useGenre();
  const gstyle = genre.still_style ? genre.still_style + '.' : '';
  const [sel, setSel] = useState(null);           // item meta | 'camera' | null
  const [shot, setShot] = useState({ height: 1.5, pitch: 0, yaw: 0, lens: 35, fov: 40 });
  const [rect, setRect] = useState(null);
  const [view, setView] = useState('layout');
  const [aspectKey, setAspectKey] = useState('16:9');
  const [gizmo, setGizmo] = useState('translate');
  const [prompt, setPrompt] = useState('');
  const [auto, setAuto] = useState(true);
  const [strength, setStrength] = useState(0.85);
  const [steps, setSteps] = useState(25);
  const [floor, setFloor] = useState(true);
  const [wall, setWall] = useState(true);
  const [overlay, setOverlay] = useState({ url: null, opacity: 0.4 });
  const [refs, setRefs] = useState({});           // item id -> {blob, url}
  const [status, setStatus] = useState(null);
  const [scan, setScan] = useState({ busy: false, msg: '', error: '' });
  const [run, setRun] = useState({ phase: 'idle', progress: 0, status: '', jobId: null, error: null, startedAt: 0 });
  const [results, setResults] = useState([]);     // [{url, asset}]
  const [showResult, setShowResult] = useState(null);
  const [depthUrl, setDepthUrl] = useState(null);
  const [tick, setTick] = useState(0);            // bump to refresh the layout description
  const [saves, setSaves] = useState({ open: false, list: [], name: 'My scene', msg: '', busy: false });

  // ---- saving: autosave in the browser + named scenes on disk
  const uiState = () => ({ cineId, prompt, setting, look, dirText: dir.text, strength, lockEnd, steps, auto, bodyText, floor, wall, aspectKey, limits });
  const snapshot = () => ({ scene: stageRef.current.serialize(), ui: uiState() });
  const refsData = async () => {
    const out = [];
    const st = stageRef.current;
    for (let i = 0; i < st.items.length; i++) { const r = refs[st.items[i].id]; if (r) out.push({ index: i, data: await blobToData(r.blob) }); }
    return out;
  };
  const restoreState = async (data) => {
    const stg = stageRef.current, u = data.ui || {};
    setCineId(u.cineId ?? ''); setPrompt(u.prompt ?? ''); setSetting(u.setting ?? ''); setLook(u.look ?? 'photo'); setDir((d) => ({ ...d, text: u.dirText ?? '', msg: '' }));
    setStrength(u.strength ?? 0.85); setLockEnd(u.lockEnd ?? 0.7); setSteps(u.steps ?? 25); setAuto(u.auto ?? true); setBodyText(u.bodyText ?? true);
    setFloor(u.floor ?? true); setWall(u.wall ?? true); setLimits(u.limits ?? true);
    if (u.aspectKey) setAspectKey(u.aspectKey);
    stg.load(data.scene);
    const next = {};
    for (const r of data.refs || []) {
      const it = stg.items[r.index]; if (!it) continue;
      const blob = await (await fetch(r.data)).blob();
      it.ref = blob; next[it.id] = { blob, url: URL.createObjectURL(blob) };
    }
    setRefs(next); stg._emit();
  };
  const doSave = async () => {
    setSaves((s) => ({ ...s, busy: true, msg: '' }));
    try {
      const r = await saveScene(saves.name, { ...snapshot(), refs: await refsData() }, stageRef.current.thumbnail());
      setSaves((s) => ({ ...s, busy: false, name: r.name, msg: `Saved “${r.name}” ✓` }));
      listScenes().then((list) => setSaves((s) => ({ ...s, list })));
    } catch (e) { setSaves((s) => ({ ...s, busy: false, msg: e.message })); }
  };
  const doOpen = async (name) => {
    try { await restoreState(await openScene(name)); setSaves((s) => ({ ...s, name, msg: `Opened “${name}”` })); } catch (e) { setSaves((s) => ({ ...s, msg: e.message })); }
  };
  const doDelete = async (name) => { await deleteScene(name); listScenes().then((list) => setSaves((s) => ({ ...s, list }))); };

  // ---- stage lifecycle
  useEffect(() => {
    const st = new SceneStage(mount.current, {
      onObjects: (l) => { setItems(l); setTick((t) => t + 1); },
      onSelect: (s) => setSel(snap(s)),
      onJoint: (name, label, ik, mode, canMove) => { setAtLimit(false); setJoint(name ? { name, label, ik, mode, canMove } : null); if (name) setGizmo(mode === 'translate' ? 'translate' : 'rotate'); },
      onLimit: setAtLimit,
      onShot: (i) => { setShot(i); setTick((t) => t + 1); },
      onRect: setRect,
    });
    stageRef.current = st;
    const devHash = location.hash.includes('?');          // test URLs always start from the default scene
    let restored = false;
    if (!devHash) {
      try { const raw = localStorage.getItem(AUTOSAVE); if (raw) { restoreState(JSON.parse(raw)); restored = true; setSaves((x) => ({ ...x, msg: 'Restored your last scene' })); } } catch { /* start fresh */ }
    }
    if (!restored) {
      st.add('person', { label: 'man', gender: 'male', position: [-1.1, 0, 0], rotationY: 0.35, silent: true });
      st.add('person', { label: 'woman', gender: 'female', position: [1.1, 0, 0.2], rotationY: -0.35, silent: true });
      st.select(null);
      st.shot.lookAt(0, 1.1, 0);
    }
    st._emit();
    listScenes().then((list) => setSaves((x) => ({ ...x, list })));
    sceneStatus().then(setStatus);
    window.__scene = st;
    // dev/test hook: #scene?cam=face|full&preset=hips renders a given view straight away (used for headless screenshots)
    if (location.hash.startsWith('#scene')) {
      const q = new URLSearchParams(location.hash.split('?')[1] || '');
      setTimeout(() => {
        if (q.get('preset')) st.items.filter((i) => i.fig).forEach((i) => i.fig.applyPreset(q.get('preset')));
        if (q.get('rt')) {   // save/load round trip: serialize -> load -> serialize must match
          applyPlan(st, parseDirection('a woman sits on a couch, her right leg reclined on the couch and her arm outstretched over the top of the couch. a man stands behind her pointing at the camera.', []));
          const d1 = JSON.stringify(st.serialize()); st.load(JSON.parse(d1)); const d2 = JSON.stringify(st.serialize());
          document.title = `RT:${d1 === d2 ? 'MATCH' : 'DIFF'}:${d1.length}`;
          if (d1 !== d2) { const a1 = JSON.parse(d1), a2 = JSON.parse(d2); const diffs = []; a1.items.forEach((x, i) => { const y = a2.items[i]; Object.keys(x).forEach((k) => { if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) { if (k === 'fig') { Object.keys(x.fig.pose.r).forEach((b) => { if (JSON.stringify(x.fig.pose.r[b]) !== JSON.stringify(y.fig.pose.r[b])) diffs.push(x.label + '.' + b + ' ' + x.fig.pose.r[b] + ' -> ' + y.fig.pose.r[b]); }); if (x.fig.pose.drop !== y.fig.pose.drop) diffs.push('drop'); } else diffs.push(x.label + '.' + k); } }); }); document.title += ':' + diffs.join(' | '); }
        }
        if (q.get('say')) { applyPlan(st, parseDirection(q.get('say'), [])); st.setView('shot'); setView('shot'); }
        if (q.get('cam') === 'face') {
          const it = st.items.filter((i) => i.fig)[+(q.get('who') || 0)]; const p = it.root.position, y = it.root.rotation.y;
          st.setLens(85);
          const az = y + (+(q.get('az') || 0) * Math.PI) / 180, dd = +(q.get('dist') || 1.0);
          st.shot.position.set(p.x + Math.sin(az) * dd, +(q.get('h') || 1.62), p.z + Math.cos(az) * dd);
          st.shot.lookAt(p.x, 1.62, p.z);
        } else if (q.get('cam') === 'full') { st.setLens(35); }
        st.setView('shot'); setView('shot'); st._emit();
        if (q.get('box')) document.title = 'BOX:' + JSON.stringify(st.items.filter((i) => i.fig).map((i) => [i.label, ...Object.values(st.screenBox(i, 1344, 768)).map(Math.round)]));
        if (q.get('depth')) st.renderDepth(1344 / 2, 768 / 2).then((b) => setDepthUrl(URL.createObjectURL(b)));
      }, 500);
    }
    return () => st.dispose();
  }, []);
  useEffect(() => { stageRef.current?.setActive(active); }, [active]);

  const stage = () => stageRef.current;
  const size = SIZES[aspectKey];
  useEffect(() => { stage()?.setAspect(size[0] / size[1]); }, [aspectKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { stage()?.setFloor(floor); }, [floor]);
  useEffect(() => {   // autosave (layout + settings; reference photos are kept in named saves)
    const t = setTimeout(() => {
      try { if (stageRef.current && !location.hash.includes('?')) localStorage.setItem(AUTOSAVE, JSON.stringify(snapshot())); } catch { /* storage full or blocked */ }
    }, 700);
    return () => clearTimeout(t);
  }, [tick, prompt, setting, look, dir.text, strength, lockEnd, steps, auto, bodyText, floor, wall, aspectKey, limits]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { stage()?.setWall(wall); }, [wall]);

  const selItem = sel && sel !== 'camera' ? items.find((i) => i.id === sel.id) : null;
  const layout = useMemo(() => stage()?.describe({ body: bodyText }), [tick, bodyText]); // eslint-disable-line react-hooks/exhaustive-deps

  const refList = items.filter((i) => refs[i.id]);
  const fullPrompt = useMemo(() => {
    if (!layout) return prompt;
    const parts = [CINE_BY_ID[cineId] ? cinePrompt(CINE_BY_ID[cineId]) : '', LOOKS[look]?.[1] || '', CINE_BY_ID[cineId] ? '' : gstyle,   // a cinematic setup replaces the genre's handheld/amateur style text
    setting.trim() ? `Setting: ${setting.trim().replace(/\.$/, '')}.` : (wall ? 'Setting: a real, detailed interior room with walls, a ceiling, furniture, decor and natural light, never a blank or white background.' : 'Setting: a real, detailed outdoor location with ground, sky and surroundings, never a blank or white background.'), prompt.trim()];
    if (auto) {
      parts.push(`Camera: ${layout.camera}.`);
      if (layout.subjects.length) parts.push(`Exact layout in frame, left to right: ${layout.subjects.join('; ')}.`);
    }
    refList.forEach((it, n) => parts.push(`Image ${n + 1} shows the ${it.label}: use that person's face, hair and likeness for the ${it.label}.`));
    parts.push('Every person is fully clothed in realistic everyday clothing from the neck to the ankles; only faces and hands show skin.');
    return parts.filter(Boolean).join(' ');
  }, [prompt, layout, auto, refList.length, refs, look, setting, wall, gstyle, cineId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- actions
  const setViewMode = (v) => { setView(v); stage()?.setView(v); };
  const applyCine = (p) => {
    const r = applyCinematic(stage(), p);
    setCineId(p.id); setWall(!!p.wall); setViewMode('shot'); setCineGrid(null);
    setCineMsg(`${p.label}: ${p.cam.lens} mm, ${r.props.length} set pieces added.${r.note ? ` ${r.note}` : ''} Move anything to taste, then generate.`);
  };
  // ---- pose from a photo
  const importPose = async (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPoseImp({ busy: true, url, poses: [], targets: [], mirror: false, faceCam: true });
    try {
      const d = await readPhotoPose(file);
      if (!d.poses.length) { setPoseImp({ busy: false, url, poses: [], targets: [], error: 'No person found in that photo. Try one where the whole body or at least the upper body is clearly visible.' }); return; }
      const figs = figuresLeftToRight(stage());
      const targets = d.poses.map((_, i) => (figs[i] ? String(figs[i].id) : (i % 2 ? 'new-female' : 'new-male')));
      setPoseImp({ busy: false, url, poses: d.poses, w: d.width, h: d.height, targets, mirror: false, faceCam: true });
    } catch (e) { setPoseImp({ busy: false, url, poses: [], targets: [], error: e.message }); }
  };
  // every pose imported from a photo is kept in "My poses" with a small picture of the person
  const rememberPoses = (url, list) => {
    if (!list.length) return;
    const img = new Image();
    img.onload = () => {
      const entries = list.map(({ pose, box }) => {
        const bw = (box[2] - box[0]) * img.naturalWidth, bh = (box[3] - box[1]) * img.naturalHeight;
        const c = document.createElement('canvas'); c.width = 72; c.height = 96;
        const g = c.getContext('2d'); g.fillStyle = '#10131c'; g.fillRect(0, 0, 72, 96);
        const k = Math.min(72 / bw, 96 / bh) * 0.92;
        g.drawImage(img, box[0] * img.naturalWidth, box[1] * img.naturalHeight, bw, bh, (72 - bw * k) / 2, (96 - bh * k) / 2, bw * k, bh * k);
        return { id: Math.random().toString(36).slice(2, 9), name: 'Photo pose', pose, thumb: c.toDataURL('image/jpeg', 0.7) };
      });
      setPoseLib((cur) => { const next = [...entries, ...cur].slice(0, 24); try { localStorage.setItem('hfPoseLib', JSON.stringify(next)); } catch { /* ignore */ } return next; });
    };
    img.src = url;
  };
  const usePose = (entry) => {
    const st = stage(); const it = st.selected && st.selected.kind === 'person' ? st.selected : null;
    if (!it) { setDir((d) => ({ ...d, msg: 'Click a person in the 3D view first, then pick a saved pose.' })); return; }
    it.fig.setPose(entry.pose); it.sitsOn = null; it.limbText = {}; st._emit();
    setDir((d) => ({ ...d, msg: `Gave ${it.label} that pose. Drag any joint to fine-tune.` }));
  };
  const applyPoses = () => {
    const st = stage(); const pi = poseImp; let n = 0; let last = null; const saved = [];
    pi.poses.forEach((p, i) => {
      const t = pi.targets[i]; if (!t || t === 'skip') return;
      const fit = fitPose(p.world, { mirror: pi.mirror });
      let it;
      if (t.startsWith('new')) {
        const pl = placeFromPhoto(st, p, pi.w / pi.h);
        it = st.add('person', { gender: t === 'new-female' ? 'female' : 'male', position: pl.position, rotationY: pl.toCamera + (pi.faceCam ? fit.yaw : 0), label: t === 'new-female' ? 'woman' : 'man' });
      } else {
        it = st.items.find((x) => x.id === +t); if (!it) return;
        if (pi.faceCam) it.root.rotation.y = Math.atan2(st.shot.position.x - it.root.position.x, st.shot.position.z - it.root.position.z) + fit.yaw;
      }
      it.fig.setPose(fit.pose); it.sitsOn = null; it.limbText = {};
      n += 1; last = it;
      saved.push({ pose: fit.pose, box: p.box });
    });
    rememberPoses(pi.url, saved);
    if (last) st.select(last);
    st._emit(); setViewMode('shot'); setPoseImp(null);
    setDir((d) => ({ ...d, msg: `${n} pose${n === 1 ? '' : 's'} copied from the photo. Drag any joint to fine-tune.` }));
  };
  useEffect(() => {
    const pi = poseImp; const cv = poseCanvas.current;
    if (!pi?.url || !cv || !pi.poses?.length) return undefined;
    const img = new Image();
    img.onload = () => {
      const W = 460, H = Math.round((W * img.naturalHeight) / img.naturalWidth);
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d'); g.drawImage(img, 0, 0, W, H);
      const cols = ['#00f2fe', '#ff7ab8', '#ffc857', '#7ef0b0', '#b69bff', '#ff8f6b'];
      pi.poses.forEach((p, k) => {
        if (pi.targets[k] === 'skip') { g.globalAlpha = 0.3; } else g.globalAlpha = 1;
        g.strokeStyle = cols[k % cols.length]; g.fillStyle = cols[k % cols.length]; g.lineWidth = 3;
        SKELETON.forEach(([a, b]) => { const A = p.image[a], B = p.image[b]; if (A[3] < 0.3 || B[3] < 0.3) return; g.beginPath(); g.moveTo(A[0] * W, A[1] * H); g.lineTo(B[0] * W, B[1] * H); g.stroke(); });
        p.image.forEach((l, i) => { if (l[3] > 0.3 && i > 10) { g.beginPath(); g.arc(l[0] * W, l[1] * H, 3.5, 0, 6.3); g.fill(); } });
        g.font = '700 16px sans-serif'; g.fillText(String(k + 1), p.box[0] * W, Math.max(16, p.box[1] * H - 6));
      });
      g.globalAlpha = 1;
    };
    img.src = pi.url;
    return undefined;
  }, [poseImp?.url, poseImp?.poses, poseImp?.targets]);
  useEffect(() => {
    if (!active) return undefined;
    const onPaste = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
      if (f) { e.preventDefault(); importPose(f); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {      // Tab flips between the 3D scene and the generated image
    if (!active) return undefined;
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (!results.length) return;
      e.preventDefault();
      setShowResult((cur) => (cur ? null : results[0]));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, results]);
  const clearCine = () => { stage().items.filter((i) => i.auto === 'cine').forEach((i) => stage().remove(i.id, true)); stage()._emit(); setCineId(''); setCineMsg(''); };
  const runPreviewAll = async () => {
    if (!stage().items.some((i) => i.kind === 'person')) { setCineMsg('Add or position at least one person first, then preview.'); return; }
    setCineGrid({ busy: true, done: 0, total: CINE.length, items: [] });
    try {
      const items = await previewAll(stage(), CINE, (done, total) => setCineGrid((g) => (g ? { ...g, done, total } : g)));
      setCineGrid({ busy: false, done: items.length, total: items.length, items });
    } catch (e) { setCineGrid(null); setCineMsg(`Preview failed: ${e.message}`); }
    setView(stage().view);
  };
  const addPerson = (gender) => stage()?.add('person', { gender });
  const addProp = (k) => { const it = stage()?.add(k, { label: k }); if (it && (PROP_TYPES.includes(k) || ['couch', 'sectional', 'armchair', 'chair', 'bed', 'table', 'bench'].includes(k))) { it.root.position.set(0, 0, -1); stage()._emit(); } };
  const camSel = () => stage()?.select('camera');
  const setLens = (mm) => stage()?.setLens(mm);

  const poseOp = (fn) => { fn(stage()); setSel(snap(stage().selected)); };

  const pickRef = (file) => {
    if (!file || !selItem) return;
    const it = stage().items.find((i) => i.id === selItem.id);
    if (it) it.ref = file;
    setRefs((r) => ({ ...r, [selItem.id]: { blob: file, url: URL.createObjectURL(file) } }));
    stage()._emit();
  };
  const clearRef = () => {
    if (!selItem) return;
    const it = stage().items.find((i) => i.id === selItem.id);
    if (it) it.ref = null;
    setRefs((r) => { const n = { ...r }; delete n[selItem.id]; return n; });
    stage()._emit();
  };

  const doDirect = async () => {
    const text = dir.text.trim();
    if (!text) return;
    setDir((d) => ({ ...d, busy: true, msg: 'Reading your stage directions…' }));
    const cast = stage().items.filter((i) => i.kind === 'person').map((i) => ({ label: i.label, gender: i.fig.build.gender }));
    const r = parseDirection(text, cast).fallback ? await directScene(text, cast) : { plan: null };
    // a small local model likes to invent camera moves; honour them only when the directions actually ask for one
    const asksCamera = /angle|above|below|overhead|aerial|close-?up|wide|lens|tight|low|high/i.test(text);
    // the rule parser decides who is in the scene (a 7B model invents extra people and drops details); the model is the fallback for text it cannot read
    const rule = parseDirection(text, cast);
    const plan = !rule.fallback ? rule : r.plan ? { ...r.plan, camera: asksCamera ? r.plan.camera : {}, source: `local AI (${r.model})`, model: r.model } : rule;
    try {
      const used = applyPlan(stage(), plan);
      if (!prompt.trim()) setPrompt(text);
      setRefs({});
      setViewMode('shot');
      setDir((d) => ({ ...d, busy: false, msg: `${used.people.length} ${used.people.length === 1 ? 'person' : 'people'} placed using the ${used.source}. Drag any joint to tweak.${r.plan ? '' : ' (Start Ollama for richer scenes.)'}` }));
    } catch (e) {
      setDir((d) => ({ ...d, busy: false, msg: `Could not apply that: ${e.message}` }));
    }
  };

  const doScan = async (blob) => {
    setScan({ busy: true, msg: 'Reading depth, camera and objects…', error: '' });
    try {
      const url = URL.createObjectURL(blob);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const res = await analyzeScene(blob);
      const best = Object.entries(SIZES).map(([k, [w, h]]) => [k, Math.abs(Math.log((w / h) / (img.naturalWidth / img.naturalHeight)))]).sort((a, b) => a[1] - b[1])[0][0];
      setAspectKey(best);
      const msg = buildFromAnalysis(stage(), res, SIZES[best][0] / SIZES[best][1]);
      setOverlay({ url, opacity: 0.4 });
      setRefs({});
      setScan({ busy: false, msg: `${msg}. Move anything that is off, then generate.`, error: '' });
      setViewMode('shot');
    } catch (e) {
      setScan({ busy: false, msg: '', error: e.message });
    }
  };

  const previewDepth = async () => {
    const blob = await stage().renderDepth(size[0] / 2, size[1] / 2);
    setDepthUrl((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(blob); });
  };

  const generate = async () => {
    const st = stage();
    setRun({ phase: 'run', progress: 0, status: 'Rendering the depth of your layout…', jobId: null, error: null, startedAt: Date.now() });
    try {
      const control = await st.renderDepth(size[0], size[1]);
      const res = await generateScene(
        { prompt: fullPrompt || 'a cinematic photograph', width: size[0], height: size[1], steps, cfg: 1, strength, end: lockEnd },
        control, refList.map((i) => refs[i.id].blob),
        (ev) => {
          if (ev.type === 'submitted') setRun((r) => ({ ...r, jobId: ev.jobId }));
          else if (ev.type === 'progress') setRun((r) => ({ ...r, progress: ev.max ? ev.value / ev.max : 0, status: `Sampling ${ev.value}/${ev.max}` }));
          else if (ev.type === 'status') setRun((r) => ({ ...r, status: ev.text }));
        },
      );
      let outUrl = res.url;
      if (lockFaces && refList.length) {
        try { outUrl = await applyFaces(res.url); } catch (e) { setRun((r) => ({ ...r, status: `Face pass skipped: ${e.message}` })); }
      }
      const asset = await onResult?.(outUrl, { prompt: fullPrompt, source: 'scene-composer' });
      const entry = { url: asset?.url || outUrl, asset };
      setResults((l) => [entry, ...l]);
      setShowResult(entry);
      setRun((r) => ({ ...r, phase: 'done', status: 'Done' }));
    } catch (e) {
      setRun((r) => (e.message === 'Cancelled' ? { ...r, phase: 'idle' } : { ...r, phase: 'error', error: e.message }));
    }
  };

  /** Put each character photo's real face on its person (InSwapper, exact identity), then a masked detail pass; keeps whichever matches the photo better. */
  const applyFaces = async (url) => {
    const st = stage();
    const people = st.items.filter((i) => i.fig && refs[i.id]);
    if (!people.length) return url;
    let blob = await (await fetch(url)).blob();
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(blob); });
    const W = img.naturalWidth, H = img.naturalHeight;
    const drawMask = (b) => new Promise((res) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.fillStyle = '#fff';
      g.beginPath(); g.roundRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 24); g.fill();
      c.toBlob(res, 'image/png');
    });
    const say = (status, progress) => setRun((r) => ({ ...r, status, progress: progress ?? r.progress }));
    for (let n = 0; n < people.length; n++) {
      const p = people[n];
      const base = n / people.length;
      say(`Putting ${p.label}'s real face on (${n + 1}/${people.length})…`, base + 0.05 / people.length);
      const mask = await drawMask(st.screenBox(p, W, H, 0.04));
      let swapped;
      try { swapped = await faceSwap(blob, refs[p.id].blob, { mask }); } catch (e) { say(`${p.label}: ${e.message}. Left as generated.`); continue; }
      let best = swapped;
      try {
        say(`Restoring detail on ${p.label}…`, base + 0.4 / people.length);
        const prompt = `Enhance this region of the photo: restore sharp, natural skin texture, crisp eyes, eyelashes and lips on the face of the ${p.label}. Keep the person's face, expression, hair, pose, clothing and the background exactly the same.`;
        const res = await generateFlux3({ prompt, steps: 8, cfg: 1, match_ref_size: true, mask_feather: 10 }, [swapped], [], [],
          (ev) => { if (ev.type === 'progress') say(`Restoring detail on ${p.label} ${ev.value}/${ev.max}`, base + (0.4 + 0.5 * (ev.max ? ev.value / ev.max : 0)) / people.length); }, mask);
        const polished = await (await fetch(res.url)).blob();
        const [a, b] = await Promise.all([faceMatch(refs[p.id].blob, polished).catch(() => ({ sim: null })), faceMatch(refs[p.id].blob, swapped).catch(() => ({ sim: null }))]);
        if (a.sim != null && (b.sim == null || a.sim >= b.sim - 0.04)) best = polished;     // the detail pass must not drift the face
      } catch { /* keep the raw swap */ }
      blob = best;
    }
    return URL.createObjectURL(blob);
  };

  const facesOnResult = async () => {
    if (!showResult) return;
    setRun({ phase: 'run', progress: 0, status: 'Starting…', jobId: null, error: null, startedAt: Date.now() });
    try {
      const url = await applyFaces(showResult.url);
      const asset = await onResult?.(url, { prompt: fullPrompt, source: 'scene-composer-faces' });
      const entry = { url: asset?.url || url, asset };
      setResults((l) => [entry, ...l]); setShowResult(entry);
      setRun((r) => ({ ...r, phase: 'done', status: 'Done' }));
    } catch (e) { setRun((r) => ({ ...r, phase: 'error', error: e.message })); }
  };

  /** Re-detail people in the result: Flux 3 inpaints just their area (an automatic mask from the 3D layout), keeping everything else. */
  const refine = async (target) => {
    if (!showResult) return;
    const st = stage();
    const people = target === 'all' ? st.items.filter((i) => i.fig) : [st.items.find((i) => i.id === target)].filter(Boolean);
    if (!people.length) return;
    setRun({ phase: 'run', progress: 0, status: 'Preparing the mask…', jobId: null, error: null, startedAt: Date.now() });
    try {
      const blob = await (await fetch(showResult.url)).blob();
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(blob); });
      const W = img.naturalWidth, H = img.naturalHeight;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.fillStyle = '#fff';
      people.forEach((p) => { const b = st.screenBox(p, W, H); g.beginPath(); g.roundRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, 24); g.fill(); });
      const maskBlob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const withRef = people.filter((p) => refs[p.id]);
      const names = people.map((p) => `the ${p.label}${p.note ? ` (${p.note})` : ''}`).join(' and ');
      const prompt = `Make ${names} look like real, sharp, photorealistic ${people.length > 1 ? 'people' : 'person'}: a crisp detailed face with natural skin texture and clear eyes, correct anatomy, natural hands and detailed fabric. Keep the pose, expression, clothing, framing, lighting and everything outside the masked area exactly the same.`
        + withRef.map((p, n) => ` The face of ${p.label} must match image ${n + 2}.`).join('');
      const res = await generateFlux3({ prompt, steps: 8, cfg: 1, match_ref_size: true, mask_feather: 14 }, [blob, ...withRef.map((p) => refs[p.id].blob)], [], [],
        (ev) => {
          if (ev.type === 'submitted') setRun((r) => ({ ...r, jobId: ev.jobId }));
          else if (ev.type === 'progress') setRun((r) => ({ ...r, progress: ev.max ? ev.value / ev.max : 0, status: `Refining ${ev.value}/${ev.max}` }));
          else if (ev.type === 'status') setRun((r) => ({ ...r, status: ev.text }));
        }, maskBlob);
      const asset = await onResult?.(res.url, { prompt, source: 'scene-composer-refine' });
      const entry = { url: asset?.url || res.url, asset };
      setResults((l) => [entry, ...l]); setShowResult(entry);
      setRun((r) => ({ ...r, phase: 'done', status: 'Done' }));
    } catch (e) {
      setRun((r) => (e.message === 'Cancelled' ? { ...r, phase: 'idle' } : { ...r, phase: 'error', error: e.message }));
    }
  };

  const rescanResult = async () => {
    if (!showResult) return;
    const blob = await (await fetch(showResult.url)).blob();
    setShowResult(null);
    doScan(blob);
  };

  const busy = run.phase === 'run';
  const noModel = status && !status.can_generate;
  const canScan = status?.can_analyze;
  const sh = shot;

  return (
    <div className="scene-composer">
      <div className="sc-stage"
        onDragOver={(e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); setDropHot(true); } }}
        onDragLeave={() => setDropHot(false)}
        onDrop={(e) => { const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/')); setDropHot(false); if (f) { e.preventDefault(); importPose(f); } }}>
        {dropHot && <div className="sc-drop">📸 Drop a photo to copy its pose</div>}
        <div ref={mount} className="sc-canvas" />
        {overlay.url && view === 'shot' && rect && (
          <img className="sc-overlay" src={overlay.url} alt="" draggable={false}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, opacity: overlay.opacity }} />
        )}
        {view === 'shot' && rect && <div className="sc-frame" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />}

        <div className="sc-toolbar">
          <div className="sc-seg sc-viewtoggle" title="Switch between your 3D scene and the image it generated (Tab)">
            <button className={!showResult ? 'on' : ''} onClick={() => setShowResult(null)}>🧊 3D View</button>
            <button className={showResult ? 'on' : ''} disabled={!results.length} onClick={() => setShowResult(showResult || results[0])}
              title={results.length ? 'See the generated image' : 'Nothing generated yet: press Generate from this layout'}>🖼 Generated View{results.length > 1 ? ` (${results.length})` : ''}</button>
          </div>
          <div className="sc-seg">
            <button className={view === 'layout' ? 'on' : ''} onClick={() => setViewMode('layout')}>🧭 Layout</button>
            <button className={view === 'shot' ? 'on' : ''} onClick={() => setViewMode('shot')}>🎥 Camera view</button>
          </div>
          <div className="sc-seg">
            {[['translate', '✥ Move'], ['rotate', '⟳ Turn'], ['scale', '⤢ Size']].map(([m, l]) => (
              <button key={m} className={gizmo === m ? 'on' : ''} onClick={() => { setGizmo(m); stage().setGizmo(m); }}>{l}</button>
            ))}
          </div>
          <button className={sel === 'camera' ? 'on' : ''} onClick={() => { setViewMode('layout'); stage().select('camera'); }} title="Select the shot camera, then drag its arrows to move it or switch to Turn to aim it">🎥 Camera</button>
          <button onClick={() => stage()?.frameSelected()} title="Orbit around the selection">◎ Focus</button>
        </div>

        <div className="sc-hint">
          {view === 'layout' ? 'Drag to orbit · right-drag to pan · click a figure, prop or the camera to move it' : 'This is exactly what the model will see. Move figures to compose the frame.'}
        </div>

        {depthUrl && (
          <div className="sc-depth" onClick={() => { URL.revokeObjectURL(depthUrl); setDepthUrl(null); }} title="Click to close">
            <img src={depthUrl} alt="depth" /><span>Depth the model will follow</span>
          </div>
        )}
        {showResult && (
          <div className="sc-result">
            <img src={showResult.url} alt="result" />
            {results.length > 1 && (
              <div className="sc-result-pick">
                {results.slice(0, 8).map((r, i) => <img key={i} src={r.url} alt="" className={r === showResult ? 'on' : ''} onClick={() => setShowResult(r)} />)}
              </div>
            )}
            <div className="sc-result-bar">
              <a href={showResult.url} download="scene.png">⬇ Save</a>
              {refList.length > 0 && <button disabled={busy} onClick={facesOnResult} title="Put each attached character photo's real face on its person">🧬 Apply character faces</button>}
              {items.filter((i) => i.kind === 'person').map((i) => <button key={i.id} disabled={busy} onClick={() => refine(i.id)} title={`Re-detail just the ${i.label} (sharper face, hands, fabric)`}>✨ Refine {i.label}</button>)}
              {items.filter((i) => i.kind === 'person').length > 1 && <button disabled={busy} onClick={() => refine('all')}>✨ Refine everyone</button>}
              {canScan && <button onClick={rescanResult} title="Rebuild this image as a 3D layout so you can adjust it">🔁 Scan this into 3D</button>}
              <button onClick={() => setShowResult(null)}>✕</button>
            </div>
          </div>
        )}
        {results.length > 0 && !showResult && (
          <div className="sc-strip">
            {results.slice(0, 6).map((r, i) => <img key={i} src={r.url} alt="" onClick={() => setShowResult(r)} />)}
          </div>
        )}
      </div>

      <div className="sc-side es-side glass gj-panel">
        <h3>Scene Composer<small className="gj-count">{items.length} in scene</small></h3>
        <div className="es-body">
          <button className="sc-more" onClick={() => setSaves((x) => ({ ...x, open: !x.open }))}>{saves.open ? '▾' : '▸'} 💾 Scenes <small>(autosaved · {saves.list.length} saved)</small></button>
          {saves.open && (
            <div className="sc-saves">
              <div className="row">
                <input value={saves.name} onChange={(e) => setSaves((x) => ({ ...x, name: e.target.value }))} placeholder="Scene name" />
                <button disabled={saves.busy || !saves.name.trim()} onClick={doSave}>{saves.busy ? '⏳' : '💾 Save'}</button>
              </div>
              {saves.msg && <div className="hint">{saves.msg}</div>}
              {saves.list.length === 0 && <div className="hint">No saved scenes yet. Your work is also autosaved in this browser, so a refresh will not lose it.</div>}
              {saves.list.map((sc) => (
                <div key={sc.name} className="sc-save-row">
                  {sc.thumb ? <img src={sc.thumb} alt="" /> : <span className="ph" />}
                  <button className="name" onClick={() => doOpen(sc.name)} title="Open this scene">{sc.name}</button>
                  <button className="x" onClick={() => doDelete(sc.name)} title="Delete">✕</button>
                </div>
              ))}
            </div>
          )}

          <div className="sc-sec">✨ Stage directions</div>
          <textarea rows={3} value={dir.text} disabled={dir.busy || busy} placeholder={'Describe who is where and what they are doing, e.g. "A tall woman crouches behind a seated man, pointing at him while he stares into the camera."'}
            onChange={(e) => setDir({ ...dir, text: e.target.value })} />
          <div className="row">
            <button className="primary-ish" disabled={dir.busy || busy || !dir.text.trim()} onClick={doDirect}>{dir.busy ? '⏳ Directing…' : '🎬 Position the cast'}</button>
            <button disabled={busy} onClick={() => { autoFrame(stage()); setViewMode('shot'); }} title="Move the camera so everyone fits the frame">🎯 Auto-frame</button>
          </div>
          {dir.msg && <div className="hint">{dir.msg}</div>}

          <div className="sc-sec">🎬 Cinematic <small className="hint">{CINE.length} setups</small></div>
          <div className="hint">One click composes the camera, dresses the set and writes the lighting for your cast.</div>
          <div className="row">
            <button className="primary-ish" disabled={busy} onClick={runPreviewAll}>👁 Preview all {CINE.length}</button>
            {cineId && <button disabled={busy} onClick={clearCine}>✕ Clear</button>}
          </div>
          <select value={cineId} disabled={busy} onChange={(e) => { const p = CINE_BY_ID[e.target.value]; if (p) applyCine(p); else clearCine(); }}>
            <option value="">Choose a cinematic setup…</option>
            {CINE_GROUPS.map((g) => <optgroup key={g} label={g}>{CINE.filter((p) => p.group === g).map((p) => <option key={p.id} value={p.id}>{p.icon} {p.label}</option>)}</optgroup>)}
          </select>
          {cineId && CINE_BY_ID[cineId] && <div className="hint"><b>{CINE_BY_ID[cineId].label}</b>: {CINE_BY_ID[cineId].blurb}</div>}
          {cineMsg && <div className="hint">{cineMsg}</div>}

          <div className="sc-sec">📸 Pose from a photo</div>
          <div className="hint">Pick any photo of a person (or several) and the figures take their pose, with a preview before anything changes.</div>
          <button className="primary-ish" disabled={busy} onClick={() => poseFile.current?.click()}>📸 Import pose from photo…</button>
          <input ref={poseFile} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; importPose(f); }} />
          <div className="hint">You can also drag a photo onto the 3D view, or press Ctrl+V with an image copied.</div>
          {poseLib.length > 0 && (
            <>
              <div className="sc-sec">My poses <small className="hint">click a person, then a pose</small></div>
              <div className="sc-poselib">
                {poseLib.map((e) => (
                  <div key={e.id} className="sc-poseitem" title="Give this pose to the selected person">
                    <button onClick={() => usePose(e)}><img src={e.thumb} alt="" /></button>
                    <i onClick={() => savePoseLib(poseLib.filter((x) => x.id !== e.id))} title="Remove from My poses">✕</i>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="sc-sec">Look &amp; setting</div>
          <select value={look} disabled={busy} onChange={(e) => setLook(e.target.value)} title="Tells the model this is a real photo, not a render">
            {Object.entries(LOOKS).map(([k, [name]]) => <option key={k} value={k}>{name}</option>)}
          </select>
          <textarea rows={2} value={setting} disabled={busy} placeholder="Where is this? e.g. a lived-in bedroom at night, a lamp on the nightstand, rain on the window"
            onChange={(e) => setSetting(e.target.value)} />
          <div className="sc-chips">
            {Object.entries(SETTINGS).map(([k, v]) => <button key={k} className={setting === v ? 'on' : ''} onClick={() => setSetting(v)}>{k}</button>)}
          </div>

          <label>Extra details</label>
          <textarea rows={3} value={prompt} disabled={busy} placeholder="What is this shot? e.g. a tense standoff in a rain-soaked alley, neon signs, cinematic"
            onChange={(e) => setPrompt(e.target.value)} />
          <label className="checkbox-label" title="Adds the camera and who-stands-where to the prompt so the model matches your blocking">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Describe my layout to the model
          </label>
          {auto && layout && (
            <details className="sc-read">
              <summary>What the model reads</summary>
              <p>{fullPrompt}</p>
            </details>
          )}

          <div className="sc-sec">Add to the scene</div>
          <div className="sc-add">
            <button onClick={() => addPerson('male')}>🧍 Man</button>
            <button onClick={() => addPerson('female')}>🧍 Woman</button>
            <button onClick={() => addProp('couch')}>🛋 Couch</button>
            <button onClick={() => addProp('sectional')}>⌐ L-couch</button>
            <button onClick={() => addProp('armchair')}>💺 Armchair</button>
            <button onClick={() => addProp('chair')}>🪑 Chair</button>
            <button onClick={() => addProp('bed')}>🛏 Bed</button>
            <button onClick={() => addProp('table')}>▭ Table</button>
            <button onClick={() => addProp('bench')}>▬ Bench</button>
            <button onClick={() => addProp('box')}>▫ Box</button>
            <button onClick={() => addProp('cylinder')}>⬭ Cylinder</button>
            <button onClick={() => addProp('sphere')}>● Sphere</button>
          </div>
          <details className="sc-props">
            <summary>＋ More objects ({PROP_TYPES.length}): doors, windows, desks, trees, a car…</summary>
            {PROP_CATS.map((cat) => (
              <div key={cat}>
                <div className="hint">{cat}</div>
                <div className="sc-add">
                  {PROP_TYPES.filter((k) => PROPS[k].cat === cat).map((k) => <button key={k} onClick={() => addProp(k)}>{PROPS[k].icon} {PROPS[k].label}</button>)}
                </div>
              </div>
            ))}
          </details>

          {items.some((i) => i.kind === 'person') && (
            <div className="sc-cast">
              {items.filter((i) => i.kind === 'person').map((i) => (
                <button key={i.id} className={selItem?.id === i.id ? 'on' : ''} onClick={() => stage().select(stage().items.find((x) => x.id === i.id))} title={refs[i.id] ? `${i.label} has a character photo` : `${i.label}: click to select, then attach a character photo`}>
                  {refs[i.id] ? <img src={refs[i.id].url} alt="" /> : <span className="ph" style={{ background: hex(i.color) }}>{i.gender === 'female' ? '♀' : '♂'}</span>}
                  <span>{i.label}</span>
                </button>
              ))}
            </div>
          )}
          {selItem && (
            <div className="sc-inspector">
              <div className="sc-sec" style={{ color: hex(selItem.color) }}>Selected · {selItem.kind}</div>
              <input value={sel.label} onChange={(e) => { setSel({ ...sel, label: e.target.value }); stage().setLabel(selItem.id, e.target.value); }}
                placeholder="Name it (the model sees this): e.g. the detective" />
              {selItem.kind === 'person' && (
                <>
                  <label className="checkbox-label" title="Off = the editable mannequin with shape sliders (shoulders, waist, bust...)">
                    <input type="checkbox" checked={realistic} onChange={(e) => { setRealistic(e.target.checked); poseOp((st) => st.setRealistic(e.target.checked)); }} /> Realistic body
                  </label>
                  <div className="sc-sub">Outfit</div>
                  <select value={sel.build?.outfit || 'casual'} onChange={(e) => poseOp((st) => st.setBuild(selItem.id, { outfit: e.target.value }))} title="What this person wears. The image model sees the clothes' shape in the depth map and is told what they are.">
                    {(OUTFITS[sel.build?.gender] || OUTFITS.male).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                  </select>
                  <div className="sc-sub">Pose</div>
                  <div className="sc-poses">
                    {Object.entries(POSES).map(([k, v]) => (
                      <button key={k} className={sel.pose === k ? 'on' : ''} onClick={() => poseOp((st) => st.setPreset(selItem.id, k))}>{v.label}</button>
                    ))}
                  </div>
                  <div className="row">
                    <button onClick={() => poseOp((st) => st.mirrorPose(selItem.id))} title="Flip left and right">⇋ Mirror</button>
                    <button onClick={() => poseOp((st) => st.faceCamera(selItem.id))} title="Turn the whole body toward the shot camera">🧍 Face camera</button>
                    <button onClick={() => poseOp((st) => st.lookAtCamera(selItem.id))} title="Turn the head toward the lens">👁 Look at lens</button>
                  </div>
                  <div className="row">
                    <button onClick={() => poseOp((st) => { if (!st.sitOnNearest(selItem.id)) setDir((d) => ({ ...d, msg: 'Add a couch, chair, bed or bench near them first.' })); })}
                      title="Sit this person on the nearest seat">🛋 Sit on nearest seat</button>
                  </div>
                  <div className="sc-sub">Arms &amp; legs</div>
                  <div className="sc-limbs">
                    {[['armL', 'Left arm', ARM_ACTIONS], ['armR', 'Right arm', ARM_ACTIONS], ['legL', 'Left leg', LEG_ACTIONS], ['legR', 'Right leg', LEG_ACTIONS]].map(([limb, name, acts]) => (
                      <select key={limb} value="" title={`${name}: pick an action (uses the seat they are on)`}
                        onChange={(e) => { if (e.target.value) poseOp((st) => st.setLimb(selItem.id, limb, e.target.value)); }}>
                        <option value="">{name}…</option>
                        {Object.entries(acts).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    ))}
                  </div>
                  <div className="sc-joint">
                    {joint
                      ? <>
                        <b>{joint.label}</b> — {jointHint(joint)}{atLimit && <em className="sc-limit"> · at its limit</em>}
                        {joint.canMove && (
                          <span className="sc-jmode">
                            <button className={joint.mode === 'translate' ? 'on' : ''} onClick={() => stage().setJointMode('translate')}>✥ Move</button>
                            <button className={joint.mode === 'rotate' ? 'on' : ''} onClick={() => stage().setJointMode('rotate')}>⟳ Rotate</button>
                          </span>
                        )}
                      </>
                      : <>Click a dot on the figure: <span className="dot c">cyan</span> bends a joint, <span className="dot o">orange</span> drags a hand or foot. The white arrow on the floor is where they face.</>}
                  </div>
                  <label className="checkbox-label" title="Stops joints bending past what a body can do. Turn off for stylised or cartoon poses.">
                    <input type="checkbox" checked={limits} onChange={(e) => { setLimits(e.target.checked); stage().setLimits(e.target.checked); }} /> Realistic joint limits
                  </label>
                  <div className="sc-sub">Hands</div>
                  <div className="row">
                    {[0, 1].map((side) => (
                      <select key={side} value={Array.isArray(sel.hands?.[side]) ? 'relaxed' : sel.hands?.[side] || 'relaxed'}
                        title={side === 0 ? 'Left hand (screen right when facing you)' : 'Right hand'}
                        onChange={(e) => poseOp((st) => st.setHands(selItem.id, side, e.target.value))}>
                        {HAND_POSES.map((h) => <option key={h} value={h}>{side === 0 ? 'L' : 'R'} · {h}</option>)}
                      </select>
                    ))}
                  </div>
                  <div className="sc-sub">Body</div>
                  <div className="row">
                    <button className={sel.build?.gender === 'male' ? 'on' : ''} onClick={() => poseOp((st) => st.setGender(selItem.id, 'male'))}>♂ Male</button>
                    <button className={sel.build?.gender === 'female' ? 'on' : ''} onClick={() => poseOp((st) => st.setGender(selItem.id, 'female'))}>♀ Female</button>
                    <select value={sel.build?.hair || 'short'} onChange={(e) => poseOp((st) => st.setBuild(selItem.id, { hair: e.target.value }))} title="Hair style">
                      {HAIR_STYLES.map((h) => <option key={h} value={h}>{h === 'none' ? 'bald' : `${h} hair`}</option>)}
                    </select>
                  </div>
                  <label>Height {Number(sel.height || 1.75).toFixed(2)} m
                    <input type="range" min={1.0} max={2.2} step={0.01} value={sel.height || 1.75}
                      onChange={(e) => poseOp((st) => st.setHeight(selItem.id, +e.target.value))} />
                  </label>
                  {realistic && <div className="hint">Realistic bodies keep one build: change Height, Outfit and Pose. Untick "Realistic body" for the shape sliders.</div>}
                  {!realistic && <button className="sc-more" onClick={() => setAnat(!anat)}>{anat ? '▾' : '▸'} Anatomy &amp; proportions</button>}
                  {anat && sel.build && (
                    <div className="sc-anat">
                      {BODY_SLIDERS.filter(([k]) => k !== 'bust' || sel.build.gender === 'female' || sel.build.bust > 0).map(([k, label, mn, mx, st]) => (
                        <label key={k}>{label} <span>{Math.round(sel.build[k] * 100)}%</span>
                          <input type="range" min={mn} max={mx} step={st} value={sel.build[k]}
                            onChange={(e) => poseOp((stg) => stg.setBuild(selItem.id, { [k]: +e.target.value }))} />
                        </label>
                      ))}
                      <label className="checkbox-label" title="Adds words like 'narrow waist, wide hips, muscular' to the prompt. The depth map already carries the exact shape.">
                        <input type="checkbox" checked={bodyText} onChange={(e) => setBodyText(e.target.checked)} /> Describe proportions to the model
                      </label>
                    </div>
                  )}
                  <div className="sc-ref">
                    {refs[selItem.id] ? (
                      <>
                        <img src={refs[selItem.id].url} alt="" />
                        <span>This is who they are</span>
                        <button onClick={clearRef}>×</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => refFileRef.current?.click()}>🧬 Upload a character photo</button>
                        <button onClick={() => setPicker(!picker)}>🖼 Pick from library</button>
                      </>
                    )}
                    <input ref={refFileRef} type="file" accept="image/*" hidden onChange={(e) => { pickRef(e.target.files?.[0]); e.target.value = ''; }} />
                  </div>
                  {picker && !refs[selItem.id] && (
                    <div className="sc-picker">
                      {assets.filter((a) => ['character', 'image'].includes(a.kind) && a.blob).slice(-30).reverse().map((a) => (
                        <img key={a.id} src={a.url} alt={a.name} title={a.name} onClick={() => { pickRef(a.blob); setPicker(false); }} />
                      ))}
                      {!assets.some((a) => ['character', 'image'].includes(a.kind) && a.blob) && <div className="hint">Your Gallery and Character Studio characters appear here once you have some.</div>}
                    </div>
                  )}
                </>
              )}
              <input value={sel.note || ''} placeholder="Extra detail: e.g. holding a lantern, wearing a trench coat"
                onChange={(e) => { setSel({ ...sel, note: e.target.value }); const it = stage().items.find((i) => i.id === selItem.id); if (it) it.note = e.target.value; setTick((t) => t + 1); }} />
              <button className="danger" onClick={() => stage().remove(selItem.id)}>🗑 Remove</button>
            </div>
          )}
          {sel === 'camera' && <div className="hint">Camera selected: drag the arrows to move it; choose ⟳ Turn in the toolbar, then drag the rings to aim it. Or use the sliders below.</div>}

          <div className="sc-sec">Camera <button className="sc-link" onClick={camSel}>select in 3D</button></div>
          <label>Lens {sh.lens} mm <small>({sh.fov}° vertical)</small>
            <input type="range" min={14} max={135} step={1} value={sh.lens} onChange={(e) => setLens(+e.target.value)} />
          </label>
          <label>Height {sh.height} m
            <input type="range" min={0.2} max={6} step={0.05} value={sh.height} onChange={(e) => stage().setShot({ height: +e.target.value })} />
          </label>
          <label>Tilt {sh.pitch}° <small>{sh.pitch > 8 ? 'looking up' : sh.pitch < -8 ? 'looking down' : 'level'}</small>
            <input type="range" min={-60} max={60} step={1} value={sh.pitch} onChange={(e) => stage().setShot({ pitch: +e.target.value })} />
          </label>
          <label>Pan {sh.yaw}°
            <input type="range" min={-180} max={180} step={1} value={sh.yaw} onChange={(e) => stage().setShot({ yaw: +e.target.value })} />
          </label>
          <div className="row">
            <select value={aspectKey} onChange={(e) => setAspectKey(e.target.value)} title="Output shape">
              {Object.keys(SIZES).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <label className="checkbox-label"><input type="checkbox" checked={floor} onChange={(e) => setFloor(e.target.checked)} /> floor</label>
            <label className="checkbox-label"><input type="checkbox" checked={wall} onChange={(e) => setWall(e.target.checked)} title="Adds walls and a ceiling to the depth map so the image has a real room. Turn off for outdoor scenes." /> room walls</label>
          </div>

          <div className="sc-sec">Start from a photo</div>
          <button disabled={scan.busy || !canScan} onClick={() => fileRef.current?.click()}
            title={canScan ? 'Detects the people, objects, camera lens and depth, then rebuilds them in 3D' : 'Depth Anything 3 is not installed yet'}>
            {scan.busy ? '⏳ Scanning…' : '📷 Scan a photo into 3D'}
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) doScan(f); e.target.value = ''; }} />
          {scan.msg && <div className="hint">{scan.msg}</div>}
          {scan.error && <div className="error">{scan.error}</div>}
          {overlay.url && (
            <label>Photo overlay {Math.round(overlay.opacity * 100)}%
              <input type="range" min={0} max={1} step={0.05} value={overlay.opacity} onChange={(e) => setOverlay({ ...overlay, opacity: +e.target.value })} />
            </label>
          )}
          {!status && <div className="hint">Checking models…</div>}
          {noModel && <div className="error">The Qwen 2.1 Fun-Controlnet model is not installed yet, so Generate is unavailable.</div>}
        </div>

        <div className="es-foot">
          {refList.length > 0 && (
            <label className="checkbox-label" title="After generating, swaps each attached character photo's real face onto its person (image-edit models only blend likeness)">
              <input type="checkbox" checked={lockFaces} disabled={busy} onChange={(e) => setLockFaces(e.target.checked)} /> Lock faces to my character photos
            </label>
          )}
          <label title="After this point the layout is released so the model can add real skin, fabric and background detail">Follow the layout for the first {Math.round(lockEnd * 100)}% of the render
            <input type="range" min={0.3} max={1} step={0.05} value={lockEnd} disabled={busy} onChange={(e) => setLockEnd(+e.target.value)} />
          </label>
          <label>Layout lock {Math.round(strength * 100)}%
            <input type="range" min={0.3} max={1.2} step={0.05} value={strength} disabled={busy} onChange={(e) => setStrength(+e.target.value)} />
          </label>
          <div className="row">
            <button onClick={previewDepth} disabled={busy}>👁 Depth</button>
            <label className="steps">steps <input type="number" min={10} max={40} value={steps} disabled={busy} onChange={(e) => setSteps(+e.target.value)} /></label>
          </div>
          {busy ? (
            <GenProgress progress={run.progress} status={run.status} startedAt={run.startedAt} onCancel={() => cancelJob(run.jobId)} cancelDisabled={!run.jobId} />
          ) : (
            <button className="primary" disabled={noModel || items.length === 0} onClick={generate}>🎬 Generate from this layout</button>
          )}
          {run.error && <div className="error">{run.error}</div>}
        </div>
      </div>
      {poseImp && (
        <div className="sc-cine-overlay" onClick={() => !poseImp.busy && setPoseImp(null)}>
          <div className="sc-cine-box sc-pose-box" onClick={(e) => e.stopPropagation()}>
            <div className="sc-cine-head">
              <b>📸 Pose from a photo</b>
              <span className="hint">{poseImp.busy ? 'Reading the pose…' : poseImp.error ? '' : `${poseImp.poses.length} ${poseImp.poses.length === 1 ? 'person' : 'people'} found, left to right`}</span>
              <button disabled={poseImp.busy} onClick={() => setPoseImp(null)}>✕</button>
            </div>
            <div className="sc-pose-body">
              <div className="sc-pose-photo">
                {poseImp.poses.length ? <canvas ref={poseCanvas} /> : <img src={poseImp.url} alt="photo" />}
              </div>
              <div className="sc-pose-side">
                {poseImp.busy && <div className="hint">Finding people and their joints…</div>}
                {poseImp.error && <div className="error">{poseImp.error}</div>}
                {poseImp.poses.map((p, i) => {
                  const conf = Math.round(100 * (p.world[11][3] + p.world[12][3] + p.world[23][3] + p.world[24][3]) / 4);
                  return (
                    <label key={i} className="sc-pose-row">
                      <span>Person {i + 1} <small>{conf}% sure</small></span>
                      <select value={poseImp.targets[i]} onChange={(e) => setPoseImp((s) => ({ ...s, targets: s.targets.map((t, k) => (k === i ? e.target.value : t)) }))}>
                        {items.filter((x) => x.kind === 'person').map((x) => <option key={x.id} value={String(x.id)}>Give it to {x.label}</option>)}
                        <option value="new-male">Add a new man</option>
                        <option value="new-female">Add a new woman</option>
                        <option value="skip">Skip this person</option>
                      </select>
                    </label>
                  );
                })}
                {poseImp.poses.length > 0 && (
                  <>
                    <label className="checkbox-label"><input type="checkbox" checked={poseImp.faceCam} onChange={(e) => setPoseImp((s) => ({ ...s, faceCam: e.target.checked }))} /> Turn each person the way they face the camera in the photo</label>
                    <label className="checkbox-label"><input type="checkbox" checked={poseImp.mirror} onChange={(e) => setPoseImp((s) => ({ ...s, mirror: e.target.checked }))} /> Mirror the pose (left becomes right)</label>
                    <button className="primary" onClick={applyPoses} disabled={poseImp.targets.every((t) => t === 'skip')}>Apply pose{poseImp.targets.filter((t) => t !== 'skip').length > 1 ? 's' : ''}</button>
                    <div className="hint">New people are placed where they stood in the photo, using your current camera. Twisting of a forearm cannot be seen in one photo, so fine-tune hands by dragging.</div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {cineGrid && (
        <div className="sc-cine-overlay" onClick={() => !cineGrid.busy && setCineGrid(null)}>
          <div className="sc-cine-box" onClick={(e) => e.stopPropagation()}>
            <div className="sc-cine-head">
              <b>🎬 {CINE.length} cinematic setups for your cast</b>
              <span className="hint">{cineGrid.busy ? `Rendering previews… ${cineGrid.done}/${cineGrid.total}` : 'Click one to use it. Same people, different camera, set and light.'}</span>
              <button disabled={cineGrid.busy} onClick={() => setCineGrid(null)}>✕</button>
            </div>
            <div className="sc-cine-scroll">
              {CINE_GROUPS.map((g) => {
                const rows = cineGrid.items.filter((x) => x.preset.group === g);
                if (!rows.length) return null;
                return (
                  <div key={g}>
                    <div className="sc-cine-grp">{g}</div>
                    <div className="sc-cine-grid">
                      {rows.map(({ preset, url }) => (
                        <button key={preset.id} className="sc-cine-card" onClick={() => applyCine(preset)} title={preset.blurb}>
                          <img src={url} alt={preset.label} />
                          <span><b>{preset.icon} {preset.label}</b><small>{preset.cam.lens} mm · {preset.blurb}</small></span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
