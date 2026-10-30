#!/usr/bin/env node
// Generate (and build) a replica's render project (spec §8).
//   node project.mjs <replica-dir> --preview|--final [--out <dir>] [--no-build]
//   node project.mjs <replica-dir> --compare [--out <dir>] [--no-build]
// --preview / --final write <replica>/project, --compare writes <replica>/review/compare-project.
// Prints the project meta as JSON (mode, total, scenes, warnings).
import { resolve } from 'node:path';
import { fail, parseArgs } from './lib/common.mjs';
import { buildProject, generateProject } from './lib/project.mjs';

const args = parseArgs();
const mode = args.compare ? 'compare' : args.final ? 'final' : args.preview ? 'preview' : null;
if (!args._[0] || !mode) fail('usage: project.mjs <replica-dir> --preview|--final|--compare [--out <dir>] [--no-build]', 2);
try {
  const meta = generateProject(args._[0], { mode, out: typeof args.out === 'string' ? resolve(args.out) : undefined });
  if (!args['no-build']) buildProject(meta.dir);
  for (const w of meta.warnings) console.error(`warning: ${w}`);
  console.log(JSON.stringify({ dir: meta.dir, mode, total: meta.total, scenes: meta.scenes.map((s) => ({ key: s.key, start: s.start, duration: s.duration })) }, null, 2));
} catch (e) {
  fail(e.stderr?.toString() || e.message);
}
