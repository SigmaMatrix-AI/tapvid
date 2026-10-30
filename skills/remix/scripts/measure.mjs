#!/usr/bin/env node
// Step 3 measurements on the original, before any board is shown to the user.
//   node measure.mjs grid  <project> --at 12.4[,13.0] [--box x,y,w,h] [--step 2]
//   node measure.mjs motion <project> [--only Board[,Board]]
//   node measure.mjs fonts <project> --at <t> --box x,y,w,h --text "<exact text>" --candidates "Family:900,Family:400" [--out name]
// `--box` is [x, y, w, h] of the canvas, top-left origin: 0–1 fractions (as in analysis/*.json) or
// percent when any value is above 1 (as read off the grid labels).
// grid:   the source frame at each time under a grid every `step` % with labelled 10 % lines
//         (percent of width / height); with --box also the box alone at 2×, every line labelled.
//         Writes analysis/measure/grid-<t>.png [and grid-<t>-zoom.png].
// motion: for every element of analysis/elements.json (else every media slot crop of
//         analysis/boards.json), the frame-to-frame change inside its box over [in + 0.3 s, out − 0.1 s]:
//         still, boil (period_s, poses_per_s) or moving (mean, loop_s when frames repeat). Presenter
//         and footage elements are skipped (jump cuts read as motion). Writes analysis/motion.json
//         (a run with --only replaces just those boards' elements) and prints a table.
// fonts:  the source crop at 2× above each candidate family setting the same text at the crop's
//         height (Google Fonts, loaded in the page); a family that does not load reads "not found".
//         Writes analysis/measure/fonts-<name>.png.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneDir, fail, launchBrowser, parseArgs, readJson, writeJson } from './lib/common.mjs';
import { grabFrame, probe, videoInfo } from './lib/video.mjs';
import { DEFAULT_STEP, fontsHtml, googleCssUrl, gridHtml, parseBox, parseCandidates, parseTimes } from './lib/measure-sheets.mjs';
import { decodeGray, measureTargets, motionTargets } from './lib/measure-motion.mjs';

// How long the font sheet may wait for Google Fonts before calling a family "not found".
const FONT_TIMEOUT_MS = 15_000;

const USAGE = 'usage: node measure.mjs grid|motion|fonts <project> … (see the header of measure.mjs)';
const label = (t) => String(Number(t.toFixed(3)));

function source(project) {
  const src = join(project, 'source', 'source.mp4');
  const info = videoInfo(probe(src));
  const timeline = readJson(join(project, 'source', 'timeline.json'), null);
  return { src, fps: timeline?.fps || info.fps, width: info.width, height: info.height };
}

