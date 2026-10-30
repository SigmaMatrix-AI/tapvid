// capture.mjs index: a material table of a capture — segments with kind, times and box — from its
// log.json when there is one, else from the video alone (cuts, motion and still spans), plus a
// contact sheet to look at.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { readJson, writeJson } from './common.mjs';
import { buildShots, hardCuts, softTransitions } from './cuts.mjs';
import { cropSize, decodeGray } from './measure-motion.mjs';
import { ffmpeg, frameMetrics, probe, videoInfo } from './video.mjs';

// Contact sheet: a frame every half second, at most this many (longer recordings space them out),
// this many per row at this width.
const SHEET_STEP_S = 0.5;
const SHEET_MAX = 120;
const SHEET_COLS = 10;
const SHEET_W = 192;
// Motion is read on the 96-wide grey copy (measure-motion.mjs decodeGray): a pixel that changes by
// more than this many levels from the previous frame has moved. H.264 noise at crf 18 stays under
// ~6 levels there, while the drawn cursor or a typed glyph moves its pixels by 30 levels or more.
const PIXEL_DIFF = 12;
// A still run shorter than this inside motion is part of it: typing changes a few pixels every
// ~5 frames, the pauses between keys are not segments of their own.
const MIN_STILL_S = 0.3;

const ACTION_KIND = { goto: 'wait', click: 'click', press: 'click', type: 'typing', hover: 'motion', scroll: 'scroll', wait_for: 'wait' };
const round3 = (v) => Number(v.toFixed(3));
const round4 = (v) => Number(v.toFixed(4));

