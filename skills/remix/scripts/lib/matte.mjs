// Local person matting for "behind the subject" layers (references/boards.md §8): Robust Video
// Matting (MobileNetV3, ONNX, 15 MB) on onnxruntime-node turns a video into a cutout — the same
// picture with everything but the people transparent (VP9 with alpha in .webm, which Chromium
// plays). A board draws the clip, the element that sits behind the person, then the cutout on top.
// Free and local: the engine (onnxruntime-node, ~190 MB) installs into ~/.tapvid-video/matte and the
// model downloads into ~/.tapvid-video/models on first use, without asking (local infrastructure).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { HOME } from './common.mjs';
import { npmCommand } from './platform.mjs';
import { probe, videoInfo } from './video.mjs';

export const ENGINE_DIR = join(HOME, 'matte');
const ORT_VERSION = '1.20.1';
export const MODEL_PATH = join(HOME, 'models', 'rvm_mobilenetv3_fp32.onnx');
const MODEL_URL = 'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx';
const MODEL_SHA256 = '88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828';
const FFMPEG = process.env.TAPVID_FFMPEG || 'ffmpeg';
// RVM's guidance: the downsampled short side near 256–512 px (0.25 for HD, 0.125 for 4K, ~0.4 at 720p).
// 288 px gave clean hair edges on 704×1280 and 1080×1920 presenter clips.
const MATTE_SHORT_SIDE = 288;
// VP9 alpha: CRF 32 kept hair edges intact at about a fifth of the source bitrate; realtime keeps
// the encode faster than the matting.
const ENCODE = ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1'];

// The cutout of `file`, next to it: clip.mp4 → clip.cutout.webm.
export const cutoutPath = (file) => `${file.replace(/\.[^./\\]+$/, '')}.cutout.webm`;

// A cutout made after its source still matches it; a newer source (a regenerated or re-sped clip) needs a new one.
export function cutoutFresh(file) {
  const out = cutoutPath(file);
  return existsSync(out) && statSync(out).mtimeMs >= statSync(file).mtimeMs;
}

export const downsampleRatio = (width, height) => Math.min(1, Number((MATTE_SHORT_SIDE / Math.min(width, height)).toFixed(3)));

function ensureEngine(log) {
  if (existsSync(join(ENGINE_DIR, 'node_modules', 'onnxruntime-node'))) return;
  const npm = npmCommand();
  if (!npm) throw new Error('npm not found — run ensure-runtime.mjs first');
  log(`installing the matting engine (onnxruntime-node, ~190 MB) into ${ENGINE_DIR}`);
  mkdirSync(ENGINE_DIR, { recursive: true });
  writeFileSync(join(ENGINE_DIR, 'package.json'), `${JSON.stringify({ private: true, dependencies: { 'onnxruntime-node': ORT_VERSION } }, null, 2)}\n`);
  const r = spawnSync(npm[0], [...npm[1], 'install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: ENGINE_DIR, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error('installing onnxruntime-node failed');
}

async function ensureModel(log) {
  if (existsSync(MODEL_PATH)) return;
  log(`downloading the matting model (15 MB) to ${MODEL_PATH}`);
  mkdirSync(dirname(MODEL_PATH), { recursive: true });
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`matting model download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== MODEL_SHA256) throw new Error(`matting model sha256 ${sha} does not match ${MODEL_SHA256}`);
  writeFileSync(`${MODEL_PATH}.part`, bytes);
  renameSync(`${MODEL_PATH}.part`, MODEL_PATH);
}

// Planar 0–1 floats from interleaved RGB bytes (the model's src tensor layout).
export function toPlanar(rgb, pixels) {
  const out = new Float32Array(3 * pixels);
  for (let i = 0, p = 0; i < pixels; i++, p += 3) {
    out[i] = rgb[p] / 255;
    out[pixels + i] = rgb[p + 1] / 255;
    out[2 * pixels + i] = rgb[p + 2] / 255;
  }
  return out;
}

// Alpha floats → gray bytes.
export function toGray(alpha) {
  const out = Buffer.alloc(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, alpha[i])) * 255);
  return out;
}

// Write the cutout of `file` (default next to it). Resolves { out, frames, seconds }.
export async function matte(file, { out = cutoutPath(file), log = () => {} } = {}) {
  ensureEngine(log);
  await ensureModel(log);
  const ort = createRequire(join(ENGINE_DIR, 'package.json'))('onnxruntime-node');
  const { width: W, height: H, fps } = videoInfo(probe(file));
  const session = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ['cpu'] });
  const ratio = new ort.Tensor('float32', new Float32Array([downsampleRatio(W, H)]), [1]);
  let rec = [0, 1, 2, 3].map(() => new ort.Tensor('float32', new Float32Array(1), [1, 1, 1, 1]));

  const part = `${out}.part.webm`;
  const dec = spawn(FFMPEG, ['-v', 'error', '-i', file, '-an', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const enc = spawn(FFMPEG, ['-v', 'error', '-y', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
    '-filter_complex', '[1:v]format=gray[m];[0:v][m]alphamerge', '-an', ...ENCODE, part], { stdio: ['pipe', 'ignore', 'inherit'] });
  const encDone = new Promise((res) => enc.on('close', res));
  const started = Date.now();
  const size = W * H * 3;
  let buf = Buffer.alloc(0);
  let frames = 0;
  for await (const chunk of dec.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= size) {
      const src = new ort.Tensor('float32', toPlanar(buf.subarray(0, size), W * H), [1, 3, H, W]);
      buf = buf.subarray(size);
      const o = await session.run({ src, r1i: rec[0], r2i: rec[1], r3i: rec[2], r4i: rec[3], downsample_ratio: ratio });
      rec = [o.r1o, o.r2o, o.r3o, o.r4o];
      if (!enc.stdin.write(toGray(o.pha.data))) await new Promise((r) => enc.stdin.once('drain', r));
      frames++;
    }
  }
  enc.stdin.end();
  await session.release();
  const code = await encDone;
  if (code !== 0 || !frames) {
    rmSync(part, { force: true });
    throw new Error(`matting ${file} failed (ffmpeg ${code}, ${frames} frames) — the encoder needs libvpx-vp9`);
  }
  renameSync(part, out);
  return { out, frames, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) };
}

// Whether the engine and the model are installed (tests skip the real run without them).
export const engineReady = () => existsSync(join(ENGINE_DIR, 'node_modules', 'onnxruntime-node')) && existsSync(MODEL_PATH);
