// capture.mjs record: perform a storyboard in headless Chromium while Playwright records the page,
// then write recording.mp4, log.json (every time on the mp4 timeline) and a 2× screenshot per step.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HOME, launchBrowser, readJson, runAsync, writeJson } from './common.mjs';
import { ffmpeg, probe, videoInfo } from './video.mjs';
import { flashMarker, installCapturePage, parseFake, smoothScroll } from './capture-page.mjs';

export const AUTH_DIR = join(HOME, 'auth');
// Saved sessions are keyed by host; a port's colon is not allowed in a Windows file name.
export const authFile = (url) => join(AUTH_DIR, `${new URL(url).host.replace(/:/g, '_')}.json`);

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
// Playwright 1.64 takes recordVideo.fps (default 25). At 60 a 1920×1080 recording on an M-series
// Mac kept 44 of 45 frames distinct through a smooth scroll: Chromium keeps up, so 60 it is.
const DEFAULT_FPS = 60;
// Screenshots at twice the viewport: sharp stills for slots that show a screen at full canvas size.
const SCALE = 2;
// A beat long enough to register the screen after each action, short enough not to drag.
const DEFAULT_HOLD_S = 0.6;
// 12 characters per second reads as brisk human typing (~140 wpm), slow enough to follow on screen.
const DEFAULT_CPS = 12;
// A generation or upload the flow waits for usually lands within half a minute; longer waits set timeout.
const DEFAULT_WAIT_S = 30;
// A click / type / hover target that is not visible after this long is a storyboard error, and a
// page that has not loaded after a minute is a broken step, not a slow one.
const ACTION_TIMEOUT_S = 15;
const NAV_TIMEOUT_S = 60;
// One video frame at 60 fps: a wait_for's end lands within a frame of the target appearing.
const VISIBLE_POLL_MS = 16;
// One second reads as a deliberate scroll, the eye can follow the content past.
const DEFAULT_SCROLL_S = 1.0;
// The pointer glides to each target over half a second: fast enough not to drag, slow enough to follow.
const CURSOR_MOVE_S = 0.5;
// 15 samples per second is plenty to place a drawn cursor or a focus ring on top of the footage.
const CURSOR_SAMPLE_HZ = 15;
// The click ripple fades out within the default hold, so the step's screenshot is taken after it.
const RIPPLE_MS = 400;
const CURSOR_ID = '__tapvid-cursor';
// DOM animation frames and recorded frames have independent cadences. Keep the marker
// for three recording intervals, with a 250 ms margin for a busy compositor at high fps.
const FLASH_MIN_MS = 250;
const FLASH_RECORDING_FRAMES = 3;
// The recorder starts a few frames after the page opens; a flash shown at once was found already
// running in the first recorded frame (its start lost, the alignment off by those frames). Half a
// second of black page before it leaves a wide margin.
const RECORDER_WARMUP_MS = 500;
// The flash is the first thing recorded; it is searched for in this many seconds.
const FLASH_SEARCH_S = 10;
// The flash search decodes the recording at this size: enough to tell the black square from the white.
const PROBE_SIZE = [32, 18];

