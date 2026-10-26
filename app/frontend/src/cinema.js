// Cinema rig — the local equivalent of Higgsfield's Cinema Studio / DOP:
// camera body + lens + focal length + aperture + film look + lighting + shot
// framing, compiled into prompt language the image (Flux 3) and video (H3 /
// LTX) models respond to. Pure data + functions; no network.

export const CAMERA_BODIES = [
  { id: 'alexa35', label: 'ARRI Alexa 35', text: 'shot on ARRI Alexa 35, rich natural highlight roll-off, organic skin tones, 17 stops of dynamic range' },
  { id: 'venice2', label: 'Sony Venice 2', text: 'shot on Sony Venice 2, clean full-frame cinematic look, deep shadows with detail' },
  { id: 'vraptor', label: 'RED V-Raptor', text: 'shot on RED V-Raptor 8K, crisp high-resolution detail, punchy contrast' },
  { id: 'dxl2', label: 'Panavision DXL2', text: 'shot on Panavision DXL2 large format, shallow depth and epic scale' },
  { id: 'film35', label: '35mm film camera', text: 'shot on 35mm motion-picture film, visible fine grain, halation around highlights, gentle gate weave' },
  { id: 'imax', label: 'IMAX 70mm', text: 'shot on IMAX 70mm film, immense clarity and scale, subtle grain' },
  { id: 'super16', label: 'Super 16 film', text: 'shot on Super 16mm film, heavy grain, soft vintage contrast, documentary feel' },
  { id: 'bolex', label: 'Bolex 16mm', text: 'shot on a hand-wound Bolex 16mm camera, flickering exposure, dust and scratches, nostalgic texture' },
  { id: 'vhs', label: 'VHS camcorder', text: 'shot on a 1990s VHS camcorder, tape noise, soft smeared color, timestamp-era lo-fi look' },
  { id: 'iphone', label: 'iPhone (handheld)', text: 'shot handheld on a modern smartphone, wide deep-focus look, vertical social video, computational HDR' },
  { id: 'gopro', label: 'GoPro action cam', text: 'shot on a GoPro action camera, ultra-wide distorted perspective, deep focus, stabilized motion' },
  { id: 'cctv', label: 'CCTV / security cam', text: 'captured on a security camera, high-angle wide lens, low resolution, flat greenish light, compression artifacts' },
  { id: 'dslr', label: 'Full-frame DSLR photo', text: 'shot on a full-frame DSLR, sharp detail, natural color' },
  { id: 'polaroid', label: 'Polaroid instant', text: 'instant Polaroid photograph, soft focus edges, faded color, white border' },
];

export const LENSES = [
  { id: 'none', label: 'Auto', text: '' },
  { id: 'spherical', label: 'Spherical prime', text: 'clean spherical prime lens, sharp and neutral' },
  { id: 'anamorphic', label: 'Anamorphic', text: 'anamorphic lens, horizontal blue lens flares, oval bokeh, cinematic widescreen feel' },
  { id: 'cooke', label: 'Vintage Cooke', text: 'vintage Cooke lens, warm gentle softness, the "Cooke look"' },
  { id: 'helios', label: 'Helios swirl', text: 'vintage Helios lens with swirling bokeh and soft glow' },
  { id: 'macro', label: 'Macro', text: 'macro lens, extreme close detail, razor-thin focus plane' },
  { id: 'tiltshift', label: 'Tilt-shift', text: 'tilt-shift lens, miniature-world selective focus band' },
  { id: 'fisheye', label: 'Fisheye', text: 'fisheye lens, strong barrel distortion, 180-degree view' },
  { id: 'telephoto', label: 'Long telephoto', text: 'long telephoto lens, compressed perspective, flattened background layers' },
  { id: 'softfocus', label: 'Soft-focus / Pro-Mist', text: 'Black Pro-Mist diffusion filter, glowing highlights, dreamy bloom' },
  { id: 'split', label: 'Split diopter', text: 'split-diopter lens, foreground and background both in sharp focus' },
  { id: 'probe', label: 'Probe lens', text: 'periscope probe lens, extreme low angle scale, macro-worldview' },
];

