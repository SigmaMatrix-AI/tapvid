// reframe.mjs: a picture moved inside the same canvas, the uncovered edge filled with a blur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reframe } from '../../skills/remix/scripts/reframe.mjs';

const SCRIPT = join(import.meta.dirname, '..', '..', 'skills', 'remix', 'scripts', 'reframe.mjs');
const W = 320;
const H = 400;

// A busy test pattern: every band of it has strong detail.
function pattern(dir) {
  const file = join(dir, 'in.jpg');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${W}x${H}`, '-frames:v', '1', file]);
  return file;
}

// Grey pixels of rows [y0, y1) as bytes.
function rows(file, y0, y1) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${W}:${y1 - y0}:0:${y0},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
}

// Mean squared difference between horizontal neighbours: high for detail, near zero for a blur.
function detail(buf) {
  let sum = 0;
  let n = 0;
  for (let i = 1; i < buf.length; i++) {
    if (i % W === 0) continue;
    sum += (buf[i] - buf[i - 1]) ** 2;
    n++;
  }
  return sum / n;
}

const dims = (file) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf-8' }).trim();
const meanAbsDiff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

test('moving down keeps the size, blurs the new top band and shifts the picture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapvid-reframe-'));
  const input = pattern(dir);
  const out = join(dir, 'down.png');
  const r = reframe(input, out, { headTop: 10, target: 30, feather: 40 });
  assert.equal(r.shift, 80);
  assert.equal(dims(out), `${W},${H}`);
  const fill = detail(rows(out, 0, 70));
  assert.ok(fill < detail(rows(input, 0, 70)) / 10, `top band detail ${fill}`);
  // Below the feather the picture is the original, 80 px lower.
  assert.ok(meanAbsDiff(rows(out, 140, 400), rows(input, 60, 320)) < 3);
});

test('moving up crops the top and blurs the new bottom band; the CLI prints path and shift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapvid-reframe-'));
  const input = pattern(dir);
  const out = join(dir, 'up.png');
  const stdout = execFileSync(process.execPath, [SCRIPT, input, out, '--head-top', '30', '--target', '20', '--feather', '30'], { encoding: 'utf-8' });
  assert.deepEqual(stdout.trim().split('\n'), [out, 'shift: -40px (head top 30% → 20% of 400px)']);
  assert.equal(dims(out), `${W},${H}`);
  assert.ok(detail(rows(out, H - 35, H)) < detail(rows(input, H - 35, H)) / 10);
  assert.ok(meanAbsDiff(rows(out, 0, 320), rows(input, 40, 360)) < 3);
});
