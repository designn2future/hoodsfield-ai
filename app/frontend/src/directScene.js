// Stage directions -> positioned, posed, aimed and framed people. The plan comes from a local LLM when one is running
// (/api/scene/direct) or from the built-in parser below, and the same applier turns either into the 3D scene.
import * as THREE from 'three';
import { POSES, HAND_POSES } from './three/Figure.js';
import { FURN_TYPES, FURN } from './three/furniture.js';
import { ARM_ACTIONS, LEG_ACTIONS, applyLimb, sitOn } from './limbs.js';

const NOUNS = {
  man: 'male', men: 'male', guy: 'male', guys: 'male', boy: 'male', boys: 'male', gentleman: 'male', groom: 'male', king: 'male', prince: 'male', waiter: 'male', father: 'male', dad: 'male',
  woman: 'female', women: 'female', girl: 'female', girls: 'female', lady: 'female', ladies: 'female', bride: 'female', queen: 'female', princess: 'female', waitress: 'female', mother: 'female', mom: 'female',
  person: null, people: null, child: null, kid: null, detective: null, officer: null, cop: null, soldier: null, doctor: null, nurse: null, chef: null, teacher: null,
  student: null, stranger: null, couple: 'pair', friends: null, monk: null, samurai: null, ninja: null, knight: null, wizard: null, pilot: null, astronaut: null,
};
const COUNTS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, both: 2 };
const STOP = 'and|with|who|that|in|on|at|is|are|the|a|an|to|of|by|while|as|then|beside|near|behind|from|looking|standing|sitting|walking|toward|towards|into|over|under|next|facing|watching|crouches|crouching|runs|running|stands|sits|walks|points|pointing|stares|staring|chases|chasing';
const NOUN_RE = new RegExp(`\\b(a|an|the|one|two|three|four|both|\\d)?\\s*((?:(?!(?:${STOP})\\b)[a-z-]+\\s+){0,2}?)(${Object.keys(NOUNS).join('|')})\\b`, 'g');
const STOP_ADJ = new RegExp(`^(${STOP})$`);
const SINGULAR = { men: 'man', women: 'woman', guys: 'guy', boys: 'boy', girls: 'girl', ladies: 'lady', people: 'person', friends: 'friend' };

const PRESET_WORDS = [   // [regex, preset]
  [/\b(sits?|sitting|seated|sat|on a (?:chair|couch|sofa|bench)|on the (?:chair|couch|sofa|bench))\b/, 'sit'],
  [/\b(runs?|running|sprints?|sprinting|fleeing|flees|chas\w+)\b/, 'run'],
  [/\b(walks?|walking|strolls?|strolling|striding|approaches|approaching)\b/, 'walk'],
  [/\b(crouch\w*|squat\w*|ducking|hiding low)\b/, 'crouch'],
  [/\b(kneel\w*|on (?:her|his|their) knees|proposes|proposing)\b/, 'kneel'],
  [/\b(hands? on (?:her|his|their) hips|akimbo)\b/, 'hips'],
  [/\b(arms? (?:are )?(?:crossed|folded)|crosses? (?:her|his|their) arms|folded arms|crossed arms)\b/, 'crossed'],
  [/\b(hands? up|raises? (?:her|his|their) hands|surrender\w*|celebrat\w*|cheer\w*|arms? (?:raised|up))\b/, 'handsup'],
  [/\b(fights?|fighting|boxing|punch\w*|combat|fighting stance|guard up|martial)\b/, 'guard'],
  [/\b(phone|calling|on the phone|texting)\b/, 'phone'],
  [/\b(points?|pointing|gestur\w+ at)\b/, 'point'],
  [/\b(reach\w*)\b/, 'reach'],
  [/\b(stands?|standing|waiting|leaning)\b/, 'stand'],
];

const cap = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const FURN_WORDS = [[/\b(?:l[- ](?:section|shape|shaped|sectional)\s*(?:couch|sofa)?|sectional|corner (?:couch|sofa))\b/, 'sectional'], [/\b(couch|sofa|settee|loveseat)\b/, 'couch'], [/\barmchair\b/, 'armchair'], [/\b(bench)\b/, 'bench'], [/\bstool\b/, 'stool'], [/\b(bed)\b/, 'bed'], [/\bchair\b/, 'chair']];
const furnIn = (text) => { for (const [re, t] of FURN_WORDS) if (re.test(text)) return t; return null; };