const ACTIONS = new Set(['goto', 'click', 'type', 'press', 'hover', 'scroll', 'wait_for', 'hold']);
const NEEDS_TARGET = new Set(['click', 'type', 'hover', 'wait_for']);
const TARGET_KEYS = ['role', 'text', 'label', 'placeholder', 'testId', 'selector'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// An error carrying the process exit code (2: the agent must do something else first).
export class CaptureError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const round3 = (v) => Number(v.toFixed(3));
const round4 = (v) => Number(v.toFixed(4));
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const clock = () => performance.timeOrigin + performance.now();

export function loadStoryboard(file) {
  const sb = readJson(resolve(file));
  const bad = (m) => { throw new CaptureError(`storyboard: ${m}`); };
  if (!ID.test(sb.name || '')) bad('"name" must be letters, digits, - or _');
  try { new URL(sb.url); } catch { bad('"url" must be an absolute URL'); }
  const viewport = sb.viewport || DEFAULT_VIEWPORT;
  if (!(viewport.width > 0 && viewport.height > 0)) bad('"viewport" needs width and height');
  if (!Array.isArray(sb.steps) || !sb.steps.length) bad('"steps" must be a non-empty list');
  const ids = new Set();
  for (const s of sb.steps) {
    if (!ID.test(s.id || '') || ids.has(s.id)) bad(`step ids must be unique letters, digits, - or _ (got ${s.id})`);
    ids.add(s.id);
    if (!ACTIONS.has(s.do)) bad(`${s.id}: unknown "do" ${s.do}`);
    if (NEEDS_TARGET.has(s.do) && !s.target) bad(`${s.id}: ${s.do} needs a target`);
    if (s.target && TARGET_KEYS.filter((k) => s.target[k] !== undefined).length !== 1) bad(`${s.id}: target needs exactly one of ${TARGET_KEYS.join(', ')}`);
    if (s.do === 'goto' && !s.url) bad(`${s.id}: goto needs a url`);
    if (s.do === 'type' && typeof s.text !== 'string') bad(`${s.id}: type needs a text`);
    if (s.do === 'press' && !s.key) bad(`${s.id}: press needs a key`);
    if (s.do === 'scroll' && !s.target && !Number.isFinite(s.to?.y)) bad(`${s.id}: scroll needs to.y or a target`);
  }
  return { ...sb, viewport, fps: sb.fps || DEFAULT_FPS, auth: Boolean(sb.auth), fake: parseFake(sb.fake), mask: sb.mask || [] };
}

// `nth` (0-based) picks one of several matches; without it a target must match exactly one element.
function locator(page, t) {
  const l = t.role ? page.getByRole(t.role, t.name ? { name: t.name } : {})
    : t.label ? page.getByLabel(t.label)
      : t.placeholder ? page.getByPlaceholder(t.placeholder)
        : t.testId ? page.getByTestId(t.testId)
          : t.selector ? page.locator(t.selector)
            : page.getByText(t.text);
  return Number.isInteger(t.nth) ? l.nth(t.nth) : l;
}

// The target once visible, and when it became visible; { text } prefers an exact match when there
// is one. Polled every VISIBLE_POLL_MS rather than with locator.waitFor, whose backoff (up to 1 s)
// would put a wait_for's end well after the target appeared. It appeared between the last check
// that missed it and the one that saw it: the middle of the two checks is the estimate.
async function find(page, target, timeoutS) {
  const loc = locator(page, target);
  const deadline = clock() + timeoutS * 1000;
  let missed = null;
  for (;;) {
    const t0 = clock();
    const visible = await loc.first().isVisible();
    const mid = (t0 + clock()) / 2;
    if (visible) {
      const at = missed === null ? mid : (missed + mid) / 2;
      if (target.text === undefined) return { loc, at };
      const exact = page.getByText(target.text, { exact: true });
      return { loc: (await exact.count()) ? exact : loc, at };
    }
    if (clock() > deadline) throw new Error(`${JSON.stringify(target)} not visible after ${timeoutS}s`);
    missed = mid;
    await sleep(VISIBLE_POLL_MS);
  }
}

// [x, y, w, h] in 0–1 of the viewport, clipped to it; null when off screen.
function fraction(bb, { width, height }) {
  if (!bb) return null;
  const x0 = Math.max(0, bb.x);
  const y0 = Math.max(0, bb.y);
  const x1 = Math.min(width, bb.x + bb.width);
  const y1 = Math.min(height, bb.y + bb.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return [round4(x0 / width), round4(y0 / height), round4((x1 - x0) / width), round4((y1 - y0) / height)];
}

function driver(page, viewport, fps) {
  const pos = { x: viewport.width / 2, y: viewport.height / 2 };
  const trail = [[clock(), pos.x, pos.y]];
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

  // Glide the pointer to (x, y): one mouse event per video frame over CURSOR_MOVE_S, eased.
  async function glide(x, y) {
    const from = { ...pos };
    const n = Math.hypot(x - from.x, y - from.y) < 2 ? 1 : Math.round(CURSOR_MOVE_S * fps);
    const t0 = clock();
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      const p = { x: from.x + (x - from.x) * k, y: from.y + (y - from.y) * k };
      await page.mouse.move(p.x, p.y);
      trail.push([clock(), p.x, p.y]);
      await sleep(t0 + (i * CURSOR_MOVE_S * 1000) / n - clock());
    }
    Object.assign(pos, { x, y });
  }

  // Bring the target into view (smoothly) and glide to its centre; returns its bounding box.
  async function aim(loc) {
    let bb = await loc.boundingBox();
    const inside = bb && bb.y >= 0 && bb.y + bb.height <= viewport.height;
    if (!inside) {
      await loc.evaluate(smoothScroll, { ms: DEFAULT_SCROLL_S * 1000 });
      bb = await loc.boundingBox();
    }
    if (!bb) throw new Error('target has no box on screen');
    await glide(bb.x + bb.width / 2, bb.y + bb.height / 2);
    return bb;
  }

  async function act(step) {
    const timeout = step.do === 'wait_for' ? step.timeout ?? DEFAULT_WAIT_S : ACTION_TIMEOUT_S;
    const found = step.target ? await find(page, step.target, timeout) : null;
    const loc = found?.loc;
    let bb = null;
    let end = null;
    switch (step.do) {
      case 'goto':
        await page.goto(step.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_S * 1000 });
        break;
      case 'click':
        bb = await aim(loc);
        await loc.click({ timeout: ACTION_TIMEOUT_S * 1000 });
        break;
      case 'hover':
        bb = await aim(loc);
        await loc.hover({ timeout: ACTION_TIMEOUT_S * 1000 });
        break;
      case 'type': {
        if (await loc.evaluate((el) => el instanceof HTMLInputElement && el.type === 'password')) {
          throw new CaptureError(`refusing to type into a password field — the user types passwords in "capture.mjs login"`, 2);
        }
        bb = await aim(loc);
        await loc.click({ timeout: ACTION_TIMEOUT_S * 1000 });
        await loc.pressSequentially(step.text, { delay: 1000 / (step.cps || DEFAULT_CPS) });
        break;
      }
      case 'press':
        if (loc) bb = await aim(loc);
        await page.keyboard.press(step.key);
        break;
      case 'scroll': {
        const ms = (step.duration ?? DEFAULT_SCROLL_S) * 1000;
        if (loc) {
          await loc.evaluate(smoothScroll, { ms });
          bb = await loc.boundingBox();
        } else await page.evaluate(`(${smoothScroll})(null, ${JSON.stringify({ y: step.to.y, ms })})`);
        break;
      }
      case 'wait_for':
        bb = await loc.boundingBox();
        end = found.at;
        break;
      default: // hold: the pause is the step
    }
    if (step.do === 'click' || step.do === 'press') await page.waitForLoadState('load', { timeout: NAV_TIMEOUT_S * 1000 });
    // A navigation drops the drawn cursor; one move at the same spot draws it again.
    await page.mouse.move(pos.x, pos.y);
    return { box: fraction(bb, viewport), end: end ?? clock() };
  }

  return { act, trail };
}

