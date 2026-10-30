#!/usr/bin/env node
// Step 3.10 clock check (references/acceptance.md §2): a board must look the same however its time was
// reached. For each built boards/<Name>.html it pauses mid-entrance after playing, seeks back, plays on,
// seeks past the entrance and back, and compares every stop with a fresh page seeked straight to the same
// time. A hidden clock (a CSS transition, a timer, a video playing on its own) shows up as a difference.
//   node clock.mjs <project> [--only Name[,Name]]
// Prints one line per board and exits 1 when any stop differs.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneDir, fail, parseArgs, readJson } from './lib/common.mjs';
import { captureAt, launch, openPage } from './lib/board-page.mjs';
import { ssim } from './lib/video.mjs';

// Pages are rendered at a quarter of the canvas: a stuck transition or a drifting video changes far more
// than the quarter-size frame hides, and capture runs ~10× faster.
const SCALE = 0.25;
// A stop matches a fresh seek at or above this grayscale SSIM. Identical renders score 1.000; a video
// frame decoded after play vs after a seek can differ by a few levels (0.995+ on the ig03 boards), while a
// transition left half-way scores below 0.98.
const MIN_SSIM = 0.99;
// How long each "play on" runs, in seconds of wall time.
const PLAY_S = 0.3;
// "Seek back" goes to this fraction of the board, "seek past" to its mirror near the end.
const SEEK_EDGE = 0.05;

async function playFor(page, seconds) {
  await page.evaluate(() => window.scenePlayer.play());
  await page.waitForTimeout(seconds * 1000);
  await page.evaluate(() => window.scenePlayer.pause());
  return page.evaluate(() => window.scenePlayer.getCurrentTime());
}

export async function clockCheck(projectArg, { only, log = console.log } = {}) {
  const project = cloneDir(projectArg);
  const templateDir = join(project, 'template');
  const template = readJson(join(templateDir, 'template.json'));
  const canvas = template.canvas || { width: 1920, height: 1080 };
  const fps = template.fps || 30;
  const names = template.boards.filter((n) => !only || only.includes(n));
  const work = join(project, 'compare', 'clock');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const results = [];
  const browser = await launch();
  try {
    for (const name of names) {
      const html = join(templateDir, 'boards', `${name}.html`);
      if (!existsSync(html)) throw new Error(`${html} missing: run build-boards.mjs first`);
      const meta = readJson(join(templateDir, 'boards', `${name}.json`));
      const duration = (meta.example_duration_ms || 0) / 1000;
      // The entrance is done by preview_t; start just before it so the pause lands mid-motion.
      const settled = (meta.preview_t ?? 0.5) * duration;
      const live = await openPage(browser, html, canvas, { scale: SCALE });
      const fresh = await openPage(browser, html, canvas, { scale: SCALE });
      const stops = [];
      try {
        // A video in a slot may land on the neighbouring frame after play / pause (a moving screen
        // recording then scores ~0.96): the stop matches the best of the fresh seeks a frame either way.
        const stop = async (label, t) => {
          const a = join(work, `${name}_${stops.length}_live.png`);
          await captureAt(live, t, a);
          let best = 0;
          for (const [k, dt] of [0, -1 / fps, 1 / fps].entries()) {
            const b = join(work, `${name}_${stops.length}_fresh${k}.png`);
            await captureAt(fresh, Math.max(0, t + dt), b);
            best = Math.max(best, await ssim(a, b));
            if (best >= MIN_SSIM) break;
          }
          stops.push({ label, t: Number(t.toFixed(3)), ssim: best });
        };
        // Long jumps between stops: whatever a hidden clock animates is still on its way when captured.
        await captureAt(live, Math.max(0, settled - PLAY_S));
        await stop('pause mid-entrance', await playFor(live, PLAY_S));
        await stop('seek back', SEEK_EDGE * duration);
        await stop('play on', await playFor(live, PLAY_S));
        await captureAt(live, (1 - SEEK_EDGE) * duration);
        await stop('seek past and back', settled);
      } finally {
        await live.close();
        await fresh.close();
      }
      const bad = stops.filter((s) => s.ssim < MIN_SSIM);
      results.push({ board: name, stops, ok: !bad.length });
      log(`${name}: ${bad.length ? `DIFFERS at ${bad.map((s) => `${s.label} (t ${s.t}s, ssim ${s.ssim.toFixed(3)})`).join(', ')}` : `ok (min ssim ${Math.min(...stops.map((s) => s.ssim)).toFixed(3)})`}`);
    }
  } finally {
    await browser.close();
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  if (!args._[0]) fail('usage: node clock.mjs <project> [--only Name[,Name]]', 2);
  try {
    const results = await clockCheck(args._[0], { only: typeof args.only === 'string' ? args.only.split(',') : undefined });
    if (results.some((r) => !r.ok)) fail('FAIL: a board looks different after play / pause / seek than after a fresh seek (references/acceptance.md §2)');
  } catch (e) {
    fail(e.message);
  }
}
