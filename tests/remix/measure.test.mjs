import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, runtimePath, writeJson } from '../../skills/remix/scripts/lib/common.mjs';
import { classifyMotion, cropSize, frameDiffs, loopLag, MAX_WIDTH, motionTargets } from '../../skills/remix/scripts/lib/measure-motion.mjs';
import { fontsHtml, gridHtml, parseBox, parseCandidates, parseTimes } from '../../skills/remix/scripts/lib/measure-sheets.mjs';
import { measureFonts, measureGrid, measureMotion } from '../../skills/remix/scripts/measure.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample-clone', import.meta.url));
const runtimeReady = existsSync(runtimePath('playwright'));
const FPS = 30;
const SIZE = 48 * 27;

function copy() {
  const dir = join(mkdtempSync(join(tmpdir(), 'tapvid-measure-')), 'clone');
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

// Deterministic pseudo-random bytes (an LCG), so synthetic frames are stable across runs.
function noise(seed, amplitude, base = 128) {
  let s = seed >>> 0;
  return Uint8Array.from({ length: SIZE }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return base + Math.floor(((s >>> 8) / 0x1000000) * amplitude);
  });
}

test('--box accepts fractions or percent; --at and --candidates parse', () => {
  assert.deepEqual(parseBox('0.31,0.18,0.37,0.17'), [0.31, 0.18, 0.37, 0.17]);
  assert.deepEqual(parseBox('31.5,18,37,17.5').map((v) => Number(v.toFixed(4))), [0.315, 0.18, 0.37, 0.175]);
  assert.throws(() => parseBox('10,10,95,10'), /not inside the canvas/);
  assert.throws(() => parseBox('1,2,3'), /x,y,w,h/);
  assert.deepEqual(parseTimes('12.4,13.0'), [12.4, 13]);
  assert.throws(() => parseTimes('a'), /seconds/);
  assert.deepEqual(parseCandidates('Source Serif 4:900, Bree Serif:400,Fraunces'), [
    { family: 'Source Serif 4', weight: 900 }, { family: 'Bree Serif', weight: 400 }, { family: 'Fraunces', weight: 400 }]);
});

