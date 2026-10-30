#!/usr/bin/env node
// Step 2 (spec §4): read the source at frame level.
//   node intake.mjs <project> <source> [--no-transcribe] [--understand]
// Writes source/{source.mp4, source.json, audio.wav, transcript.json, timeline.json, sfx.json,
// sfx/, understanding.json, frames/overview.jpg, frames/shots/<n>/}.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseArgs, readJson, writeJson } from './lib/common.mjs';
import { check } from './lib/schema.mjs';
import { buildShots, hardCuts, motionPeaks, shotFrames, softTransitions } from './lib/cuts.mjs';
import { writeSfx } from './lib/sfx-detect.mjs';
import { detectBeats } from './lib/tempo.mjs';
import { decodePcm, extractAudio, ffmpeg, frameMetrics, hasFilter, probe, videoInfo } from './lib/video.mjs';

const BEAT_SAMPLE_RATE = 11025;
// Overview tile: one frame per second, this many per row at this width.
const OVERVIEW_COLS = 10;
const OVERVIEW_W = 192;
// Shot strip: frames per row and cell width.
const STRIP_COLS = 6;
const STRIP_W = 320;

const round3 = (v) => Number(v.toFixed(3));

// Burned-in timestamp (seconds of the source). drawtext needs an ffmpeg built with libfreetype;
// without it frames are still extracted and the times stay in the file names.
const stamp = () => (hasFilter('drawtext')
  ? "drawtext=text='%{pts\\:flt}':x=8:y=8:fontsize=h/14:fontcolor=white:box=1:boxcolor=black@0.6,"
  : '');

async function copySource(src, dst) {
  if (resolve(src) === resolve(dst)) return;
  mkdirSync(dirname(dst), { recursive: true });
  if (extname(src).toLowerCase() === '.mp4') copyFileSync(src, dst);
  else await ffmpeg(['-i', src, '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', dst]);
}

// ffprobe output plus url / title / author from a downloader's info.json next to the source.
function sourceJson(src, probed) {
  const dir = dirname(src);
  const stem = basename(src, extname(src));
  const infoPath = [join(dir, `${stem}.info.json`), join(dir, 'info.json')].find(existsSync);
  const info = infoPath ? readJson(infoPath) : {};
  const pick = (...keys) => keys.map((k) => info[k]).find((v) => v !== undefined && v !== null) ?? null;
  return { ...probed, url: pick('url', 'webpage_url', 'original_url'), title: pick('title'), author: pick('author', 'uploader', 'channel') };
}

// One media request through the runner; null (with a warning) when no provider can serve it.
async function runMedia(sourceDir, request, log) {
  const [{ loadRegistry }, { createSecrets }, { loadConfig }, { createRunner }] = await Promise.all([
    import('./lib/media/registry.mjs'), import('./lib/media/secrets.mjs'), import('./lib/media/router.mjs'), import('./lib/media/runner.mjs'),
  ]);
  const runner = createRunner({ registry: await loadRegistry(), secrets: createSecrets(), config: loadConfig(), log });
  const [res] = await runner.runPlan([request], { planDir: sourceDir, tasksPath: join(sourceDir, 'media-tasks.json') });
  if (res.status !== 'completed' || !res.files?.length) {
    log(`warning: ${request.capability} skipped (${res.error?.message || 'no result'})`);
    return null;
  }
  return readJson(join(sourceDir, ...res.files[0].path.split('/')));
}

async function overview(src, out, duration) {
  const count = Math.max(1, Math.ceil(duration));
  const cols = Math.min(OVERVIEW_COLS, count);
  const rows = Math.ceil(count / cols);
  await ffmpeg(['-i', src, '-an', '-vf', `fps=1,${stamp()}scale=${OVERVIEW_W}:-2,tile=${cols}x${rows}`, '-frames:v', '1', '-update', '1', out]);
}

