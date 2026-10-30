// Open a built project's index.html in headless Chromium and capture frames through the
// renderer contract: window.scenePlayer.getDuration() / seekTo(sec), then wait for fonts,
// images and every <video> to settle before the screenshot. Also the sound-effect cue
// tracker: boards mark the element whose entrance makes a sound with data-sfx.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './common.mjs';

// Up to 60 × 25 ms for videos to finish seeking: a 1080p H.264 seek lands well inside 1.5 s.
const VIDEO_SETTLE_POLLS = 60;
const VIDEO_SETTLE_MS = 25;

export async function openProject(dir, canvas, { scale = 1, browser, page: pageFile = 'index.html' } = {}) {
  const own = !browser;
  const b = browser || await launchBrowser();
  const context = await b.newContext({ viewport: { width: canvas.width, height: canvas.height }, deviceScaleFactor: scale });
  // Frame-accurate video: every seek lands exactly, videos never free-run between captures (videoSync.js).
  await context.addInitScript(() => { window.__tapvidFrameAccurate = true; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(join(dir, pageFile)).href);
  await page.waitForFunction(() => window.scenePlayer && window.scenePlayer.getDuration() > 0, null, { timeout: 15000 });
  const duration = await page.evaluate(() => window.scenePlayer.getDuration());
  return {
    page, duration, errors,
    async seek(t) {
      await page.evaluate(async ({ sec, polls, ms }) => {
        const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
        window.scenePlayer.seekTo(sec);
        await raf(); await raf();
        // A <video> the seek just mounted (a page's first frame, a scene cut) missed that seek's alignment and
        // sits decoded at 0 until the sync watchdog; seeking again aligns it before the readiness poll below.
        window.scenePlayer.seekTo(sec);
        await raf();
        await document.fonts.ready;
        await Promise.all([...document.images].filter((i) => !i.complete).map((i) => i.decode().catch(() => {})));
        for (let k = 0; k < polls; k++) {
          const vids = [...document.querySelectorAll('video')];
          if (vids.every((v) => !v.seeking && v.readyState >= 2)) break;
          await new Promise((r) => setTimeout(r, ms));
        }
        await raf();
      }, { sec: t, polls: VIDEO_SETTLE_POLLS, ms: VIDEO_SETTLE_MS });
    },
    async shot(opts = {}) {
      return page.screenshot({ clip: { x: 0, y: 0, width: canvas.width, height: canvas.height }, ...opts });
    },
    async close() { await context.close(); if (own) await b.close(); },
  };
}

// In-page: every [data-sfx] element present and visible now (non-zero box, not
// visibility:hidden, opacity through its ancestors > 0.05) as { id, kind, gain, offset, index }:
// id is data-sfx-id or null, offset the data-time-offset of its scene wrapper (projectPlayer.js:
// how far its scene started before the active one, null outside a project page) and index its
// DOM order among the [data-sfx] elements of that wrapper.
function visibleSfxInPage() {
  const counts = new Map();
  const out = [];
  for (const el of document.querySelectorAll('[data-sfx]')) {
    const wrap = el.closest('[data-time-offset]');
    const index = counts.get(wrap) || 0;
    counts.set(wrap, index + 1);
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || getComputedStyle(el).visibility === 'hidden') continue;
    let opacity = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
    if (opacity <= 0.05) continue;
    const gain = parseFloat(el.dataset.sfxGain);
    out.push({ id: el.dataset.sfxId || null, kind: el.dataset.sfx, gain: Number.isFinite(gain) ? gain : 1, offset: wrap ? Number(wrap.dataset.timeOffset) : null, index });
  }
  return out;
}

// Sound-effect cues of one page: call it with each captured frame's time, in order, and it
// returns the [data-sfx] elements visible for the first time on that page as { id, kind, gain, t }.
// The default id is the kind plus the element's DOM order index, prefixed in a project page with
// its scene's start (`sceneStart(t)`: start of the scene active at t, minus the wrapper's offset),
// so an element keeps its id through its scene's transitions and pages capturing different parts
// of one timeline agree on it. A board that mounts sound elements conditionally, in a changing
// order, sets data-sfx-id itself.
export function sfxTracker(page, { sceneStart = () => 0 } = {}) {
  const seen = new Set();
  const idOf = (c, t) => c.id ?? (c.offset === null ? `${c.kind}${c.index}` : `${Number((sceneStart(t) - c.offset).toFixed(3))}:${c.kind}${c.index}`);
  return async (t) => {
    const fresh = (await page.evaluate(visibleSfxInPage)).map((c) => ({ id: idOf(c, t), kind: c.kind, gain: c.gain })).filter((c) => !seen.has(c.id));
    fresh.forEach((c) => seen.add(c.id));
    return fresh.map((c) => ({ ...c, t: Number(t.toFixed(3)) }));
  };
}

// Cues from several pages that captured parts of one timeline: each id once, at its earliest time.
export function firstCues(lists) {
  const first = lists.flat().reduce((acc, c) => (acc.has(c.id) && acc.get(c.id).t <= c.t ? acc : new Map([...acc, [c.id, c]])), new Map());
  return [...first.values()].sort((a, b) => a.t - b.t);
}
