// Edit Studio tool library — the local counterparts of Higgsfield's Edit
// Image / Apps (inpaint, relight, try-on, product placement, headshot, skin
// enhancer, mixed-media styles ...). Each tool compiles a Flux 3 instruction
// edit: image 1 is always the source; extra reference slots become image 2+.

import { LIGHTING, FILM_LOOKS, EFFECTS } from './cinema.js';

export const STYLE_PRESETS = [
  ['Oil painting', 'a classical oil painting with visible brush strokes and rich impasto texture'],
  ['Watercolor', 'a soft watercolor painting with bleeding pigments and paper texture'],
  ['Anime', 'a high-quality anime illustration with clean linework and cel shading'],
  ['Studio Ghibli', 'a hand-painted Studio Ghibli-style animation frame with lush painterly backgrounds'],
  ['Pixar 3D', 'a stylized Pixar-like 3D animated render with soft subsurface lighting'],
  ['Comic book', 'a halftone comic book panel with bold black inks and flat colors'],
  ['Pencil sketch', 'a detailed graphite pencil sketch on paper with cross-hatching'],
  ['Ink wash', 'a traditional East-Asian ink wash painting with expressive brushwork'],
  ['Claymation', 'a stop-motion claymation scene with fingerprint-textured clay figures'],
  ['Paper cutout', 'layered paper-cutout collage art with drop shadows between layers'],
  ['LEGO bricks', 'a scene built entirely from toy plastic building bricks'],
  ['Pixel art', 'detailed 16-bit pixel art with a limited palette'],
  ['Low-poly 3D', 'a low-poly 3D render with flat-shaded geometric facets'],
  ['Neon cyberpunk', 'a neon-drenched cyberpunk scene with magenta and cyan glow'],
  ['Vaporwave', 'vaporwave aesthetic with pastel gradients, grids and statues'],
  ['Stained glass', 'a stained glass window with lead lines and luminous colored panes'],
  ['Embroidery', 'a hand-embroidered textile with visible stitches and thread texture'],
  ['Cross-stitch', 'a cross-stitch pattern on aida cloth'],
  ['Origami', 'a scene folded from origami paper'],
  ['Wood carving', 'a relief carved from wood with chisel marks'],
  ['Marble statue', 'a classical marble sculpture, polished and veined'],
  ['Blueprint', 'a technical blueprint drawing with white lines on blue paper'],
  ['Retro 80s poster', 'a retro 1980s movie poster illustration with airbrushed gradients'],
  ['Film noir', 'a high-contrast black-and-white film noir still'],
  ['Polaroid', 'an instant Polaroid photograph with faded color and a white border'],
  ['Double exposure', 'a double-exposure photograph blending the subject with a forest landscape'],
  ['Risograph', 'a two-color risograph print with grainy overprint'],
  ['Ukiyo-e', 'a Japanese ukiyo-e woodblock print with flat colors and bold outlines'],
  ['Art deco', 'an art deco poster with geometric gold ornament'],
  ['Surreal collage', 'a surreal vintage collage with cut-out magazine elements'],
].map(([label, text]) => ({ label, text }));

const lightingOpts = LIGHTING.filter((l) => l.id !== 'none').map((l) => ({ label: l.label, text: l.text }));
const gradeOpts = FILM_LOOKS.filter((l) => l.id !== 'none').map((l) => ({ label: l.label, text: l.text }));
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Tool shape: {id, icon, label, blurb, needsText, placeholder, mask:
 * 'optional'|'required'|'none', refs: [{label, required}], options?: {label,
 * items:[{label,text}]}, build(userText, optionText, hasRef) -> instruction} */
