import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intake } from '../../skills/remix/scripts/intake.mjs';
import { buildShots, hardCuts, peakFrames, shotFrames, softTransitions } from '../../skills/remix/scripts/lib/cuts.mjs';
import { detectBeats } from '../../skills/remix/scripts/lib/tempo.mjs';
import { readJson } from '../../skills/remix/scripts/lib/common.mjs';
import { SFX_RATE, synthSfx, wavBytes } from '../../skills/remix/scripts/lib/sfx.mjs';
import { check } from '../../skills/remix/scripts/lib/schema.mjs';

const FPS = 30;
const FRAME = 1 / FPS;
const tmp = () => mkdtempSync(join(tmpdir(), 'tapvid-intake-'));

// 6.5 s at 30 fps: red 0–2 s, hard cut to blue, 0.5 s crossfade to green over 4.0–4.5 s, and a
// yellow block sliding in over 5.5–5.8 s.
function synthVideo(file) {
  const graph = [
    'color=c=0xc03030:s=640x360:r=30:d=2[a]', 'color=c=0x3050c0:s=640x360:r=30:d=2.5[b]',
    'color=c=0x30a050:s=640x360:r=30:d=2.5[c0]', 'color=c=0xf0e020:s=160x120:r=30:d=2.5[blk]',
    "[c0][blk]overlay=x='if(lt(t,1.5),-200,min(400,-200+(t-1.5)*2000))':y=120,settb=1/30[c]",
    '[a][b]concat=n=2:v=1:a=0,settb=1/30[ab]', '[ab][c]xfade=transition=fade:duration=0.5:offset=4[v]',
  ].join(';');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-filter_complex', graph, '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
}

test('intake finds the hard cut, the crossfade window and the block entrance within a frame', async () => {
  const dir = tmp();
  const src = join(dir, 'synth.mp4');
  synthVideo(src);
  const project = join(dir, 'clone-synth');
  const tl = await intake(project, src, { transcribe: false, log: () => {} });

  assert.deepEqual(check('timeline', tl), []);
  assert.equal(tl.fps, FPS);
  assert.equal(tl.frames, 195);
  assert.equal(tl.shots.length, 3);
  const [s0, s1, s2] = tl.shots;
  assert.equal(s0.transition_out.type, 'cut');
  assert.ok(Math.abs(s0.end - 2.0) <= FRAME, `cut at ${s0.end}`);
  assert.equal(s1.transition_out.type, 'soft');
  assert.ok(Math.abs(s1.transition_out.start - 4.0) <= FRAME, `soft start ${s1.transition_out.start}`);
  assert.ok(Math.abs(s1.transition_out.end - 4.5) <= FRAME, `soft end ${s1.transition_out.end}`);
  assert.deepEqual(s2.transition_in, s1.transition_out);
  const blockPeaks = tl.motion_peaks.filter((p) => p.shot === 2);
  assert.equal(blockPeaks.length, 1);
  assert.ok(blockPeaks[0].t >= 5.5 - FRAME && blockPeaks[0].t <= 5.8 + FRAME, `block peak at ${blockPeaks[0].t}`);
  assert.equal(tl.beats, null); // no audio track

  assert.deepEqual(readJson(join(project, 'source', 'timeline.json')), tl);
  assert.ok(existsSync(join(project, 'source', 'source.json')));
  assert.ok(existsSync(join(project, 'source', 'frames', 'overview.jpg')));
  for (const s of tl.shots) {
    const shotDir = join(project, 'source', 'frames', 'shots', String(s.index));
    assert.ok(existsSync(join(shotDir, 'strip.jpg')));
    const { frames } = readJson(join(shotDir, 'frames.json'));
    assert.ok(frames.length >= 8);
    for (const f of frames) assert.ok(existsSync(join(shotDir, f.file)), f.file);
  }
});

