import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The library cache lives under TAPVID_VIDEO_HOME, read when common.mjs loads: point it at a
// scratch directory before importing anything (each test file runs in its own process), with
// the real runtime linked in for the browser tests.
const realRuntime = join(process.env.TAPVID_VIDEO_HOME || join(homedir(), '.tapvid-video'), 'runtime');
const home = mkdtempSync(join(tmpdir(), 'tapvid-sfx-home-'));
if (existsSync(realRuntime)) symlinkSync(realRuntime, join(home, 'runtime'));
process.env.TAPVID_VIDEO_HOME = home;
const { SFX_KINDS, SFX_RATE, ensureSfx, resolveSfx, synthSfx, wavBytes } = await import('../../skills/remix/scripts/lib/sfx.mjs');
const { DETECT_RATE, detectSfx, guessKind, writeSfx } = await import('../../skills/remix/scripts/lib/sfx-detect.mjs');
const { matchSfx } = await import('../../skills/remix/scripts/lib/timing-check.mjs');
const { firstCues, sfxTracker } = await import('../../skills/remix/scripts/lib/capture.mjs');
const { requireRuntime, runtimePath } = await import('../../skills/remix/scripts/lib/common.mjs');

const SCRIPTS = join(import.meta.dirname, '..', '..', 'skills', 'remix', 'scripts');
const runtimeReady = existsSync(runtimePath('playwright'));
const tmp = () => mkdtempSync(join(tmpdir(), 'tapvid-sfx-'));
const PEAK = 10 ** (-3 / 20);

// Mono float mix of library kinds placed at times (seconds), `amp` scaling each.
function mix(seconds, placed, rate = SFX_RATE) {
  const out = new Float32Array(Math.round(seconds * rate));
  for (const { kind, t, amp = 0.5 } of placed) {
    const s = synthSfx(kind);
    const step = SFX_RATE / rate; // decimate when mixing at a lower rate
    const o = Math.round(t * rate);
    for (let j = 0; j * step < s.length && o + j < out.length; j++) out[o + j] += amp * s[Math.floor(j * step)];
  }
  return out;
}

test('every library kind renders deterministically at −3 dBFS peak with silent edges', () => {
  assert.deepEqual(SFX_KINDS, ['pop', 'click', 'whoosh', 'swoosh', 'ding', 'paper', 'typewriter', 'impact', 'riser', 'shutter']);
  const lengths = { pop: 0.12, click: 0.02, whoosh: 0.45, swoosh: 0.25, ding: 0.9, paper: 0.3, typewriter: 0.08, impact: 0.6, riser: 1, shutter: 0.15 };
  for (const kind of SFX_KINDS) {
    const s = synthSfx(kind);
    assert.ok(Math.abs(s.length / SFX_RATE - lengths[kind]) < 0.001, `${kind} length ${s.length / SFX_RATE}`);
    assert.ok(s.every(Number.isFinite), `${kind} has non-finite samples`);
    const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    assert.ok(Math.abs(peak - PEAK) < 1e-4, `${kind} peak ${peak}`);
    assert.equal(Math.abs(s[0]), 0);
    assert.equal(Math.abs(s[s.length - 1]), 0);
    assert.deepEqual(synthSfx(kind), s);
  }
  assert.throws(() => synthSfx('kazoo'), /unknown sfx kind: kazoo/);
});

test('wavBytes writes a 44.1 kHz mono 16-bit WAV', () => {
  const buf = wavBytes(Float32Array.from([0, 0.5, -1, 1]));
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.readUInt16LE(22), 1);
  assert.equal(buf.readUInt32LE(24), 44100);
  assert.equal(buf.readUInt16LE(34), 16);
  assert.equal(buf.readUInt32LE(40), 8);
  assert.deepEqual([0, 1, 2, 3].map((i) => buf.readInt16LE(44 + 2 * i)), [0, 16384, -32767, 32767]);
});

