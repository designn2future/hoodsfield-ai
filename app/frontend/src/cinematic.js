import * as THREE from 'three';

/**
 * Cinematic presets for the 3D Shot view. A preset does three things around whoever is on stage:
 *   1. composes the camera (lens, height, angle, framing, rule-of-thirds offset, Dutch roll),
 *   2. dresses the set with a few props (foreground / midground / background layers),
 *   3. adds a lighting + colour recipe to the prompt, because the depth map carries no light at all.
 *
 * cam:  size  wide | full | cowboy | medium | mcu | cu | ecu      (how much of the subject fills the frame)
 *       lens mm, h camera height (m), az degrees around the subject (0 = in front of them, 90 = their left side),
 *       off  where the subject sits across the frame (-1..1 NDC; 0.33 = a third in from the right), aim 0..1 of the subject's height,
 *       roll degrees (Dutch angle), ots: true = over the first person's shoulder at the second
 * set:  props to add. t = prop/furniture type, r = metres to the camera's right of the subject, d = metres BEHIND the subject
 *       (negative = in front of them, between camera and subject: a foreground layer), ry = extra turn in degrees
 * wall: closed room (walls + ceiling) or open outdoors.
 */
export const CINE_GROUPS = ['Drama', 'Horror & thriller', 'Stylised', 'Everyday', 'Epic & wide'];

const FILM = 'Cinematic film still, shot on an anamorphic cinema lens, professional cinematography, shallow depth of field, natural film grain, rich tonal range, no text.';

