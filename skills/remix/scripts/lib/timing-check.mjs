// compare.mjs --timing: does each board page change when the source changes? (spec §4 step 3.9)
//   - board windows start and end on a timeline shot boundary or transition edge;
//   - a template transition's duration matches the source's soft transition at that boundary;
//   - every hard cut and motion peak inside a board window has a frame-difference peak of the
//     rendered board within one frame;
//   - with source/sfx.json, every sound effect of the source has a template cue (a [data-sfx]
//     element entering, capture.mjs) within two frames, and every cue a sound in the source.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { peakFrames } from './cuts.mjs';
import { captureAt, openPage } from './board-page.mjs';
import { sfxTracker } from './capture.mjs';
import { frameMetrics } from './video.mjs';

// Rendered frames are screenshot at this fraction of the canvas: layout is unchanged, and a
// quarter-size frame still shows any element change while capturing ~10× faster.
const RENDER_SCALE = 0.25;
// Board difference peaks count from this share of the board's largest change, and at least
// BOARD_PEAK_YDIF luma levels, so anti-aliasing shimmer is not an "element change".
const BOARD_PEAK_SHARE = 0.1;
const BOARD_PEAK_YDIF = 0.3;
// A source event with no board peak within this many frames is reported as missing.
const MATCH_RADIUS = 8;
const TOLERANCE_FRAMES = 1;
// A sound effect and a template cue pair up within two frames: the onset detector's hop is
// 11.6 ms and a cue lands on the first visible frame, so one frame each way, plus one.
const SFX_TOLERANCE_FRAMES = 2;

const edgesOf = (timeline) => {
  const set = new Set([0, timeline.duration_s]);
  for (const s of timeline.shots) {
    set.add(s.start); set.add(s.end);
    for (const tr of [s.transition_in, s.transition_out]) if (tr) { set.add(tr.start); set.add(tr.end); }
  }
  return [...set];
};

export function boundaryIssues(board, template, timeline, fps) {
  const issues = [];
  const edges = edgesOf(timeline);
  for (const [label, t] of [['start', board.start], ['end', board.end]]) {
    const nearest = edges.reduce((a, e) => (Math.abs(e - t) < Math.abs(a - t) ? e : a), edges[0]);
    const off = Math.round((t - nearest) * fps);
    if (Math.abs(off) > TOLERANCE_FRAMES) issues.push({ board: board.name, kind: `window ${label}`, source_t: nearest, board_t: t, frames: off });
  }
  for (const tr of (template.transitions || []).filter((x) => x.from === board.name)) {
    const soft = timeline.shots.map((s) => s.transition_out).filter((x) => x?.type === 'soft')
      .find((x) => x.start - 1 / fps <= board.end && board.end <= x.end + 1 / fps);
    if (!soft) {
      issues.push({ board: board.name, kind: `transition ${tr.type}`, source_t: board.end, board_t: board.end, frames: null, note: 'no soft transition in the source at this boundary' });
      continue;
    }
    const off = Math.round((tr.duration - (soft.end - soft.start)) * fps);
    if (Math.abs(off) > TOLERANCE_FRAMES) {
      issues.push({ board: board.name, kind: `transition ${tr.type} duration`, source_t: soft.start, board_t: board.end, frames: off,
        note: `template ${tr.duration}s, source ${Number((soft.end - soft.start).toFixed(3))}s` });
    }
  }
  return issues;
}

// Source events inside the board window, as frames relative to the window start.
export function sourceEvents(board, timeline, fps) {
  const s0 = Math.round(board.start * fps);
  const n = Math.round((board.end - board.start) * fps);
  const events = [
    ...timeline.shots.filter((s) => s.transition_in?.type === 'cut').map((s) => ({ kind: 'cut', frame: s.start_frame })),
    ...(timeline.motion_peaks || []).map((p) => ({ kind: 'motion peak', frame: p.frame })),
  ];
  // An event within a frame of the window edge is the board boundary itself, checked above.
  return events.map((e) => ({ ...e, frame: e.frame - s0 })).filter((e) => e.frame > TOLERANCE_FRAMES && e.frame < n - TOLERANCE_FRAMES);
}

