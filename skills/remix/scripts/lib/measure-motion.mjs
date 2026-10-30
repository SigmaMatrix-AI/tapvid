// Motion inside an element's box (measure.mjs motion): decode the box as small grayscale frames,
// take the mean absolute difference between consecutive frames, and classify the series as
// still, boil (stop-motion poses at a regular period) or moving (a loop / GIF, a screen
// recording, footage), with a loop period when frames repeat.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './common.mjs';
import { fieldAt } from './board-fields.mjs';
import { sec } from './video.mjs';

const FFMPEG = process.env.TAPVID_FFMPEG || 'ffmpeg';
// Decoded crops are at most this wide: enough to see a pose change or a GIF frame, small enough
// that a whole element window decodes and compares in well under a second.
export const MAX_WIDTH = 96;
// Skip the entrance (pop / slide settling) and the exit's first frames.
export const SKIP_IN_S = 0.3;
export const SKIP_OUT_S = 0.1;
// Mean absolute difference (0–255) a frame must exceed to count as a change. A static region of a
// grainy H.264 test render (ffmpeg noise=alls=6, crf 20) measured 0.7 at ≤ 96 px; a sticker's new
// pose measured spikes of ~40 and a test-pattern GIF a mean of 3, so 1.5 leaves margin both ways.
export const NOISE_FLOOR = 1.5;
// At most this share of changed frames is still (a stray compression pulse, a passing cursor).
export const STILL_ACTIVE_MAX = 0.05;
// Above this share of changed frames the motion is sustained, not a boil: poses held 3+ frames
// change on ≤ 1 frame in 3.
export const BOIL_ACTIVE_MAX = 0.4;
// A boil's pose changes are regular: this share of the gaps between them within BOIL_JITTER
// (relative, at least one frame) of the median gap; needs BOIL_MIN_SPIKES changes to call it.
export const BOIL_REGULAR_MIN = 0.6;
export const BOIL_JITTER = 0.25;
export const BOIL_MIN_SPIKES = 3;
// Six pose changes make a boil period unmistakable; fewer lower the confidence.
const BOIL_SURE_SPIKES = 6;
// Loop periods looked for, seconds: shorter is shimmer, longer is rarely a loop in a short video.
export const LOOP_MIN_S = 0.4;
export const LOOP_MAX_S = 6;
// A lag whose frames differ by at most this share of the median lag difference is a repeat.
export const LOOP_MATCH = 0.35;
// Pixel stride when comparing frames for a loop: every 4th pixel keeps it fast and still exact
// enough for whole-frame repeats.
const LOOP_PIXEL_STRIDE = 4;
// Less than a second of samples makes any verdict shaky; confidence scales down below it.
const SURE_SECONDS = 1;
// Kinds whose box holds a person or filmed footage: jump cuts there read as motion, so skip them.
export const SKIP_KINDS = ['presenter', 'footage'];

const round = (v, d = 2) => Number(v.toFixed(d));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

// Mean absolute difference of each frame to the previous one (one value per frame after the first).
export function frameDiffs(frames) {
  const out = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    let s = 0;
    for (let k = 0; k < b.length; k++) s += Math.abs(b[k] - a[k]);
    out.push(s / b.length);
  }
  return out;
}

// Smallest lag (frames) in [LOOP_MIN_S, LOOP_MAX_S] at which the frames repeat, or null.
export function loopLag(frames, fps) {
  const lo = Math.max(1, Math.round(LOOP_MIN_S * fps));
  // At least 1.5 cycles must fit, or a match at that lag is one coincidence.
  const hi = Math.min(Math.round(LOOP_MAX_S * fps), Math.floor(frames.length / 1.5));
  if (hi < lo) return null;
  const lagDiff = [];
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    let n = 0;
    for (let i = 0; i + lag < frames.length; i++) {
      const a = frames[i];
      const b = frames[i + lag];
      for (let k = 0; k < a.length; k += LOOP_PIXEL_STRIDE) { s += Math.abs(a[k] - b[k]); n++; }
    }
    lagDiff.push(s / n);
  }
  const threshold = Math.max(NOISE_FLOOR, LOOP_MATCH * median(lagDiff));
  let j = lagDiff.findIndex((d) => d <= threshold);
  if (j < 0) return null;
  while (j + 1 < lagDiff.length && lagDiff[j + 1] < lagDiff[j]) j++;
  return lo + j;
}

/**
 * Classify a box's frames.
 * @param {Array<Uint8Array>} frames grayscale frames, all the same size
 * @param {number} fps
 * @returns {{class: 'still'|'boil'|'moving', mean: number, confidence: number, period_s?: number, poses_per_s?: number, loop_s?: number}}
 */