// Dense frames of one shot (named f<frame>_<seconds>.jpg) and its strip, in one decode of the
// shot's own span: seek near it, keep source timestamps, select the wanted frames by time.
async function shotFramesAndStrip(src, shot, frames, fps, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const half = 0.4 / fps;
  const all = frames.map((f) => `between(t,${(f / fps - half).toFixed(4)},${(f / fps + half).toFixed(4)})`);
  // ffmpeg's expression parser fails past ~100 chained terms; group them so long shots still parse.
  const groups = [];
  for (let i = 0; i < all.length; i += 20) groups.push(`(${all.slice(i, i + 20).join('+')})`);
  const terms = groups.join('+');
  const cols = Math.min(STRIP_COLS, frames.length);
  const rows = Math.ceil(frames.length / cols);
  const from = Math.max(0, frames[0] / fps - 0.5);
  const to = frames[frames.length - 1] / fps + 0.5;
  const graph = `[0:v]${stamp()}select='${terms}',split[f][s];[s]scale=${STRIP_W}:-2,tile=${cols}x${rows}[strip]`;
  await ffmpeg(['-ss', from.toFixed(4), '-to', to.toFixed(4), '-copyts', '-i', src, '-filter_complex', graph,
    '-map', '[f]', '-fps_mode', 'passthrough', '-q:v', '3', join(dir, 'tmp-%04d.jpg'),
    '-map', '[strip]', '-frames:v', '1', '-q:v', '3', '-update', '1', join(dir, 'strip.jpg')]);
  const index = [];
  frames.forEach((f, k) => {
    const tmp = join(dir, `tmp-${String(k + 1).padStart(4, '0')}.jpg`);
    if (!existsSync(tmp)) return;
    const name = `f${String(f).padStart(5, '0')}_${(f / fps).toFixed(3)}.jpg`;
    writeFileSync(join(dir, name), readFileSync(tmp));
    rmSync(tmp);
    index.push({ frame: f, t: round3(f / fps), file: name });
  });
  writeJson(join(dir, 'frames.json'), { shot: shot.index, frames: index });
}

export async function intake(projectArg, sourceArg, { transcribe: doTranscribe = true, understand: doUnderstand = false, log = console.error } = {}) {
  const project = resolve(projectArg);
  const sourceDir = join(project, 'source');
  const src = join(sourceDir, 'source.mp4');
  await copySource(resolve(sourceArg), src);
  const probed = probe(src);
  writeJson(join(sourceDir, 'source.json'), sourceJson(resolve(sourceArg), probed));
  const info = videoInfo(probed);
  const { fps } = info;

  log('measuring every frame…');
  const metrics = await frameMetrics(src);
  const cuts = hardCuts(metrics);
  const softs = softTransitions(metrics, fps, cuts);
  const shots = buildShots(metrics.frames, fps, cuts, softs);
  const peaks = motionPeaks(metrics, fps, shots);
  log(`${shots.length} shots, ${cuts.length} cuts, ${softs.length} soft transitions, ${peaks.length} motion peaks`);

  let words = [];
  let beats = null;
  if (info.hasAudio) {
    const wav = join(sourceDir, 'audio.wav');
    await extractAudio(src, wav);
    if (doTranscribe) {
      const transcript = await runMedia(sourceDir, { id: 'transcribe', capability: 'speech.transcribe', params: { file: 'audio.wav' }, out: 'media/transcript' }, log);
      if (transcript) writeJson(join(sourceDir, 'transcript.json'), transcript);
      words = transcript?.words || [];
    }
    beats = detectBeats(await decodePcm(wav, BEAT_SAMPLE_RATE), BEAT_SAMPLE_RATE, metrics.frames / fps);
    const sfx = await writeSfx(sourceDir, wav, words);
    log(`${sfx.events.length} sound effects${sfx.dense ? ' (dense soundtrack: the strongest kept)' : ''}`);
  } else log('no audio track: audio.wav, transcript, beats and sound effects skipped');

  log('extracting frames…');
  const framesDir = join(sourceDir, 'frames');
  mkdirSync(framesDir, { recursive: true });
  await overview(src, join(framesDir, 'overview.jpg'), metrics.frames / fps);
  for (const shot of shots) {
    await shotFramesAndStrip(src, shot, shotFrames(shot, fps, peaks), fps, join(framesDir, 'shots', String(shot.index)));
  }

  const timeline = {
    fps, duration_s: round3(metrics.frames / fps), frames: metrics.frames, shots, motion_peaks: peaks,
    words: words.map((w) => ({ text: w.text, start: w.start, end: w.end })), beats,
  };
  const errors = check('timeline', timeline);
  if (errors.length) throw new Error(`timeline.json is invalid:\n${errors.join('\n')}`);
  writeJson(join(sourceDir, 'timeline.json'), timeline);

  if (doUnderstand) {
    const params = { file: 'source.mp4', shots: shots.map((s) => ({ start: s.start, end: s.end })) };
    const understanding = await runMedia(sourceDir, { id: 'understand', capability: 'video.understand', params, out: 'media/understanding' }, log);
    if (understanding) writeJson(join(sourceDir, 'understanding.json'), understanding);
  }
  return timeline;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  const [project, source] = args._;
  if (!project || !source) fail('usage: node intake.mjs <project> <source> [--no-transcribe] [--understand]');
  try {
    const tl = await intake(project, source, { transcribe: !args['no-transcribe'], understand: Boolean(args.understand) });
    console.log(`timeline: ${tl.shots.length} shots over ${tl.duration_s}s at ${tl.fps} fps -> ${join(resolve(project), 'source', 'timeline.json')}`);
  } catch (e) {
    fail(e.message);
  }
}
