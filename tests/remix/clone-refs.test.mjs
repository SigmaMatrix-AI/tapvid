import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRefs, subjectCrop } from '../../skills/remix/scripts/refs.mjs';
import { readJson, writeJson } from '../../skills/remix/scripts/lib/common.mjs';
import { check } from '../../skills/remix/scripts/lib/schema.mjs';
import { probe } from '../../skills/remix/scripts/lib/video.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample-clone', import.meta.url));

function project() {
  const dir = join(mkdtempSync(join(tmpdir(), 'tapvid-refs-')), 'clone-sample');
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

test('refs cuts the slot clip, frame and subjects and keeps describe', async () => {
  const dir = project();
  const refs = await extractRefs(dir, { log: () => {} });
  const refsDir = join(dir, 'template', 'refs');
  const entry = refs['Title01.cover'];
  assert.deepEqual(check('refs', refs), []);
  assert.equal(entry.clip, 'Title01.cover.mp4');
  assert.equal(entry.frame, 'Title01.cover.png');
  assert.deepEqual(entry.window, { start: 0, end: 2.5 });
  assert.equal(entry.describe, 'Medium shot of a person at a desk; slow push-in, soft side light');
  assert.deepEqual(entry.subjects, [{ id: 'presenter', kind: 'person', image: 'subjects/presenter.png' }]);
  assert.deepEqual(readJson(join(refsDir, 'refs.json')), refs);

  const clip = probe(join(refsDir, entry.clip));
  const v = clip.streams.find((s) => s.codec_type === 'video');
  assert.equal(clip.streams.some((s) => s.codec_type === 'audio'), false);
  assert.equal(v.width, 268); // 0.42 × 640, even
  assert.equal(v.height, 272); // 0.76 × 360, even
  assert.ok(Math.abs(Number(clip.format.duration) - 2.5) < 0.05);
  assert.ok(existsSync(join(refsDir, entry.frame)));
  assert.ok(existsSync(join(refsDir, 'subjects', 'presenter.png')));
});

test('refs --only leaves other boards untouched and uses a slot window', async () => {
  const dir = project();
  const analysisPath = join(dir, 'analysis', 'boards.json');
  const analysis = readJson(analysisPath);
  analysis.boards[1].media = { 'points.0.icon': { crop: [0, 0, 0.5, 0.5], window: { start: 3, end: 4 } } };
  writeJson(analysisPath, analysis);
  const refs = await extractRefs(dir, { only: ['Points02'], log: () => {} });
  assert.equal(refs['Title01.cover'].clip, null); // the fixture's entry, not re-extracted
  assert.deepEqual(refs['Points02.points.0.icon'].window, { start: 3, end: 4 });
  assert.deepEqual(refs['Points02.points.0.icon'].subjects, []);
});

test('a subject box is relative to the slot crop', () => {
  assert.deepEqual(subjectCrop([0.5, 0.2, 0.4, 0.6], [0.25, 0.5, 0.5, 0.5]), [0.6, 0.5, 0.2, 0.3]);
});
