import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN } from '../../skills/remix/scripts/lib/common.mjs';
import { cutoutFresh, cutoutPath, downsampleRatio, engineReady, toGray, toPlanar } from '../../skills/remix/scripts/lib/matte.mjs';
import { probe, videoInfo } from '../../skills/remix/scripts/lib/video.mjs';

test('cutoutPath sits next to the clip; a cutout older than its clip is stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapvid-matte-'));
  const clip = join(dir, 'a.presenter.mp4');
  assert.equal(cutoutPath(clip), join(dir, 'a.presenter.cutout.webm'));
  writeFileSync(clip, 'x');
  assert.equal(cutoutFresh(clip), false);
  writeFileSync(cutoutPath(clip), 'y');
  utimesSync(clip, new Date(statSync(cutoutPath(clip)).mtimeMs - 5000), new Date(statSync(cutoutPath(clip)).mtimeMs - 5000));
  assert.equal(cutoutFresh(clip), true);
  utimesSync(clip, new Date(), new Date(Date.now() + 5000));
  assert.equal(cutoutFresh(clip), false);
});

test('downsampleRatio keeps the matted short side near 288 px; pixel conversions', () => {
  assert.equal(downsampleRatio(1080, 1920), 0.267);
  assert.equal(downsampleRatio(704, 1280), 0.409);
  assert.equal(downsampleRatio(200, 300), 1);
  assert.deepEqual([...toPlanar(Buffer.from([255, 0, 51, 0, 255, 0]), 2)].map((v) => Number(v.toFixed(2))), [1, 0, 0, 1, 0.2, 0]);
  assert.deepEqual([...toGray(new Float32Array([-0.2, 0.5, 1.4]))], [0, 128, 255]);
});

// Through the CLI, as project.mjs calls it: onnxruntime stays out of the test process.
test('matte.mjs writes a VP9 cutout with alpha, then reuses it', { skip: !engineReady() && 'matting engine not installed (matte.mjs installs it)' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapvid-matte-'));
  const clip = join(dir, 'c.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=24:d=1', '-pix_fmt', 'yuv420p', clip]);
  const cli = (...a) => spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'matte.mjs'), ...a], { encoding: 'utf-8', timeout: 120000 });
  const first = cli(clip);
  assert.equal(first.status, 0, first.stderr);
  const out = first.stdout.trim();
  assert.equal(out, cutoutPath(clip));
  assert.match(first.stderr, /^24 frames in/m);
  const v = probe(out).streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'vp9');
  assert.equal(v.tags?.alpha_mode ?? v.tags?.ALPHA_MODE, '1');
  assert.equal(videoInfo(probe(out)).width, 320);
  assert.equal(cutoutFresh(clip), true);
  assert.equal(cli(clip).stdout.trim(), `fresh ${out}`);
});
