// Ad formats for Ad Studio (the local Click-to-Ad). Deterministic shot lists —
// they work with no LLM; with Ollama running, the director can refine the copy.
// Each shot: still prompt (Flux 3 composes the product from its reference
// photo), motion prompt (camera move from the 80-move library), optional spoken
// line (MiniMax H3 voices + lip-syncs it), and a length in seconds.

import { motionText } from './cinema.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export const TONES = {
  energetic: { label: 'Energetic', light: 'bright natural daylight, punchy saturated colors', pace: 'fast, upbeat' },
  premium: { label: 'Calm premium', light: 'soft diffused studio light, muted luxurious tones, shallow depth of field', pace: 'slow, elegant' },
  funny: { label: 'Playful / funny', light: 'bright cheerful light, colorful backdrop', pace: 'snappy, comedic' },
  cozy: { label: 'Warm & cozy', light: 'warm golden lamp light, soft shadows', pace: 'gentle, intimate' },
};

const move = (id) => `${cap(motionText(id))}.`;

/** @returns {{title, still, motion, dialogue, seconds}[]} */
export const AD_FORMATS = {
  ugc: {
    label: '🤳 UGC testimonial', blurb: 'A real-person talking-to-camera review with the product in hand. Hook → problem → demo → result → CTA.',
    shots: (p) => [
      { title: 'Hook', seconds: 4, still: `Selfie-style vertical video frame of a friendly ordinary person in a lived-in home, holding up the product (${p.name}) toward the camera with a surprised smile, ${p.tone.light}`,
        motion: `${move('selfie')} The person says the line to camera with natural expressions and small hand gestures, holding the product up.`, dialogue: `Okay, I did not expect ${p.name} to be this good.`, talk: true },
      { title: 'Problem', seconds: 4, still: `The same person at home looking mildly frustrated while talking to the camera, ${p.tone.light}`,
        motion: `${move('handheld')} They shrug and gesture as they explain the problem.`, dialogue: p.problem ? `${p.problem}` : `I was so tired of settling for something that just didn't work.`, talk: true },
      { title: 'Demo', seconds: 5, still: `Close-up of hands using the product (${p.name}), clearly showing its design, label and details, ${p.tone.light}`,
        motion: `${move('slow-push')} Hands demonstrate the product smoothly.`, dialogue: '' },
      { title: 'Result', seconds: 4, still: `The same person smiling happily at the camera, product in hand, ${p.tone.light}`,
        motion: `${move('handheld')} They nod and smile genuinely.`, dialogue: p.benefit ? `${p.benefit}` : `Honestly, it just works, and I use it every single day.`, talk: true },
      { title: 'Call to action', seconds: 4, still: `The same person pointing toward the lower part of the frame, holding the product, big warm smile, ${p.tone.light}`,
        motion: `${move('static-breath')} They point down and wink at the camera.`, dialogue: p.cta, talk: true },
    ],
  },
  unboxing: {
    label: '📦 Unboxing', blurb: 'Hands open the package, reveal and react. Great for physical products.',
    shots: (p) => [
      { title: 'The package', seconds: 4, still: `Top-down shot of a sealed package for ${p.name} on a clean table, ${p.tone.light}`, motion: `${move('top-down')} A hand reaches in and starts to open the box.`, dialogue: '' },
      { title: 'Opening', seconds: 4, still: `Close-up of hands lifting the lid of the box to reveal tissue paper and the product (${p.name}) inside, ${p.tone.light}`, motion: `${move('dolly-in')} The lid lifts slowly.`, dialogue: '' },
      { title: 'The reveal', seconds: 5, still: `Hands lifting the product (${p.name}) out of its box, perfectly lit, details and label clearly visible, ${p.tone.light}`, motion: `${move('orbit-cw')} The product is turned slowly in the hands.`, dialogue: '' },
      { title: 'Reaction', seconds: 4, still: `A person smiling with delight holding the product (${p.name}) next to their face, ${p.tone.light}`, motion: `${move('slow-push')} They react with a delighted smile.`, dialogue: `Oh wow. Okay, ${p.name} is gorgeous.`, talk: true },
      { title: 'Call to action', seconds: 3, still: `Clean hero shot of the product (${p.name}) centered on a plain surface with soft shadow, ${p.tone.light}`, motion: `${move('dolly-in')}`, dialogue: p.cta },
    ],
  },
  hero: {
    label: '🎬 Product hero / TV spot', blurb: 'Cinematic beauty shots, lifestyle moment and a clean end card. No people required.',
    shots: (p) => [
      { title: 'Macro beauty', seconds: 4, still: `Extreme macro beauty shot of ${p.name}, textures and craftsmanship in tack-sharp detail, droplets and highlights, ${p.tone.light}`, motion: `${move('macro-dive')}`, dialogue: '' },
      { title: 'Hero turn', seconds: 4, still: `${p.name} floating on a seamless gradient backdrop, dramatic rim light, subtle reflections, premium product photography, ${p.tone.light}`, motion: `${move('orbit-cw')}`, dialogue: '' },
      { title: 'Lifestyle', seconds: 5, still: `Aspirational lifestyle scene where ${p.name} is naturally used by a stylish person in a beautiful real-world setting, ${p.tone.light}`, motion: `${move('steadicam')}`, dialogue: '' },
      { title: 'Detail', seconds: 3, still: `Close-up of the product's most distinctive feature, ${p.name}, crisp focus, shallow depth of field, ${p.tone.light}`, motion: `${move('slide-parallax')}`, dialogue: '' },
      { title: 'End card', seconds: 4, still: `Minimal end card: ${p.name} centered on a clean backdrop with generous empty space around it, soft shadow, ${p.tone.light}`, motion: `${move('dolly-in')}`, dialogue: p.cta },
    ],
  },
  demo: {
    label: '🛠 How-to / demo', blurb: 'Show it working in three clear steps, then the payoff.',
    shots: (p) => [
      { title: 'What it is', seconds: 4, still: `Clean tabletop shot of ${p.name} with a hand pointing at it, bright even light, ${p.tone.light}`, motion: `${move('dolly-in')} A hand gestures toward the product.`, dialogue: `Here's ${p.name}, and here's how it works.` },
      { title: 'Step one', seconds: 4, still: `Close-up of hands starting to use ${p.name}, step one of the process clearly visible, ${p.tone.light}`, motion: `${move('slow-push')}`, dialogue: '' },
      { title: 'Step two', seconds: 4, still: `Close-up of hands continuing to use ${p.name}, the key feature in action, ${p.tone.light}`, motion: `${move('track-side')}`, dialogue: '' },
      { title: 'Payoff', seconds: 4, still: `The satisfying finished result from using ${p.name}, shown clearly with the product beside it, ${p.tone.light}`, motion: `${move('orbit-cw')}`, dialogue: p.benefit || '' },
      { title: 'Call to action', seconds: 3, still: `Hero shot of ${p.name} on a clean backdrop with space for text, ${p.tone.light}`, motion: `${move('dolly-in')}`, dialogue: p.cta },
    ],
  },
};
