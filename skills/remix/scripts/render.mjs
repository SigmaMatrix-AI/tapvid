#!/usr/bin/env node
// Step 9 (spec §8): generate and build the final project, capture every frame in parallel
// pages, encode, and mix the audio from replica.resolved into out/tapvid.mp4 (1080p, no draft).
//   node render.mjs <replica-dir> [--workers N] [--no-build]
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, fromPosixRel, launchBrowser, parseArgs, readJson, run } from './lib/common.mjs';
import { firstCues, openProject, sfxTracker } from './lib/capture.mjs';
import { buildProject, generateProject, projectDirFor } from './lib/project.mjs';
import { loadReplica } from './lib/replica.mjs';
import { resolveSfx } from './lib/sfx.mjs';

// BGM level under narration before sidechain ducking, and the fade at both ends (spec §8).
const BGM_UNDER_VOICE = 0.55;
const FADE_S = 0.5;
// Sound effects under the voice: the library renders every kind at −3 dBFS peak, as loud as
// the narration's own peaks; at half that (−6 dB) a pop accents an entrance without masking
// the word it lands on. A board's data-sfx-gain scales it further.
const SFX_GAIN = 0.5;

const args = parseArgs();
if (!args._[0]) fail('usage: render.mjs <replica-dir> [--workers N] [--no-build]', 2);
const ctx = loadReplica(args._[0]);
const { replica } = ctx;
let meta;
try {
  meta = args['no-build'] ? { dir: projectDirFor(ctx.dir, 'final'), ...readJson(join(projectDirFor(ctx.dir, 'final'), 'project.json')) } : generateProject(ctx.dir, { mode: 'final' });
  if (!args['no-build']) buildProject(meta.dir);
} catch (e) {
  fail(e.stderr?.toString() || e.message);
}
for (const w of meta.warnings || []) console.error(`warning: ${w}`);
const dir = meta.dir;
const rate = meta.fps;
// Half the cores (capped at 4): each page plus its ffmpeg encoder keeps about two cores busy.
const workers = Number(args.workers) || Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));
const outDir = join(ctx.dir, 'out');
const parts = join(outDir, '.parts');
rmSync(parts, { recursive: true, force: true });
mkdirSync(parts, { recursive: true });

const t0 = Date.now();
const browser = await launchBrowser();
let duration;
let jobs = 0;
let cues = [];
try {
  const probe = await openProject(dir, meta.canvas, { browser });
  duration = probe.duration;
  await probe.close();
  const total = Math.round(duration * rate);
  const per = Math.ceil(total / workers);
  const ranges = [];
  for (let w = 0; w < workers; w++) {
    const from = w * per;
    const to = Math.min(total, from + per);
    if (from < to) ranges.push([from, to]);
  }
  cues = firstCues(await Promise.all(ranges.map(([from, to], i) => renderRange(i, from, to))));
  writeFileSync(join(dir, 'sfx-cues.json'), JSON.stringify({ cues }, null, 2) + '\n', 'utf-8');
  jobs = ranges.length;
  writeFileSync(join(parts, 'list.txt'), ranges.map((_, i) => `file 'part-${i}.mp4'`).join('\n') + '\n', 'utf-8');
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(parts, 'list.txt'), '-c', 'copy', join(parts, 'video.mp4')]);
} finally {
  await browser.close();
}

async function renderRange(index, from, to) {
  const cap = await openProject(dir, meta.canvas, { browser });
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(rate), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(rate),
    join(parts, `part-${index}.mp4`)], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
  const sceneStart = (t) => meta.scenes.filter((s) => s.start <= t + 1e-6).pop()?.start ?? 0;
  const track = sfxTracker(cap.page, { sceneStart });
  const found = [];
  for (let f = from; f < to; f++) {
    await cap.seek(f / rate);
    found.push(...await track(f / rate));
    const buf = await cap.shot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
  if (cap.errors.length) console.error(`page errors (worker ${index}):\n  ${[...new Set(cap.errors)].join('\n  ')}`);
  await cap.close();
  return found;
}

