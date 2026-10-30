#!/usr/bin/env node
// Self-check frames (spec §4 steps 5 and 9.3), captured from a built project.
//   node frames.mjs <replica-dir> [--preview] [--no-build]
//     every scene's midpoint, start / middle / end of every transition (or just before / at /
//     after a hard cut) into review/frames/, and a 1-frame-per-second contact sheet
//     review/contact-sheet.jpg. Uses the final project when replica.resolved covers every
//     scene, else (or with --preview) the preview project.
//   node frames.mjs <replica-dir> --sketch <file.jsx> [--duration s]
//     25 / 50 / 85 % frames of one sketch into review/sketches/<name>-<pct>.jpg.
import { mkdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fail, fromPosixRel, parseArgs, readJson, run, toPosixRel } from './lib/common.mjs';
import { openProject } from './lib/capture.mjs';
import { buildProject, generateProject, generateSketchProject, projectDirFor } from './lib/project.mjs';
import { loadReplica, sceneKey } from './lib/replica.mjs';

const SKETCH_MARKS = [0.25, 0.5, 0.85];
const SHEET_COLUMNS = 6;
const SHEET_TILE_WIDTH = 270;

const args = parseArgs();
if (!args._[0]) fail('usage: frames.mjs <replica-dir> [--preview] [--no-build] | --sketch <file.jsx> [--duration s]', 2);
const ctx = loadReplica(args._[0]);
const review = join(ctx.dir, 'review');
const saved = [];

async function grabAll(meta, marks, outDir) {
  mkdirSync(outDir, { recursive: true });
  const cap = await openProject(meta.dir, meta.canvas, { scale: 0.5 });
  try {
    for (const [t, name] of marks) {
      const time = Math.max(0, Math.min(cap.duration - 1 / meta.fps, t));
      await cap.seek(time);
      const path = join(outDir, `${name}.jpg`);
      await cap.shot({ type: 'jpeg', quality: 85, path });
      saved.push({ t: Number(time.toFixed(3)), path: toPosixRel(ctx.dir, path) });
    }
    return cap.duration;
  } finally {
    if (cap.errors.length) console.error(`page errors:\n  ${[...new Set(cap.errors)].join('\n  ')}`);
    await cap.close();
  }
}

// Media slot of a sketch file: its aspect and duration.
function slotOf(file) {
  for (const scene of ctx.replica.scenes) {
    for (const m of Object.values(scene.media || {})) {
      if (m.sketch && fromPosixRel(ctx.dir, m.sketch) === file) return m;
    }
  }
  return {};
}

try {
  if (args.sketch) {
    const file = resolve(args.sketch);
    const slot = slotOf(file);
    const duration = Number(args.duration) || slot.duration_s || 3;
    const meta = generateSketchProject(ctx.dir, file, { duration, aspect: slot.aspect });
    buildProject(meta.dir);
    const name = basename(file).replace(/\.jsx$/, '');
    await grabAll(meta, SKETCH_MARKS.map((p) => [duration * p, `${name}-${Math.round(p * 100)}`]), join(review, 'sketches'));
    rmSync(meta.dir, { recursive: true, force: true });
  } else {
    const complete = ctx.replica.scenes.every((s, i) => ctx.replica.resolved?.[sceneKey(i, s.board)]);
    const mode = args.preview || !complete ? 'preview' : 'final';
    const meta = args['no-build'] ? { dir: projectDirFor(ctx.dir, mode), ...readJson(join(projectDirFor(ctx.dir, mode), 'project.json')) } : generateProject(ctx.dir, { mode });
    if (!args['no-build']) buildProject(meta.dir);
    const items = meta.scenes;
    const step = 1 / meta.fps;
    const marks = items.map((it) => [it.start + it.duration / 2, `${it.key}-mid`]);
    for (let k = 1; k < items.length; k++) {
      const it = items[k];
      const T = it.transitionIn?.duration || 0;
      const at = T > 0 ? [it.start, it.start + T / 2, it.start + T] : [it.start - step, it.start, it.start + 2 * step];
      at.forEach((t, j) => marks.push([t, `boundary-${items[k - 1].key}-${it.key}-${j}`]));
    }
    const duration = await grabAll(meta, marks, join(review, 'frames'));
    const sheetDir = join(review, '.sheet');
    rmSync(sheetDir, { recursive: true, force: true });
    const n = Math.max(1, Math.floor(duration));
    const before = saved.length;
    await grabAll(meta, Array.from({ length: n }, (_, i) => [i + 0.5, String(i).padStart(3, '0')]), sheetDir);
    saved.splice(before);
    run('ffmpeg', ['-y', '-v', 'error', '-framerate', '1', '-i', join(sheetDir, '%03d.jpg'),
      '-vf', `scale=${SHEET_TILE_WIDTH}:-1,tile=${SHEET_COLUMNS}x${Math.ceil(n / SHEET_COLUMNS)}:padding=4:color=black`, '-frames:v', '1', join(review, 'contact-sheet.jpg')]);
    rmSync(sheetDir, { recursive: true, force: true });
    saved.push({ t: null, path: 'review/contact-sheet.jpg' });
  }
} catch (e) {
  fail(e.stderr?.toString() || e.message);
}
console.log(JSON.stringify(saved, null, 2));
