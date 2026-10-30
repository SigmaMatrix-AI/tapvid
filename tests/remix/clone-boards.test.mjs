import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePath } from '../../skills/remix/scripts/lib/common.mjs';
import { extractRefs } from '../../skills/remix/scripts/refs.mjs';
import { buildBoards } from '../../skills/remix/scripts/build-boards.mjs';
import { compareBoards } from '../../skills/remix/scripts/compare.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample-clone', import.meta.url));
const RUNTIME_READY = ['esbuild', 'react', 'react-dom', 'playwright'].every((p) => existsSync(runtimePath(p)));

test('build-boards and compare run on the sample template', { skip: RUNTIME_READY ? false : 'runtime not installed (~/.tapvid-video/runtime)' }, async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'tapvid-boards-')), 'clone-sample');
  cpSync(FIXTURE, dir, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'source', 'source.mp4'), '-vn', '-ac', '2', '-ar', '44100', join(dir, 'source', 'audio.wav')]);
  await extractRefs(dir, { log: () => {} });
  const built = await buildBoards(dir, { log: () => {} });
  assert.deepEqual(built, ['Title01', 'Points02']);

  const boards = join(dir, 'template', 'boards');
  for (const name of built) {
    for (const ext of ['html', 'png', 'mp3']) assert.ok(existsSync(join(boards, `${name}.${ext}`)), `${name}.${ext}`);
    const meta = JSON.parse(readFileSync(join(boards, `${name}.json`), 'utf-8'));
    assert.equal(meta.example_duration_ms, 2500);
  }
  const html = readFileSync(join(boards, 'Title01.html'), 'utf-8');
  assert.match(html, /scenePlayer/);
  assert.match(html, /\.\.\/refs\/Title01\.cover\.mp4/);
  assert.ok(existsSync(join(dir, 'template', 'preview.mp3')));
  assert.ok(existsSync(join(dir, 'template', 'cover.png')));

  const { rows, worst } = await compareBoards(dir, { log: () => {} });
  assert.equal(rows.length, 9); // Title01: 3 samples of its one window; Points02: 3 per segment
  for (const r of rows) {
    assert.ok(Number.isFinite(r.ssim) && r.ssim > 0 && r.ssim <= 1, `ssim ${r.ssim}`);
    assert.ok(Number.isFinite(r.struct) && r.struct > 0 && r.struct <= 1, `struct ${r.struct}`);
    assert.ok(existsSync(join(dir, r.image)), r.image);
  }
  assert.equal(worst, Math.min(...rows.map((r) => r.struct)));
});
