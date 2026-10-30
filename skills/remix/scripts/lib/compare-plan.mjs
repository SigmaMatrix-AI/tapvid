// What compare.mjs samples (ported from compare_boards.py): per board a list of runs (the board
// itself and each count variant), each with windows (board time, source time, length) and the
// three sample instants per window. Pure functions.
import { boardSegments } from './board-fields.mjs';

export const FRACTIONS = [0.25, 0.6, 0.85];

// Where inside its frame interval source frame n is sampled: the middle for a recorded source
// (a camera or screen frame was exposed over the whole interval), just after n / fps for a source
// rendered frame by frame (`"source_frame_time": "start"`), plus 1 ms so a clip seek never lands
// on a frame boundary.
export function frameOffset(mode = 'middle', fps) {
  if (mode === 'middle') return 0.5 / fps;
  if (mode === 'start') return 0.001;
  throw new Error(`analysis/boards.json: source_frame_time "${mode}" must be "middle" or "start"`);
}

// Windows of an unsegmented board: each timeline shot inside the board window, else the window.
export function shotWindows(board, timeline) {
  const shots = (timeline?.shots || []).filter((s) => (board.shots ? board.shots.includes(s.index) : s.end > board.start && s.start < board.end));
  const windows = shots.map((s) => {
    const a = Math.max(s.start, board.start) - board.start;
    const b = Math.min(s.end, board.end) - board.start;
    return [a, a, b - a];
  }).filter(([, , len]) => len > 0);
  return windows.length ? windows : [[0, 0, board.end - board.start]];
}

// [{ k, fraction, n, ts, boardT }]: source frame n and its sample time ts, and the board time
// that keeps the instant's offset inside its window (so a variant maps to the source's frame).
export function sampleWindows(windows, boardStart, fps, offset) {
  const out = [];
  windows.forEach(([boardAt, srcAt, len], k) => {
    for (const fraction of FRACTIONS) {
      const n = Math.floor((boardStart + srcAt + fraction * len) * fps + 1e-3);
      const ts = n / fps + offset;
      out.push({ k, fraction, n, ts, boardT: boardAt + ts - boardStart - srcAt });
    }
  });
  return out;
}

// A segmented board at another list count, made of its own source items. `pick` is
// { "<object[] field>": [source item index, …] }. Returns the variant's data, its segments laid
// back to back from 0 (each line keeps its source length), its windows, and per variant item j
// the shift (source start − variant start of its first line) that media offsets follow.
export function variantContent(meta, pick) {
  const entries = Object.entries(pick || {});
  if (entries.length !== 1) throw new Error('pick must name exactly one list field');
  const [[field, idx]] = entries;
  const fields = meta.schema?.fields || [];
  const f = fields.find((x) => x.key === field);
  if (f?.type !== 'object[]') throw new Error(`pick field ${field} is not a top-level object[]`);
  const items = meta.example_data?.[field] || [];
  if (!Array.isArray(idx) || !idx.length || idx.some((i) => !Number.isInteger(i) || i < 0 || i >= items.length)) {
    throw new Error(`pick ${field}: must list source item indexes 0..${items.length - 1}`);
  }
  if ((f.minItems && idx.length < f.minItems) || (f.maxItems && idx.length > f.maxItems)) {
    throw new Error(`pick ${field}: ${idx.length} items is outside ${f.minItems ?? 0}..${f.maxItems ?? '∞'}`);
  }
  const source = Object.fromEntries((meta.example_segments || []).map((s) => [s.key, s]));
  const data = { ...meta.example_data, [field]: idx.map((i) => structuredClone(items[i])) };
  const head = `${field}.`;
  const segments = [];
  const windows = [];
  const shift = {};
  let at = 0;
  for (const [key] of boardSegments(fields, data)) {
    let srcKey = key;
    let item = null;
    if (key.startsWith(head)) {
      const [j, ...rest] = key.slice(head.length).split('.');
      item = Number(j);
      srcKey = `${head}${idx[item]}.${rest.join('.')}`;
    }
    const src = source[srcKey];
    if (!src) throw new Error(`example_segments has no ${srcKey}`);
    const len = src.end - src.start;
    if (item !== null && shift[item] === undefined) shift[item] = Number((src.start - at).toFixed(6));
    segments.push({ key, start: Number(at.toFixed(3)), end: Number((at + len).toFixed(3)) });
    windows.push([at, src.start, len]);
    at += len;
  }
  return { data, segments, windows, shift };
}

// Media of a variant: a slot inside source item idx[j] of `field` moves to item j, and a video
// slot's offset follows its item's move on the timeline.
export function variantMedia(media, field, idx, shift) {
  const head = `${field}.`;
  const out = {};
  for (const [key, m] of Object.entries(media)) {
    if (!key.startsWith(head)) { out[key] = m; continue; }
    const [i, ...rest] = key.slice(head.length).split('.');
    idx.forEach((src, j) => {
      if (String(src) !== i) return;
      out[`${head}${j}.${rest.join('.')}`] = m.kind === 'video' ? { ...m, offset: Number(((m.offset || 0) + (shift[j] || 0)).toFixed(6)) } : m;
    });
  }
  return out;
}

// The board itself, then each of its variants: { label, variant, data, segments, duration, windows, segmented, remap }.
export function boardRuns(board, meta, timeline) {
  const segs = meta.example_segments;
  const duration = board.end - board.start;
  const runs = [{
    label: board.name, variant: null, data: meta.example_data, segments: segs, duration, segmented: Boolean(segs?.length),
    windows: segs?.length ? segs.map((s) => [s.start, s.start, s.end - s.start]) : shotWindows(board, timeline),
    remap: (media) => media,
  }];
  for (const v of board.variants || []) {
    const c = variantContent(meta, v.pick);
    const [[field, idx]] = Object.entries(v.pick);
    runs.push({
      label: `${board.name}-${v.id}`, variant: v.id, data: c.data, segments: c.segments, duration: c.segments[c.segments.length - 1].end,
      segmented: true, windows: c.windows, remap: (media) => variantMedia(media, field, idx, c.shift),
    });
  }
  return runs;
}