const armAction = (text) => {
  if (/(over|along|across|on|behind) the (top|back)( of)?|along the (back|top)|over the back|on the back of|along the backrest/.test(text)) return 'back';
  if (/armrest|arm rest/.test(text)) return 'rest';
  if (/behind (?:her|his|their) head/.test(text)) return 'head';
  if (/on (?:her|his|their) hip/.test(text)) return 'hip';
  if (/(?:in|on) (?:her|his|their) (?:lap|knee)/.test(text)) return 'lap';
  if (/raised|above (?:her|his|their) head|in the air|waving|up high/.test(text)) return 'up';
  if (/outstretched|stretched out|out to the side|extended|spread/.test(text)) return 'out';
  if (/forward|reaching|reaches|toward/.test(text)) return 'forward';
  if (/down|relaxed|at (?:her|his|their) side/.test(text)) return 'down';
  return null;
};
const legAction = (text) => {
  if (/slightly bent|resting on the (?:couch|sofa|seat|cushions?|chaise)|rests on the (?:couch|sofa|seat)|lying on the (?:couch|sofa)/.test(text) && !/sideways|knee up|foot up/.test(text)) return 'bent';
  if (/crossed|over (?:her|his|their) (?:other )?knee|ankle on/.test(text)) return 'cross';
  if (/reclin\w*|lying|laid|stretched (?:out )?(?:along|across|on)|extended (?:along|across|on)|sideways/.test(text)) return 'side';
  if (/propped|bent|knee up|foot up|tucked|curled|raised|up on|on the (?:couch|sofa|seat|bed|bench|chair)/.test(text)) return 'up';
  if (/stretched out|straight out|extended|out in front/.test(text)) return 'extended';
  return null;
};

/** "her right arm stretched along the back of the couch", "left leg propped up" -> {armR: 'back', legL: 'up'} */
function parseLimbs(clause) {
  const out = {};
  const free = [];
  const re = /\b(right|left)\s+(arm|hand|leg|foot|knee)\b/g;
  const hits = [];
  let m;
  while ((m = re.exec(clause))) hits.push({ at: m.index, tag: m[1] === 'right' ? 'R' : 'L', part: m[2] });
  hits.forEach((h, i) => {
    const text = clause.slice(h.at, hits[i + 1] ? hits[i + 1].at : h.at + 90);
    if (/leg|foot|knee/.test(h.part)) { const l = legAction(text); if (l) out[`leg${h.tag}`] = l; }
    else { const a = armAction(text); if (a) out[`arm${h.tag}`] = a; }
  });
  // "one leg ..., the other leg ...", "one arm ..., the other hand ...", or just "her arm ...": no side given, so the scene decides later
  const plain = clause.replace(/\b(right|left)\s+(arm|hand|leg|foot|knee)\b/g, ' _ ');
  const re2 = /\b(?:one|the other|her|his|their|an)\s+(arm|hand|leg|foot)\b/g;
  const hits2 = [];
  while ((m = re2.exec(plain))) hits2.push({ at: m.index, part: m[1] });
  hits2.forEach((h, i) => {
    const text = plain.slice(h.at, hits2[i + 1] ? hits2[i + 1].at : h.at + 90);
    if (/leg|foot/.test(h.part)) { const l = legAction(text); if (l) free.push({ kind: 'leg', action: l }); }
    else if (!/^(?:her|his|their) (?:arm|hand)s? (?:are|is) (?:crossed|folded)/.test(text)) { const a = armAction(text); if (a) free.push({ kind: 'arm', action: a }); }
  });
  // a leg "resting on the floor" is the default; keep only meaningful extras
  const meaningful = free.filter((f) => !(f.kind === 'leg' && f.action === 'down'));
  return { limbs: out, free: meaningful.filter((f) => !(f.kind === 'arm' && Object.keys(out).some((k) => k.startsWith('arm')))) };
}

