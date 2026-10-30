#!/usr/bin/env node
// Render a Tone.js score to mp3 + beat grid, offline in headless Chromium (spec §4 step 8).
//   node music-compose.mjs <replica-dir> <score.js> --seconds 30 --out assets/audio/candidates/1.mp3 [--cues cues.json]
// Paths are relative to the replica dir. Writes <out> and <out without .mp3>.beats.json
// ({ bpm, beatsPerBar, offset, beats, bars }). `--cues` passes scene boundaries / accents
// (seconds) to the score as `cues`; in music-only mode pass the source beat times so the
// score's changes land on the cuts.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ASSETS_DIR, PLUGIN, fail, launchBrowser, parseArgs, readJson, run, runtimePath, writeJson } from './lib/common.mjs';
import { ensureSamples } from './lib/vsco.mjs';

// Tail fade so a score cut at the film's length never ends mid-note.
const TAIL_FADE_S = 1.5;

const args = parseArgs();
const dir = resolve(args._[0] || '.');
const seconds = Number(args.seconds);
if (!args._[1] || !(seconds > 0) || typeof args.out !== 'string') {
  fail('usage: music-compose.mjs <replica-dir> <score.js> --seconds N --out <mp3> [--cues file.json]', 2);
}
const scoreFile = resolve(dir, args._[1]);
const out = resolve(dir, args.out);
const cues = typeof args.cues === 'string' ? readJson(resolve(dir, args.cues)) : [];

const ORIGIN = 'http://tapvid-music.local';
const files = {
  '/': { body: '<!doctype html><html><body></body></html>', type: 'text/html' },
  '/tone.js': { path: runtimePath('tone', 'build', 'Tone.js'), type: 'text/javascript' },
  '/runtime.js': { path: join(ASSETS_DIR, 'template', 'music', 'runtime.js'), type: 'text/javascript' },
  '/score.js': { path: scoreFile, type: 'text/javascript' },
};
const t0 = Date.now();
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const f = files[path];
    if (!f) return route.fulfill({ status: 404, body: 'not found' });
    return f.path ? route.fulfill({ path: f.path, contentType: f.type }) : route.fulfill({ body: f.body, contentType: f.type });
  });
  await page.goto(`${ORIGIN}/`);
  for (const s of ['/tone.js', '/runtime.js', '/score.js']) await page.addScriptTag({ url: `${ORIGIN}${s}` });
  const meta = await page.evaluate(() => window.__scoreMeta());
  if (!meta || !(meta.bpm > 0)) throw new Error('score must call score({ bpm, compose, ... })');

  // Serve every sample through the same origin so Tone's fetch can load it.
  const local = await ensureSamples(meta.instruments, meta.oneShots);
  const samples = { instruments: {}, oneShots: {} };
  let n = 0;
  const serve = (abs) => { const p = `/s/${n++}.mp3`; files[p] = { path: abs, type: 'audio/mpeg' }; return `${ORIGIN}${p}`; };
  for (const [name, inst] of Object.entries(local.instruments)) {
    samples.instruments[name] = { release: inst.release, urls: Object.fromEntries(Object.entries(inst.urls).map(([k, v]) => [k, serve(v)])) };
  }
  for (const [name, abs] of Object.entries(local.oneShots)) samples.oneShots[name] = serve(abs);

  const b64 = await page.evaluate((o) => window.__render(o), { seconds, samples, cues });
  mkdirSync(dirname(out), { recursive: true });
  const wav = `${out}.wav`;
  writeFileSync(wav, Buffer.from(b64, 'base64'));
  const fadeAt = Math.max(0, seconds - TAIL_FADE_S).toFixed(3);
  run('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-af', `afade=t=out:st=${fadeAt}:d=${TAIL_FADE_S},loudnorm=I=-16:TP=-1.5:LRA=11`,
    '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', out]);
  rmSync(wav, { force: true });

  const beat = 60 / meta.bpm;
  const beats = [];
  for (let t = 0; t < seconds - 1e-6; t += beat) beats.push(Number(t.toFixed(3)));
  writeJson(out.replace(/\.mp3$/, '') + '.beats.json', {
    bpm: meta.bpm, beatsPerBar: meta.beatsPerBar, offset: 0, beats,
    bars: beats.filter((_, i) => i % meta.beatsPerBar === 0),
  });
  console.log(JSON.stringify({ out, seconds, bpm: meta.bpm, instruments: meta.instruments, renderSeconds: (Date.now() - t0) / 1000 }));
} finally {
  await browser.close();
}
