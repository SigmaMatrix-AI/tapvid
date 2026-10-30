#!/usr/bin/env node
// Step 3.6 (spec §4, §6.4): reference media per image / video slot, from analysis/boards.json.
//   node refs.mjs <project> [--only Board[,Board]]
// A board's `media` maps a slot path to { crop: [x, y, w, h] (0–1 of the source frame),
// window?: { start, end } (source seconds; default the board window), frame_t? (source seconds;
// default the window middle), subjects: [{ id, kind, box: [x, y, w, h] (0–1 of the cropped slot),
// t (source seconds) }] }. Writes template/refs/<Board>.<path>.{mp4,png}, refs/subjects/<id>.png
// and merges template/refs/refs.json, keeping the `describe` texts already written.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneDir, fail, parseArgs, readJson, writeJson } from './lib/common.mjs';
import { check } from './lib/schema.mjs';
import { cutClip, grabFrame } from './lib/video.mjs';

const FULL_FRAME = [0, 0, 1, 1];
const round3 = (v) => Number(v.toFixed(3));

// A subject box inside the slot crop, as a box of the whole source frame.
export function subjectCrop(crop, box) {
  const [cx, cy, cw, ch] = crop;
  const [bx, by, bw, bh] = box;
  return [cx + bx * cw, cy + by * ch, bw * cw, bh * ch].map((v) => round3(Math.min(1, Math.max(0, v))));
}

export async function extractRefs(projectArg, { only, log = console.log } = {}) {
  const project = cloneDir(projectArg);
  const src = join(project, 'source', 'source.mp4');
  const refsDir = join(project, 'template', 'refs');
  const analysis = readJson(join(project, 'analysis', 'boards.json'));
  const existing = readJson(join(refsDir, 'refs.json'), {});
  const refs = { ...existing };
  const boards = analysis.boards.filter((b) => !only || only.includes(b.name));
  if (only && !boards.length) throw new Error(`no board named ${only.join(', ')} in analysis/boards.json`);

  for (const b of boards) {
    for (const [path, m] of Object.entries(b.media || {})) {
      const key = `${b.name}.${path}`;
      const crop = m.crop || FULL_FRAME;
      const window = { start: round3(m.window?.start ?? b.start), end: round3(m.window?.end ?? b.end) };
      if (!(window.end > window.start)) throw new Error(`${key}: window ${window.start}–${window.end} is empty`);
      const clip = `${key}.mp4`;
      const frame = `${key}.png`;
      await cutClip(src, window.start, window.end, join(refsDir, clip), { crop });
      await grabFrame(src, m.frame_t ?? (window.start + window.end) / 2, join(refsDir, frame), { fps: analysis.fps, crop });
      const subjects = [];
      for (const s of m.subjects || []) {
        const image = `subjects/${s.id}.png`;
        await grabFrame(src, s.t ?? (window.start + window.end) / 2, join(refsDir, ...image.split('/')),
          { fps: analysis.fps, crop: subjectCrop(crop, s.box || FULL_FRAME) });
        subjects.push({ id: s.id, kind: s.kind, image, ...(s.note ? { note: s.note } : {}) });
      }
      refs[key] = { clip, frame, window, crop, subjects, ...(existing[key]?.describe ? { describe: existing[key].describe } : {}) };
      log(`${key}: ${window.start}–${window.end}s, ${subjects.length} subject(s)`);
    }
  }
  const errors = check('refs', refs);
  if (errors.length) throw new Error(`refs.json is invalid:\n${errors.join('\n')}`);
  writeJson(join(refsDir, 'refs.json'), refs);
  return refs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  if (!args._[0]) fail('usage: node refs.mjs <project> [--only Board[,Board]]');
  try {
    await extractRefs(args._[0], { only: typeof args.only === 'string' ? args.only.split(',') : undefined });
  } catch (e) {
    fail(e.message);
  }
}
