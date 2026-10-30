#!/usr/bin/env node
// Step 3 (spec §4, §6.2): build every board's preview deliverables.
//   node build-boards.mjs <project> [--only Name[,Name]] [--skip-audio] [--skip-png]
// Per board: boards/<Name>.mp3 (source audio over the board window) and example_duration_ms,
// boards/<Name>.html (single-file page, media slots from template/refs), boards/<Name>.png at
// preview_t. Without --only also template/preview.mp3 (default order) and template/cover.png.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneDir, fail, parseArgs, readJson } from './lib/common.mjs';
import { bundleBoardPage, captureAt, launch, openPage, refsMedia } from './lib/board-page.mjs';
import { concatAudio, cutAudio, grabFrame } from './lib/video.mjs';

// The moment a board's entrance has finished and its exit not begun, when the json gives none.
const DEFAULT_PREVIEW_T = 0.9;

// Rewrite a json only when its content changes, so a hand-formatted board json stays as it is
// and watchers do not reload untouched boards.
function saveJson(path, value) {
  if (existsSync(path) && JSON.stringify(JSON.parse(readFileSync(path, 'utf-8'))) === JSON.stringify(value)) return;
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

export async function buildBoards(projectArg, { only, skipAudio = false, skipPng = false, log = console.log } = {}) {
  const project = cloneDir(projectArg);
  const templateDir = join(project, 'template');
  const boardsDir = join(templateDir, 'boards');
  const analysis = readJson(join(project, 'analysis', 'boards.json'));
  const template = readJson(join(templateDir, 'template.json'));
  const canvas = template.canvas || analysis.canvas || { width: 1920, height: 1080 };
  const wav = join(project, 'source', 'audio.wav');
  const video = join(project, 'source', 'source.mp4');
  const selected = analysis.boards.filter((b) => !only || only.includes(b.name));
  if (only && !selected.length) throw new Error(`no board named ${only.join(', ')} in analysis/boards.json`);

  const pages = [];
  for (const b of selected) {
    const jsonPath = join(boardsDir, `${b.name}.json`);
    const meta = readJson(jsonPath);
    if (!skipAudio && existsSync(wav)) await cutAudio(wav, b.start, b.end, join(boardsDir, `${b.name}.mp3`));
    meta.example_duration_ms = Math.round((b.end - b.start) * 1000);
    const htmlFile = join(boardsDir, `${b.name}.html`);
    const media = refsMedia(templateDir, b.name, b.start, (abs) => relative(boardsDir, abs).split(sep).join('/'));
    const html = await bundleBoardPage({ templateDir, board: b.name, data: meta.example_data, segments: meta.example_segments,
      media, duration: meta.example_duration_ms / 1000, canvas, outFile: htmlFile });
    saveJson(jsonPath, meta);
    pages.push({ name: b.name, htmlFile, at: (meta.preview_t ?? DEFAULT_PREVIEW_T) * (meta.example_duration_ms / 1000) });
    log(`${b.name}: html ${Math.round(html.length / 1024)} KB, ${meta.example_duration_ms} ms, ${Object.keys(media).length} media slot(s)`);
  }

  if (!skipPng && pages.length) {
    const browser = await launch();
    try {
      for (const p of pages) {
        const page = await openPage(browser, p.htmlFile, canvas);
        await captureAt(page, p.at, join(boardsDir, `${p.name}.png`));
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }

  if (!only) {
    const order = template.boards || analysis.boards.map((b) => b.name);
    const mp3s = order.map((n) => join(boardsDir, `${n}.mp3`));
    if (!skipAudio && mp3s.every(existsSync)) {
      await concatAudio(mp3s, join(templateDir, 'preview.mp3'));
      log(`preview.mp3: ${order.join(' → ')}`);
    } else if (!skipAudio) log('preview.mp3 skipped: not every board has an example mp3');
    if (existsSync(video)) {
      await grabFrame(video, analysis.cover_t ?? 0, join(templateDir, 'cover.png'), { width: canvas.width, height: canvas.height });
      log(`cover.png at ${analysis.cover_t ?? 0}s`);
    }
  }
  return pages.map((p) => p.name);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  if (!args._[0]) fail('usage: node build-boards.mjs <project> [--only Name[,Name]] [--skip-audio] [--skip-png]');
  try {
    await buildBoards(args._[0], { only: typeof args.only === 'string' ? args.only.split(',') : undefined,
      skipAudio: Boolean(args['skip-audio']), skipPng: Boolean(args['skip-png']) });
  } catch (e) {
    fail(e.message);
  }
}