// First flash frame and the first frame after it, by frame index of `webm`.
async function findFlash(webm, fps) {
  const [w, h] = PROBE_SIZE;
  const res = await runAsync(process.env.TAPVID_FFMPEG || 'ffmpeg', ['-hide_banner', '-nostats', '-v', 'error', '-i', webm,
    '-frames:v', String(Math.round(FLASH_SEARCH_S * fps)), '-an', '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { binary: true });
  if (res.code !== 0) throw new Error(`ffmpeg could not decode the recording: ${res.stderr.trim()}`);
  const buf = res.stdout;
  // White in the outer columns, black in the middle: the marker, not a blank white page.
  const isFlash = (f) => {
    let side = 0;
    let sideN = 0;
    let mid = 0;
    let midN = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = f[y * w + x];
        if (x < w * 0.25 || x >= w * 0.75) { side += v; sideN++; } else if (Math.abs(x - w / 2 + 0.5) < w * 0.06 && Math.abs(y - h / 2 + 0.5) < h * 0.12) { mid += v; midN++; }
      }
    }
    return side / sideN > 200 && mid / midN < 60;
  };
  const size = w * h;
  let first = -1;
  for (let i = 0; (i + 1) * size <= buf.length; i++) {
    const flash = isFlash(buf.subarray(i * size, (i + 1) * size));
    if (first < 0 && flash) {
      if (i === 0) throw new CaptureError('the recording started after the alignment flash');
      first = i;
    } else if (first >= 0 && !flash) return { first, after: i };
  }
  throw new CaptureError('the alignment flash was not found in the recording');
}