export const CINE = [
  // ---------------------------------------------------------------- Drama
  { id: 'classic_medium', group: 'Drama', label: 'Classic Medium', icon: '🎬', blurb: 'Eye-level medium shot, subject on a third, warm key and cool fill.',
    cam: { size: 'medium', lens: 50, h: 1.55, az: 14, off: 0.3, aim: 0.74 }, wall: true,
    set: [{ t: 'lamp', r: -2.6, d: 2.2 }, { t: 'bookshelf', r: 2.4, d: 3.4 }, { t: 'window', r: -1.0, d: 3.8 }],
    light: 'Soft warm key light from the side with a gentle cool fill, light falloff into the background, practical lamp glow, subtle haze.', look: 'Natural skin tones, muted teal and amber palette, soft contrast.' },
  { id: 'ots', group: 'Drama', label: 'Over the Shoulder', icon: '🫂', blurb: 'Camera behind one person, looking at the other (needs two people).',
    cam: { size: 'mcu', lens: 65, h: 1.55, ots: true, off: -0.28, aim: 0.88 }, wall: true,
    set: [{ t: 'window', r: 1.6, d: 3.2 }, { t: 'lamp', r: -1.8, d: 2.4 }],
    light: 'Window light wrapping the faces, a soft rim on the shoulder in the foreground, the foreground shoulder dark and out of focus, shallow depth of field.', look: 'Intimate, desaturated warm palette.' },
  { id: 'profile_two', group: 'Drama', label: 'Profile Two-Shot', icon: '↔️', blurb: 'Camera at 90° so two people face each other in profile.',
    cam: { size: 'cowboy', lens: 40, h: 1.45, az: 0, axis: 'between', off: 0, aim: 0.66, fit: true }, wall: true,
    set: [{ t: 'window', r: 0, d: 3.4 }, { t: 'lamp', r: 2.2, d: 2.6 }],
    light: 'Even, soft side light, both faces in clean profile against a softly lit background.', look: 'Calm, balanced neutral palette.' },
  { id: 'intimate_cu', group: 'Drama', label: 'Intimate Close-up', icon: '🙂', blurb: '85 mm close-up, eyes on a third, creamy background.',
    cam: { size: 'cu', lens: 85, h: 1.6, az: 8, off: 0.26, aim: 0.93 }, wall: true,
    set: [{ t: 'lamp', r: -1.6, d: 2.6 }, { t: 'bookshelf', r: 1.8, d: 3 }],
    light: 'Soft key from camera-left, a bright catch-light in the eyes, background blown out into warm bokeh balls, skin detail visible.', look: 'Warm, flattering, gentle contrast.' },
  { id: 'ecu', group: 'Drama', label: 'Extreme Close-up', icon: '👁️', blurb: '135 mm on the face. Maximum tension, almost no background.',
    cam: { size: 'ecu', lens: 135, h: 1.62, az: 4, off: 0.1, aim: 0.95 }, wall: true,
    set: [{ t: 'lamp', r: -2, d: 3 }],
    light: 'A single hard key from one side, deep shadow on the other half of the face, fine skin pores and eyelashes in focus, black falloff behind.', look: 'High contrast, desaturated.' },
  { id: 'wide_est', group: 'Drama', label: 'Establishing Wide', icon: '🏙️', blurb: 'High wide shot: the people small inside a big space.',
    cam: { size: 'wide', lens: 24, h: 3.1, az: 20, off: 0, aim: 0.5, fit: true }, wall: true,
    set: [{ t: 'column', r: -4, d: 2 }, { t: 'column', r: 4, d: 2 }, { t: 'window', r: -2, d: 6 }, { t: 'window', r: 2, d: 6 }, { t: 'stairs', r: 5, d: 4, ry: 90 }],
    light: 'Large soft window light raking across the floor, long shadows, depth haze, the people small in a large architectural space.', look: 'Cool, spacious, restrained palette.' },
  { id: 'low_hero', group: 'Drama', label: 'Low-Angle Hero', icon: '🦸', blurb: 'Camera on the floor looking up: power and scale.',
    cam: { size: 'full', lens: 24, h: 0.3, az: 6, off: 0, aim: 0.7 }, wall: false,
    set: [{ t: 'column', r: -3.2, d: 3 }, { t: 'column', r: 3.2, d: 3 }],
    light: 'Strong backlight with a bright rim around the body, dramatic sky behind, lens flare, the figure towering over the camera.', look: 'Epic, saturated warm-cool contrast.' },
  { id: 'high_vuln', group: 'Drama', label: 'High-Angle Vulnerable', icon: '⬇️', blurb: 'Looking down from above: small, trapped, exposed.',
    cam: { size: 'medium', lens: 35, h: 3.2, az: 10, off: 0, aim: 0.55 }, wall: true,
    set: [{ t: 'wall', r: -2.4, d: 1.4, ry: 90 }, { t: 'crate', r: 1.6, d: 1.6 }],
    light: 'Overhead top light creating a pool of light around the person, dark surroundings, long shadows pointing away.', look: 'Cold and desaturated.' },
  { id: 'dutch', group: 'Drama', label: 'Dutch Tension', icon: '📐', blurb: 'Tilted horizon: unease, something is wrong.',
    cam: { size: 'medium', lens: 35, h: 1.5, az: 22, off: 0.2, aim: 0.7, roll: 13 }, wall: true,
    set: [{ t: 'door', r: -2, d: 3.4 }, { t: 'lamp', r: 2.2, d: 2.4 }],
    light: 'Hard side light, strong contrast, deep shadows, a single practical light in the frame.', look: 'Teal shadows with warm highlights.' },
  { id: 'silhouette', group: 'Drama', label: 'Silhouette', icon: '🌅', blurb: 'Big bright window behind: the person as a dark shape.',
    cam: { size: 'full', lens: 35, h: 1.3, az: 0, off: 0, aim: 0.56 }, wall: true,
    set: [{ t: 'window', r: -0.9, d: 3 }, { t: 'window', r: 0.9, d: 3 }],
    light: 'Strong backlight pouring through large windows behind the person, who is a near-silhouette with a glowing edge, volumetric light beams through haze.', look: 'High contrast, golden-white highlights.' },

  // ---------------------------------------------------------------- Horror & thriller
  { id: 'doorway', group: 'Horror & thriller', label: 'Doorway Dread', icon: '🚪', blurb: 'The person framed small inside a dark doorway, deep in the frame.',
    cam: { size: 'full', lens: 28, h: 1.2, az: 0, off: 0, aim: 0.6 }, wall: true,
    set: [{ t: 'wall', r: -2.1, d: 0.1 }, { t: 'wall', r: 2.1, d: 0.1 }, { t: 'door', r: 0, d: 0.15 }, { t: 'wall', r: -3.4, d: -3, ry: 90 }, { t: 'wall', r: 3.4, d: -3, ry: 90 }],
    light: 'Almost no light, a thin cold glow from behind the door edge, deep black shadows, the room barely visible, held-breath silence.', look: 'Cold green-blue, crushed blacks.' },
  { id: 'hallway', group: 'Horror & thriller', label: 'Hallway Vanishing Point', icon: '🕳️', blurb: 'One-point perspective down a long corridor.',
    cam: { size: 'full', lens: 24, h: 1.5, az: 0, off: 0, aim: 0.55 }, wall: true,
    set: [{ t: 'wall', r: -1.9, d: -2, ry: 90 }, { t: 'wall', r: 1.9, d: -2, ry: -90 }, { t: 'wall', r: -1.9, d: 1.2, ry: 90 }, { t: 'wall', r: 1.9, d: 1.2, ry: -90 }, { t: 'door', r: 0, d: 6 }],
    light: 'A flickering overhead light far down the hall, sickly fluorescent green cast, pools of darkness between lights, long shadows, damp haze.', look: 'Sickly green and yellow, low saturation.' },
  { id: 'peek', group: 'Horror & thriller', label: 'Peeking From the Dark', icon: '🫣', blurb: 'A wall edge cuts the foreground: we are watching from hiding.',
    cam: { size: 'cowboy', lens: 50, h: 1.5, az: 20, off: 0.3, aim: 0.7 }, wall: true,
    set: [{ t: 'wall', r: -2.5, d: -1.6, ry: 0 }, { t: 'door', r: 2.1, d: 3.2 }, { t: 'lamp', r: -2.2, d: 3.6 }],
    light: 'We look from a dark space past a wall edge, the foreground wall blurry and nearly black, the subject lit by a weak practical lamp, voyeuristic mood.', look: 'Desaturated, heavy shadows, a subtle green tint.' },
  { id: 'stalk', group: 'Horror & thriller', label: 'Behind You', icon: '🏃', blurb: 'Following from behind: the back of a head, danger ahead.',
    cam: { size: 'medium', lens: 35, h: 1.55, az: 180, off: -0.3, aim: 0.72 }, wall: true,
    set: [{ t: 'door', r: 0, d: -4.2 }, { t: 'wall', r: -2.2, d: -3.2, ry: 90 }, { t: 'wall', r: 2.2, d: -3.2, ry: -90 }],
    light: 'Dim light ahead in the distance, the subject seen from behind and rim-lit, dark walls pressing in, depth haze.', look: 'Cold and dark, a single warm spot far ahead.' },
  { id: 'security', group: 'Horror & thriller', label: 'Security Camera', icon: '📹', blurb: 'High corner angle, wide and flat, like CCTV.',
    cam: { size: 'wide', lens: 20, h: 2.8, az: 38, off: 0, aim: 0.5, fit: true }, wall: true,
    set: [{ t: 'counter', r: -2.6, d: 2.2 }, { t: 'fridge', r: 2.8, d: 3.2 }],
    light: 'Flat overhead fluorescent light, grainy low-resolution surveillance footage, slight fisheye distortion, washed-out colours, timestamp-free.', look: 'Desaturated green-grey, noisy, compressed.' },
  { id: 'found', group: 'Horror & thriller', label: 'Found Footage', icon: '📼', blurb: 'Handheld, off-centre, lit by a harsh on-camera light.',
    cam: { size: 'cowboy', lens: 28, h: 1.35, az: 12, off: 0.36, aim: 0.66, roll: 3 }, wall: true,
    set: [{ t: 'door', r: -2, d: 3 }, { t: 'crate', r: 1.5, d: 1.2 }],
    light: 'Harsh direct on-camera flash light blowing out the foreground, the background falling to black, red-eye-free, amateur camcorder look, motion blur.', look: 'Washed colours, crushed blacks, noise.' },
  { id: 'moonlit', group: 'Horror & thriller', label: 'Moonlit Exterior', icon: '🌙', blurb: 'Cold moonlight, long shadows, a tree silhouette.',
    cam: { size: 'full', lens: 35, h: 1.1, az: 18, off: 0.22, aim: 0.58 }, wall: false,
    set: [{ t: 'tree', r: -3.6, d: 3.6 }, { t: 'tree', r: 4.4, d: 6 }, { t: 'rock', r: 1.9, d: -1.2 }, { t: 'fence', r: 0, d: 5 }],
    light: 'Cold blue moonlight from behind and above, long soft shadows, a faint mist over the ground, black sky with a few stars.', look: 'Deep blue palette with a tiny warm accent.' },

  // ---------------------------------------------------------------- Stylised
  { id: 'noir', group: 'Stylised', label: 'Film Noir', icon: '🕴️', blurb: 'Hard key, venetian-blind shadows, smoke.',
    cam: { size: 'medium', lens: 40, h: 1.2, az: 16, off: 0.28, aim: 0.72, roll: 4 }, wall: true,
    set: [{ t: 'window', r: -1.9, d: 2.4, ry: 40 }, { t: 'desk', r: 1.9, d: 1.6 }, { t: 'lamp', r: 2.7, d: 2.4 }],
    light: 'Hard single key light cutting through window blinds, stripes of light and shadow across the face and wall, drifting cigarette smoke, deep black shadows.', look: 'Black and white, high contrast, silver highlights.' },
  { id: 'neon', group: 'Stylised', label: 'Neon Rain Street', icon: '🌃', blurb: 'Wet street at night, neon colours bouncing off everything.',
    cam: { size: 'full', lens: 35, h: 1.3, az: 22, off: 0.2, aim: 0.58 }, wall: false,
    set: [{ t: 'streetlamp', r: -3.4, d: 4 }, { t: 'car', r: 3.8, d: 5, ry: 70 }, { t: 'dumpster', r: -4.2, d: 7 }],
    light: 'Magenta and cyan neon signs glowing from both sides, wet asphalt reflecting the lights, fine rain falling and backlit, steam rising.', look: 'Saturated magenta, cyan and amber on deep black.' },
  { id: 'golden', group: 'Stylised', label: 'Golden Hour', icon: '🌇', blurb: 'Low sun behind the subject, glowing rim light.',
    cam: { size: 'cowboy', lens: 70, h: 1.4, az: 14, off: 0.3, aim: 0.7 }, wall: false,
    set: [{ t: 'tree', r: -3, d: 5.5 }, { t: 'tree', r: 3.6, d: 8 }, { t: 'bush', r: 1.6, d: -1.1 }, { t: 'fence', r: 0, d: 4.5 }],
    light: 'Low golden sun directly behind the subject creating a glowing hair rim, warm lens flare, long soft shadows, hazy golden background bokeh.', look: 'Warm gold and amber, gentle contrast.' },
  { id: 'scifi', group: 'Stylised', label: 'Sci-fi Corridor', icon: '🛸', blurb: 'Cold, symmetrical corridor with glowing strips.',
    cam: { size: 'full', lens: 24, h: 1.4, az: 0, off: 0, aim: 0.55 }, wall: true,
    set: [{ t: 'column', r: -2, d: -1.5 }, { t: 'column', r: 2, d: -1.5 }, { t: 'column', r: -2, d: 2 }, { t: 'column', r: 2, d: 2 }, { t: 'column', r: -2, d: 5.5 }, { t: 'column', r: 2, d: 5.5 }, { t: 'archway', r: 0, d: 8 }],
    light: 'Cold cyan light strips running along the walls and ceiling, a hot orange glow at the far end, light haze, polished reflective floor.', look: 'Teal and orange, clean and cold.' },
  { id: 'symmetry', group: 'Stylised', label: 'Symmetrical Tableau', icon: '🎨', blurb: 'Perfectly centred, flat and pastel: storybook framing.',
    cam: { size: 'full', lens: 35, h: 1.3, az: 0, off: 0, aim: 0.55 }, wall: true,
    set: [{ t: 'window', r: -2.2, d: 3.2 }, { t: 'window', r: 2.2, d: 3.2 }, { t: 'dresser', r: -1.2, d: 3 }, { t: 'dresser', r: 1.2, d: 3 }, { t: 'lamp', r: -3, d: 2.4 }, { t: 'lamp', r: 3, d: 2.4 }],
    light: 'Flat, even frontal light, no hard shadows, a perfectly symmetrical composition with the subject dead centre, painted-set feel.', look: 'Pastel pink, mint and cream palette.' },

  // ---------------------------------------------------------------- Everyday
  { id: 'living', group: 'Everyday', label: 'Living-Room Tableau', icon: '🛋️', blurb: 'Lived-in room: sofa, lamp, shelves, soft evening light.',
    cam: { size: 'full', lens: 35, h: 1.25, az: 16, off: 0.18, aim: 0.58 }, wall: true,
    set: [{ t: 'couch', r: -2.3, d: 2.2, ry: 20 }, { t: 'coffeetable', r: 0.4, d: -0.9 }, { t: 'lamp', r: 2.8, d: 2.6 }, { t: 'bookshelf', r: 3, d: 4 }, { t: 'tv', r: -2.4, d: 5 }],
    light: 'Warm evening light from a table lamp, the room softly lit with deep corners, a blue glow from a screen, realistic clutter on surfaces.', look: 'Warm amber and soft blue, lived-in.' },
  { id: 'kitchen', group: 'Everyday', label: 'Kitchen Morning', icon: '☕', blurb: 'Soft window daylight, counter, fridge, steam.',
    cam: { size: 'cowboy', lens: 35, h: 1.4, az: 20, off: 0.3, aim: 0.68 }, wall: true,
    set: [{ t: 'counter', r: -2.2, d: 2.4 }, { t: 'fridge', r: 2.6, d: 3 }, { t: 'window', r: 0, d: 3.8 }],
    light: 'Soft cool daylight pouring through the window, bright and airy, steam from a cup, gentle shadows, pale morning haze.', look: 'Fresh, airy, slightly desaturated.' },
  { id: 'bedroom', group: 'Everyday', label: 'Bedroom Night Lamp', icon: '🛏️', blurb: 'One bedside lamp, soft pool of light, dark room.',
    cam: { size: 'medium', lens: 40, h: 1.2, az: 25, off: 0.3, aim: 0.7 }, wall: true,
    set: [{ t: 'bed', r: -2.2, d: 2.4, ry: 90 }, { t: 'nightstand', r: 0.6, d: 3.4 }, { t: 'lamp', r: 1.5, d: 3.4 }, { t: 'wardrobe', r: 3, d: 3 }],
    light: 'A single warm bedside lamp making a small intimate pool of light, the rest of the room falling into deep shadow, quiet night mood.', look: 'Warm amber on deep navy.' },
  { id: 'office', group: 'Everyday', label: 'Office Fluorescent', icon: '🏢', blurb: 'Flat overhead light, desk and shelves: mundane and tense.',
    cam: { size: 'medium', lens: 35, h: 1.5, az: 30, off: 0.28, aim: 0.7 }, wall: true,
    set: [{ t: 'desk', r: -1.6, d: -0.3 }, { t: 'bookshelf', r: 2.6, d: 3 }, { t: 'window', r: -2.2, d: 3.6 }],
    light: 'Cool flat overhead fluorescent light, slightly green, a bluish daylight window, mundane workplace realism, no flattering shadows.', look: 'Cool desaturated greens and greys.' },
  { id: 'bathroom', group: 'Everyday', label: 'Bathroom Mirror', icon: '🪞', blurb: 'Harsh light over a mirror, tight tiled space.',
    cam: { size: 'mcu', lens: 35, h: 1.5, az: 30, off: 0.3, aim: 0.85 }, wall: true,
    set: [{ t: 'mirror', r: -0.7, d: 1.8 }, { t: 'bathtub', r: 2.1, d: 1.6, ry: 90 }],
    light: 'Hard vertical light above a mirror, slightly harsh and unflattering, tiled walls bouncing cool white light, a faint steam haze.', look: 'Cool white with a pale green cast.' },

  // ---------------------------------------------------------------- Epic & wide
  { id: 'epic_land', group: 'Epic & wide', label: 'Epic Landscape', icon: '🏔️', blurb: 'People tiny in a huge exterior, big sky.',
    cam: { size: 'wide', lens: 24, h: 1.0, az: 14, off: -0.25, aim: 0.5, fit: true }, wall: false,
    set: [{ t: 'rock', r: -5, d: 8 }, { t: 'rock', r: 6, d: 14 }, { t: 'tree', r: 4.4, d: 5 }, { t: 'tree', r: -2.6, d: 18 }],
    light: 'Dramatic low sun breaking through clouds, god rays, vast sky filling most of the frame, tiny figures dwarfed by the landscape, atmospheric depth haze.', look: 'Epic, rich colour, soft film contrast.' },
  { id: 'car_night', group: 'Epic & wide', label: 'Car Headlight Night', icon: '🚗', blurb: 'Parked car, headlights cutting the dark.',
    cam: { size: 'full', lens: 35, h: 1.1, az: 10, off: 0.2, aim: 0.58 }, wall: false,
    set: [{ t: 'car', r: -0.4, d: 4.4, ry: 180 }, { t: 'streetlamp', r: 4.2, d: 4.5 }, { t: 'tree', r: -4.2, d: 6.5 }],
    light: 'Car headlights shining straight toward the camera in the haze, the subject in front of them as a bright rim-lit shape, a dim street lamp, dust in the beams.', look: 'Deep blue night with warm white headlights.' },
  { id: 'church', group: 'Epic & wide', label: 'Grand Hall', icon: '⛪', blurb: 'Tall columns, one beam of light from a high window.',
    cam: { size: 'full', lens: 24, h: 1.0, az: 0, off: 0, aim: 0.55 }, wall: true,
    set: [{ t: 'column', r: -3, d: -1 }, { t: 'column', r: 3, d: -1 }, { t: 'column', r: -3, d: 3.5 }, { t: 'column', r: 3, d: 3.5 }, { t: 'column', r: -3, d: 8 }, { t: 'column', r: 3, d: 8 }, { t: 'archway', r: 0, d: 11 }],
    light: 'A single shaft of light from a high window cutting through dust and incense haze, the rest of the vast space in cool shadow.', look: 'Cool shadows with a golden beam.' },
];

