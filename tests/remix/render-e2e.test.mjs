import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from '../../skills/remix/scripts/lib/common.mjs';
import { fakeTasks, makeClone, makeReplica, probe, runtimeReady, tone } from './render-helpers.mjs';

const SCRIPTS = join(import.meta.dirname, '..', '..', 'skills', 'remix', 'scripts');
const node = (script, ...args) => execFileSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

test('sample clone renders end to end: timing → project → frames → out/tapvid.mp4', { skip: !runtimeReady && 'runtime not installed (node scripts/ensure-runtime.mjs)', timeout: 90_000 }, () => {
  const dir = makeReplica(makeClone(), { edit: (r) => { r.audio.captions = 'word-highlight'; } });
  fakeTasks(dir);
  tone(join(dir, 'assets', 'audio', 'candidates', '1.mp3'), 3);
  const r = readJson(join(dir, 'replica.json'));
  r.audio.bgm.candidates = [{ source: 'compose', title: 'test bed', path: 'assets/audio/candidates/1.mp3', bpm: null }];
  writeJson(join(dir, 'replica.json'), r);

  const timing = JSON.parse(node('timing.mjs', dir));
  const resolved = readJson(join(dir, 'replica.json')).resolved;
  assert.deepEqual(Object.keys(resolved), ['01-Title01', '02-Points02']);
  const total = Object.values(resolved).reduce((a, s) => a + s.duration, 0);
  assert.ok(Math.abs(timing.total - total) < 1e-6);

  const frames = JSON.parse(node('frames.mjs', dir));
  assert.ok(frames.some((f) => f.path === 'review/frames/boundary-01-Title01-02-Points02-1.jpg'));
  assert.ok(existsSync(join(dir, 'review', 'contact-sheet.jpg')));

  const out = JSON.parse(node('render.mjs', dir, '--workers', '2', '--no-build'));
  assert.equal(out.out, join(dir, 'out', 'tapvid.mp4'));
  assert.ok(Math.abs(probe(out.out) - total) <= 1 / 30 + 1e-3, `${probe(out.out)} vs ${total}`);
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'csv=p=0', out.out], { encoding: 'utf-8' });
  assert.match(streams, /video,1920,1080/);
  assert.match(streams, /audio/);
  assert.equal(node('validate.mjs', 'project', join(dir, 'project')).trim().split('\n').pop(), 'ok');
});

test('a board element marked data-sfx becomes a sound-effect cue at its first visible frame', { skip: !runtimeReady && 'runtime not installed (node scripts/ensure-runtime.mjs)', timeout: 90_000 }, () => {
  const clone = makeClone();
  const board = join(clone, 'template', 'boards', 'Points02.jsx');
  writeFileSync(board, readFileSync(board, 'utf-8').replace('<div key={i} style=', '<div key={i} data-sfx="pop" data-sfx-gain="0.8" style='));
  const dir = makeReplica(clone);
  fakeTasks(dir);
  node('timing.mjs', dir);
  const resolved = readJson(join(dir, 'replica.json')).resolved;
  const out = JSON.parse(node('render.mjs', dir, '--workers', '2'));

  const { cues } = readJson(join(dir, 'project', 'sfx-cues.json'));
  const start = resolved['01-Title01'].duration;
  const segs = resolved['02-Points02'].segments;
  assert.equal(cues.length, 2);
  cues.forEach((c, i) => {
    assert.equal(c.kind, 'pop');
    assert.equal(c.gain, 0.8);
    // A point fades in from its segment start: opacity passes 0.05 on the next frame.
    const enter = start + segs.find((x) => x.key === `points.${i}.say`).start;
    assert.ok(c.t > enter - 1e-6 && c.t <= enter + 2 / 30 + 1e-6, `cue ${i} at ${c.t}, segment at ${enter}`);
  });
  assert.deepEqual(cues.map((c) => c.id), [`${start}:pop0`, `${start}:pop1`]);
  assert.match(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out.out], { encoding: 'utf-8' }), /audio/);
});