export function parseDirection(text, existing = []) {
  const rawLower = text.toLowerCase().replace(/\s+/g, ' ');
  const camSentences = [...rawLower.matchAll(/(?:^|[.;]\s*)((?:the\s+)?camera\b[^.;]*)/g)].map((m) => m[1]);
  const t = ` ${rawLower.replace(/(?:^|(?<=[.;]))\s*(?:the\s+)?camera\b[^.;]*[.;]?/g, ' ')} `;
  const actors = [];
  let m;
  NOUN_RE.lastIndex = 0;
  while ((m = NOUN_RE.exec(t))) {
    const [full, det, adj, noun] = m;
    const prevIdx = m.index;
    if (/\b(of|toward|at|to|from|behind|beside|near)\s*$/.test(t.slice(Math.max(0, prevIdx - 12), prevIdx)) && actors.length) {
      // a reference ("looks at the man") not a new actor, unless it introduces a counted group
      if (!det || det === 'the') continue;
    }
    let count = COUNTS[det] ?? (/^\d$/.test(det || '') ? +det : 1);
    if (/^(men|women|guys|boys|girls|ladies|people|friends)$/.test(noun) && count === 1 && !det) count = 2;
    const base = SINGULAR[noun] || noun;
    const gender = NOUNS[noun];
    const adjWord = adj.trim().split(/\s+/).filter((w) => w && !STOP_ADJ.test(w)).pop();
    const mention = { start: m.index, end: m.index + full.length };
    if (gender === 'pair') {
      actors.push({ noun: 'man', gender: 'male', label: 'man', ...mention }, { noun: 'woman', gender: 'female', label: 'woman', ...mention });
      continue;
    }
    // the same noun again with "the" refers back to an existing actor
    if (det === 'the' && actors.some((a) => a.noun === base)) continue;
    for (let i = 0; i < count; i++) actors.push({ noun: base, gender: gender || null, label: adjWord && count === 1 ? `${adjWord} ${base}` : base, ...mention });
  }
  const actorsFound = actors.length > 0;
  if (!actors.length) {
    // no nouns: keep whoever is already in the scene
    existing.forEach((e) => actors.push({ noun: e.label, gender: e.gender, label: e.label, start: 0, end: 0 }));
    if (!actors.length) actors.push({ noun: 'person', gender: 'male', label: 'person', start: 0, end: 0 });
  }
  const dup = {};
  actors.forEach((a) => { dup[a.label] = (dup[a.label] || 0) + 1; });
  const seen = {};
  actors.forEach((a) => { if (dup[a.label] > 1) { seen[a.label] = (seen[a.label] || 0) + 1; a.label = `${a.label} ${seen[a.label]}`; } });
  actors.forEach((a, i) => { a.gender = a.gender || (i % 2 ? 'female' : 'male'); a.idx = i; });

  // Attribute every phrase to its grammatical subject: split at commas / "while" / "then", a segment's subjects are the actors it
  // names that are not objects of a preposition ("behind a seated man"), a bare pronoun picks by gender, and a participle
  // ("pointing at him") continues the previous subject. Each actor also keeps their own mention (adjectives such as "seated").
  actors.forEach((a) => { a.clause = t.slice(a.start, a.end); });
  const OBJ_PREP = /(?:\bat|\bto|toward|towards|behind|beside|near|from|of|than|for|around|against|before)\s+(?:the\s+|a\s+|an\s+)?$/;
  const cuts = [0];
  const cutRe = /[.;,]|\bwhile\b|\bthen\b|\bas\b/g;
  let cm;
  while ((cm = cutRe.exec(t))) cuts.push(cm.index);
  cuts.push(t.length);
  let subjects = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const s0 = cuts[k], s1 = cuts[k + 1];
    const seg = t.slice(s0, s1);
    if (!seg.trim() || /^[.;,\s]*$/.test(seg)) continue;
    const inSeg = actors.filter((a) => a.start >= s0 && a.start < s1);
    const subs = inSeg.filter((a) => !OBJ_PREP.test(t.slice(Math.max(0, a.start - 14), a.start)));
    if (subs.length) subjects = subs;
    else {
      const pron = /\b(he|she|they)\b/.exec(seg);
      if (pron) {
        const g = pron[1] === 'he' ? 'male' : pron[1] === 'she' ? 'female' : null;
        const hit = g ? actors.find((a) => a.gender === g && !subjects.includes(a)) || actors.find((a) => a.gender === g) : null;
        if (hit) subjects = [hit];
      }
    }
    // objects of a preposition contribute only their noun here ("behind a seated man" must not make the subject seated)
    let text = seg;
    inSeg.filter((a) => !subs.includes(a)).forEach((a) => { text = text.replace(t.slice(a.start, a.end).trim(), ` ${a.noun}`); });
    subjects.forEach((a) => { a.clause += ` ${text}`; });
  }

  const refTo = (word, self) => {
    const w = word.toLowerCase();
    const candidates = actors.filter((x) => x !== self);
    const byNoun = candidates.find((x) => w.includes(x.noun) || x.label.split(' ').some((p) => p === w));
    if (byNoun) return byNoun;
    if (/\b(him|his|he)\b/.test(w)) return candidates.find((x) => x.gender === 'male') || candidates[0];
    if (/\b(her|she)\b/.test(w)) return candidates.find((x) => x.gender === 'female') || candidates[0];
    return candidates[0];
  };

  const people = actors.map((a) => ({ label: a.label, gender: a.gender, preset: 'relaxed', hands: ['relaxed', 'relaxed'], faces: 'camera', looks_at: null, points_at: null, x: null, z: 0, _a: a }));
  const all = t;
  const n = people.length;
  people.forEach((p, i) => {
    const c = p._a.clause;
    for (const [re, preset] of PRESET_WORDS) if (re.test(c)) { p.preset = preset; break; }
    p.sits_on = furnIn(c) && (p.preset === 'sit' || /\b(on|in|at) (?:a|the) (?:couch|sofa|chair|armchair|bench|stool|bed)\b/.test(c)) ? furnIn(c) : null;
    if (p.sits_on && p.preset !== 'sit') p.preset = 'sit';
    if (p.preset === 'sit' && !p.sits_on) p.sits_on = 'chair';
    const pl = parseLimbs(c);
    p.limbs = pl.limbs; p.free = pl.free;
    const rc = /\breclin(?:ed|ing)\b|\blounging\b|\blying back\b|\bleaning back\b|\bsprawled\b/.exec(c);
    if (rc && !/\b(?:leg|foot|knee|arm|hand)\b[^.]{0,30}$/.test(c.slice(0, rc.index))) p.recline = true;
    if (/\b(?:one|the|either) end of\b|\bat (?:one|the) end\b|\bon the end\b/.test(c)) p.slot = 'end';
    const wear = [...c.matchAll(/\b(?:wears?|wearing|dressed in|in)\s+((?:(?:an?|the|his|her)\s+)?(?:[a-z-]+\s+){0,3}?(?:suit|tuxedo|bikini|swimsuit|swimwear|dress|gown|shirt|t-shirt|blouse|jacket|coat|jeans|sweater|hoodie|uniform|skirt|lingerie|robe|pajamas|shorts|trousers|pants|blazer|armor|costume|tank top|cape|cloak|overalls|trench coat))\b/g)].map((w) => w[1]);
    if (wear.length) p.note = `wearing ${wear.join(' and ')}`;
    if (p.preset === 'point') p.hands = ['point', 'relaxed'];
    if (['crossed', 'hips', 'phone'].includes(p.preset)) p.hands = ['relaxed', 'relaxed'];
    if (p.preset === 'guard') p.hands = ['fist', 'fist'];
    if (p.preset === 'handsup') p.hands = ['open', 'open'];
    if (p.preset === 'run') p.hands = ['fist', 'fist'];
    const at = /(?:looks?|looking|stares?|staring|glares?|glaring|watch\w*|gazes?|gazing)\s+(?:right\s+)?(?:at|toward|towards|into)\s+(?:the\s+)?([a-z ]{2,24})/.exec(c);
    if (at) {
      if (/camera|lens|us|viewer|audience/.test(at[1])) { p.looks_at = 'camera'; p.faces = 'camera'; }
      else { const r = refTo(at[1], p._a); if (r) { p.looks_at = r.label; p.faces = r.label; } }
    }
    const pt = /(?:points?|pointing|gestur\w+)\s+(?:at|to|toward|towards)\s+(?:the\s+)?([a-z ]{2,24})/.exec(c);
    if (pt) {
      if (!['crouch', 'kneel', 'sit', 'walk', 'run', 'guard'].includes(p.preset)) p.preset = 'point';
      p.hands = ['point', 'relaxed'];
      if (/camera|lens|us|viewer/.test(pt[1])) p.points_at = 'camera';
      else { const r = refTo(pt[1], p._a); p.points_at = r ? r.label : null; if (r) { p.faces = r.label; p.looks_at = r.label; } }
    }
    const fc = /(?:facing|talk\w* (?:to|with)|speak\w* (?:to|with)|confront\w*|arguing with|toward|towards)\s+(?:the\s+)?([a-z ]{2,24})/.exec(c);
    if (fc && !at && !/camera|lens/.test(fc[1])) { const r = refTo(fc[1], p._a); if (r) p.faces = r.label; }
    if (/\baway from (?:the )?camera|back to (?:the )?camera|from behind\b/.test(c)) p.faces = 'away';
    if (/\b(?:looking|looks|facing|stares|staring) (?:at|into|toward) (?:the )?(?:camera|lens)\b/.test(c)) { p.looks_at = 'camera'; p.faces = 'camera'; }
    if (/\bprofile\b/.test(c)) p.faces = /\bleft\b/.test(c) ? 'left' : 'right';
    if (/\b(on the left|left side|far left|stage left)\b/.test(c)) p.x = -1.6;
    if (/\b(on the right|right side|far right|stage right)\b/.test(c)) p.x = 1.6;
    if (/\b(center|centre|middle)\b/.test(c)) p.x = 0;
    if (/\b(foreground|close to (?:the )?camera|up front)\b/.test(c)) p.z = 1.3;
    if (/\b(background|in the distance|far away|far behind)\b/.test(c)) p.z = -3;
    const rel = /(behind|in front of|to the left of|left of|to the right of|right of|beside|next to)\s+(?:the\s+)?([a-z ]{2,22})/.exec(c);
    if (rel) p._rel = { kind: rel[1], ref: refTo(rel[2], p._a)?.label };
  });

  // group relations over the whole text
  if (n >= 2 && /face to face|facing each other|across from each other|face each other|toward each other|confront each other|arguing|argue/.test(all)) {
    people[0].faces = people[1].label; people[1].faces = people[0].label;
    people[0].x = people[0].x ?? -1.0; people[1].x = people[1].x ?? 1.0;
  }
  if (n >= 2 && /back to back/.test(all)) {
    people[0].x = -0.35; people[1].x = 0.35; people[0].faces = 'left'; people[1].faces = 'right'; people[0].looks_at = null; people[1].looks_at = null;
  }
  // default horizontal spread, then relative placement
  people.forEach((p, i) => { if (p.x == null) p.x = +((i - (n - 1) / 2) * 1.5).toFixed(2); });
  people.forEach((p) => {
    if (!p._rel) return;
    const ref = people.find((q) => q.label === p._rel.ref); if (!ref) return;
    if (p._rel.kind === 'behind') { p.z = ref.z - 1.8; p.x = ref.x + 0.35; }
    else if (p._rel.kind === 'in front of') { p.z = ref.z + 1.4; p.x = ref.x - 0.3; p.in_front_of = ref.label; }
    else if (/left/.test(p._rel.kind)) { p.x = ref.x - 1.3; p.z = ref.z; }
    else if (/right/.test(p._rel.kind)) { p.x = ref.x + 1.3; p.z = ref.z; }
    else { p.x = ref.x + (p.x >= ref.x ? 1 : -1) * 1.0; p.z = ref.z; }
  });
  people.forEach((p) => { delete p._a; delete p._rel; });

  const camera = {};
  const camText = `${all} ${camSentences.join(' ')}`;
  if (/close[- ]?up|tight shot|portrait shot/.test(camText)) camera.lens = 85;
  else if (/wide shot|establishing|wide angle|wide-angle/.test(camText)) camera.lens = 24;
  if (/low[- ]angle|from below|looking up at/.test(camText)) { camera.height = 0.5; camera.pitch = 12; }
  else if (/high[- ]angle|from above|overhead|bird/.test(camText)) { camera.height = 3.6; camera.pitch = -22; }
  const cs = camSentences.join(' ');
  if (cs) {   // where the camera stands relative to the cast: "to the right of the couch", "quarter side view", "from behind"...
    const side = /\b(right)\b/.test(cs) ? 1 : /\b(left)\b/.test(cs) ? -1 : 0;
    let mag = 0;
    if (/from behind|behind (?:them|the)/.test(cs)) { camera.azimuth = 180; }
    else {
      if (/quarter|three[- ]quarter|3\/4|angled|slight/.test(cs)) mag = 40;
      else if (/side view|profile|from the side|90/.test(cs)) mag = 80;
      else if (side) mag = 40;
      if (mag) camera.azimuth = (side || 1) * mag;
    }
  }
  return { people, camera, source: 'built-in parser', fallback: !actorsFound };
}

