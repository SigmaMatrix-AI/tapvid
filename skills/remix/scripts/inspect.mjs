#!/usr/bin/env node
// Step 7 (spec §4): frames of a generated clip for the anatomy / product / subject-drift check.
// Frames are written one per file, never tiled, at a size where fingers can be counted.
//   node inspect.mjs <replica-dir> <request-id | file> [--fps 2] [--width 720] [--identity]
// --identity is the read the identity gate asks for (lib/identity.mjs): the first second at 8 fps, the
// rest at 2 fps, at full width, because a person can be a few dozen pixels in a wide or overhead shot.
// Prints JSON: { clip, duration, frames: [{ time, path }] } with paths relative to the replica.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fail, fromPosixRel, parseArgs, readJson, run, toPosixRel } from './lib/common.mjs';
import { recordInspection } from './lib/identity.mjs';

const IDENTITY = { headS: 1, headFps: 8, restFps: 2, width: 1920 };

const args = parseArgs();
const [dirArg, target] = args._;
if (!dirArg || !target) fail('usage: inspect.mjs <replica-dir> <request-id | file> [--fps 2] [--width 720] [--identity]', 2);
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
const duration = Number(Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip])).toFixed(3));
const grab = (seek, fps, count, name) => run('ffmpeg', ['-v', 'error', '-y', ...(seek ? ['-ss', String(seek)] : []), '-i', clip,
  '-vf', `fps=${fps},scale=${args.identity ? IDENTITY.width : width}:-2`, '-q:v', '3', ...(count ? ['-frames:v', String(count)] : []), join(out, name)]);

let times;
if (args.identity) {
  const head = Math.ceil(Math.min(duration, IDENTITY.headS) * IDENTITY.headFps);
  const rest = Math.ceil(Math.max(0, duration - IDENTITY.headS) * IDENTITY.restFps);
  grab(0, IDENTITY.headFps, head, 'a%02d.jpg');
  if (rest) grab(IDENTITY.headS, IDENTITY.restFps, rest, 'b%02d.jpg');
  times = (i) => (i < head ? i / IDENTITY.headFps : IDENTITY.headS + (i - head) / IDENTITY.restFps);
} else {
  grab(0, rate, 0, '%02d.jpg');
  times = (i) => i / rate;
}
const frames = readdirSync(out).filter((f) => f.endsWith('.jpg')).sort()
  .map((f, i) => ({ time: Number(times(i).toFixed(3)), path: toPosixRel(dir, join(out, f)) }));
if (args.identity && fromTask) recordInspection(dir, id, clip);
console.log(JSON.stringify({ clip: toPosixRel(dir, clip), duration, frames }, null, 2));