// The capture directory for `input`: itself, or for a bare video $REPLICA/assets/capture/<stem>/
// with the video copied (an .mp4) or converted to recording.mp4.
export async function captureDirFor(replica, input) {
  const src = resolve(input);
  if (existsSync(join(src, 'recording.mp4'))) return src;
  if (!existsSync(src)) throw new Error(`no such capture or video: ${input}`);
  const dir = join(resolve(replica), 'assets', 'capture', basename(src, extname(src)));
  if (existsSync(join(dir, 'log.json'))) throw new Error(`${dir} holds a recorded capture; rename the video`);
  mkdirSync(dir, { recursive: true });
  const mp4 = join(dir, 'recording.mp4');
  if (extname(src).toLowerCase() === '.mp4') copyFileSync(src, mp4);
  else await ffmpeg(['-i', src, '-an', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  return dir;
}

// Per frame of `src`: how many pixels moved since the previous frame, and their bounding boxes
// in pixels of the grey copy, plus the copy's size.
async function frameChanges(src, info) {
  const full = [0, 0, 1, 1];
  const frames = await decodeGray(src, { start: 0, end: info.duration + 1, box: full, width: info.width, height: info.height });
  const [width, height] = cropSize(full, info.width, info.height);
  const counts = [0];
  const boxes = [null];
  for (let k = 1; k < frames.length; k++) {
    let n = 0;
    let [x0, y0, x1, y1] = [width, height, -1, -1];
    for (let i = 0; i < frames[k].length; i++) {
      if (Math.abs(frames[k][i] - frames[k - 1][i]) <= PIXEL_DIFF) continue;
      n++;
      const x = i % width;
      const y = Math.floor(i / width);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    counts.push(n);
    boxes.push(n ? [x0, y0, x1, y1] : null);
  }
  return { counts, boxes, width, height };
}

// Runs of still / moving frames over [from, to). A short still run joins the motion around it; a
// motion run is kept however short (a result appearing changes the picture in one frame).
export function stillRuns(counts, fps, from, to) {
  const runs = [];
  for (let i = from; i < to; i++) {
    const kind = counts[i] ? 'motion' : 'still';
    const last = runs.at(-1);
    if (last && last.kind === kind) runs[runs.length - 1] = { ...last, to: i + 1 };
    else runs.push({ kind, from: i, to: i + 1 });
  }
  const min = Math.max(1, Math.round(MIN_STILL_S * fps));
  const short = (r, k) => r.kind === 'still' && r.to - r.from < min && k > 0 && k < runs.length - 1;
  return runs.reduce((acc, r, k) => {
    const last = acc.at(-1);
    return last && (last.kind === r.kind || short(r, k)) ? [...acc.slice(0, -1), { ...last, to: r.to }] : [...acc, r];
  }, []);
}

// Union (0–1) of the moved-pixel boxes of frames [from, to); null when nothing moved.
function unionBox({ boxes, width, height }, from, to) {
  const hit = boxes.slice(from, to).filter(Boolean);
  if (!hit.length) return null;
  const [x0, y0] = [Math.min(...hit.map((b) => b[0])), Math.min(...hit.map((b) => b[1]))];
  const [x1, y1] = [Math.max(...hit.map((b) => b[2])), Math.max(...hit.map((b) => b[3]))];
  return [round4(x0 / width), round4(y0 / height), round4((x1 - x0 + 1) / width), round4((y1 - y0 + 1) / height)];
}

// Segments from the action log: each step's action, then its hold until the next step — a
// wait_for's hold is its `result`, any other hold still or motion by the frames.
function logSegments(log, changes, fps) {
  const out = [];
  log.steps.forEach((s, i) => {
    const next = log.steps[i + 1]?.start ?? log.duration;
    const box = s.box ? { box: s.box } : {};
    if (s.end > s.start && s.do !== 'hold') out.push({ id: s.id, kind: ACTION_KIND[s.do], start: s.start, end: s.end, ...box, step: s.id });
    if (next <= s.end) return;
    if (s.do === 'wait_for') return out.push({ id: `${s.id}-result`, kind: 'result', start: s.end, end: next, ...box, step: s.id });
    const runs = stillRuns(changes.counts, fps, Math.round(s.end * fps), Math.min(changes.counts.length, Math.round(next * fps)));
    // A hold step is its pause; any other step's pause is "<id>-hold".
    const base = s.do === 'hold' ? s.id : `${s.id}-hold`;
    runs.forEach((r, k) => out.push({
      id: runs.length > 1 ? `${base}${k + 1}` : base, kind: r.kind,
      start: k ? round3(r.from / fps) : s.end, end: k === runs.length - 1 ? next : round3(r.to / fps), ...box, step: s.id,
    }));
  });
  return out;
}

// Segments from the video alone: shots by cut detection, each split into still / motion runs; a
// motion run gets the box of what changed in it.
function videoSegments(fps, metrics, changes) {
  const cuts = hardCuts(metrics);
  const shots = buildShots(metrics.frames, fps, cuts, softTransitions(metrics, fps, cuts));
  const out = [];
  for (const shot of shots) {
    for (const r of stillRuns(changes.counts, fps, shot.start_frame, shot.end_frame)) {
      const box = r.kind === 'motion' ? unionBox(changes, r.from, r.to) : null;
      out.push({ id: `s${out.length + 1}`, kind: r.kind, start: round3(r.from / fps), end: round3(r.to / fps), ...(box ? { box } : {}) });
    }
  }
  return out;
}

async function contactSheet(src, duration, out) {
  const step = Math.max(SHEET_STEP_S, duration / SHEET_MAX);
  const count = Math.max(1, Math.min(SHEET_MAX, Math.ceil(duration / step)));
  const cols = Math.min(SHEET_COLS, count);
  const rows = Math.ceil(count / cols);
  await ffmpeg(['-i', src, '-an', '-vf', `fps=1/${step.toFixed(4)}:round=down,scale=${SHEET_W}:-2,tile=${cols}x${rows}`, '-frames:v', '1', '-update', '1', out]);
  return { file: 'sheet.png', step: round3(step), count, cols };
}

export async function indexCapture(replica, input) {
  const dir = await captureDirFor(replica, input);
  const src = join(dir, 'recording.mp4');
  const info = videoInfo(probe(src));
  const log = readJson(join(dir, 'log.json'), null);
  const changes = await frameChanges(src, info);
  const segments = log ? logSegments(log, changes, info.fps) : videoSegments(info.fps, await frameMetrics(src), changes);
  const sheet = await contactSheet(src, info.duration, join(dir, 'sheet.png'));
  const index = { recording: 'recording.mp4', fps: info.fps, width: info.width, height: info.height, duration: round3(info.duration), from: log ? 'log' : 'video', sheet, segments };
  writeJson(join(dir, 'index.json'), index);
  return { dir, index };
}