export function matchEvents(board, events, boardSeries, fps) {
  const max = Math.max(...boardSeries, 0);
  const peaks = peakFrames(boardSeries, Math.max(BOARD_PEAK_YDIF, BOARD_PEAK_SHARE * max), 2);
  const issues = [];
  for (const e of events) {
    const p = peaks.reduce((a, k) => (a === null || Math.abs(k - e.frame) < Math.abs(a - e.frame) ? k : a), null);
    const t = board.start + e.frame / fps;
    if (p === null || Math.abs(p - e.frame) > MATCH_RADIUS) {
      issues.push({ board: board.name, kind: e.kind, source_t: Number(t.toFixed(3)), board_t: null, frames: null, note: 'no matching change in the board' });
    } else if (Math.abs(p - e.frame) > TOLERANCE_FRAMES) {
      issues.push({ board: board.name, kind: e.kind, source_t: Number(t.toFixed(3)), board_t: Number((board.start + p / fps).toFixed(3)), frames: p - e.frame });
    }
  }
  return issues;
}

// Source sound effects (sfx.json events, source seconds) against template cues ({ t, kind },
// source seconds): each pairs with the nearest unpaired one of the other within
// SFX_TOLERANCE_FRAMES; whatever stays unpaired on either side is an issue.
export function matchSfx(board, events, cues, fps) {
  const tol = (SFX_TOLERANCE_FRAMES + 0.5) / fps;
  const paired = new Set();
  const issues = [];
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const best = cues.map((c, i) => ({ i, d: Math.abs(c.t - e.t) })).filter((x) => !paired.has(x.i) && x.d <= tol)
      .reduce((a, x) => (a === null || x.d < a.d ? x : a), null);
    if (best) paired.add(best.i);
    else issues.push({ board: board.name, kind: 'sfx', source_t: e.t, board_t: null, frames: null, note: `sfx ${e.t}s (${e.kindGuess}) has no cue in the template` });
  }
  cues.forEach((c, i) => {
    if (!paired.has(i)) issues.push({ board: board.name, kind: 'sfx', source_t: null, board_t: c.t, frames: null, note: `template sfx cue ${c.t}s (${c.kind}) has no sound in the source` });
  });
  return issues;
}

// Render every frame of the board window at RENDER_SCALE and return its per-frame luma difference
// (unsmoothed: a board change is crisp, and a 3-frame mean would turn a one-frame spike into a tie)
// and the sound-effect cues it shows, in source seconds.
export async function boardDiffSeries(browser, htmlFile, canvas, board, fps, offset, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const n = Math.round((board.end - board.start) * fps);
  const page = await openPage(browser, htmlFile, canvas, { scale: RENDER_SCALE });
  const track = sfxTracker(page);
  const cues = [];
  try {
    for (let k = 0; k < n; k++) {
      await captureAt(page, k / fps + offset, join(dir, `${String(k).padStart(5, '0')}.png`));
      cues.push(...await track(board.start + k / fps));
    }
  } finally {
    await page.close();
  }
  const m = await frameMetrics(['-framerate', String(fps), '-i', join(dir, '%05d.png')]);
  rmSync(dir, { recursive: true, force: true });
  return { ydif: m.ydif, cues };
}

// `sfx`: source/sfx.json events when the source has been scanned for sound effects.
export async function checkTiming({ browser, board, template, timeline, canvas, fps, offset, htmlFile, work, sfx }) {
  const issues = boundaryIssues(board, template, timeline, fps);
  const events = sourceEvents(board, timeline, fps);
  if (events.length || sfx) {
    const { ydif, cues } = await boardDiffSeries(browser, htmlFile, canvas, board, fps, offset, join(work, `${board.name}.timing`));
    issues.push(...matchEvents(board, events, ydif, fps));
    if (sfx) issues.push(...matchSfx(board, sfx.filter((e) => e.t >= board.start && e.t < board.end), cues, fps));
  }
  return issues;
}
