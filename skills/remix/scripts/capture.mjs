#!/usr/bin/env node
// Footage of the user's own product: record a storyboard in the browser, index the recording, cut
// each slot's material from it.
//   node capture.mjs login <url>            the user logs in in a browser window; the session is saved
//   node capture.mjs login --check <url>    prints "logged-in <host>" or "none"
//   node capture.mjs record <replica> <storyboard.json>
//   node capture.mjs index <replica> <capture dir | video file>
//   node capture.mjs clip <replica> --from <capture name | dir> --start <s> --end <s> [--box x,y,w,h]
//        [--aspect W:H] [--duration <s> | --speed <f>] --out <path under the replica>
//   node capture.mjs clip <replica> --from <capture name | dir> --still <t> [--box x,y,w,h] [--aspect W:H] --out <file.png>
// login: a headed Chromium on <url>; when the user closes the window (or presses Enter here) the
//        context's storage state goes to ~/.tapvid-video/auth/<host>.json (0600), outside every project.
//        Prints "saved <host>", or "cancelled" when the page never navigated past the start or holds no cookies.
// record: writes $REPLICA/assets/capture/<name>/{recording.mp4, log.json, shots/<step>.png} (lib/capture-record.mjs).
//        Exit 2 with "login needed: <host>" when the storyboard needs a session that is not saved.
// index: writes index.json and sheet.png next to recording.mp4 and prints the segments.
// clip:  cuts [start, end) cropped to --box (0–1 of the frame, widened to --aspect), retimed to
//        --duration seconds or by --speed, H.264 without audio; --still writes the PNG of one instant,
//        from the step's 2× screenshot when t falls in that step's hold.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseArgs, readJson, requireRuntime } from './lib/common.mjs';
import { AUTH_DIR, authFile, CaptureError, record } from './lib/capture-record.mjs';
import { indexCapture } from './lib/capture-index.mjs';
import { ffmpeg, probe, sec, videoInfo } from './lib/video.mjs';
import { parseBox } from './lib/measure-sheets.mjs';

// The session is read every second while the window is open, so closing the window keeps the last one.
// Only cookies and the open page's localStorage are read: context.storageState() opens helper pages for
// every origin it knows, which in a visible window flickers on every poll and makes logging in impossible.
const STATE_POLL_MS = 1000;
// A visible browser that sign-in providers accept: the user's installed Chrome when present (Google
// sign-in refuses Playwright's bundled Chromium as "not secure"), without the automation banner.
const LOGIN_LAUNCH = { headless: false, ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled'] };
// Clips keep at most this short edge (a 4K screen recording stays 4K, nothing is upscaled).
const MAX_SHORT_EDGE = 2160;

const USAGE = 'usage: node capture.mjs login|record|index|clip … (see the header of capture.mjs)';

export async function login(url, { log = console.log } = {}) {
  const host = new URL(url).host;
  const { chromium } = requireRuntime('playwright');
  const browser = await chromium.launch({ ...LOGIN_LAUNCH, channel: 'chrome' }).catch(() => chromium.launch(LOGIN_LAUNCH));
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  let started = false;
  let moved = false;
  page.on('framenavigated', (f) => { if (started && f === page.mainFrame()) moved = true; });
  await page.goto(url).catch(() => {});
  started = true;

  let state = null;
  const done = new Promise((res) => {
    const check = () => { if (!context.pages().length) res(); };
    context.on('page', (p) => p.on('close', check));
    page.on('close', check);
    browser.on('disconnected', res);
    process.stdin.on('data', (d) => { if (String(d).includes('\n')) res(); });
  });
  log(`log in in the browser window, then close it (or press Enter here)`);
  const origins = new Map();
  const read = async () => {
    const cookies = await context.cookies();
    for (const p of context.pages()) {
      const o = await p.evaluate(() => ({ origin: location.origin, localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value })) })).catch(() => null);
      if (o && o.origin.startsWith('http')) origins.set(o.origin, o);
    }
    state = { cookies, origins: [...origins.values()] };
  };
  const poll = setInterval(() => { read().catch(() => {}); }, STATE_POLL_MS);
  await done;
  clearInterval(poll);
  process.stdin.destroy();
  await read().catch(() => {});
  await browser.close().catch(() => {});
  if (!moved || !state?.cookies?.length) {
    log('cancelled');
    return null;
  }
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  chmodSync(AUTH_DIR, 0o700);
  const file = authFile(url);
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  chmodSync(file, 0o600);
  log(`saved ${host}`);
  return file;
}