/** Clamp / validate a plan from any source. */
export function sanitizePlan(plan) {
  const clean = (v) => String(v).replace(/_/g, ' ').replace(/^the\s+/i, '').trim();
  // a small model sometimes puts other things (the camera) in the people list; only real people count
  const raw = (plan.people || []).filter((p) => p && typeof p === 'object' && !p.camera && (p.label || p.gender || p.preset)).slice(0, 6);
  const people = raw.map((p, i) => ({
    label: clean(p.label || (p.gender === 'female' ? 'woman' : 'man')).slice(0, 28) || 'person',
    gender: p.gender === 'female' ? 'female' : 'male',
    preset: POSES[p.preset] ? p.preset : 'relaxed',
    hands: [0, 1].map((k) => (HAND_POSES.includes(p.hands?.[k]) ? p.hands[k] : 'relaxed')),
    x: cap(Number.isFinite(+p.x) ? +p.x : (i - (raw.length - 1) / 2) * 1.5, -5, 5),
    z: cap(Number.isFinite(+p.z) ? +p.z : 0, -8, 4),
    faces: clean(p.faces || 'camera'), looks_at: p.looks_at ? clean(p.looks_at) : null, points_at: p.points_at ? clean(p.points_at) : null,
    sits_on: FURN_TYPES.includes(p.sits_on) ? p.sits_on : (p.preset === 'sit' ? 'chair' : null),
    limbs: Object.fromEntries(Object.entries(p.limbs || {}).filter(([k, v]) => (k.startsWith('arm') ? ARM_ACTIONS[v] : LEG_ACTIONS[v]) && /^(arm|leg)[LR]$/.test(k))),
    free: (p.free || []).filter((f) => f && (f.kind === 'arm' ? ARM_ACTIONS[f.action] : f.kind === 'leg' ? LEG_ACTIONS[f.action] : false)),
    recline: !!p.recline, slot: p.slot === 'end' ? 'end' : null, in_front_of: p.in_front_of || null,
    height: p.height ? cap(+p.height, 1.0, 2.2) : null, hair: p.hair || null, note: p.note ? String(p.note).slice(0, 80) : '',
  }));
  const c = plan.camera || {};
  return {
    people,
    camera: {
      lens: c.lens ? cap(+c.lens, 14, 135) : null, height: c.height != null ? cap(+c.height, 0.2, 6) : null, pitch: c.pitch != null ? cap(+c.pitch, -60, 60) : null,
      azimuth: c.azimuth != null ? cap(+c.azimuth, -180, 180) : 0,
    },
    source: plan.source, model: plan.model,
  };
}

