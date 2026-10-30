#!/usr/bin/env node
// Step 3 at the low tier: analysis/shots.json → a complete
// template, then its reference clips and board previews.
//   node quick.mjs <project> [--title "…"] [--force] [--skip-build]
// Refuses to replace an existing template unless --force (a high-tier template is hours of work).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneDir, fail, parseArgs, readJson, writeJson } from './lib/common.mjs';
import { check } from './lib/schema.mjs';
import { quickTemplate } from './lib/quick.mjs';
import { videoInfo } from './lib/video.mjs';
import { fetchFonts } from './fonts.mjs';
import { extractRefs } from './refs.mjs';
import { buildBoards } from './build-boards.mjs';

// The overlay draws every text at weight 800.
const TEXT_WEIGHTS = [800];

export async function quick(projectArg, { title, force = false, skipBuild = false, log = console.log } = {}) {
  const project = cloneDir(projectArg);
  const templateDir = join(project, 'template');
  if (existsSync(join(templateDir, 'template.json')) && !force) throw new Error(`${templateDir} already has a template (pass --force to replace it)`);
  const shots = readJson(join(project, 'analysis', 'shots.json'));
  const errors = check('shots', shots);
  if (errors.length) throw new Error(`analysis/shots.json is invalid:\n  ${errors.join('\n  ')}`);
  const timeline = readJson(join(project, 'source', 'timeline.json'));
  const size = videoInfo(readJson(join(project, 'source', 'source.json')));
  const id = basename(project).replace(/^clone-/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 64) || 'clone';

  // Boards and refs are generated per scene: a replaced template must not keep the old scenes' files.
  for (const dir of ['boards', 'refs']) rmSync(join(templateDir, dir), { recursive: true, force: true });
  mkdirSync(join(templateDir, 'boards'), { recursive: true });
  let family = null;
  if (shots.font && !skipBuild) {
    // The font is a look, not a blocker: a failed download leaves the overlay on sans-serif; rerun to retry.
    try {
      family = (await fetchFonts({ templateDir, family: shots.font, weights: TEXT_WEIGHTS, substitute: true, log })).family;
    } catch (e) {
      log(`warning: ${shots.font} could not be downloaded (${e.message}); the texts use sans-serif`);
    }
  }
  const out = quickTemplate({ shots, timeline, size, id, title: title || id, family });
  writeJson(join(project, 'analysis', 'boards.json'), out.analysis);
  writeJson(join(project, 'analysis', 'elements.json'), out.elements);
  writeJson(join(templateDir, 'template.json'), out.template);
  writeFileSync(join(templateDir, 'design.js'), out.design);
  mkdirSync(join(templateDir, 'skill'), { recursive: true });
  writeFileSync(join(templateDir, 'skill', 'SKILL.md'), out.skill);
  for (const [name, b] of Object.entries(out.boards)) {
    writeFileSync(join(templateDir, 'boards', `${name}.jsx`), b.jsx);
    writeJson(join(templateDir, 'boards', `${name}.json`), b.json);
  }
  log(`${Object.keys(out.boards).length} boards: ${out.template.boards.join(', ')}`);
  if (skipBuild) return out;

  const refs = await extractRefs(project, { log });
  for (const [key, text] of Object.entries(out.describe)) if (refs[key] && !refs[key].describe) refs[key].describe = text;
  writeJson(join(templateDir, 'refs', 'refs.json'), refs);
  await buildBoards(project, { log });
  return out;
}

async function main() {
  const args = parseArgs();
  const [projectArg] = args._;
  if (!projectArg) fail('usage: quick.mjs <project> [--title "…"] [--force] [--skip-build]', 2);
  try {
    await quick(projectArg, { title: typeof args.title === 'string' ? args.title : undefined, force: Boolean(args.force), skipBuild: Boolean(args['skip-build']) });
  } catch (e) {
    fail(e.message);
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main();