export const FOCAL_LENGTHS = [
  { mm: 8, text: '8mm ultra-wide, exaggerated perspective' },
  { mm: 14, text: '14mm wide, expansive environment' },
  { mm: 24, text: '24mm wide angle' },
  { mm: 35, text: '35mm natural cinematic field of view' },
  { mm: 50, text: '50mm normal lens, human-eye perspective' },
  { mm: 85, text: '85mm portrait lens, flattering compression' },
  { mm: 135, text: '135mm telephoto, strong background compression' },
  { mm: 200, text: '200mm super-telephoto, isolated subject, heavily compressed depth' },
];

export const APERTURES = [
  { f: 1.2, text: 'f/1.2 wide open, razor-thin depth of field, creamy bokeh' },
  { f: 1.4, text: 'f/1.4, very shallow depth of field, soft bokeh' },
  { f: 2.8, text: 'f/2.8, shallow depth of field' },
  { f: 4, text: 'f/4, moderate depth of field' },
  { f: 5.6, text: 'f/5.6, balanced sharpness' },
  { f: 8, text: 'f/8, deep focus, everything crisp' },
  { f: 11, text: 'f/11, deep focus, sunstar highlights' },
  { f: 16, text: 'f/16, maximum depth of field, crisp sunstars' },
];

export const SHOT_SIZES = [
  { id: 'none', label: 'Auto', text: '' },
  { id: 'ews', label: 'Extreme wide', text: 'extreme wide shot, tiny figure in a vast environment' },
  { id: 'ws', label: 'Wide', text: 'wide establishing shot' },
  { id: 'fs', label: 'Full', text: 'full-body shot' },
  { id: 'cowboy', label: 'Cowboy', text: 'medium-wide cowboy shot from mid-thigh up' },
  { id: 'ms', label: 'Medium', text: 'medium shot from the waist up' },
  { id: 'mcu', label: 'Medium close-up', text: 'medium close-up from the chest up' },
  { id: 'cu', label: 'Close-up', text: 'close-up on the face' },
  { id: 'ecu', label: 'Extreme close-up', text: 'extreme close-up on the eyes and fine detail' },
  { id: 'insert', label: 'Insert / detail', text: 'insert shot of a detail object, tight framing' },
];

export const ANGLES = [
  { id: 'none', label: 'Auto', text: '' },
  { id: 'eye', label: 'Eye level', text: 'eye-level camera' },
  { id: 'low', label: 'Low angle', text: 'low-angle camera looking up, heroic scale' },
  { id: 'high', label: 'High angle', text: 'high-angle camera looking down' },
  { id: 'dutch', label: 'Dutch tilt', text: 'dutch angle, tilted horizon, unsettling' },
  { id: 'birds', label: "Bird's-eye", text: "bird's-eye view directly overhead" },
  { id: 'worm', label: "Worm's-eye", text: "worm's-eye view from ground level looking up" },
  { id: 'ots', label: 'Over-the-shoulder', text: 'over-the-shoulder framing' },
  { id: 'pov', label: 'POV', text: 'first-person point-of-view shot' },
  { id: 'profile', label: 'Profile', text: 'side-profile view' },
  { id: 'back', label: 'From behind', text: 'seen from behind, following the subject' },
];

