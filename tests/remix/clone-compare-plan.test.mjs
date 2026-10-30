import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardRuns, frameOffset, sampleWindows, shotWindows, variantContent, variantMedia } from '../../skills/remix/scripts/lib/compare-plan.mjs';
import { boundaryIssues, matchEvents, sourceEvents } from '../../skills/remix/scripts/lib/timing-check.mjs';

const SEGMENTED = {
  schema: { fields: [{ key: 'heading', type: 'string', desc: 'x' }, { key: 'points', type: 'object[]', minItems: 2, maxItems: 4, desc: 'x',
    fields: [{ key: 'label', type: 'string', desc: 'x' }, { key: 'say', type: 'narration', desc: 'x' }] }] },
  example_data: { heading: 'H', points: [{ label: 'a', say: 'A' }, { label: 'b', say: 'B' }, { label: 'c', say: 'C' }] },
  example_segments: [{ key: 'points.0.say', start: 0, end: 1 }, { key: 'points.1.say', start: 1, end: 3 }, { key: 'points.2.say', start: 3, end: 3.5 }],
};

test('samples sit in the middle of their source frame, mapped to board time', () => {
  const s = sampleWindows([[0, 0, 2]], 1, 30, frameOffset('middle', 30));
  assert.deepEqual(s.map((x) => x.n), [45, 66, 81]);
  assert.ok(Math.abs(s[0].ts - 45.5 / 30) < 1e-9);
  assert.ok(Math.abs(s[0].boardT - (45.5 / 30 - 1)) < 1e-9);
  assert.equal(frameOffset('start', 30), 0.001);
  assert.throws(() => frameOffset('end', 30), /source_frame_time/);
});

test('an unsegmented board is sampled per source shot inside its window', () => {
  const timeline = { shots: [{ index: 0, start: 0, end: 1.5 }, { index: 1, start: 1.5, end: 4 }, { index: 2, start: 4, end: 6 }] };
  assert.deepEqual(shotWindows({ start: 1, end: 4 }, timeline), [[0, 0, 0.5], [0.5, 0.5, 2.5]]);
  assert.deepEqual(shotWindows({ start: 1, end: 4, shots: [1] }, timeline), [[0.5, 0.5, 2.5]]);
  assert.deepEqual(shotWindows({ start: 1, end: 4 }, null), [[0, 0, 3]]);
});

test('a count variant re-picks source items and lays their segments back to back', () => {
  const v = variantContent(SEGMENTED, { points: [2, 0] });
  assert.deepEqual(v.data.points.map((p) => p.label), ['c', 'a']);
  assert.deepEqual(v.segments, [{ key: 'points.0.say', start: 0, end: 0.5 }, { key: 'points.1.say', start: 0.5, end: 1.5 }]);
  assert.deepEqual(v.windows, [[0, 3, 0.5], [0.5, 0, 1]]);
  assert.deepEqual(v.shift, { 0: 3, 1: -0.5 });
  assert.throws(() => variantContent(SEGMENTED, { points: [0] }), /outside 2\.\.4/);
  const media = variantMedia({ 'points.2.shot': { kind: 'video', src: 'c.mp4', offset: 0 }, cover: { kind: 'image', src: 'x.png' } }, 'points', [2, 0], v.shift);
  assert.deepEqual(media, { 'points.0.shot': { kind: 'video', src: 'c.mp4', offset: 3 }, cover: { kind: 'image', src: 'x.png' } });
  const runs = boardRuns({ name: 'P', start: 0, end: 3.5, variants: [{ id: 'n2', pick: { points: [2, 0] } }] }, SEGMENTED, null);
  assert.deepEqual(runs.map((r) => [r.label, r.duration, r.windows.length]), [['P', 3.5, 3], ['P-n2', 1.5, 2]]);
});

test('timing: window edges, transition durations and board changes against the timeline', () => {
  const timeline = { duration_s: 6, shots: [
    { index: 0, start: 0, end: 2, start_frame: 0, end_frame: 60, transition_in: null, transition_out: { type: 'cut', start: 2, end: 2 } },
    { index: 1, start: 2, end: 4.5, start_frame: 60, end_frame: 135, transition_in: { type: 'cut', start: 2, end: 2 }, transition_out: { type: 'soft', start: 4, end: 4.5 } },
    { index: 2, start: 4.5, end: 6, start_frame: 135, end_frame: 180, transition_in: { type: 'soft', start: 4, end: 4.5 }, transition_out: null },
  ], motion_peaks: [{ t: 3, frame: 90, shot: 1 }] };
  const template = { transitions: [{ from: 'A', to: 'B', type: 'crossfade', duration: 0.3 }] };
  const issues = boundaryIssues({ name: 'A', start: 0.1, end: 4.5 }, template, timeline, 30);
  assert.deepEqual(issues.map((i) => [i.kind, i.frames]), [['window start', 3], ['transition crossfade duration', -6]]);

  const board = { name: 'A', start: 0, end: 4.5 };
  const events = sourceEvents(board, timeline, 30);
  assert.deepEqual(events, [{ kind: 'cut', frame: 60 }, { kind: 'motion peak', frame: 90 }]);
  const series = Array(135).fill(0);
  series[61] = 5; // one frame late: fine
  series[95] = 4; // five frames late: reported
  assert.deepEqual(matchEvents(board, events, series, 30).map((i) => [i.kind, i.frames]), [['motion peak', 5]]);
  series[95] = 0;
  assert.deepEqual(matchEvents(board, events, series, 30).map((i) => [i.kind, i.note]), [['motion peak', 'no matching change in the board']]);
});
