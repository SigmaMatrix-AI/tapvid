// ffmpeg / ffprobe helpers shared by the clone scripts (intake, refs, build-boards, compare).
// Every call passes an argument array (spec §2.1); binary output is read as a byte stream.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { run, runAsync } from './common.mjs';

const FFMPEG = process.env.TAPVID_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.TAPVID_FFPROBE || 'ffprobe';
const QUIET = ['-hide_banner', '-nostats', '-v', 'error', '-y'];

export async function ffmpeg(args, { input } = {}) {
  const res = await runAsync(FFMPEG, [...QUIET, ...args], { input });
  if (res.code !== 0) throw new Error(`ffmpeg failed (${res.code}): ${res.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  return res;
}

export function probe(file) {
  return JSON.parse(run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
}

const rate = (s) => {
  const [num, den] = String(s || '0/1').split('/').map(Number);
  return den ? num / den : num;
};

// fps, size, duration and whether there is an audio track, from a probe() result.
export function videoInfo(probed) {
  const v = probed.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('no video stream');
  const fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate);
  return {
    fps: Number(fps.toFixed(3)),
    width: v.width,
    height: v.height,
    duration: Number(probed.format?.duration || v.duration || 0),
    hasAudio: probed.streams.some((s) => s.codec_type === 'audio'),
  };
}

const filterCache = new Map();
export function hasFilter(name) {
  if (!filterCache.has(name)) {
    let out = '';
    try { out = run(FFMPEG, ['-hide_banner', '-filters']); } catch { /* treat as missing */ }
    filterCache.set(name, new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(out));
  }
  return filterCache.get(name);
}

// Per-frame analysis in one decode: ffmpeg's scene score (select) and luma difference to the
// previous frame (signalstats YDIF, 0–255), both computed on a 160×90 copy, plus a coarse RGB
// histogram per frame computed here from a 64×36 copy streamed on stdout.
const METRIC_SIZE = [160, 90];
const HIST_SIZE = [64, 36];
export const HIST_BINS = 8; // per channel; coarse so codec noise and small motion barely move it

// `input` is a file, or ffmpeg input arguments (e.g. an image sequence with its frame rate).
export function frameMetrics(input) {
  const [hw, hh] = HIST_SIZE;
  const frameBytes = hw * hh * 3;
  const chain = [
    `scale=${METRIC_SIZE.join(':')}`, 'signalstats', 'metadata=print:key=lavfi.signalstats.YDIF',
    "select='gte(scene,0)'", 'metadata=print:key=lavfi.scene_score', `scale=${hw}:${hh}`, 'format=rgb24',
  ].join(',');
  const inputArgs = Array.isArray(input) ? input : ['-i', input];
  const args = ['-hide_banner', '-nostats', ...inputArgs, '-an', '-vf', chain, '-f', 'rawvideo', '-'];
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args);
    const hists = [];
    let pending = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        hists.push(histogram(pending.subarray(0, frameBytes)));
        pending = pending.subarray(frameBytes);
      }
    });
    const err = [];
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const log = Buffer.concat(err).toString('utf-8');
      if (code !== 0) return reject(new Error(`ffmpeg frame metrics failed: ${log.trim().split('\n').slice(-3).join(' | ')}`));
      const ydif = [...log.matchAll(/lavfi\.signalstats\.YDIF=([\d.eE+-]+)/g)].map((m) => Number(m[1]));
      const scene = [...log.matchAll(/lavfi\.scene_score=([\d.eE+-]+)/g)].map((m) => Number(m[1]));
      const n = Math.min(hists.length, ydif.length, scene.length);
      resolve({ frames: n, ydif: ydif.slice(0, n), scene: scene.slice(0, n), hists: hists.slice(0, n) });
    });
  });
}

function histogram(rgb) {
  const h = new Float32Array(HIST_BINS * 3);
  const shift = 8 - Math.log2(HIST_BINS);
  const px = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 3) {
    h[rgb[i] >> shift] += 1;
    h[HIST_BINS + (rgb[i + 1] >> shift)] += 1;
    h[2 * HIST_BINS + (rgb[i + 2] >> shift)] += 1;
  }
  for (let i = 0; i < h.length; i++) h[i] /= px;
  return h;
}

// Histogram distance in [0, 1]: half the L1 distance, averaged over the three channels.
export function histDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / 6;
}

// Mono float PCM at `sampleRate`, for onset / beat analysis.
export async function decodePcm(file, sampleRate = 11025) {
  const res = await runAsync(FFMPEG, ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'], { binary: true });
  if (res.code !== 0) throw new Error(`ffmpeg audio decode failed: ${res.stderr.trim()}`);
  const buf = res.stdout;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4)));
}

export async function extractAudio(file, out) {
  mkdirSync(dirname(out), { recursive: true });
  await ffmpeg(['-i', file, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', out]);
}

// Audio window [start, end) of `file` as mp3.
export async function cutAudio(file, start, end, out) {
  mkdirSync(dirname(out), { recursive: true });
  await ffmpeg(['-ss', sec(start), '-to', sec(end), '-i', file, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-q:a', '4', out]);
}

export async function concatAudio(files, out) {
  const inputs = files.flatMap((f) => ['-i', f]);
  const graph = `${files.map((_, i) => `[${i}:a]`).join('')}concat=n=${files.length}:v=0:a=1[a]`;
  await ffmpeg([...inputs, '-filter_complex', graph, '-map', '[a]', '-c:a', 'libmp3lame', '-q:a', '4', out]);
}

export const sec = (t) => Math.max(0, t).toFixed(6);

// ffmpeg crop expression for a [x, y, w, h] box in 0–1 of the frame, kept to even pixels.
export function cropFilter([x, y, w, h]) {
  return `crop=trunc(iw*${w}/2)*2:trunc(ih*${h}/2)*2:trunc(iw*${x}):trunc(ih*${y})`;
}

// One frame at time t (seconds). Seeks a quarter frame early when `fps` is given, since -ss
// returns the first frame at or after the seek point.
export async function grabFrame(file, t, out, { fps, width, height, crop } = {}) {
  mkdirSync(dirname(out), { recursive: true });
  const vf = [crop && cropFilter(crop), width && height && `scale=${width}:${height}:flags=bicubic`].filter(Boolean);
  const seek = fps ? Math.max(0, t - 0.25 / fps) : t;
  await ffmpeg(['-ss', sec(seek), '-i', file, '-frames:v', '1', ...(vf.length ? ['-vf', vf.join(',')] : []), '-update', '1', out]);
}

// Silent clip of [start, end), optionally cropped, re-encoded so it seeks frame-accurately.
export async function cutClip(file, start, end, out, { crop } = {}) {
  mkdirSync(dirname(out), { recursive: true });
  const vf = crop ? ['-vf', cropFilter(crop)] : [];
  await ffmpeg(['-ss', sec(start), '-to', sec(end), '-i', file, '-an', ...vf,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-g', '15', '-movflags', '+faststart', out]);
}

// Grayscale SSIM of two images; `size` [w, h] scales both first (area filter, like INTER_AREA).
export async function ssim(a, b, size) {
  const prep = size ? `scale=${size[0]}:${size[1]}:flags=area,format=gray` : 'format=gray';
  const graph = `[0:v]${prep}[a];[1:v]${prep}[b];[a][b]ssim`;
  const res = await runAsync(FFMPEG, ['-hide_banner', '-nostats', '-i', a, '-i', b, '-lavfi', graph, '-f', 'null', '-']);
  const m = res.stderr.match(/SSIM .*?All:([\d.]+)/);
  if (res.code !== 0 || !m) throw new Error(`ffmpeg ssim failed: ${res.stderr.trim().split('\n').slice(-2).join(' | ')}`);
  return Number(m[1]);
}

// source | board | |diff|×3 row at 640×360 per cell.
export async function diffRow(source, board, out) {
  const cell = 'scale=640:360,format=gbrp';
  const graph = `[0:v]${cell},split[s1][s2];[1:v]${cell},split[b1][b2];[s2][b2]blend=all_mode=difference,`
    + "format=rgb24,lutrgb=r='min(val*3,255)':g='min(val*3,255)':b='min(val*3,255)',format=gbrp[d];"
    + '[s1][b1][d]hstack=inputs=3,format=rgb24';
  await ffmpeg(['-i', source, '-i', board, '-filter_complex', graph, '-frames:v', '1', '-update', '1', out]);
}