export const FILM_LOOKS = [
  { id: 'none', label: 'None', text: '' },
  { id: 'vision3', label: 'Kodak Vision3 500T', text: 'Kodak Vision3 500T tungsten film stock, warm halation, cinematic grain' },
  { id: 'portra', label: 'Kodak Portra 400', text: 'Kodak Portra 400 film, soft pastel skin tones, fine grain' },
  { id: 'cinestill', label: 'CineStill 800T', text: 'CineStill 800T, red halation glow around night lights, teal shadows' },
  { id: 'ektachrome', label: 'Ektachrome slide', text: 'Ektachrome slide film, saturated punchy color, crisp contrast' },
  { id: 'fuji', label: 'Fuji Eterna', text: 'Fujifilm Eterna cinema stock, muted greens and soft contrast' },
  { id: 'tealorange', label: 'Teal & orange', text: 'teal and orange blockbuster color grade' },
  { id: 'bleach', label: 'Bleach bypass', text: 'bleach bypass grade, desaturated, high contrast, gritty' },
  { id: 'noir', label: 'Black & white noir', text: 'high-contrast black and white film noir, hard shadows' },
  { id: 'technicolor', label: '3-strip Technicolor', text: 'three-strip Technicolor, hyper-saturated primary colors' },
  { id: 'pastel', label: 'Pastel dream', text: 'soft pastel color palette, airy low contrast' },
  { id: 'cyber', label: 'Neon cyberpunk', text: 'neon magenta and cyan cyberpunk grade, glowing wet streets' },
  { id: 'sepia', label: 'Faded sepia', text: 'faded sepia vintage tone, aged paper warmth' },
  { id: 'moody', label: 'Cool moody', text: 'cool desaturated moody grade, crushed blacks' },
  { id: 'golden', label: 'Golden hour warm', text: 'warm golden-hour grade, glowing amber highlights' },
];

export const LIGHTING = [
  { id: 'none', label: 'Auto', text: '' },
  { id: 'golden', label: 'Golden hour', text: 'golden-hour sunlight, long soft shadows' },
  { id: 'blue', label: 'Blue hour', text: 'blue-hour twilight, cool ambient glow with warm window lights' },
  { id: 'overcast', label: 'Overcast soft', text: 'soft overcast daylight, even and shadowless' },
  { id: 'hard', label: 'Hard noon sun', text: 'hard midday sun, crisp dark shadows' },
  { id: 'rembrandt', label: 'Rembrandt', text: 'Rembrandt lighting, triangle of light on the cheek' },
  { id: 'rim', label: 'Rim / backlight', text: 'strong rim light and backlight separating the subject, haze in the air' },
  { id: 'lowkey', label: 'Low-key', text: 'low-key chiaroscuro lighting, deep black shadows' },
  { id: 'neon', label: 'Neon practicals', text: 'neon signs as practical light sources, colored reflections' },
  { id: 'candle', label: 'Candlelight', text: 'warm flickering candlelight, intimate glow' },
  { id: 'window', label: 'Window light', text: 'soft directional window light' },
  { id: 'fog', label: 'Volumetric fog', text: 'volumetric fog with visible light shafts' },
  { id: 'moon', label: 'Moonlight', text: 'cold moonlight with silver highlights' },
  { id: 'flash', label: 'Direct flash', text: 'harsh on-camera flash, paparazzi snapshot look' },
  { id: 'studio', label: 'Studio softbox', text: 'clean studio softbox lighting' },
];

// ---------------------------------------------------------------- color (Soul HEX equivalent)