async function framePng(src, t, fps, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tapvid-measure-'));
  try {
    const file = join(dir, 'f.png');
    await grabFrame(src, t, file, { fps, ...opts });
    return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function shoot(browser, html, viewport, out, { selector, ready } = {}) {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(html, { waitUntil: ready ? 'domcontentloaded' : 'load' });
    if (ready) await page.waitForFunction(ready, null, { timeout: FONT_TIMEOUT_MS * 2 });
    mkdirSync(dirname(out), { recursive: true });
    if (selector) await page.locator(selector).screenshot({ path: out });
    else await page.screenshot({ path: out });
  } finally {
    await page.close();
  }
  return out;
}

export async function measureGrid(projectArg, { at, box, step = DEFAULT_STEP }) {
  const project = cloneDir(projectArg);
  const { src, fps, width, height } = source(project);
  const outDir = join(project, 'analysis', 'measure');
  const files = [];
  const browser = await launchBrowser();
  try {
    for (const t of at) {
      const image = await framePng(src, t, fps);
      const full = gridHtml({ image, width, height, step });
      files.push(await shoot(browser, full.html, { width: full.width, height: full.height }, join(outDir, `grid-${label(t)}.png`)));
      if (box) {
        const zoom = gridHtml({ image, width, height, step, box });
        files.push(await shoot(browser, zoom.html, { width: zoom.width, height: zoom.height }, join(outDir, `grid-${label(t)}-zoom.png`)));
      }
    }
  } finally {
    await browser.close();
  }
  return files;
}

export async function measureFonts(projectArg, { at, box, text, candidates, out, cssUrl = googleCssUrl }) {
  const project = cloneDir(projectArg);
  const { src, fps, width, height } = source(project);
  const image = await framePng(src, at, fps, { crop: box });
  // cropFilter keeps even pixels; the sheet shows the crop at that size ×2.
  const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
  const html = fontsHtml({ image, cropWidth: even(width * box[2]), cropHeight: even(height * box[3]), text, candidates, cssUrl, timeoutMs: FONT_TIMEOUT_MS });
  const file = join(project, 'analysis', 'measure', `fonts-${out || label(at)}.png`);
  const browser = await launchBrowser();
  try {
    await shoot(browser, html, { width: 1600, height: 900 }, file, { selector: '#sheet', ready: () => window.__sheetReady === true });
  } finally {
    await browser.close();
  }
  return file;
}

export async function measureMotion(projectArg, { only, decode = decodeGray, log = console.log } = {}) {
  const project = cloneDir(projectArg);
  const { src, fps, width, height } = source(project);
  const targets = motionTargets(project, only);
  if (only && !targets.length) throw new Error(`nothing to measure on ${only.join(', ')}`);
  const { results, skipped } = await measureTargets(targets, { src, fps, width, height, decode });
  const path = join(project, 'analysis', 'motion.json');
  const prev = readJson(path, { elements: {} }).elements || {};
  const done = new Set(targets.map((t) => t.id));
  const kept = Object.fromEntries(Object.entries(prev).filter(([id]) => !done.has(id)));
  writeJson(path, { elements: { ...kept, ...results } });

  const fmt = (v, d = 2) => (v === undefined ? '—' : Number(v).toFixed(d));
  log('| element | class | mean | period s | poses/s | loop s | confidence |\n|---|---|---|---|---|---|---|');
  for (const [id, r] of Object.entries(results)) {
    log(`| ${id} | ${r.class} | ${fmt(r.mean)} | ${fmt(r.period_s, 3)} | ${fmt(r.poses_per_s)} | ${fmt(r.loop_s, 3)} | ${fmt(r.confidence)} |`);
  }
  for (const id of skipped) log(`| ${id} | skipped: window under 3 frames after the entrance | | | | | |`);
  return { results, skipped, path };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  const [cmd, project] = args._;
  if (!project || !['grid', 'motion', 'fonts'].includes(cmd)) fail(USAGE);
  try {
    if (cmd === 'grid') {
      if (typeof args.at !== 'string') fail('grid needs --at <seconds>[,<seconds>]');
      const step = args.step === undefined ? DEFAULT_STEP : Number(args.step);
      if (!(step > 0 && step <= 50)) fail(`--step must be a percent between 0 and 50, got ${args.step}`);
      const files = await measureGrid(project, { at: parseTimes(args.at), box: args.box ? parseBox(args.box) : undefined, step });
      for (const f of files) console.log(f);
    } else if (cmd === 'motion') {
      await measureMotion(project, { only: typeof args.only === 'string' ? args.only.split(',') : undefined });
    } else {
      if (typeof args.at !== 'string' || typeof args.box !== 'string' || typeof args.text !== 'string' || typeof args.candidates !== 'string') {
        fail('fonts needs --at <t> --box x,y,w,h --text "<text>" --candidates "Family:weight,…"');
      }
      const [at] = parseTimes(args.at);
      const out = typeof args.out === 'string' ? args.out.replace(/[^\w.-]+/g, '-') : undefined;
      console.log(await measureFonts(project, { at, box: parseBox(args.box), text: args.text, candidates: parseCandidates(args.candidates), out }));
    }
  } catch (e) {
    fail(e.message);
  }
}
