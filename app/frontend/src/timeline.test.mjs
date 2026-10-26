// Run:  node src/timeline.test.mjs   (pure-function tests for the timeline model; no test framework needed)
import assert from 'node:assert/strict';
import {
  newTimeline, clipFromAsset, addClipToTrack, updateClip, splitClip, removeClip, duplicateClip, clipDur, clipEnd,
  timelineDuration, snapStart, activeClip, sourceTime, exportJson, autoTransitions,
} from './timeline.js';

const vid = (id, secs) => ({ id, kind: 'video', mime: 'video/mp4', name: id, meta: { seconds: secs } });
let tl = newTimeline();

// append two 4 s clips -> back to back
tl = addClipToTrack(tl, 'v1', clipFromAsset(vid('a', 4), 'v1', 0));
tl = addClipToTrack(tl, 'v1', clipFromAsset(vid('b', 4), 'v1', 0));
assert.equal(tl.v1[1].start, 4);
assert.equal(timelineDuration(tl), 8);

// split the first clip at 1.5 s -> two pieces that tile the original
const a = tl.v1[0];
tl = splitClip(tl, 'v1', a.id, 1.5);
assert.equal(tl.v1.length, 3);
const [p1, p2] = tl.v1.filter((c) => c.assetId === 'a').sort((x, y) => x.start - y.start);
assert.equal(p1.out, 1.5); assert.equal(p2.in, 1.5); assert.equal(p2.start, 1.5);
assert.ok(Math.abs(clipDur(p1) + clipDur(p2) - 4) < 1e-9);
// splitting too close to an edge is a no-op
assert.equal(splitClip(tl, 'v1', p1.id, 0.05), tl);

// speed 2 halves the duration and maps timeline time to source time
tl = updateClip(tl, 'v1', p2.id, { speed: 2 });
const p2b = tl.v1.find((c) => c.id === p2.id);
assert.ok(Math.abs(clipDur(p2b) - 1.25) < 1e-9);
assert.ok(Math.abs(sourceTime(p2b, p2b.start + 0.5) - (1.5 + 1.0)) < 1e-9);

// overlapping a later clip over the previous one auto-creates a dissolve of the overlap length
const b = tl.v1.find((c) => c.assetId === 'b');
tl = updateClip(tl, 'v1', b.id, { start: clipEnd(p2b) - 0.5 });
assert.ok(Math.abs(tl.v1.find((c) => c.id === b.id).fadeIn - 0.5) < 1e-9);

// the later clip wins where two overlap
const t = clipEnd(p2b) - 0.25;
assert.equal(activeClip(tl.v1, t).id, b.id);

// ripple delete closes the gap
const before = tl.v1.find((c) => c.id === b.id).start;
tl = removeClip(tl, 'v1', p1.id, true);
assert.ok(tl.v1.find((c) => c.id === b.id).start < before);

// snapping pulls a drag onto a neighbouring edge
const snap = snapStart(tl, 'v1', 'zzz', clipEnd(p2b) + 0.03, 2, 99, 0.1);
assert.ok(Math.abs(snap - clipEnd(p2b)) < 1e-9, `snap=${snap}`);

// duplicate + export mapping
tl = duplicateClip(tl, 'v1', b.id);
const ex = exportJson(tl, '1080p');
assert.equal(ex.width, 1920); assert.equal(ex.height, 1080);
assert.ok(ex.v1.every((c) => c.key));
console.log('timeline.js: all assertions passed');