const headPoint = (it) => it.fig.root.localToWorld(new THREE.Vector3(0, 1.62, 0));

/** Resolve "one arm ..., the other hand ..." into real sides: arms "over the back" go toward the middle of the seat, the other arm takes the other side. */
function resolveFree(p, slot) {
  const out = { ...p.limbs };
  const toCenter = slot > 0.05 ? 'R' : slot < -0.05 ? 'L' : 'R';
  const other = (t) => (t === 'L' ? 'R' : 'L');
  (p.free || []).forEach((f) => {
    if (f.kind === 'arm') {
      const taken = ['L', 'R'].filter((t) => out[`arm${t}`]);
      const tag = f.action === 'back' ? toCenter : (taken.length ? other(taken[0]) : other(toCenter));
      if (!out[`arm${tag}`]) out[`arm${tag}`] = f.action;
    } else {
      const taken = ['L', 'R'].filter((t) => out[`leg${t}`]);
      const tag = taken.length ? other(taken[0]) : toCenter;
      if (!out[`leg${tag}`]) out[`leg${tag}`] = f.action;
    }
  });
  return out;
}

/** Put the plan on the stage. */
export function applyPlan(stage, rawPlan) {
  const plan = sanitizePlan(rawPlan);
  stage.items.filter((i) => i.auto === 'seat').forEach((i) => stage.remove(i.id, true));
  stage.items.forEach((i) => { if (i.kind === 'person') { i.sitsOn = null; i.limbText = {}; } });
  const existing = stage.items.filter((i) => i.kind === 'person');
  const claimed = new Set();
  const used = plan.people.map((p) => {
    let it = existing.find((e) => !claimed.has(e.id) && e.label.toLowerCase() === p.label.toLowerCase())
      || existing.find((e) => !claimed.has(e.id) && e.fig.build.gender === p.gender);
    if (!it) it = stage.add('person', { gender: p.gender, label: p.label, silent: true });
    else {
      if (it.fig.build.gender !== p.gender) stage.setGender(it.id, p.gender);
      it = stage.items.find((x) => x.id === it.id);
      stage.setLabel(it.id, p.label);
    }
    claimed.add(it.id);
    if (p.height) stage.setHeight(it.id, p.height);
    if (p.hair) stage.setBuild(it.id, { hair: p.hair });
    it = stage.items.find((x) => x.id === it.id);
    it.note = p.note || '';
    return it;
  });
  existing.filter((e) => !claimed.has(e.id)).forEach((e) => stage.remove(e.id, true));

  const by = (label) => used[plan.people.findIndex((q) => q.label.toLowerCase() === String(label).toLowerCase())];
  used.forEach((it, i) => {
    const p = plan.people[i];
    it.fig.applyPreset(p.preset);
    it.fig.applyHands(p.hands);
    it.root.position.set(p.x, 0, p.z);
    it.root.rotation.set(0, 0, 0);
  });
  // standing in front of someone on a couch with a chaise: clear the furniture
  used.forEach((it, i) => {
    const p = plan.people[i];
    if (!p.in_front_of) return;
    const ref = plan.people[plan.people.findIndex((q) => q.label.toLowerCase() === p.in_front_of.toLowerCase())];
    if (ref && ref.sits_on && FURN[ref.sits_on].chaise) it.root.position.z = ref.z + FURN[ref.sits_on].chaise.front + 0.55;
  });
  // facing (needs everyone placed first). "camera" means the front of the scene: the camera may end up at an angle, and gaze handles that.
  used.forEach((it, i) => {
    const p = plan.people[i];
    const toward = (pt) => Math.atan2(pt.x - it.root.position.x, pt.z - it.root.position.z);
    let yaw = 0;
    if (p.faces === 'away') yaw = Math.PI;
    else if (p.faces === 'left') yaw = -Math.PI / 2;
    else if (p.faces === 'right') yaw = Math.PI / 2;
    else if (p.faces !== 'camera') { const o = by(p.faces); if (o && o !== it) yaw = toward(o.root.position); }
    it.root.rotation.y = yaw;
  });
  // seating: real furniture under the sitters (people close together share one couch / bench / bed)
  const seats = new Map();
  const slotOf = new Map();
  const groups = [];
  used.forEach((it, i) => {
    const p = plan.people[i];
    if (!p.sits_on) return;
    const wide = ['couch', 'bench', 'bed', 'sectional'].includes(p.sits_on);
    let g = wide ? groups.find((q) => q.type === p.sits_on && Math.abs(q.cx - p.x) < 1.3) : null;
    if (!g) { g = { type: p.sits_on, idxs: [], cx: p.x, cz: p.z }; groups.push(g); }
    g.idxs.push(i);
    g.cx = g.idxs.reduce((a, k) => a + plan.people[k].x, 0) / g.idxs.length;
    g.cz = g.idxs.reduce((a, k) => a + plan.people[k].z, 0) / g.idxs.length;
  });
  groups.forEach((g) => {
    const first = used[g.idxs[0]];
    const yaw = first.root.rotation.y;
    const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), lat = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const d = FURN[g.type];
    const zLocal = d.back ? -d.d / 2 + d.backT + 0.17 : 0;
    const order = [...g.idxs].sort((a, b) => plan.people[a].x - plan.people[b].x);
    const n = order.length;
    const step = Math.min(0.62, (d.w - 0.5) / Math.max(1, n));
    const slots = order.map((k, j) => (n === 1 && plan.people[k].slot === 'end' ? Math.min(0.75, Math.max(0.2, d.w / 2 - d.armT - 0.5)) : (j - (n - 1) / 2) * step));
    const avg = slots.reduce((a, b) => a + b, 0) / n;
    const furn = stage.add(g.type, { label: d.label, silent: true, rotationY: yaw, position: [g.cx - f.x * zLocal - lat.x * avg, 0, g.cz - f.z * zLocal - lat.z * avg] });
    furn.auto = 'seat';
    order.forEach((k, j) => { sitOn(used[k], furn, slots[j], { recline: plan.people[k].recline }); seats.set(k, furn); slotOf.set(k, slots[j]); });
  });

  // camera first (it may stand to one side), so that gaze and pointing aim at where the camera really is
  stage.setLens(plan.camera.lens || stage.lens);
  autoFrame(stage, plan.camera);
  const cam = stage.shot.position.clone();

  used.forEach((it, i) => {
    const p = plan.people[i];
    it.root.updateMatrixWorld(true);
    if (p.looks_at) {
      const o = p.looks_at === 'camera' ? null : by(p.looks_at);
      stage.lookAtPoint(it, o && o !== it ? headPoint(o) : cam);
    }
    const limbs = resolveFree(p, slotOf.get(i) || 0);
    if (p.points_at && !Object.keys(limbs).some((k) => k.startsWith('arm'))) {
      const o = p.points_at === 'camera' ? null : by(p.points_at);
      const world = o && o !== it ? o.fig.root.localToWorld(new THREE.Vector3(0, 1.3, 0)) : cam;
      const local = it.root.worldToLocal(world.clone());
      const left = local.x > 0;
      const sh = it.fig.endPoint(left ? 'armL' : 'armR');
      const dir = local.clone().sub(sh).normalize();
      it.fig.solveIK(left ? 'handL' : 'handR', sh.clone().add(dir.multiplyScalar(0.52)));
      const hands = [...p.hands]; hands[left ? 0 : 1] = 'point'; it.fig.applyHands(hands);
    }
    const furn = seats.get(i) || stage.nearestFurniture(it, 1.4);
    Object.entries(limbs).forEach(([limb, action]) => applyLimb(it, limb, action, furn));
    it.fig.poseName = p.sits_on ? 'sit' : (p.points_at || p.looks_at || Object.keys(limbs).length ? 'custom' : p.preset);
    if (Object.keys(limbs).length) it.fig.poseName = 'custom';
  });

  stage.select(null);
  return plan;
}