test('ensureSfx renders a kind once into the home cache; resolveSfx prefers the template file', () => {
  const path = ensureSfx('ding');
  assert.equal(path, join(home, 'sfx', 'v1', 'ding.wav'));
  assert.deepEqual(readFileSync(path), wavBytes(synthSfx('ding')));
  const mtime = statSync(path).mtimeMs;
  assert.equal(ensureSfx('ding'), path);
  assert.equal(statSync(path).mtimeMs, mtime);
  assert.throws(() => ensureSfx('kazoo'), /unknown sfx kind/);
  assert.equal(existsSync(join(home, 'sfx', 'v1', 'kazoo.wav')), false);

  const templateDir = tmp();
  mkdirSync(join(templateDir, 'sfx'));
  writeFileSync(join(templateDir, 'sfx', 'pop.wav'), wavBytes(Float32Array.from([0, 0.1, 0])));
  writeFileSync(join(templateDir, 'sfx', 'chime.wav'), wavBytes(Float32Array.from([0, 0.1, 0])));
  assert.equal(resolveSfx(templateDir, 'pop'), join(templateDir, 'sfx', 'pop.wav'));
  assert.equal(resolveSfx(templateDir, 'chime'), join(templateDir, 'sfx', 'chime.wav'));
  assert.equal(resolveSfx(templateDir, 'whoosh'), join(home, 'sfx', 'v1', 'whoosh.wav'));
  assert.throws(() => resolveSfx(templateDir, '../pop'), /invalid sfx kind/);
});

test('sfx.mjs lists the kinds and renders one to a file', () => {
  const env = { ...process.env, TAPVID_VIDEO_HOME: home };
  assert.deepEqual(execFileSync(process.execPath, [join(SCRIPTS, 'sfx.mjs'), 'list'], { encoding: 'utf-8', env }).trim().split('\n'), SFX_KINDS);
  const out = join(tmp(), 'nested', 'w.wav');
  execFileSync(process.execPath, [join(SCRIPTS, 'sfx.mjs'), 'render', 'whoosh', out], { env });
  assert.deepEqual(readFileSync(out), wavBytes(synthSfx('whoosh')));
});

test('guessKind follows the documented duration / attack / centroid rules', () => {
  const k = (dur, attack, centroidHz) => guessKind({ dur, attack, centroidHz });
  assert.equal(k(0.015, 0, 5000), 'click');
  assert.equal(k(0.3, 0.1, 3000), 'whoosh');
  assert.equal(k(0.3, 0, 400), 'impact');
  assert.equal(k(0.07, 0, 450), 'pop');
  assert.equal(k(0.8, 0, 2600), 'ding');
  assert.equal(k(0.25, 0, 1500), 'other');
});

test('writeSfx finds library effects in a soundtrack with their kinds, clips and a spectrogram sheet', async () => {
  const sourceDir = tmp();
  const wav = join(sourceDir, 'audio.wav');
  const placed = [{ kind: 'pop', t: 0.5 }, { kind: 'click', t: 2 }, { kind: 'whoosh', t: 3.5 }, { kind: 'ding', t: 5 }, { kind: 'impact', t: 7 }];
  writeFileSync(wav, wavBytes(mix(8.5, placed)));
  const res = await writeSfx(sourceDir, wav, []);

  assert.equal(res.dense, false);
  assert.deepEqual(res.events.map((e) => e.kindGuess), ['pop', 'click', 'whoosh', 'ding', 'impact']);
  res.events.forEach((e, i) => {
    // The whoosh is reported where it becomes audible (−20 dB of its swell), ~60 ms in.
    assert.ok(e.t >= placed[i].t - 0.02 && e.t <= placed[i].t + 0.1, `${e.kindGuess} at ${e.t}`);
    assert.ok(e.dur > 0 && e.dur <= 1.5);
    assert.ok(e.peakDb < -8 && e.peakDb > -10, `${e.kindGuess} ${e.peakDb} dB`);
    assert.equal(e.clip, `sfx/${String(i + 1).padStart(2, '0')}.wav`);
    assert.ok(existsSync(join(sourceDir, 'sfx', `${String(i + 1).padStart(2, '0')}.wav`)));
  });
  assert.equal(res.sheet, 'sfx/sheet.png');
  assert.ok(existsSync(join(sourceDir, 'sfx', 'sheet.png')));
  assert.deepEqual(JSON.parse(readFileSync(join(sourceDir, 'sfx.json'), 'utf-8')), res);
});