export function classifyMotion(frames, fps) {
  const diffs = frameDiffs(frames);
  const n = diffs.length;
  const mean = n ? diffs.reduce((a, b) => a + b, 0) / n : 0;
  const sure = Math.min(1, n / (SURE_SECONDS * fps));
  const active = diffs.map((d) => d > NOISE_FLOOR);
  const activeShare = n ? active.filter(Boolean).length / n : 0;
  const out = (cls, confidence, extra = {}) => ({ class: cls, ...extra, mean: round(mean), confidence: round(Math.max(0, Math.min(1, confidence)) * sure) });
  if (activeShare <= STILL_ACTIVE_MAX) return out('still', 1 - activeShare / STILL_ACTIVE_MAX / 2);

  if (activeShare <= BOIL_ACTIVE_MAX) {
    // Pose changes: a changed frame after an unchanged one (a two-frame dissolve counts once).
    const onsets = active.flatMap((a, i) => (a && (i === 0 || !active[i - 1]) ? [i] : []));
    if (onsets.length >= BOIL_MIN_SPIKES) {
      const gaps = onsets.slice(1).map((v, i) => v - onsets[i]);
      const m = median(gaps);
      const tol = Math.max(1, m * BOIL_JITTER);
      const regular = gaps.filter((g) => Math.abs(g - m) <= tol).length / gaps.length;
      if (regular >= BOIL_REGULAR_MIN) {
        return out('boil', regular * Math.min(1, onsets.length / BOIL_SURE_SPIKES),
          { period_s: round(m / fps, 3), poses_per_s: round(fps / m) });
      }
      // Sparse but irregular changes: a screen recording's typing and clicks.
      return out('moving', 1 - regular, loopExtra(frames, fps));
    }
  }
  // Confidence 0.5 at the boil boundary, 1 when every frame changes; below it (one or two change events) under 0.5.
  return out('moving', 0.5 + (activeShare - BOIL_ACTIVE_MAX) / (1 - BOIL_ACTIVE_MAX) / 2, loopExtra(frames, fps));
}

function loopExtra(frames, fps) {
  const lag = loopLag(frames, fps);
  return lag ? { loop_s: round(lag / fps, 3) } : {};
}

// Pixel size of the decoded crop: ≤ MAX_WIDTH wide, even, aspect kept.
export function cropSize(box, width, height) {
  const cw = Math.max(2, width * box[2]);
  const ch = Math.max(2, height * box[3]);
  const w = Math.max(2, Math.min(MAX_WIDTH, Math.round(cw / 2) * 2));
  const h = Math.max(2, Math.round((ch * w) / cw / 2) * 2);
  return [w, h];
}

// Decode [start, end) of `src` inside `box` (0–1 fractions) as grayscale frames at source fps.
export function decodeGray(src, { start, end, box, width, height }) {
  const [w, h] = cropSize(box, width, height);
  const [x, y, bw, bh] = box;
  const vf = `crop=iw*${bw}:ih*${bh}:iw*${x}:ih*${y},scale=${w}:${h}:flags=area,format=gray`;
  const args = ['-hide_banner', '-nostats', '-v', 'error', '-ss', sec(start), '-t', sec(end - start), '-i', src,
    '-an', '-vf', vf, '-f', 'rawvideo', '-'];
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args);
    const chunks = [];
    const err = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg crop decode failed: ${Buffer.concat(err).toString('utf-8').trim()}`));
      const buf = Buffer.concat(chunks);
      const size = w * h;
      const frames = [];
      for (let o = 0; o + size <= buf.length; o += size) frames.push(new Uint8Array(buf.subarray(o, o + size)));
      resolve(frames);
    });
  });
}

// What to measure: analysis/elements.json (minus presenter / footage), else every media slot crop
// of analysis/boards.json (minus presenter slots), as { id, board, box, in, out }.
export function motionTargets(project, only) {
  const keep = (t) => !only || only.includes(t.board);
  const inventory = readJson(join(project, 'analysis', 'elements.json'), null);
  if (inventory) {
    return inventory.elements.filter((e) => !SKIP_KINDS.includes(e.kind) && keep(e))
      .map((e) => ({ id: e.id, board: e.board, box: e.box, in: e.in, out: e.out }));
  }
  const boards = readJson(join(project, 'analysis', 'boards.json')).boards;
  const out = [];
  for (const b of boards) {
    const metaPath = join(project, 'template', 'boards', `${b.name}.json`);
    const fields = existsSync(metaPath) ? readJson(metaPath).schema?.fields : null;
    for (const [path, slot] of Object.entries(b.media || {})) {
      if (!slot.crop || (fields && fieldAt(fields, path)?.media?.role === 'presenter')) continue;
      const [start, end] = slot.window || [b.start, b.end];
      out.push({ id: `${b.name}.${path}`, board: b.name, box: slot.crop, in: start, out: end });
    }
  }
  return out.filter(keep);
}

/**
 * Measure every target; `decode(src, opts)` is the frame source (decodeGray; tests pass a fake).
 * @returns {Promise<{results: object, skipped: string[]}>} results keyed by element id
 */
export async function measureTargets(targets, { src, fps, width, height, decode = decodeGray }) {
  const results = {};
  const skipped = [];
  for (const t of targets) {
    const start = t.in + SKIP_IN_S;
    const end = t.out - SKIP_OUT_S;
    // Fewer than three frames to compare cannot tell a boil from a cut.
    if (end - start < 3 / fps) { skipped.push(t.id); continue; }
    const frames = await decode(src, { start, end, box: t.box, width, height });
    if (frames.length < 3) { skipped.push(t.id); continue; }
    results[t.id] = classifyMotion(frames, fps);
  }
  return { results, skipped };
}
