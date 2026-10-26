// Character names in prompts: write "@Harvey" and the app links the name to that character's reference picture.
// At generate time every @Name becomes "Name (the person from image N)" with N = that picture's place in the reference strip
// (the picture is added to the strip if it is not there yet), so numbering never has to be done by hand.

export const charName = (a) => String(a?.meta?.name || '').split(/[,.(]/)[0].trim().slice(0, 30);

/** The named characters in the library (first one wins when two share a name). */
export function characterList(assets) {
  const seen = new Set();
  const out = [];
  for (const a of assets || []) {
    if (a.kind !== 'character' || !a.blob) continue;
    const name = charName(a);
    if (name.length < 2 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, asset: a });
  }
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const regexFor = (chars) => (chars.length ? new RegExp(`@(${chars.map((c) => esc(c.name)).sort((a, b) => b.length - a.length).join('|')})(?![\\w])`, 'gi') : null);

/** @words in the prompt that match no character (for a gentle warning). */
export function unknownMentions(prompt, chars) {
  const re = regexFor(chars);
  const known = re ? String(prompt || '').replace(re, '') : String(prompt || '');
  return [...known.matchAll(/(?:^|\s)@([A-Za-z][\w-]{1,29})/g)].map((m) => m[1]);
}

/**
 * Turn @Name into text the model understands and make sure the right pictures are in the strip.
 * refs: [{id, name, blob, char?}] (the current strip). Returns { prompt, refs, used: [names] }.
 */
export function resolveMentions(prompt, refs, chars, newId) {
  const re = regexFor(chars);
  const text = String(prompt || '');
  if (!re || !re.test(text)) return { prompt: text, refs, used: [] };
  re.lastIndex = 0;
  const next = [...refs];
  const pos = {};            // lowercase name -> image number
  const said = new Set();
  const out = text.replace(re, (_, nm) => {
    const c = chars.find((x) => x.name.toLowerCase() === nm.toLowerCase());
    if (!c) return nm;
    const key = c.name.toLowerCase();
    if (!pos[key]) {
      let i = next.findIndex((r) => r.blob === c.asset.blob || r.char === key);
      if (i < 0) { next.push({ id: newId(), name: c.asset.name || c.name, blob: c.asset.blob, char: key }); i = next.length - 1; }
      pos[key] = i + 1;
    }
    if (said.has(key)) return c.name;
    said.add(key);
    return `${c.name} (the person from image ${pos[key]})`;
  });
  return { prompt: out, refs: next, used: Object.keys(pos) };
}
