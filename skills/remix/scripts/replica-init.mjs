#!/usr/bin/env node
// Step 4.1 (spec §4): skeleton replicas/<slug>/replica.json from the template — scenes in the
// template's default order seeded with each board's example data, one media entry per media
// field path with its reference material from refs.json.
//   node replica-init.mjs <project> <slug> --topic "…" [--language zh] [--force]
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cloneDir, fail, parseArgs, replicaDir, writeJson } from './lib/common.mjs';
import { check } from './lib/schema.mjs';
import { loadTemplate, mediaPaths } from './lib/replica.mjs';
import { refShowsPerson, templateTier } from './lib/identity.mjs';

const canvasAspect = (canvas) => (canvas.width > canvas.height ? '16:9' : '9:16');

function mediaEntry(ctx, board, path, field, type, mode) {
  if (type === 'element') return { kind: 'element', source: 'code', file: `elements/${board.name}.${path}.jsx` };
  const key = `${board.name}.${path}`;
  const ref = ctx.refs[key];
  const presenter = type === 'video' && field.media?.role === 'presenter' && mode === 'narration';
  const entry = {
    kind: presenter ? 'avatar' : type,
    source: 'ai',
    mode: ref?.clip ? (refShowsPerson(ref) && templateTier(ctx) === 'high' ? 'keyframe' : 'reference') : 'text',
    ref: ref ? key : null,
    replace: (ref?.subjects || []).map((s) => s.id),
    prompt: '',
    visual: '',
    aspect: field.media?.aspect || canvasAspect(ctx.template.canvas),
    provider: null,
    sketch: null,
    file: null,
  };
  if (type === 'video') entry.duration_s = (board.json.example_duration_ms || 0) / 1000 || board.json.meta?.minDuration || 3;
  return entry;
}

export function buildReplica(project, slug, { topic, language = 'zh' }) {
  const ctx = loadTemplate(join(project, 'template'));
  const mode = ctx.template.audio?.source_mode || 'narration';
  const scenes = ctx.template.boards.map((name) => {
    const board = ctx.boards.get(name);
    if (!board) throw new Error(`template.json lists ${name} but boards/${name}.json is missing`);
    const data = structuredClone(board.json.example_data || {});
    const media = {};
    for (const { path, field, type } of mediaPaths(board.json.schema?.fields || [], data)) {
      media[path] = mediaEntry(ctx, board, path, field, type, mode);
    }
    const scene = { board: name, data, media };
    if (board.json.example_narration) scene.narration = board.json.example_narration;
    return scene;
  });
  return {
    version: 1,
    slug,
    topic,
    language,
    template: '../../template',
    product: null,
    replace: [],
    audio: {
      mode,
      voice: null,
      captions: mode === 'narration' ? ctx.template.audio?.captions ?? null : null,
      bgm: mode === 'silent' ? null : { brief: '', candidates: [], selected: 0, path: null, beats: null },
    },
    scenes,
    resolved: {},
  };
}

async function main() {
  const args = parseArgs();
  const [projectArg, slug] = args._;
  if (!projectArg || !slug || typeof args.topic !== 'string') fail('usage: replica-init.mjs <project> <slug> --topic "…" [--language zh] [--force]', 2);
  const project = cloneDir(projectArg);
  const out = join(replicaDir(project, slug), 'replica.json');
  if (existsSync(out) && !args.force) fail(`${out} exists (pass --force to overwrite)`);
  const replica = buildReplica(project, slug, { topic: args.topic, language: typeof args.language === 'string' ? args.language : 'zh' });
  const errors = check('replica', replica);
  if (errors.length) fail(`generated replica does not validate:\n  ${errors.join('\n  ')}`);
  writeJson(out, replica);
  console.log(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