test('grid page: labelled 10 % lines on the full frame, every line in a 2× zoom', () => {
  const full = gridHtml({ image: 'data:,', width: 1920, height: 1080 });
  assert.deepEqual([full.width, full.height], [1920, 1080]);
  // 0–100 every 2 % → 51 lines per axis; labels (two per line) only on the 11 major lines.
  assert.equal((full.html.match(/class="v /g) || []).length, 51);
  assert.equal((full.html.match(/class="lx/g) || []).length, 22);
  const zoom = gridHtml({ image: 'data:,', width: 1920, height: 1080, box: [0.3, 0.1, 0.2, 0.1] });
  assert.deepEqual([zoom.width, zoom.height], [768, 216]);
  // x 30–50 % → 11 lines, each labelled top and bottom, with absolute percent values.
  assert.equal((zoom.html.match(/class="lx/g) || []).length, 22);
  assert.match(zoom.html, />42<\/div>/);
  assert.match(zoom.html, /left:-1152px;top:-216px;width:3840px;height:2160px/);
});

test('font sheet page: one stylesheet and row per candidate, text escaped', () => {
  const html = fontsHtml({ image: 'data:,', cropWidth: 300, cropHeight: 40, text: 'A <b> & "c"',
    candidates: [{ family: 'Bree Serif', weight: 400 }, { family: 'Source Serif 4', weight: 900 }] });
  assert.match(html, /href="https:\/\/fonts\.googleapis\.com\/css2\?family=Bree\+Serif:wght@400&amp;display=block"/);
  assert.match(html, /family=Source\+Serif\+4:wght@900/);
  assert.match(html, /id="lab1">Source Serif 4 900</);
  assert.match(html, /A &lt;b&gt; &amp; &quot;c&quot;/);
  assert.match(html, /class="src" src="data:,"/);
  assert.match(html, /width:600px;height:80px/);
});

test('motion: still, boil, a loop and sustained motion', () => {
  const still = Array.from({ length: 60 }, (_, i) => noise(i, 2));
  const r1 = classifyMotion(still, FPS);
  assert.equal(r1.class, 'still');
  assert.ok(r1.confidence > 0.9, JSON.stringify(r1));

  // A new pose every 8 frames, held still in between.
  const poses = [noise(101, 120, 60), noise(202, 120, 60), noise(303, 120, 60)];
  const boil = Array.from({ length: 64 }, (_, i) => poses[Math.floor(i / 8) % 3]);
  const r2 = classifyMotion(boil, FPS);
  assert.equal(r2.class, 'boil', JSON.stringify(r2));
  assert.equal(r2.poses_per_s, 3.75);
  assert.equal(r2.period_s, 0.267);

  // A 15-frame GIF loop (0.5 s), every frame different.
  const cycle = Array.from({ length: 15 }, (_, i) => noise(1000 + i, 200, 20));
  const loop = Array.from({ length: 60 }, (_, i) => cycle[i % 15]);
  const r3 = classifyMotion(loop, FPS);
  assert.equal(r3.class, 'moving');
  assert.equal(r3.loop_s, 0.5);
  assert.ok(r3.mean > 10);
  assert.equal(loopLag(loop, FPS), 15);

  // Footage-like: every frame new, no repeat.
  const moving = Array.from({ length: 60 }, (_, i) => noise(5000 + i, 200, 20));
  const r4 = classifyMotion(moving, FPS);
  assert.equal(r4.class, 'moving');
  assert.equal(r4.loop_s, undefined);
  assert.equal(r4.confidence, 1);

  assert.deepEqual(frameDiffs([Uint8Array.of(0, 10), Uint8Array.of(4, 4)]), [5]);
  assert.deepEqual(cropSize([0, 0, 0.5, 0.25], 1920, 1080), [MAX_WIDTH, 28]);
  assert.deepEqual(cropSize([0, 0, 0.02, 0.02], 1920, 1080), [38, 22]);
});

test('motion targets: elements.json minus presenter / footage, else boards.json slot crops', () => {
  const dir = copy();
  const ids = motionTargets(dir).map((t) => t.id);
  assert.ok(!ids.includes('Title01.cover'));
  assert.deepEqual(motionTargets(dir, ['Points02']).map((t) => t.id), ['Points02.heading', 'Points02.points.0', 'Points02.points.1']);
  rmSync(join(dir, 'analysis', 'elements.json'));
  assert.deepEqual(motionTargets(dir), [{ id: 'Title01.cover', board: 'Title01', box: [0.52, 0.12, 0.42, 0.76], in: 0, out: 2.5 }]);
});

test('measureMotion writes analysis/motion.json and keeps other boards on --only', async () => {
  const dir = copy();
  const calls = [];
  const decode = async (src, opts) => {
    calls.push(opts);
    return Array.from({ length: 20 }, (_, i) => noise(i, 2));
  };
  writeJson(join(dir, 'analysis', 'motion.json'), { elements: { 'Title01.title': { class: 'boil', period_s: 0.25, poses_per_s: 4, mean: 2, confidence: 0.9 }, 'Points02.heading': { class: 'moving', mean: 9, confidence: 1 } } });
  const lines = [];
  const { results } = await measureMotion(dir, { only: ['Points02'], decode, log: (l) => lines.push(l) });
  assert.deepEqual(Object.keys(results), ['Points02.heading', 'Points02.points.0', 'Points02.points.1']);
  const written = readJson(join(dir, 'analysis', 'motion.json')).elements;
  assert.equal(written['Title01.title'].class, 'boil');
  assert.equal(written['Points02.heading'].class, 'still');
  // The window skips the entrance and the exit's last frames, in source pixels of the fixture video.
  assert.deepEqual(calls[0], { start: 2.8, end: 4.9, box: [0.08, 0.12, 0.6, 0.08], width: 640, height: 360 });
  assert.match(lines.join('\n'), /\| Points02\.heading \| still \|/);
});

test('grid and font sheets render from the source', { skip: !runtimeReady && 'runtime not installed' }, async () => {
  const dir = copy();
  const files = await measureGrid(dir, { at: [1.2], box: [0.5, 0.1, 0.4, 0.4] });
  assert.deepEqual(files, ['grid-1.2.png', 'grid-1.2-zoom.png'].map((f) => join(dir, 'analysis', 'measure', f)));
  for (const f of files) assert.ok(existsSync(f));
  // Offline: a candidate whose stylesheet is empty does not load and is labelled "not found".
  const sheet = await measureFonts(dir, { at: 1, box: [0.06, 0.3, 0.3, 0.06], text: 'NEW', out: 'kicker',
    candidates: [{ family: 'Nope Zzz', weight: 400 }], cssUrl: () => 'data:text/css,' });
  assert.ok(sheet.endsWith(join('analysis', 'measure', 'fonts-kicker.png')) && existsSync(sheet));
});
