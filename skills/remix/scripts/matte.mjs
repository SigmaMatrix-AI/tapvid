#!/usr/bin/env node
// Cut the people out of video clips for "behind the subject" layers (references/boards.md §8): writes
// <clip>.cutout.webm next to each clip (the picture with all but the people transparent). Skips a clip
// whose cutout is newer than it unless --force. Installs the engine and the model on first use.
//   node matte.mjs <clip.mp4>... [--force]
// Prints one line per clip: the cutout path, or "fresh <path>" when it was already up to date.
import { resolve } from 'node:path';
import { fail, parseArgs } from './lib/common.mjs';
import { cutoutFresh, cutoutPath, matte } from './lib/matte.mjs';

const args = parseArgs();
if (!args._.length) fail('usage: matte.mjs <clip.mp4>... [--force]', 2);
for (const clip of args._.map((f) => resolve(f))) {
  if (!args.force && cutoutFresh(clip)) { console.log(`fresh ${cutoutPath(clip)}`); continue; }
  try {
    const { out, frames, seconds } = await matte(clip, { log: (m) => console.error(m) });
    console.error(`${frames} frames in ${seconds}s`);
    console.log(out);
  } catch (e) {
    fail(e.message);
  }
}
// onnxruntime-node can deadlock Node's shutdown (a V8 worker parked on a GC barrier while the main thread
// drains tasks); exit outright once every cutout is written.
process.exit(0);
