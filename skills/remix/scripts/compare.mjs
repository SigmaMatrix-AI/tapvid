#!/usr/bin/env node
// Step 3.9 (spec §4): three-frame acceptance of boards against the source.
//   node compare.mjs <project> [--only Name[,Name]] [--fail-under 0.95] [--timing] [--fresh]
// Every board (and each count variant) is rendered with its media slots filled from template/refs
// and sampled at 25 / 60 / 85 % of each source shot inside its window (of each segment for a
// segmented board), against the source frame at the mapped time. Scores: `ssim` (grayscale, full
// resolution) and `struct` (SSIM at 480×270, the gated one). Writes compare/boards/<label>_<k>_<pct>.png
// rows (source | board | diff×3) and compare/report.json, prints a table, exits 1 when a struct score is below --fail-under
// or (with --timing) any board change is more than a frame off timeline.json.
// Boards run in parallel, and a board whose inputs are unchanged since the last run reuses that run's
// rows and timing issues (compare/cache.json); --fresh measures every board again.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cloneDir, fail, parseArgs, readJson, writeJson } from './lib/common.mjs';
import { bundleBoardPage, captureAt, launch, openPage, refsMedia } from './lib/board-page.mjs';
import { boardRuns, frameOffset, sampleWindows } from './lib/compare-plan.mjs';
import { checkTiming } from './lib/timing-check.mjs';
import { diffRow, grabFrame, probe, ssim, videoInfo } from './lib/video.mjs';

// The structural score is SSIM on frames downscaled to this size (compare_boards.py's `struct`).
const STRUCT_SIZE = [480, 270];

// Boards measured at once, each in its own page: on a 12-core Mac four pages cut the 75 s ig03 template's
// --timing run from 5.5 to under 2 minutes; more pages contend for the video decoder.
const PARALLEL_BOARDS = 4;
// The scripts whose behaviour the cached results depend on: editing one invalidates the cache.
const CODE = ['compare.mjs', 'lib/compare-plan.mjs', 'lib/timing-check.mjs', 'lib/board-page.mjs', 'lib/video.mjs', 'lib/cuts.mjs', 'lib/capture.mjs']
  .map((f) => fileURLToPath(new URL(f, import.meta.url)));

const fmt = (v, d = 3) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));