export const EDIT_TOOLS = [
  {
    id: 'free', icon: '🪄', label: 'Free edit', blurb: 'Describe any change. Add a brush mask to limit it to a region.',
    needsText: true, placeholder: 'e.g. make it a rainy night, add neon reflections', mask: 'optional', refs: [],
    build: (t) => `${t.trim()}. Keep everything else the same.`,
  },
  {
    id: 'inpaint', icon: '🖌️', label: 'Inpaint / replace', blurb: 'Paint over the area, say what goes there. Only the painted region changes.',
    needsText: true, placeholder: 'what should appear in the painted area', mask: 'required',
    refs: [{ label: 'Optional reference for the new content', required: false }],
    build: (t, o, hasRef) => `Replace the marked region with ${t.trim()}${hasRef ? ', matching the object shown in the second image' : ''}. Blend seamlessly with the lighting, perspective and style of the rest of the image. Keep everything else identical.`,
  },
  {
    id: 'remove', icon: '🧽', label: 'Remove object', blurb: 'Paint over what to erase — the background is rebuilt behind it.',
    needsText: false, placeholder: 'optional: name the object', mask: 'required', refs: [],
    build: (t) => `Remove ${t.trim() || 'the marked object'} completely and fill the space with a natural continuation of the surrounding background. Keep everything else identical.`,
  },
  {
    id: 'effects', icon: '✨', label: 'Effects', blurb: 'One-click looks — melting, burning, floating, giant, hologram… (the same presets are in the video prompt picker).',
    needsText: false, mask: 'optional', refs: [],
    options: { label: 'Effect', items: EFFECTS.map((e) => ({ label: `${e.label} · ${e.cat}`, text: e.edit })) },
    build: (t, o) => `${o.charAt(0).toUpperCase() + o.slice(1)}. Keep the subject's identity and the overall composition recognisable.${t.trim() ? ' ' + t.trim() : ''}`,
  },
  {
    id: 'relight', icon: '💡', label: 'Relight', blurb: 'Change the lighting of the whole shot.',
    needsText: false, mask: 'none', refs: [], options: { label: 'Lighting', items: lightingOpts },
    build: (t, o) => `Relight the scene with ${o}. Keep the subject, composition and colors of objects the same; only change the lighting, shadows and atmosphere.${t.trim() ? ' ' + t.trim() : ''}`,
  },
  {
    id: 'grade', icon: '🎞️', label: 'Color grade', blurb: 'Apply a film stock / color look.',
    needsText: false, mask: 'none', refs: [], options: { label: 'Look', items: gradeOpts },
    build: (t, o) => `Apply a color grade: ${o}. Keep the composition and content identical.`,
  },
  {
    id: 'outfit', icon: '👗', label: 'Virtual try-on', blurb: 'Dress the person in a garment from a reference photo (or describe one).',
    needsText: false, mask: 'optional', refs: [{ label: 'Garment photo', required: false }],
    placeholder: 'or describe the outfit',
    build: (t, o, hasRef) => (hasRef
      ? `Dress the person in image 1 in the garment shown in image 2. Keep their face, pose, body and the background identical.${t.trim() ? ' ' + t.trim() : ''}`
      : `Change the person's outfit to ${t.trim()}. Keep their face, pose, body and the background identical.`),
  },
  {
    id: 'product', icon: '🛍️', label: 'Product placement', blurb: 'Place a product naturally into a scene (or in a hand).',
    needsText: false, mask: 'optional', refs: [{ label: 'Product photo', required: true }],
    placeholder: 'where/how, e.g. held in her right hand, on the table',
    build: (t) => `Place the product from image 2 into image 1${t.trim() ? ', ' + t.trim() : ' in a natural spot'}. Match the scene's lighting, perspective, reflections and shadows so it looks photographed in place. Keep the product's logo, shape and colors exact. Keep everything else the same.`,
  },
  {
    id: 'bg', icon: '🏞️', label: 'Replace background', blurb: 'New environment, same subject.',
    needsText: true, placeholder: 'the new background, e.g. a rainy Tokyo street at night', mask: 'none',
    refs: [{ label: 'Optional background reference', required: false }],
    build: (t, o, hasRef) => (hasRef
      ? 'Keep the subject of image 1 exactly as is and place them in the environment shown in image 2. Match lighting and perspective.'
      : `Keep the subject exactly as is and replace the background with ${t.trim()}. Match lighting, shadows and perspective so the subject belongs in the scene.`),
  },
  {
    id: 'character', icon: '🧑', label: 'Character swap', blurb: 'Swap one person for a character from a reference photo. With several people, paint over the one to replace and/or say who.',
    needsText: false, placeholder: 'Which person? e.g. "the man on the left", "the woman in the red coat"', mask: 'optional', refs: [{ label: 'New character photo', required: true }],
    build: (t, o, hasRef, hasMask) => {
      const who = t.trim() ? `the ${t.trim().replace(/^the\s+/i, '')}` : hasMask ? 'the person in the highlighted area' : 'the person';
      return `Replace ${who} in image 1 with the person from image 2, keeping image 2's face, hair and identity exactly, while preserving the pose, framing, clothing placement, lighting and background of image 1.${t.trim() || hasMask ? ' Leave every other person in image 1 completely unchanged.' : ''}`;
    },
  },
  {
    id: 'style', icon: '🎨', label: 'Mixed media / style', blurb: '30 art styles — keep the content, change the medium.',
    needsText: false, mask: 'none', refs: [], options: { label: 'Style', items: STYLE_PRESETS },
    build: (t, o) => `Redraw this image as ${o}. Keep the composition, subjects and poses identical.`,
  },
  {
    id: 'headshot', icon: '📸', label: 'AI headshot', blurb: 'Selfie → professional portrait.',
    needsText: false, mask: 'none', refs: [],
    options: {
      label: 'Look',
      items: [
        { label: 'Corporate grey backdrop', text: 'a clean mid-grey studio backdrop, wearing a tailored dark blazer and crisp shirt' },
        { label: 'Warm outdoor bokeh', text: 'a softly blurred sunlit outdoor background, smart-casual clothing' },
        { label: 'Creative studio', text: 'a colored seamless studio backdrop with dramatic rim light' },
        { label: 'LinkedIn white', text: 'a bright white backdrop, business attire, soft even light' },
      ],
    },
    build: (t, o) => `Turn this photo into a professional studio headshot with ${o}. Keep the person's face, identity, hair and expression exactly the same. Soft flattering key light, sharp eyes, natural skin.`,
  },
  {
    id: 'skin', icon: '✨', label: 'Skin enhancer', blurb: 'Natural retouch — pores and texture kept.',
    needsText: false, mask: 'optional', refs: [],
    build: () => 'Retouch the skin so it looks naturally healthy and even, with realistic pores and fine skin texture still visible, remove blemishes and shine. Do not change the identity, face shape, pose, clothing or background.',
  },
  {
    id: 'expression', icon: '😀', label: 'Expression / age', blurb: 'Change expression or age, keep identity.',
    needsText: false, mask: 'none', refs: [],
    options: {
      label: 'Change',
      items: [
        { label: 'Smile', text: 'give the person a warm natural smile' },
        { label: 'Laugh', text: 'make the person laugh joyfully' },
        { label: 'Serious', text: 'give the person a serious, intense expression' },
        { label: 'Surprised', text: 'make the person look genuinely surprised' },
        { label: 'Older (+30 yrs)', text: 'age the person by thirty years, with natural wrinkles and grey hair' },
        { label: 'Younger (-20 yrs)', text: 'make the person twenty years younger' },
        { label: 'Child version', text: 'show the person as a child of about eight' },
      ],
    },
    build: (t, o) => `${upper(o)}. Keep the identity, pose, clothing and background identical.`,
  },
  {
    id: 'restore', icon: '🕰️', label: 'Restore / colorize', blurb: 'Repair old photos, add color.',
    needsText: false, mask: 'none', refs: [],
    options: {
      label: 'Do',
      items: [
        { label: 'Restore + colorize', text: 'Restore this old photograph: remove scratches, dust and fading, sharpen details and add natural realistic color' },
        { label: 'Restore only', text: 'Restore this old photograph: remove scratches, dust and fading and sharpen details, keeping it black and white' },
        { label: 'Colorize only', text: 'Colorize this black and white photograph with natural, historically plausible colors' },
      ],
    },
    build: (t, o) => `${o}. Keep the content and composition identical.`,
  },
  {
    id: 'angle', icon: '📐', label: 'New camera angle', blurb: 'Re-shoot the same scene from another angle.',
    needsText: false, mask: 'none', refs: [],
    options: {
      label: 'Angle',
      items: [
        { label: 'Low angle', text: 'a low-angle shot looking up at the subject' },
        { label: 'High angle', text: 'a high-angle shot looking down on the subject' },
        { label: 'Close-up', text: 'a close-up of the main subject' },
        { label: 'Wide shot', text: 'a wide shot revealing the whole environment' },
        { label: 'From behind', text: 'the same scene seen from behind the subject' },
        { label: 'Profile (side)', text: 'the same scene seen from the side, in profile' },
        { label: 'Over-the-shoulder', text: 'an over-the-shoulder framing' },
        { label: "Bird's-eye", text: "an overhead bird's-eye view" },
      ],
    },
    build: (t, o) => `Show the same scene and subjects from ${o}. Keep identity, clothing, setting and lighting consistent.`,
  },
];