const NAMED = [
  ['black', '#000000'], ['white', '#ffffff'], ['charcoal grey', '#36454f'], ['light grey', '#c0c0c0'],
  ['crimson red', '#dc143c'], ['scarlet', '#ff2400'], ['burgundy', '#800020'], ['orange', '#ff8c00'],
  ['amber', '#ffbf00'], ['golden yellow', '#ffd700'], ['olive green', '#808000'], ['emerald green', '#50c878'],
  ['forest green', '#228b22'], ['mint', '#98ff98'], ['teal', '#008080'], ['cyan', '#00ffff'],
  ['sky blue', '#87ceeb'], ['royal blue', '#4169e1'], ['navy blue', '#000080'], ['indigo', '#4b0082'],
  ['violet', '#8f00ff'], ['lavender', '#b57edc'], ['magenta', '#ff00ff'], ['hot pink', '#ff69b4'],
  ['blush pink', '#f4c2c2'], ['brown', '#8b4513'], ['tan', '#d2b48c'], ['cream', '#fffdd0'], ['rust', '#b7410e'],
];
const hexRgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export function colorName(hex) {
  const [r, g, b] = hexRgb(hex);
  let best = NAMED[0][0], bd = Infinity;
  for (const [name, h] of NAMED) {
    const [r2, g2, b2] = hexRgb(h);
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}

export const PALETTE_PRESETS = [
  { id: 'sunset', label: 'Sunset', colors: ['#ff5e3a', '#ffb347', '#6a2c70'] },
  { id: 'noir', label: 'Neo-noir', colors: ['#0b132b', '#1c2541', '#ff2e63'] },
  { id: 'forest', label: 'Forest', colors: ['#1b4332', '#52b788', '#d8f3dc'] },
  { id: 'candy', label: 'Candy', colors: ['#ff9ff3', '#feca57', '#48dbfb'] },
  { id: 'desert', label: 'Desert', colors: ['#c9a66b', '#e07a5f', '#3d405b'] },
];

// ---------------------------------------------------------------- compiler

export const DEFAULT_RIG = {
  enabled: false,
  body: 'alexa35', lens: 'none', focal: 35, aperture: 2.8,
  shot: 'none', angle: 'none', film: 'none', light: 'none',
  palette: [], // hex strings
};

const find = (arr, key, val) => arr.find((x) => x[key] === val);

/** Rig -> a single trailing prompt clause for the *still* (Flux 3 / Krea 2). */
export function rigToPrompt(rig) {
  if (!rig?.enabled) return '';
  const parts = [];
  const shot = find(SHOT_SIZES, 'id', rig.shot)?.text;
  const angle = find(ANGLES, 'id', rig.angle)?.text;
  if (shot) parts.push(shot);
  if (angle) parts.push(angle);
  const body = find(CAMERA_BODIES, 'id', rig.body)?.text;
  if (body) parts.push(body);
  const lens = find(LENSES, 'id', rig.lens)?.text;
  if (lens) parts.push(lens);
  const focal = find(FOCAL_LENGTHS, 'mm', rig.focal)?.text;
  if (focal) parts.push(focal);
  const ap = find(APERTURES, 'f', rig.aperture)?.text;
  if (ap) parts.push(ap);
  const light = find(LIGHTING, 'id', rig.light)?.text;
  if (light) parts.push(light);
  const film = find(FILM_LOOKS, 'id', rig.film)?.text;
  if (film) parts.push(film);
  if (rig.palette?.length) parts.push(`dominant color palette of ${rig.palette.map(colorName).join(', ')}`);
  return parts.join(', ');
}

export const withRig = (prompt, rig) => {
  const clause = rigToPrompt(rig);
  return clause ? `${prompt.trim().replace(/[,\s]+$/, '')}. ${clause}.` : prompt;
};

// ---------------------------------------------------------------- camera motion library
// 80 moves. `text` is appended to the video (H3 / LTX) motion prompt.

const M = (id, label, cat, text) => ({ id, label, cat, text });
export const MOTION_CATEGORIES = ['Static', 'Push / Pull', 'Pan / Tilt', 'Truck / Pedestal', 'Orbit', 'Crane / Drone', 'Handheld', 'Zoom', 'Dynamic', 'Creative'];

export const CAMERA_MOTIONS = [
  M('static', 'Locked-off', 'Static', 'the camera is completely static on a tripod'),
  M('static-breath', 'Subtle breathing', 'Static', 'the camera is nearly still with a barely perceptible handheld breathing drift'),
  M('lock-focus', 'Static + rack focus', 'Static', 'the camera stays locked while the focus racks from foreground to background'),
  M('dolly-in', 'Dolly in', 'Push / Pull', 'the camera dollies smoothly forward toward the subject'),
  M('dolly-out', 'Dolly out', 'Push / Pull', 'the camera dollies smoothly backward, revealing more of the scene'),
  M('slow-push', 'Slow push-in', 'Push / Pull', 'a very slow, tense push-in toward the subject\'s face'),
  M('fast-push', 'Fast push-in', 'Push / Pull', 'a fast aggressive push-in on the subject'),
  M('push-reveal', 'Pull-back reveal', 'Push / Pull', 'the camera pulls back to reveal the wider surroundings'),
  M('super-dolly-in', 'Super dolly in', 'Push / Pull', 'an extreme long dolly in, racing toward the subject through the space'),
  M('dolly-zoom-in', 'Dolly zoom (Vertigo)', 'Push / Pull', 'a dolly-zoom Vertigo effect: the camera dollies backward while zooming in, the background warping behind the subject'),
  M('dolly-zoom-out', 'Reverse dolly zoom', 'Push / Pull', 'a reverse dolly zoom: the camera dollies forward while zooming out, the background stretching away'),
  M('pan-left', 'Pan left', 'Pan / Tilt', 'the camera pans smoothly to the left'),
  M('pan-right', 'Pan right', 'Pan / Tilt', 'the camera pans smoothly to the right'),
  M('whip-left', 'Whip pan left', 'Pan / Tilt', 'a fast whip pan to the left with heavy motion blur'),
  M('whip-right', 'Whip pan right', 'Pan / Tilt', 'a fast whip pan to the right with heavy motion blur'),
  M('tilt-up', 'Tilt up', 'Pan / Tilt', 'the camera tilts upward, revealing what is above'),
  M('tilt-down', 'Tilt down', 'Pan / Tilt', 'the camera tilts downward'),
  M('pan-follow', 'Follow pan', 'Pan / Tilt', 'the camera pans to follow the subject as they move across the frame'),
  M('swish-tilt', 'Whip tilt', 'Pan / Tilt', 'a fast whip tilt with motion blur'),
  M('roll-cw', 'Roll clockwise', 'Pan / Tilt', 'the camera rolls clockwise around its lens axis'),
  M('roll-ccw', 'Roll counter-clockwise', 'Pan / Tilt', 'the camera rolls counter-clockwise around its lens axis'),
  M('truck-left', 'Truck left', 'Truck / Pedestal', 'the camera trucks sideways to the left, parallax shifting the layers'),
  M('truck-right', 'Truck right', 'Truck / Pedestal', 'the camera trucks sideways to the right, parallax shifting the layers'),
  M('track-side', 'Side tracking', 'Truck / Pedestal', 'a lateral tracking shot keeping pace with the subject'),
  M('track-back', 'Tracking back', 'Truck / Pedestal', 'the camera tracks backward in front of the subject as they walk toward it'),
  M('track-follow', 'Tracking follow', 'Truck / Pedestal', 'the camera follows closely behind the subject as they walk'),
  M('ped-up', 'Pedestal up', 'Truck / Pedestal', 'the camera rises vertically straight up'),
  M('ped-down', 'Pedestal down', 'Truck / Pedestal', 'the camera lowers vertically straight down'),
  M('slide-parallax', 'Parallax slide', 'Truck / Pedestal', 'a slow sideways slide emphasizing foreground-background parallax'),
  M('orbit-cw', 'Orbit clockwise', 'Orbit', 'the camera orbits clockwise around the subject'),
  M('orbit-ccw', 'Orbit counter-clockwise', 'Orbit', 'the camera orbits counter-clockwise around the subject'),
  M('orbit-360', '360° orbit', 'Orbit', 'a full 360-degree orbit around the subject'),
  M('orbit-low', 'Low-angle orbit', 'Orbit', 'the camera orbits the subject from a low angle, looking up'),
  M('orbit-high', 'High-angle orbit', 'Orbit', 'the camera orbits the subject from a high angle, looking down'),
  M('half-orbit', 'Half orbit reveal', 'Orbit', 'a 180-degree orbit revealing the subject from the other side'),
  M('arc-shot', 'Arc shot', 'Orbit', 'a smooth partial arc around the subject'),
  M('bullet-time', 'Bullet time', 'Orbit', 'a bullet-time effect: the action freezes while the camera swings around the frozen subject'),
  M('robo-arm', 'Robo-arm spin', 'Orbit', 'a fast robotic motion-control arm swings around the subject in a sweeping spiral'),
  M('crane-up', 'Crane up', 'Crane / Drone', 'a crane shot rising high above the scene'),
  M('crane-down', 'Crane down', 'Crane / Drone', 'a crane shot descending toward the subject'),
  M('crane-reveal', 'Crane reveal', 'Crane / Drone', 'the crane rises to reveal a vast landscape beyond the foreground'),
  M('drone-rise', 'Drone rise', 'Crane / Drone', 'an aerial drone rises and tilts down over the scene'),
  M('drone-fly', 'Drone fly-through', 'Crane / Drone', 'an aerial drone flies forward through the environment'),
  M('drone-orbit', 'Drone orbit', 'Crane / Drone', 'an aerial drone circles the subject from above'),
  M('drone-dive', 'Drone dive', 'Crane / Drone', 'an aerial drone dives steeply down toward the subject'),
  M('fpv', 'FPV drone', 'Crane / Drone', 'a fast FPV drone flight weaving through the environment with swooping banking turns'),
  M('top-down', 'Overhead top-down', 'Crane / Drone', 'a steady top-down overhead view looking straight down'),
  M('handheld', 'Handheld', 'Handheld', 'natural handheld camera with subtle shake'),
  M('handheld-doc', 'Documentary handheld', 'Handheld', 'documentary-style handheld camera, searching and reframing'),
  M('shaky', 'Shaky cam', 'Handheld', 'intense shaky handheld camera, chaotic and urgent'),
  M('steadicam', 'Steadicam glide', 'Handheld', 'a smooth Steadicam glide following the action'),
  M('snorricam', 'Snorricam', 'Handheld', 'a body-mounted Snorricam: the subject stays fixed in frame while the world swirls behind'),
  M('pov-walk', 'POV walking', 'Handheld', 'first-person POV walking forward with a natural bob'),
  M('pov-run', 'POV running', 'Handheld', 'first-person POV running, bouncing and breathless'),
  M('selfie', 'Selfie arm-length', 'Handheld', 'arm-length selfie-style camera facing the subject, slightly wobbling'),
  M('found-footage', 'Found footage', 'Handheld', 'found-footage handheld camera, abrupt reframing and autofocus hunting'),
  M('zoom-in', 'Zoom in', 'Zoom', 'a smooth optical zoom in'),
  M('zoom-out', 'Zoom out', 'Zoom', 'a smooth optical zoom out'),
  M('crash-in', 'Crash zoom in', 'Zoom', 'a sudden crash zoom in on the subject\'s face'),
  M('crash-out', 'Crash zoom out', 'Zoom', 'a sudden crash zoom out'),
  M('slow-zoom', 'Slow creeping zoom', 'Zoom', 'an almost imperceptible slow zoom in building tension'),
  M('rack-zoom', 'Rack focus + zoom', 'Zoom', 'rack focus shifting to the subject while slowly zooming in'),
  M('ramp', 'Speed ramp', 'Dynamic', 'dynamic speed ramping from slow motion to real time as the camera pushes in'),
  M('slowmo', 'Slow motion', 'Dynamic', 'ultra slow-motion, every detail suspended'),
  M('timelapse', 'Timelapse', 'Dynamic', 'a timelapse with clouds and shadows racing across the scene'),
  M('hyperlapse', 'Hyperlapse', 'Dynamic', 'a hyperlapse moving rapidly forward through the environment'),
  M('chase', 'Chase cam', 'Dynamic', 'a fast chase camera pursuing the subject'),
  M('whip-cut', 'Whip transition', 'Dynamic', 'a whip pan that blurs the frame, ending on a fresh composition'),
  M('through-object', 'Fly through object', 'Dynamic', 'the camera flies through a small opening, transitioning seamlessly into the next space'),
  M('impact-shake', 'Impact shake', 'Dynamic', 'the camera jolts and shakes with a heavy impact, debris drifting through frame'),
  M('vertigo-fall', 'Falling camera', 'Dynamic', 'the camera tumbles in a free-fall, spinning as the world rushes past'),
  M('lens-flare-sweep', 'Flare sweep', 'Creative', 'the camera sweeps past a bright light creating a long anamorphic lens flare'),
  M('mirror-reflect', 'Reflection reveal', 'Creative', 'the camera moves to reveal the subject in a reflective surface'),
  M('keyhole', 'Keyhole peek', 'Creative', 'the camera pushes through a keyhole-shaped dark vignette into the scene'),
  M('split-screen', 'Split diopter drift', 'Creative', 'a subtle drift with a split-focus foreground and background'),
  M('dream-float', 'Dreamlike float', 'Creative', 'a floating, weightless dreamlike drift with gentle sway'),
  M('earth-zoom', 'Earth zoom-out', 'Creative', 'an enormous zoom-out from the subject to reveal the whole city, then the planet'),
  M('macro-dive', 'Macro dive-in', 'Creative', 'an extreme push-in diving into microscopic detail'),
  M('glitch', 'Glitch cut', 'Creative', 'the footage stutters with digital glitch distortion and RGB-split frames'),
  M('vertigo-roll', 'Corkscrew', 'Creative', 'the camera corkscrews forward, rolling as it advances'),
];

export const motionText = (id) => find(CAMERA_MOTIONS, 'id', id)?.text || '';

// ---------------------------------------------------------------- one-click effects
// Higgsfield-style preset effects. Each is an editing / video prompt recipe
// that can be re-applied to any image or clip ("Recreate").

const E = (id, label, cat, video, edit) => ({ id, label, cat, video, edit });
export const EFFECT_CATEGORIES = ['Transform', 'Elements', 'Motion', 'Dynamic', 'Style', 'Social'];
export const EFFECTS = [
  E('melting', 'Melting', 'Transform', 'the subject slowly melts like hot wax, flowing downward in thick glossy drips while the camera holds', 'make the subject look like it is melting like hot wax, thick glossy drips'),
  E('burning', 'Burning man', 'Elements', 'the subject catches fire, flames spreading over the body and lighting the scene, embers rising', 'the subject is engulfed in flames, embers in the air'),
  E('floating', 'Floating fall', 'Motion', 'the subject floats weightlessly upward, hair and clothes drifting in slow motion', 'the subject floats in mid-air, hair and clothes drifting upward'),
  E('worldmorph', 'World morphing', 'Transform', 'the whole environment continuously morphs and reshapes around the subject into a new fantastical world', 'the environment morphs into a surreal fantastical world around the subject'),
  E('cutout', 'Paper cutout', 'Style', 'the scene turns into layered paper cutouts with stop-motion jitter', 'convert the scene into layered paper-cutout collage art'),
  E('smash', 'Smash & grab', 'Dynamic', 'the subject smashes through glass, shards flying, and grabs the object in slow motion', 'shards of glass explode around the subject mid-motion'),
  E('selfie-ception', 'Selfie-ception', 'Social', 'the subject lowers a phone and a nested copy of themselves takes a selfie, repeating into infinity', 'the subject holds a phone showing the same scene recursively'),
  E('giant', 'Street colossus', 'Transform', 'the subject grows into a skyscraper-sized giant stepping over the street as people look up', 'make the subject a colossal giant towering over the city street'),
  E('shrink', 'Tiny world', 'Transform', 'the subject shrinks to the size of a toy in a miniature macro world', 'make the subject tiny, standing in a giant macro-scale world'),
  E('eyes-in', 'Eyes in', 'Motion', 'the camera pushes rapidly into the subject\'s eye, passing through the pupil into a new world', 'extreme close-up of the subject\'s eye reflecting a whole world'),
  E('act-natural', 'Act natural', 'Social', 'the subject freezes then casually acts natural as someone passes behind, comedic timing', 'the subject pretends to act casually, caught mid-action'),
  E('lacewalker', 'Lacewalker', 'Style', 'the subject walks gracefully as intricate lace patterns grow over their outfit and the surroundings', 'cover the outfit and surroundings in intricate delicate lace patterns'),
  E('flip', 'High flip', 'Motion', 'the subject launches into a high acrobatic backflip, the camera tracking the arc', 'the subject caught mid-air in a high acrobatic flip'),
  E('studio-slide', 'Studio slide', 'Motion', 'the subject slides across a glossy studio floor in a dramatic pose, the camera tracking alongside', 'the subject sliding across a glossy studio floor in a dramatic pose'),
  E('wild-ride', 'Wild ride', 'Dynamic', 'a wild ride: the subject races forward with intense speed, the world a blur of motion lines', 'speed-lines motion blur, the subject racing forward'),
  E('explode', 'Explosion', 'Elements', 'a huge explosion erupts behind the subject who walks forward unfazed', 'a large fiery explosion erupts behind the subject'),
  E('water', 'Water burst', 'Elements', 'a wall of water crashes through the scene, drenching everything in slow motion', 'water splashing and bursting all around the subject, frozen mid-splash'),
  E('snow', 'Snowfall', 'Elements', 'heavy snow begins to fall, the world turning white', 'heavy snowfall, snow-covered scene, cold breath'),
  E('lightning', 'Lightning strike', 'Elements', 'lightning forks across the sky and strikes near the subject, flashing the scene white', 'dramatic lightning in a stormy sky, lighting the subject'),
  E('dust', 'Dust disintegrate', 'Transform', 'the subject slowly disintegrates into drifting dust and ash starting from the edges', 'the subject disintegrating into floating ash and dust particles'),
  E('glow', 'Aura glow', 'Elements', 'a glowing energy aura builds around the subject, light pulsing outward', 'a bright energy aura glowing around the subject'),
  E('clone', 'Clone army', 'Transform', 'the subject splits into many identical clones that spread out and stand in formation', 'many identical clones of the subject standing in formation'),
  E('age', 'Time aging', 'Transform', 'the subject visibly ages decades in seconds, face and hair changing naturally', 'show the subject as a very old person with deep wrinkles and white hair'),
  E('anime', 'Anime transform', 'Style', 'the footage transitions into hand-drawn anime with bold linework', 'redraw the image as a high-quality anime illustration'),
  E('clay', 'Claymation', 'Style', 'the scene becomes stop-motion claymation with fingerprint textures and choppy motion', 'convert the image into stop-motion claymation figures with fingerprint textures'),
  E('lego', 'Brick world', 'Style', 'the scene turns into a world built of toy plastic bricks', 'rebuild the scene entirely from toy plastic building bricks'),
  E('comic', 'Comic panel', 'Style', 'the scene shifts into halftone comic book art with onomatopoeia popping up', 'redraw as a halftone comic book panel with bold inks'),
  E('retro-vhs', 'Retro VHS', 'Style', 'the footage degrades into a 1980s VHS tape with tracking lines and color bleed', 'degrade into an authentic 1980s VHS frame with scanlines and color bleed'),
  E('hologram', 'Hologram', 'Transform', 'the subject flickers into a blue holographic projection with scanlines', 'the subject rendered as a translucent blue hologram with scanlines'),
  E('flowers', 'Bloom', 'Elements', 'flowers rapidly bloom and spread over the subject and the ground', 'flowers blooming all over the subject and surroundings'),
  E('portal', 'Portal step-through', 'Dynamic', 'a glowing portal opens and the subject steps through into another world', 'a glowing swirling portal opens beside the subject'),
  E('zero-g', 'Zero gravity', 'Motion', 'gravity vanishes: objects and the subject drift upward and tumble slowly', 'everything floating in zero gravity, objects drifting mid-air'),
  E('freeze', 'Time freeze', 'Dynamic', 'time freezes around the subject while only they keep moving, dust and drops hanging in the air', 'time frozen: droplets and debris suspended in mid-air around the subject'),
];