// Even pixel crop of `box` (0–1) in a W×H frame, widened (or heightened) around its centre to
// `aspect` and kept inside the frame.
export function cropRect(box, W, H, aspect) {
  const [bx, by, bw, bh] = box || [0, 0, 1, 1];
  let w = bw * W;
  let h = bh * H;
  if (aspect) {
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
    const k = Math.min(1, W / w, H / h);
    w *= k;
    h *= k;
  }
  const ew = Math.max(2, Math.floor(w / 2) * 2);
  const eh = Math.max(2, Math.floor(h / 2) * 2);
  const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(v)));
  return { x: clamp((bx + bw / 2) * W - ew / 2, W - ew), y: clamp((by + bh / 2) * H - eh / 2, H - eh), w: ew, h: eh };
}

function sizeFilter(r) {
  const k = Math.min(1, MAX_SHORT_EDGE / Math.min(r.w, r.h));
  const w = Math.floor((r.w * k) / 2) * 2;
  const h = Math.floor((r.h * k) / 2) * 2;
  return { vf: [`crop=${r.w}:${r.h}:${r.x}:${r.y}`, ...(k < 1 ? [`scale=${w}:${h}:flags=lanczos`] : [])], w, h };
}

function captureDir(replica, from) {
  const named = join(replica, 'assets', 'capture', from);
  const dir = existsSync(join(named, 'recording.mp4')) ? named : resolve(from);
  if (!existsSync(join(dir, 'recording.mp4'))) throw new Error(`no capture ${from} (no recording.mp4)`);
  return dir;
}

// The step whose hold [end, next start) contains t, when its screenshot exists.
function shotAt(dir, t) {
  const log = readJson(join(dir, 'log.json'), null);
  if (!log) return null;
  const i = log.steps.findIndex((s, k) => t >= s.end && t < (log.steps[k + 1]?.start ?? log.duration));
  const step = log.steps[i];
  return step && existsSync(join(dir, ...step.shot.split('/'))) ? step : null;
}

