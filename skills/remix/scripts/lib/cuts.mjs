// Shot structure from per-frame metrics (video.mjs frameMetrics): hard cuts, soft transitions,
// motion peaks, and which frames to extract per shot. Pure functions, unit-tested on arrays.
//
// The thresholds are first-pass values from synthetic clips (solid colours, a 0.5 s crossfade,
// a sliding block) and the sample fixture; spec §12 item 2 calibrates them on real sources.
import { histDistance } from './video.mjs';

// A hard cut changes the picture between two frames: the change score (max of ffmpeg's scene
// score and the RGB histogram distance) is high, and the frame's luma difference stands far
// above both neighbours. A crossfade's frames each change a little and evenly, so they fail the
// isolation test however high their histogram jump.
export const HARD_CUT_SCORE = 0.3;
export const CUT_ISOLATION = 3;
// A soft transition (dissolve, wipe, push, zoom) is a run of frames that each change by at
// least SOFT_YDIF (luma levels of 255), lasting MIN_SOFT_FRAMES..MAX_SOFT_S, whose frame before
// and last frame differ by SOFT_PICTURE_CHANGE in histogram distance. The last test separates
// a transition from a camera move or an element entrance, which leave the palette mostly as it
// was (a block covering 8 % of the frame moves the distance by ~0.08).
export const SOFT_YDIF = 1.0;
export const MIN_SOFT_FRAMES = 5;
export const MAX_SOFT_S = 2.0;
export const SOFT_PICTURE_CHANGE = 0.35;
// Shots shorter than this many frames are merged into the previous one (flash frames).
export const MIN_SHOT_FRAMES = 3;
// A motion peak is a local maximum of the smoothed luma difference at least MOTION_PEAK_YDIF,
// the highest within ±PEAK_RADIUS frames.
export const MOTION_PEAK_YDIF = 0.8;
export const PEAK_RADIUS = 5;

const round3 = (v) => Number(v.toFixed(3));

// Hard cut frames: the first frame of the new shot.
export function hardCuts({ ydif, scene, hists }) {
  const out = [];
  for (let i = 1; i < ydif.length; i++) {
    const score = Math.max(scene[i] || 0, histDistance(hists[i - 1], hists[i]));
    if (score < HARD_CUT_SCORE) continue;
    const around = Math.max(ydif[i - 1] || 0, ydif[i + 1] || 0, 0.25);
    if (ydif[i] >= CUT_ISOLATION * around) out.push(i);
  }
  return out;
}

// Soft transitions as frame windows { from, to }: frame `from` is the last frame before the
// change, frame `to` the first frame after it (the first frame of the incoming picture).
export function softTransitions({ ydif, hists }, fps, cuts = []) {
  const cutSet = new Set(cuts);
  const out = [];
  let i = 1;
  while (i < ydif.length) {
    if (ydif[i] < SOFT_YDIF || cutSet.has(i)) { i++; continue; }
    let j = i;
    while (j + 1 < ydif.length && ydif[j + 1] >= SOFT_YDIF && !cutSet.has(j + 1)) j++;
    const len = j - i + 1;
    if (len >= MIN_SOFT_FRAMES && len <= MAX_SOFT_S * fps && histDistance(hists[i - 1], hists[j]) >= SOFT_PICTURE_CHANGE) {
      out.push({ from: i - 1, to: j });
    }
    i = j + 1;
  }
  return out;
}

// Shots with transition_in / transition_out. A soft transition's window belongs to the shot it
// leaves: the boundary is the transition's last frame (spec §4 step 2 example).
export function buildShots(frames, fps, cuts, softs) {
  const bounds = [
    ...cuts.map((f) => ({ frame: f, transition: { type: 'cut', start: round3(f / fps), end: round3(f / fps) } })),
    ...softs.map((s) => ({ frame: s.to, transition: { type: 'soft', start: round3(s.from / fps), end: round3(s.to / fps) } })),
  ].sort((a, b) => a.frame - b.frame);
  const kept = [];
  for (const b of bounds) {
    const prev = kept.length ? kept[kept.length - 1].frame : 0;
    if (b.frame - prev >= MIN_SHOT_FRAMES && frames - b.frame >= MIN_SHOT_FRAMES) kept.push(b);
  }
  const edges = [0, ...kept.map((b) => b.frame), frames];
  return edges.slice(0, -1).map((start, k) => ({
    index: k,
    start: round3(start / fps),
    end: round3(edges[k + 1] / fps),
    start_frame: start,
    end_frame: edges[k + 1],
    transition_in: k === 0 ? null : kept[k - 1].transition,
    transition_out: k === kept.length ? null : kept[k].transition,
  }));
}

// Local maxima of the 3-frame mean luma difference, outside cut frames and transition windows.
export function motionPeaks({ ydif }, fps, shots) {
  const masked = ydif.map((v, i) => (shots.some((s) => insideTransition(s, i, fps)) ? 0 : v));
  for (const s of shots) if (s.transition_in?.type === 'cut') masked[s.start_frame] = 0;
  const smooth = smooth3(masked);
  const max = Math.max(...smooth, 1e-9);
  return peakFrames(smooth, MOTION_PEAK_YDIF).map((i) => {
    const shot = shots.find((s) => i >= s.start_frame && i < s.end_frame);
    return { t: round3(i / fps), frame: i, shot: shot ? shot.index : 0, strength: round3(smooth[i] / max) };
  });
}

export const smooth3 = (v) => v.map((_, i) => ((v[i - 1] ?? v[i]) + v[i] + (v[i + 1] ?? v[i])) / 3);

// Indexes of local maxima at least `min`, each the highest within ±radius (first one on ties).
export function peakFrames(series, min, radius = PEAK_RADIUS) {
  const out = [];
  for (let i = 1; i < series.length - 1; i++) {
    if (series[i] < min) continue;
    let top = true;
    for (let k = Math.max(0, i - radius); k <= Math.min(series.length - 1, i + radius); k++) {
      if (series[k] > series[i] || (series[k] === series[i] && k < i)) { top = false; break; }
    }
    if (top) out.push(i);
  }
  return out;
}

function insideTransition(shot, frame, fps) {
  const t = shot.transition_out;
  return t?.type === 'soft' && frame > Math.round(t.start * fps) && frame <= Math.round(t.end * fps);
}

// Frames to extract for one shot (spec §4 step 2.5): every 4th frame under 2 s, 4 per second up
// to 6 s, 2 per second beyond; plus first, last, motion peaks, and transition start / middle / end.
export function shotFrames(shot, fps, peaks) {
  const len = shot.end_frame - shot.start_frame;
  const seconds = len / fps;
  const step = seconds < 2 ? 4 : seconds <= 6 ? fps / 4 : fps / 2;
  const set = new Set([shot.start_frame, shot.end_frame - 1]);
  for (let f = shot.start_frame; f < shot.end_frame; f += step) set.add(Math.round(f));
  for (const p of peaks) if (p.frame >= shot.start_frame && p.frame < shot.end_frame) set.add(p.frame);
  for (const tr of [shot.transition_in, shot.transition_out]) {
    if (tr?.type !== 'soft') continue;
    const a = Math.round(tr.start * fps);
    const b = Math.round(tr.end * fps);
    for (const f of [a, Math.round((a + b) / 2), b]) set.add(f);
  }
  return [...set].filter((f) => f >= 0).sort((a, b) => a - b);
}