export const CINE_BY_ID = Object.fromEntries(CINE.map((p) => [p.id, p]));
export const cinePrompt = (p) => `${FILM} ${p.light} ${p.look}`;

const VIS_H = { wide: 7.0, full: 2.7, cowboy: 1.9, medium: 1.45, mcu: 0.95, cu: 0.62, ecu: 0.34 };

/** Compose the camera + dress the set for the people currently on stage. Returns a short report. */
export function applyCinematic(stage, preset) {
  stage.items.filter((i) => i.auto === 'cine').forEach((i) => stage.remove(i.id, true));
  stage.setWall(!!preset.wall);
  const ps = stage.items.filter((i) => i.kind === 'person');
  const c = preset.cam;
  const V = THREE.Vector3;

  const focusItem = (stage.selected && stage.selected.kind === 'person' ? stage.selected : ps[0]) || null;   // close-ups frame the selected person
  const pos2 = (i) => new V(i.root.position.x, 0, i.root.position.z);
  const near = ['mcu', 'cu', 'ecu'].includes(c.size);
  const members = near && focusItem ? [focusItem] : ps;
  const center = members.length ? members.reduce((s, i) => s.add(pos2(i)), new V()).multiplyScalar(1 / members.length) : new V(0, 0, 0);
  const tall = members.length ? Math.max(...members.map((i) => i.fig.build.height)) : 1.75;
  const span = members.length > 1 ? Math.max(...members.map((i) => pos2(i).distanceTo(center))) * 2 + 0.9 : 0.9;

  stage.setLens(c.lens);
  const aspect = stage.aspect;
  const vfov = THREE.MathUtils.degToRad(stage.shot.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  let vis = VIS_H[c.size] || 2.2;
  if (c.size !== 'wide' && c.size !== 'full') vis *= tall / 1.75;
  let dist = (vis / 2) / Math.tan(vfov / 2);
  if (c.fit || !near) dist = Math.max(dist, (span / 2) / Math.tan(hfov / 2) * 1.4);
  dist = Math.max(dist, 1.0);

  // base direction (az 0): the way the group faces; if they face each other it cancels out, so use the side that sees both faces
  const fwdOf = (i) => new V(Math.sin(i.root.rotation.y), 0, Math.cos(i.root.rotation.y));
  const toCurrent = new V(stage.shot.position.x - center.x, 0, stage.shot.position.z - center.z);
  let base = new V(0, 0, 1);
  if (ps.length >= 2 && c.axis === 'between') {
    const ax = pos2(ps[1]).sub(pos2(ps[0])).normalize();
    base = new V(-ax.z, 0, ax.x);
    if (base.dot(toCurrent) < 0) base.multiplyScalar(-1);
  } else if (members.length) {
    const m = members.reduce((s, i) => s.add(fwdOf(i)), new V()).multiplyScalar(1 / members.length);
    if (m.length() > 0.4) base = m.normalize();
    else if (members.length >= 2) {
      const ax = pos2(members[1]).sub(pos2(members[0])).normalize();
      const perp = new V(-ax.z, 0, ax.x);
      if (perp.dot(toCurrent) < 0) perp.multiplyScalar(-1);
      // three-quarter view: swing from the flat profile toward the first person's face, so we see a face, not an ear
      base = perp.clone().multiplyScalar(Math.cos(0.62)).add(fwdOf(members[0]).multiplyScalar(Math.sin(0.62))).normalize();
    } else base = fwdOf(members[0]);
  }
  const yaw = Math.atan2(base.x, base.z) + THREE.MathUtils.degToRad(c.az || 0);
  let camPos; let look;
  const aimY = Math.max(0.15, tall * (c.aim ?? 0.65));

  if (c.ots && ps.length >= 2) {
    const A = ps[0], B = ps[1];
    const a = pos2(A), b = pos2(B);
    const dir = a.clone().sub(b).setY(0).normalize();                 // from B toward A
    const right = new V(-dir.z * -1, 0, dir.x * -1).normalize();      // sideways, for the shoulder offset
    camPos = a.clone().add(dir.clone().multiplyScalar(0.95)).add(right.multiplyScalar(0.22));
    camPos.y = c.h || 1.55;
    look = b.clone(); look.y = B.fig.build.height * (c.aim ?? 0.88);
    stage.shot.position.copy(camPos); stage.shot.lookAt(look);
  } else {
    const camDir = new V(Math.sin(yaw), 0, Math.cos(yaw));
    camPos = center.clone().add(camDir.clone().multiplyScalar(dist)); camPos.y = c.h ?? 1.5;
    const f = camDir.clone().multiplyScalar(-1);
    const right = new V(-f.z, 0, f.x);
    const halfW = (vis * aspect) / 2;
    look = center.clone().sub(right.clone().multiplyScalar((c.off || 0) * halfW)); look.y = aimY;
    stage.shot.position.copy(camPos); stage.shot.lookAt(look);
  }
  if (c.roll) stage.shot.rotateZ(THREE.MathUtils.degToRad(c.roll));

  // set dressing, laid out in the camera's own axes so "left foreground" stays left foreground
  const fwd = center.clone().sub(new V(camPos.x, 0, camPos.z)).setY(0);
  if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
  fwd.normalize();
  const rightV = new V(-fwd.z, 0, fwd.x);
  const faceCam = Math.atan2(-fwd.x, -fwd.z);
  const added = [];
  const R = { wall: 1.6, door: 0.7, window: 0.8, archway: 1.2, column: 0.45, stairs: 1.6, fence: 1.5, car: 2.4, tree: 0.7, couch: 1.1, bed: 1.2, counter: 1.1, desk: 0.9, bookshelf: 0.7, fridge: 0.6, tv: 0.8, dresser: 0.7, wardrobe: 0.8, dumpster: 1.0, coffeetable: 0.7 };
  const clearOf = (p, rad) => ps.every((i) => Math.hypot(i.root.position.x - p.x, i.root.position.z - p.z) > rad + 0.55);
  (preset.set || []).forEach((s) => {
    let d = s.d || 0;
    const at = (dd) => center.clone().add(rightV.clone().multiplyScalar(s.r || 0)).add(fwd.clone().multiplyScalar(dd));
    // keep set pieces off the cast: slide back (or toward the camera for foreground pieces) until clear
    for (let k = 0; k < 14 && !clearOf(at(d), R[s.t] || 0.5); k++) d += d < 0 ? -0.5 : 0.5;
    const p = at(d);
    const it = stage.add(s.t, { position: [p.x, 0, p.z], rotationY: faceCam + THREE.MathUtils.degToRad(s.ry || 0), label: s.label, silent: true });
    if (it) { it.auto = 'cine'; added.push(it.label); }
  });
  stage._emit();
  return { props: added, note: c.ots && ps.length < 2 ? 'Over-the-shoulder needs two people: framed as a medium shot instead.' : '' };
}

/** Render one preview per preset from the CURRENT cast, then put the scene back exactly as it was. Returns [{preset, url}] */
export async function previewAll(stage, list = CINE, onProgress) {
  const keep = stage.serialize();
  const keepView = stage.view;
  const out = [];
  try {
    stage.select(null);                       // no joint handles in the thumbnails
    stage.setView('shot');
    for (let n = 0; n < list.length; n++) {
      applyCinematic(stage, list[n]);
      await new Promise((r) => setTimeout(r, 40));            // thumbnail() draws the frame itself, so this works in a background tab too
      out.push({ preset: list[n], url: stage.thumbnail(360) });
      onProgress?.(n + 1, list.length);
    }
  } finally {
    stage.load(keep);
    stage.setView(keepView);
  }
  return out;
}