export async function clip(replicaArg, { from, start, end, box, aspect, duration, speed, still, out }) {
  const replica = resolve(replicaArg);
  if (!out || out.startsWith('/') || /^[A-Za-z]:/.test(out) || out.split('/').includes('..')) throw new Error(`--out must be a relative posix path inside the replica, got ${out}`);
  const dir = captureDir(replica, from);
  const src = join(dir, 'recording.mp4');
  const info = videoInfo(probe(src));
  const file = join(replica, ...out.split('/'));
  mkdirSync(dirname(file), { recursive: true });

  if (still !== undefined) {
    if (!(still >= 0 && still <= info.duration)) throw new Error(`--still ${still} is outside the recording (0–${info.duration.toFixed(3)} s)`);
    const step = shotAt(dir, still);
    // The 2× screenshot is exactly twice the recording's size.
    const [W, H] = step ? [info.width * 2, info.height * 2] : [info.width, info.height];
    const { vf, w, h } = sizeFilter(cropRect(box, W, H, aspect));
    const input = step ? ['-i', join(dir, ...step.shot.split('/'))] : ['-ss', sec(Math.max(0, still - 0.25 / info.fps)), '-i', src];
    await ffmpeg([...input, '-frames:v', '1', '-vf', vf.join(','), '-update', '1', file]);
    return { file, width: w, height: h, from: step ? `2× shot of ${step.id}` : 'frame of the recording' };
  }

  const to = Math.min(end, info.duration);
  if (!(start >= 0 && to > start)) throw new Error(`--start ${start} / --end ${end} is not a span of the recording (0–${info.duration.toFixed(3)} s)`);
  const factor = duration ? (to - start) / duration : speed || 1;
  const { vf, w, h } = sizeFilter(cropRect(box, info.width, info.height, aspect));
  await ffmpeg(['-ss', sec(start), '-to', sec(to), '-i', src, '-an', '-vf', [...vf, `setpts=(PTS-STARTPTS)/${factor}`].join(','),
    // -t: frame-rate conversion of the retimed frames would otherwise run a frame or two long.
    '-r', String(info.fps), '-t', sec((to - start) / factor), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
  return { file, width: w, height: h, duration: Number(videoInfo(probe(file)).duration.toFixed(3)) };
}

function printIndex({ dir, index }, log = console.log) {
  const fmt = (b) => (b ? b.map((v) => v.toFixed(2)).join(',') : '—');
  log(`${join(dir, 'index.json')} (${index.from}, ${index.duration}s at ${index.fps} fps)`);
  log('| id | kind | start | end | box | step |\n|---|---|---|---|---|---|');
  for (const s of index.segments) log(`| ${s.id} | ${s.kind} | ${s.start.toFixed(2)} | ${s.end.toFixed(2)} | ${fmt(s.box)} | ${s.step ?? '—'} |`);
  const { sheet } = index;
  log(`${join(dir, sheet.file)}: ${sheet.count} frames, ${sheet.cols} per row, frame k (row by row from 0) = k × ${sheet.step}s`);
}

const num = (v, name) => {
  const n = Number(v);
  if (v === undefined || v === true || !Number.isFinite(n)) throw new Error(`${name} must be a number, got ${v}`);
  return n;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  const [cmd, a, b] = args._;
  try {
    if (cmd === 'login') {
      if (typeof args.check === 'string') console.log(existsSync(authFile(args.check)) ? `logged-in ${new URL(args.check).host}` : 'none');
      else if (a) await login(a);
      else fail(USAGE);
    } else if (cmd === 'record') {
      if (!a || !b) fail(USAGE);
      const r = await record(a, b);
      console.log(`${join(r.dir, 'recording.mp4')} (${r.steps} steps)`);
    } else if (cmd === 'index') {
      if (!a || !b) fail(USAGE);
      printIndex(await indexCapture(a, b));
    } else if (cmd === 'clip') {
      if (!a || typeof args.from !== 'string' || typeof args.out !== 'string') fail(USAGE);
      if (args.duration !== undefined && args.speed !== undefined) fail('pass --duration or --speed, not both');
      const [aw, ah] = typeof args.aspect === 'string' ? args.aspect.split(':').map(Number) : [];
      if (args.aspect !== undefined && !(aw > 0 && ah > 0)) fail(`--aspect must be W:H, got ${args.aspect}`);
      const still = args.still === undefined ? undefined : num(args.still, '--still');
      const opts = {
        from: args.from, out: args.out, still, box: args.box ? parseBox(args.box) : undefined, aspect: aw ? aw / ah : undefined,
        ...(still === undefined ? { start: num(args.start, '--start'), end: num(args.end, '--end') } : {}),
        duration: args.duration === undefined ? undefined : num(args.duration, '--duration'),
        speed: args.speed === undefined ? undefined : num(args.speed, '--speed'),
      };
      if (!(opts.duration === undefined || opts.duration > 0) || !(opts.speed === undefined || opts.speed > 0)) fail('--duration and --speed must be positive');
      const r = await clip(a, opts);
      console.log(r.file);
      console.log(r.duration === undefined ? `${r.width}×${r.height} (${r.from})` : `${r.width}×${r.height}, ${r.duration}s`);
    } else fail(USAGE);
  } catch (e) {
    fail(e.message, e instanceof CaptureError ? e.exitCode : 1);
  }
}