test('shot frames follow the density rule and include transition edges', () => {
  const short = { start_frame: 0, end_frame: 45, transition_in: null, transition_out: null };
  assert.deepEqual(shotFrames(short, 30, []), [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44]);
  const mid = { start_frame: 0, end_frame: 90, transition_in: null, transition_out: { type: 'soft', start: 2.5, end: 3 } };
  const f = shotFrames(mid, 30, [{ frame: 50 }]);
  assert.ok(f.includes(50) && f.includes(75) && f.includes(83) && f.includes(90) && f.includes(89));
  assert.equal(f.filter((x) => x < 30).length, 4); // 4 per second
});

test('cut detection ignores a gradual change and a lone spike survives', () => {
  const h = (v) => Float32Array.from({ length: 24 }, (_, i) => (i % 8 === v ? 1 : 0)); // one bin per channel
  const metrics = { ydif: [0, 0, 0, 40, 0, 0, 3, 3, 3, 3, 3, 3, 0, 0, 0], scene: Array(15).fill(0),
    hists: [h(0), h(0), h(0), h(1), h(1), h(1), h(1), h(2), h(3), h(4), h(5), h(6), h(6), h(6), h(6)] };
  const cuts = hardCuts(metrics);
  assert.deepEqual(cuts, [3]);
  const softs = softTransitions(metrics, 30, cuts);
  assert.deepEqual(softs, [{ from: 5, to: 11 }]);
  const shots = buildShots(15, 30, cuts, softs);
  assert.deepEqual(shots.map((s) => [s.start_frame, s.end_frame]), [[0, 3], [3, 11], [11, 15]]);
  assert.deepEqual(peakFrames([0, 1, 3, 1, 0, 2, 0], 1, 1), [2, 5]);
});

test('beats: a click track gives its tempo and grid, a steady tone none', () => {
  const rate = 11025;
  const pcm = new Float32Array(rate * 8);
  const period = 60 / 104;
  for (let t = 0; t < 8; t += period) for (let k = 0; k < 0.03 * rate; k++) pcm[Math.floor(t * rate) + k] = 0.8 * Math.sin(k * 0.5);
  const beats = detectBeats(pcm, rate);
  assert.ok(Math.abs(beats.bpm - 104) < 2, `bpm ${beats.bpm}`);
  assert.ok(beats.times.length >= 13);
  assert.ok(beats.times.every((t, i) => Math.abs(t - i * period) < 0.05), JSON.stringify(beats.times.slice(0, 5)));
  const tone = Float32Array.from({ length: rate * 8 }, (_, i) => 0.5 * Math.sin(i * 0.25));
  assert.deepEqual(detectBeats(tone, rate), { bpm: null, times: [] });
});

test('intake writes source/sfx.json with the sound effects of the soundtrack', async () => {
  const dir = tmp();
  const pcm = new Float32Array(3 * SFX_RATE);
  for (const [kind, t] of [['pop', 0.8], ['ding', 1.8]]) synthSfx(kind).forEach((v, j) => { pcm[Math.round(t * SFX_RATE) + j] += 0.5 * v; });
  writeFileSync(join(dir, 'fx.wav'), wavBytes(pcm));
  const src = join(dir, 'fx.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x204060:s=320x180:r=30:d=3', '-i', join(dir, 'fx.wav'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const project = join(dir, 'clone-fx');
  await intake(project, src, { transcribe: false, log: () => {} });

  const sfx = readJson(join(project, 'source', 'sfx.json'));
  assert.equal(sfx.dense, false);
  assert.deepEqual(sfx.events.map((e) => e.kindGuess), ['pop', 'ding']);
  assert.ok(Math.abs(sfx.events[0].t - 0.8) < 0.03, `pop at ${sfx.events[0].t}`);
  assert.ok(Math.abs(sfx.events[1].t - 1.8) < 0.03, `ding at ${sfx.events[1].t}`);
  for (const e of sfx.events) assert.ok(existsSync(join(project, 'source', ...e.clip.split('/'))), e.clip);
  assert.ok(existsSync(join(project, 'source', 'sfx', 'sheet.png')));
});