// Audio: each scene's narration (or avatar track) at start + audioOffset, BGM under it, and each
// sound-effect cue at its time (not ducked: the sidechain applies to the BGM only).
function audioGraph() {
  const mode = replica.audio?.mode || 'narration';
  if (mode === 'silent') return null;
  const inputs = [];
  const filters = [];
  const voices = [];
  for (const s of meta.scenes) {
    const r = replica.resolved?.[s.key];
    const src = r?.audio && fromPosixRel(ctx.dir, r.audio);
    if (!src || !existsSync(src)) continue;
    const i = inputs.length / 2 + 1; // input 0 is the video
    inputs.push('-i', src);
    const ms = Math.round((s.start + (r.audioOffset || 0)) * 1000);
    const len = Math.max(0, s.duration - (r.audioOffset || 0));
    filters.push(`[${i}:a]atrim=0:${len.toFixed(3)},adelay=${ms}|${ms},aformat=channel_layouts=stereo[v${voices.length}]`);
    voices.push(`[v${voices.length}]`);
  }
  const sfx = [];
  for (const c of replica.audio?.sfx === false ? [] : cues) {
    let file;
    try {
      file = resolveSfx(ctx.templateDir, c.kind);
    } catch (e) {
      console.error(`warning: sound effect ${c.id} skipped (${e.message})`);
      continue;
    }
    const i = inputs.length / 2 + 1; // pairs only, so BGM can still go last
    inputs.push('-i', file);
    const ms = Math.round(c.t * 1000);
    filters.push(`[${i}:a]aformat=channel_layouts=stereo,adelay=${ms}:all=1,volume=${(SFX_GAIN * c.gain).toFixed(3)}[s${sfx.length}]`);
    sfx.push(`[s${sfx.length}]`);
  }
  const bgm = replica.audio?.bgm;
  const bgmRel = bgm?.path || bgm?.candidates?.[bgm.selected || 0]?.path;
  const bgmPath = bgmRel && fromPosixRel(ctx.dir, bgmRel);
  const hasBgm = Boolean(bgmPath && existsSync(bgmPath));
  if (hasBgm) {
    const i = inputs.length / 2 + 1; // BGM is the last input, so the pair count still holds here
    inputs.push('-stream_loop', '-1', '-i', bgmPath);
    const fadeAt = Math.max(0, duration - FADE_S).toFixed(3);
    filters.push(`[${i}:a]atrim=0:${duration.toFixed(3)},afade=t=in:d=${FADE_S},afade=t=out:st=${fadeAt}:d=${FADE_S},`
      + `volume=${voices.length ? BGM_UNDER_VOICE : 1},aformat=channel_layouts=stereo[bgm]`);
  }
  if (!voices.length && !hasBgm && !sfx.length) return null;
  if (voices.length) {
    filters.push(`${voices.join('')}amix=inputs=${voices.length}:normalize=0[vo]`);
    if (hasBgm) {
      filters.push('[vo]asplit=2[vo1][vo2]', '[bgm][vo2]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]',
        '[vo1][duck]amix=inputs=2:normalize=0[mix]');
    } else filters.push('[vo]anull[mix]');
  } else if (hasBgm) filters.push('[bgm]anull[mix]');
  if (sfx.length) {
    filters.push(`${sfx.join('')}amix=inputs=${sfx.length}:normalize=0[sfx]`,
      voices.length || hasBgm ? '[mix][sfx]amix=inputs=2:normalize=0[all]' : '[sfx]anull[all]');
  } else filters.push('[mix]anull[all]');
  filters.push(`[all]apad,atrim=0:${duration.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
  return { inputs, filters };
}

const video = join(parts, 'video.mp4');
const final = join(outDir, 'tapvid.mp4');
const graph = audioGraph();
if (graph) {
  run('ffmpeg', ['-y', '-v', 'error', '-i', video, ...graph.inputs, '-filter_complex', graph.filters.join(';'),
    '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', final]);
} else {
  run('ffmpeg', ['-y', '-v', 'error', '-i', video, '-c:v', 'copy', '-an', final]);
}
rmSync(parts, { recursive: true, force: true });
console.log(JSON.stringify({ out: final, duration, fps: rate, workers: jobs, seconds: (Date.now() - t0) / 1000 }));