// Quiet "speech": 150 ms syllables of noise with a 30 ms rise, every 250 ms over [from, to).
function speech(out, rate, from, to, amp) {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
  for (let s = from; s < to; s += 0.25) {
    for (let j = 0; j < 0.15 * rate; j++) out[Math.round(s * rate) + j] += amp * rnd() * Math.min(1, j / (0.03 * rate));
  }
  return out;
}

test('effects inside spoken words are dropped unless they stand well above the speech', () => {
  const words = [{ text: 'all', start: 0.4, end: 3.1 }];
  const quiet = speech(mix(3.5, [{ kind: 'pop', t: 1.62, amp: 0.08 }], DETECT_RATE), DETECT_RATE, 0.5, 3, 0.08);
  const loud = speech(mix(3.5, [{ kind: 'pop', t: 1.62, amp: 0.9 }], DETECT_RATE), DETECT_RATE, 0.5, 3, 0.08);
  assert.deepEqual(detectSfx(quiet, DETECT_RATE, words).events, []);
  const kept = detectSfx(loud, DETECT_RATE, words).events;
  assert.equal(kept.length, 1);
  assert.ok(Math.abs(kept[0].t - 1.62) < 0.02, `pop at ${kept[0].t}`);
  // Without a transcript every syllable is a candidate.
  assert.ok(detectSfx(quiet, DETECT_RATE, []).events.length >= 10);
});

test('a dense soundtrack keeps the strongest 60 events in time order and says so', () => {
  const placed = Array.from({ length: 80 }, (_, i) => ({ kind: 'click', t: 0.2 + i * 0.15, amp: i % 2 ? 0.3 : 0.9 }));
  const { events, dense } = detectSfx(mix(12.5, placed, DETECT_RATE), DETECT_RATE);
  assert.equal(dense, true);
  assert.equal(events.length, 60);
  assert.deepEqual(events.map((e) => e.t), [...events.map((e) => e.t)].sort((a, b) => a - b));
  for (let i = 0; i < 80; i += 2) assert.ok(events.some((e) => Math.abs(e.t - placed[i].t) < 0.02), `loud click ${placed[i].t} kept`);
});

test('matchSfx pairs source effects with template cues within two frames and reports the rest', () => {
  const board = { name: 'Points02', start: 0, end: 4 };
  const events = [{ t: 1.0, kindGuess: 'pop' }, { t: 2.0, kindGuess: 'whoosh' }, { t: 2.5, kindGuess: 'ding' }];
  const cues = [{ t: 1.067, kind: 'pop' }, { t: 2.6, kind: 'ding' }, { t: 3, kind: 'ding' }];
  assert.deepEqual(matchSfx(board, events, cues, 30).map((i) => i.note), [
    'sfx 2s (whoosh) has no cue in the template',
    'sfx 2.5s (ding) has no cue in the template',
    'template sfx cue 2.6s (ding) has no sound in the source',
    'template sfx cue 3s (ding) has no sound in the source',
  ]);
  assert.deepEqual(matchSfx(board, [{ t: 1, kindGuess: 'pop' }], [{ t: 1.05, kind: 'pop' }], 30), []);
});

test('firstCues keeps each cue id once at its earliest time across capture pages', () => {
  const cues = firstCues([
    [{ id: 'a', kind: 'pop', gain: 1, t: 0.5 }, { id: 'b', kind: 'ding', gain: 1, t: 1 }],
    [{ id: 'a', kind: 'pop', gain: 1, t: 2 }, { id: 'c', kind: 'click', gain: 0.6, t: 2 }],
  ]);
  assert.deepEqual(cues.map((c) => [c.id, c.t]), [['a', 0.5], ['b', 1], ['c', 2]]);
});