/** Place the shot camera so everyone (and the furniture they use) is in frame; `azimuth` swings it around the cast (+ = to the right). */
export function autoFrame(stage, opt = {}) {
  const ps = stage.items.filter((i) => i.kind === 'person');
  if (!ps.length) return;
  const box = new THREE.Box3();
  ps.forEach((i) => box.expandByPoint(new THREE.Vector3(i.root.position.x, 0, i.root.position.z)));
  stage.items.filter((i) => i.auto === 'seat').forEach((i) => { i.root.updateMatrixWorld(true); box.expandByObject(i.root); });
  const tall = Math.max(...ps.map((i) => i.fig.build.height));
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const sx = box.max.x - box.min.x, sz = box.max.z - box.min.z;
  const az = THREE.MathUtils.degToRad(opt.azimuth || 0);
  const span = Math.abs(Math.cos(az)) * sx + Math.abs(Math.sin(az)) * sz + 1.0;
  const depth = Math.abs(Math.cos(az)) * sz + Math.abs(Math.sin(az)) * sx;
  const hfov = 2 * Math.atan(18 / stage.lens), vfov = THREE.MathUtils.degToRad(stage.shot.fov);
  const dist = Math.max((span / 2) / Math.tan(hfov / 2), ((tall + 0.4) / 2) / Math.tan(vfov / 2), 2.4) + depth / 2;
  const camY = opt.height ?? 1.4;
  stage.shot.position.set(cx + Math.sin(az) * dist, camY, cz + Math.cos(az) * dist);
  const targetY = opt.height != null ? 1.1 : Math.min(1.15, tall * 0.62);
  stage.shot.lookAt(cx, targetY, cz);
  if (opt.pitch != null) stage.setShot({ pitch: opt.pitch });
  stage._emit();
  stage.orbit.target.set(cx, 0.9, cz);
  stage.cam.position.set(cx + dist * 0.9, 3.2 + camY, cz + dist * 0.6);
  stage.orbit.update();
}