export async function compareBoards(projectArg, { only, timing = false, fresh = false, log = console.log } = {}) {
  const project = cloneDir(projectArg);
  const templateDir = join(project, 'template');
  const analysis = readJson(join(project, 'analysis', 'boards.json'));
  const template = readJson(join(templateDir, 'template.json'));
  const canvas = template.canvas || analysis.canvas || { width: 1920, height: 1080 };
  const src = join(project, 'source', 'source.mp4');
  if (!existsSync(src)) throw new Error(`${src} missing: run intake.mjs first`);
  const timeline = readJson(join(project, 'source', 'timeline.json'), null);
  const sfx = readJson(join(project, 'source', 'sfx.json'), null)?.events;
  if (timing && !timeline) throw new Error('--timing needs source/timeline.json: run intake.mjs first');
  const fps = timeline?.fps || videoInfo(probe(src)).fps;
  const offset = frameOffset(analysis.source_frame_time, fps);
  const work = join(project, 'compare', 'boards');
  const scratch = join(work, '.frames');
  mkdirSync(scratch, { recursive: true });
  const boards = analysis.boards.filter((b) => !only || only.includes(b.name));
  if (only && !boards.length) throw new Error(`no board named ${only.join(', ')} in analysis/boards.json`);

  // Everything a board's results depend on besides its page: the source, the measured timeline and sound
  // effects, its transitions and the scripts themselves. Media files count by size and time.
  const stamp = (f) => (existsSync(f) ? `${f}:${statSync(f).size}:${statSync(f).mtimeMs}` : `${f}:-`);
  const shared = [stamp(src), JSON.stringify(timeline), JSON.stringify(sfx || null), String(timing), ...CODE.map((f) => readFileSync(f, 'utf-8'))].join('\n');
  const cachePath = join(project, 'compare', 'cache.json');
  const cache = fresh ? {} : readJson(cachePath, {});

  async function compareBoard(browser, b) {
    const meta = readJson(join(templateDir, 'boards', `${b.name}.json`));
    const media = refsMedia(templateDir, b.name, b.start, (abs) => pathToFileURL(abs).href);
    const runs = boardRuns(b, meta, timeline);
    const pages = [];
    for (const run of runs) {
      const htmlFile = join(work, `${run.label}.compare.html`);
      await bundleBoardPage({ templateDir, board: b.name, data: run.data, segments: run.segments,
        media: run.remap(media), duration: run.duration, canvas, outFile: htmlFile });
      pages.push({ run, htmlFile });
    }
    const hash = createHash('sha256').update(shared).update(JSON.stringify(b))
      .update(JSON.stringify((template.transitions || []).filter((x) => x.from === b.name || x.to === b.name)));
    for (const { htmlFile } of pages) hash.update(readFileSync(htmlFile));
    for (const m of Object.values(media)) hash.update(stamp(fileURLToPath(m.src)));
    const key = hash.digest('hex');
    if (cache[b.name]?.key === key) return { ...cache[b.name], cached: true };

    const rows = [];
    const timingIssues = [];
    for (const { run, htmlFile } of pages) {
      const page = await openPage(browser, htmlFile, canvas);
      try {
        for (const s of sampleWindows(run.windows, b.start, fps, offset)) {
          const stem = `${run.label}_${s.k + 1}_${Math.round(s.fraction * 100)}`;
          const boardPng = join(scratch, `${stem}_board.png`);
          const sourcePng = join(scratch, `${stem}_source.png`);
          await captureAt(page, s.boardT, boardPng);
          await grabFrame(src, s.n / fps, sourcePng, { fps, width: canvas.width, height: canvas.height });
          const full = await ssim(sourcePng, boardPng);
          const struct = await ssim(sourcePng, boardPng, STRUCT_SIZE);
          await diffRow(sourcePng, boardPng, join(work, `${stem}.png`));
          rows.push({ board: b.name, variant: run.variant, window: run.segmented ? `s${s.k + 1}` : `shot ${s.k + 1}`,
            pct: Math.round(s.fraction * 100), source_t: Number(s.ts.toFixed(3)), ssim: full, struct, image: `compare/boards/${stem}.png` });
        }
      } finally {
        await page.close();
      }
      if (timing && !run.variant) {
        timingIssues.push(...await checkTiming({ browser, board: b, template, timeline, canvas, fps, offset, htmlFile, work: scratch, sfx }));
      }
    }
    return { key, rows, timingIssues };
  }

  const results = new Array(boards.length);
  const browser = await launch();
  try {
    let next = 0;
    const worker = async () => {
      while (next < boards.length) {
        const i = next++;
        results[i] = await compareBoard(browser, boards[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_BOARDS, boards.length) }, worker));
  } finally {
    await browser.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  const reused = boards.filter((_, i) => results[i].cached).map((b) => b.name);
  if (reused.length) log(`unchanged since the last run (results reused): ${reused.join(', ')}`);
  writeJson(cachePath, { ...cache, ...Object.fromEntries(boards.map((b, i) => [b.name, { key: results[i].key, rows: results[i].rows, timingIssues: results[i].timingIssues }])) });
  const rows = results.flatMap((r) => r.rows);
  const timingIssues = results.flatMap((r) => r.timingIssues);

  const showVariant = rows.some((r) => r.variant);
  const cols = ['board', ...(showVariant ? ['variant'] : []), 'window', 't', 'source s', 'ssim', 'struct'];
  log(`| ${cols.join(' | ')} |\n|${'---|'.repeat(cols.length)}`);
  for (const r of rows) {
    log(`| ${[r.board, ...(showVariant ? [r.variant || '—'] : []), r.window, `${r.pct}%`, fmt(r.source_t, 2), fmt(r.ssim), fmt(r.struct)].join(' | ')} |`);
  }
  const worst = rows.length ? Math.min(...rows.map((r) => r.struct)) : null;
  const mean = (k) => rows.reduce((a, r) => a + r[k], 0) / Math.max(1, rows.length);
  log(`\nmin struct = ${fmt(worst)}, mean struct = ${fmt(mean('struct'))}, mean ssim = ${fmt(mean('ssim'))}`);
  if (timing) {
    if (!timingIssues.length) log('\ntiming: every boundary, transition and board change within 1 frame of timeline.json');
    else {
      log('\n| board | check | source s | board s | frames | note |\n|---|---|---|---|---|---|');
      for (const i of timingIssues) log(`| ${i.board} | ${i.kind} | ${fmt(i.source_t)} | ${fmt(i.board_t)} | ${i.frames ?? '—'} | ${i.note || ''} |`);
    }
  }
  // compare/report.json feeds the review page; a run with --only replaces just those boards' rows.
  const reportPath = join(project, 'compare', 'report.json');
  const prev = readJson(reportPath, { rows: [], timing: [] });
  const done = new Set(boards.map((b) => b.name));
  writeJson(reportPath, {
    generated_at: new Date().toISOString(),
    rows: [...prev.rows.filter((x) => !done.has(x.board)), ...rows],
    timing: timing ? [...(prev.timing || []).filter((x) => !done.has(x.board)), ...timingIssues] : prev.timing || [],
  });
  return { rows, worst, timingIssues };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  if (!args._[0]) fail('usage: node compare.mjs <project> [--only Name[,Name]] [--fail-under 0.95] [--timing] [--fresh]');
  const failUnder = args['fail-under'] === undefined ? null : Number(args['fail-under']);
  if (failUnder !== null && !Number.isFinite(failUnder)) fail(`--fail-under must be a number, got ${args['fail-under']}`);
  try {
    const { worst, timingIssues } = await compareBoards(args._[0], { only: typeof args.only === 'string' ? args.only.split(',') : undefined, timing: Boolean(args.timing), fresh: Boolean(args.fresh) });
    if (failUnder !== null && worst !== null && worst < failUnder) fail(`FAIL: struct ${worst.toFixed(3)} < ${failUnder}`);
    if (timingIssues.length) fail(`FAIL: ${timingIssues.length} timing issue(s)`);
  } catch (e) {
    fail(e.message);
  }
}