test('sfxTracker reports [data-sfx] elements the first time they are visible', { skip: !runtimeReady && 'runtime not installed' }, async () => {
  const { chromium } = requireRuntime('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<div data-time-offset="1.5">
      <div id="a" data-sfx="pop" style="width:10px;height:10px"></div>
      <div id="wrap" style="opacity:0.04"><div id="b" data-sfx="ding" data-sfx-gain="0.6" style="width:10px;height:10px"></div></div>
      <div id="c" data-sfx="click" data-sfx-id="tick" style="width:0;height:10px"></div>
    </div>`);
    // The wrapper's scene started 1.5 s before the active one, which starts at 4 s.
    const track = sfxTracker(page, { sceneStart: () => 4 });
    assert.deepEqual(await track(0), [{ id: '2.5:pop0', kind: 'pop', gain: 1, t: 0 }]);
    assert.deepEqual(await track(0.033), []);
    await page.evaluate(() => { document.getElementById('wrap').style.opacity = '1'; document.getElementById('c').style.width = '5px'; });
    assert.deepEqual(await track(0.0667), [{ id: '2.5:ding1', kind: 'ding', gain: 0.6, t: 0.067 }, { id: 'tick', kind: 'click', gain: 1, t: 0.067 }]);
  } finally {
    await browser.close();
  }
});

test('the review bridge posts { tapvid: "sfx" } for elements entering during playback, not after a seek', { skip: !runtimeReady && 'runtime not installed' }, async () => {
  const dir = tmp();
  const player = `window.scenePlayer = { t: 0, getCurrentTime() { return this.t; }, getDuration() { return 10; }, play() {}, pause() {}, seekTo(s) { this.t = s; } };
    document.getElementById('root').innerHTML = '<div data-time-offset="0"><div id="a" data-sfx="pop" data-sfx-gain="0.6" style="opacity:0;width:10px;height:10px"></div><div id="b" data-sfx="whoosh" style="display:none;width:10px;height:10px"></div></div>';`;
  const html = readFileSync(join(SCRIPTS, '..', 'assets', 'template', 'template.html'), 'utf-8').replace('/*__BUNDLE__*/', player);
  writeFileSync(join(dir, 'child.html'), html);
  writeFileSync(join(dir, 'parent.html'), `<script>window.msgs = []; addEventListener('message', (e) => { if (e.data && e.data.tapvid === 'sfx') msgs.push(e.data); });</script><iframe src="child.html"></iframe>`);
  const { chromium } = requireRuntime('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(join(dir, 'parent.html')).href);
    const child = await (await page.waitForSelector('iframe')).contentFrame();
    await child.waitForFunction(() => window.scenePlayer !== undefined);
    const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));
    await settle();
    await child.evaluate(() => { scenePlayer.t = 0.5; document.getElementById('a').style.opacity = '1'; });
    await page.waitForFunction(() => window.msgs.length === 1);
    assert.deepEqual(await page.evaluate(() => window.msgs), [{ tapvid: 'sfx', kind: 'pop', gain: 0.6 }]);
    // A seek (here backwards) re-arms the seen-set with what is on screen: the pop does not fire again.
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ tapvid: 'cmd', cmd: 'seek', t: 0.2 }, '*'));
    await settle();
    await child.evaluate(() => { scenePlayer.t = 0.6; document.getElementById('b').style.display = 'block'; });
    await page.waitForFunction(() => window.msgs.length === 2);
    await settle();
    assert.deepEqual(await page.evaluate(() => window.msgs), [{ tapvid: 'sfx', kind: 'pop', gain: 0.6 }, { tapvid: 'sfx', kind: 'whoosh', gain: 1 }]);
  } finally {
    await browser.close();
  }
});
