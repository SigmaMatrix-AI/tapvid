#!/usr/bin/env node
// Step 7 (spec §4): frames of a generated clip for the anatomy / product / subject-drift check.
// Frames are written one per file, never tiled, at a size where fingers can be counted.
//   node inspect.mjs <replica-dir> <request-id | file> [--fps 2] [--width 720]
// Prints JSON: { clip, duration, frames: [{ time, path }] } with paths relative to the replica.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fail, fromPosixRel, parseArgs, readJson, run, toPosixRel } from './lib/common.mjs';

const args = parseArgs();
const [dirArg, target] = args._;
if (!dirArg || !target) fail('usage: inspect.mjs <replica-dir> <request-id | file> [--fps 2] [--width 720]', 2);
const dir = resolve(dirArg);
const rate = Number(args.fps || 2);
const width = Number(args.width || 720);

const tasks = readJson(join(dir, 'tasks.json'), { tasks: {} });
const fromTask = tasks.tasks[target]?.result?.files?.find((f) => /^video\//.test(f.mime || '') || /\.(mp4|mov|webm)$/i.test(f.path));
const clip = fromTask ? fromPosixRel(dir, fromTask.path) : resolve(dir, target);
if (!existsSync(clip)) fail(`no clip for ${target} (neither a completed request in tasks.json nor a file)`);
const id = fromTask ? target : basename(clip).replace(/\.[^.]+$/, '');

const out = join(dir, 'review', 'gen', id);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run('ffmpeg', ['-v', 'error', '-y', '-i', clip, '-vf', `fps=${rate},scale=${width}:-2`, '-q:v', '3', join(out, '%02d.jpg')]);

const duration = Number(Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip])).toFixed(3));
const frames = readdirSync(out).filter((f) => f.endsWith('.jpg')).sort()
  .map((f, i) => ({ time: Number((i / rate).toFixed(2)), path: toPosixRel(dir, join(out, f)) }));
console.log(JSON.stringify({ clip: toPosixRel(dir, clip), duration, frames }, null, 2));