// Cursor positions resampled at CURSOR_SAMPLE_HZ over the video, as [t, x, y] in 0–1.
function cursorSamples(trail, toVideo, duration, viewport) {
  const pts = trail.map(([wall, x, y]) => [toVideo(wall), x, y]);
  const out = [];
  let k = 0;
  for (let t = 0; t <= duration + 1e-9; t += 1 / CURSOR_SAMPLE_HZ) {
    while (k + 1 < pts.length && pts[k + 1][0] <= t) k++;
    out.push([round3(t), round4(pts[k][1] / viewport.width), round4(pts[k][2] / viewport.height)]);
  }
  return out;
}

/**
 * Perform `storyboardFile` and write $REPLICA/assets/capture/<name>/{recording.mp4, log.json, shots/}.
 * A failing step stops the run; what was recorded is kept, log.json carries error { step, message }
 * and a CaptureError is thrown.
 */
export async function record(replicaArg, storyboardFile) {
  const sb = loadStoryboard(storyboardFile);
  const host = new URL(sb.url).host;
  let storageState;
  if (sb.auth) {
    storageState = authFile(sb.url);
    if (!existsSync(storageState)) throw new CaptureError(`login needed: ${host}`, 2);
  }
  const out = join(resolve(replicaArg), 'assets', 'capture', sb.name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'shots'), { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'tapvid-capture-'));
  const { viewport, fps } = sb;
  const steps = [];
  let error = null; // { step, message, exitCode }
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: SCALE, storageState, recordVideo: { dir: tmp, size: viewport, fps } });
    await context.addInitScript(installCapturePage, { fake: sb.fake, mask: sb.mask, cursorId: CURSOR_ID, rippleMs: RIPPLE_MS });
    const page = await context.newPage();
    await page.setContent('<html><body style="margin:0;background:#000"></body></html>');
    await sleep(RECORDER_WARMUP_MS);
    const flashWall = await page.evaluate(flashMarker, Math.max(FLASH_MIN_MS, 1000 * FLASH_RECORDING_FRAMES / fps));
    const { act, trail } = driver(page, viewport, fps);
    // Shots keep the drawn cursor: hiding it for the screenshot would blank it in the video too.
    for (const step of sb.steps) {
      const start = clock();
      try {
        const { box, end } = await act(step);
        await sleep((step.hold ?? DEFAULT_HOLD_S) * 1000);
        const shot = `shots/${step.id}.png`;
        await page.screenshot({ path: join(out, ...shot.split('/')) });
        steps.push({ id: step.id, do: step.do, note: step.note ?? null, start, end, box, ...(step.do === 'type' ? { text: step.text } : {}), url: page.url(), shot });
      } catch (e) {
        error = { step: step.id, message: e.message.split('\n')[0], exitCode: e.exitCode || 1 };
        await page.screenshot({ path: join(out, 'shots', `${step.id}-error.png`) }).catch(() => {});
        break;
      }
    }
    await context.close();
    const webm = await page.video().path();
    const info = videoInfo(probe(webm));
    const flash = await findFlash(webm, info.fps);
    const mp4 = join(out, 'recording.mp4');
    await ffmpeg(['-i', webm, '-an', '-vf', `trim=start_frame=${flash.after},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      '-r', String(info.fps), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
    const duration = round3(videoInfo(probe(mp4)).duration);
    const toVideo = (wall) => round3(Math.max(0, (wall - flashWall) / 1000 + (flash.first - flash.after) / info.fps));
    writeJson(join(out, 'log.json'), {
      name: sb.name, url: sb.url, viewport, fps: info.fps, duration,
      steps: steps.map((s) => ({ ...s, start: toVideo(s.start), end: toVideo(s.end) })),
      cursor: cursorSamples(trail, toVideo, duration, viewport),
      ...(error ? { error: { step: error.step, message: error.message } } : {}),
    });
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  if (error) throw new CaptureError(`step ${error.step} failed: ${error.message}`, error.exitCode);
  return { dir: out, steps: steps.length };
}
