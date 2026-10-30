// Local transcription with whisper.cpp (spec §5.6): ffmpeg → 16 kHz mono wav, then
// `whisper-cli -ojf`, whose full JSON carries per-token timestamps (examples/cli/cli.cpp:
// result.language, transcription[].{offsets.{from,to} in ms, text, tokens[].{text, offsets}}).
// The model is fetched on first use from Hugging Face, or its mirror hf-mirror.com when Hugging
// Face fails or crawls (TAPVID_WHISPER_MODEL_URL overrides both). Child processes go through
// `deps` so tests can replace them (setDeps).
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MediaError } from '../lib/media/errors.mjs';
import { HOME, runAsync } from '../lib/common.mjs';
import { platform } from '../lib/platform.mjs';

const MODEL = 'ggml-large-v3-turbo.bin';
const MODEL_URLS = [
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}`,
  `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/${MODEL}`,
];
// Time allowed to reach the first response headers; the body itself is watched by the speed check.
const MODEL_HEADERS_TIMEOUT_MS = 120_000;
// After ~8 s a host still under 500 KB/s is dropped for the next one: Hugging Face through a
// user's proxy ran at ~35 KB/s (13 h for the 1.6 GB model) while hf-mirror.com gave 3.8 MB/s.
const SPEED_PROBE_MS = 8_000;
const MIN_BYTES_PER_S = 500 * 1024;
const MAX_REDIRECTS = 5;

const defaults = {
  exec: runAsync, which: (tool) => platform.which(tool), modelPath: () => join(HOME, 'models', MODEL), speedProbeMs: SPEED_PROBE_MS,
};
let deps = defaults;

// Test seam: replace the child-process runner, executable lookup, model path or speed-probe delay;
// returns a restore function.
export function setDeps(overrides) {
  deps = { ...defaults, ...overrides };
  return () => { deps = defaults; };
}

export const meta = {
  name: 'whisper-local',
  displayName: 'whisper.cpp (local)',
  docs: 'https://github.com/ggml-org/whisper.cpp',
  secrets: [],
  concurrency: 1, // one model in memory at a time
  timeoutS: 3600,
  capabilities: { 'speech.transcribe': { models: [{ id: 'large-v3-turbo', default: true, price: { usdPerRequest: 0 } }] } },
};

function binaries() {
  const whisper = deps.which('whisper-cli');
  if (!whisper) throw new MediaError('unsupported', 'whisper-cli not installed (whisper.cpp, spec §2.1)');
  const ffmpeg = deps.which('ffmpeg');
  if (!ffmpeg) throw new MediaError('unsupported', 'ffmpeg not installed');
  return { whisper, ffmpeg };
}

export async function verify() {
  binaries();
}

// Hugging Face reports an LFS file's sha256 as X-Linked-ETag on the resolve response (before its
// redirect to the CDN); hf-mirror.com passes it through. Plain git ETags (sha1) are ignored.
const linkedSha = (res) => (res.headers.get('x-linked-etag') || '').match(/\b[0-9a-f]{64}\b/i)?.[0].toLowerCase() || null;

// GET following redirects by hand, so the hash header of every hop is seen.
// → { res, sha, error }: the final response, the first sha256 reported, why it failed.
async function openModel(ctx, url) {
  let next = url;
  let sha = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await ctx.fetch(next, { redirect: 'manual', timeoutMs: MODEL_HEADERS_TIMEOUT_MS });
    } catch (e) {
      return { sha, error: e.message };
    }
    sha ||= linkedSha(res);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      next = new URL(location, next).href;
      continue;
    }
    if (!res.ok || !res.body) return { sha, error: `HTTP ${res.status}` };
    return { res, sha, error: null };
  }
  return { sha, error: 'too many redirects' };
}

// Stream one host's body into `part`, hashing on the way. With `probe`, a host still under
// MIN_BYTES_PER_S after deps.speedProbeMs is cancelled. → { sha, error }: the sha256 the host
// reported (kept to check the next host's file) and why it failed, null on success.
async function fetchModel(ctx, url, part, { probe, expectedSha }) {
  const { res, sha, error } = await openModel(ctx, url);
  const want = expectedSha || sha;
  if (error) return { sha: want, error };
  const length = Number(res.headers.get('content-length')) || null;
  const reader = res.body.getReader();
  const hash = createHash('sha256');
  const fd = openSync(part, 'w');
  const started = Date.now();
  let bytes = 0;
  let slow = false;
  const timer = probe ? setTimeout(() => {
    const rate = bytes / ((Date.now() - started) / 1000);
    if (rate < MIN_BYTES_PER_S) { slow = `${Math.round(rate / 1024)} KB/s`; reader.cancel().catch(() => {}); }
  }, deps.speedProbeMs) : null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      writeSync(fd, value);
      hash.update(value);
      bytes += value.length;
    }
  } catch (e) {
    if (!slow) return { sha: want, error: e.message };
  } finally {
    clearTimeout(timer);
    closeSync(fd);
  }
  if (slow) return { sha: want, error: `too slow (${slow})` };
  if (length && bytes !== length) return { sha: want, error: `incomplete: ${bytes} of ${length} bytes` };
  const got = hash.digest('hex');
  if (want && got !== want) return { sha: want, error: `sha256 ${got} does not match ${want}` };
  return { sha: want, error: null };
}

const modelUrls = () => (process.env.TAPVID_WHISPER_MODEL_URL ? [process.env.TAPVID_WHISPER_MODEL_URL] : MODEL_URLS);

async function ensureModel(ctx) {
  const path = deps.modelPath();
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.part`;
  const urls = modelUrls();
  const errors = [];
  let expectedSha = null;
  for (const [i, url] of urls.entries()) {
    const host = new URL(url).host;
    ctx.log(`downloading whisper model ${MODEL} (~1.6 GB) from ${host} to ${path}`);
    const { sha, error } = await fetchModel(ctx, url, part, { probe: i < urls.length - 1, expectedSha });
    if (!error) {
      renameSync(part, path);
      return path;
    }
    rmSync(part, { force: true });
    // A hash one host reported still checks the next host's file.
    expectedSha ||= sha;
    errors.push(`${host}: ${error}`);
    ctx.log(`model download from ${host} failed: ${error}`);
  }
  throw new MediaError('transient', `model download failed — ${errors.join('; ')}`);
}

const SPECIAL = /^\[_[A-Z]+_?\d*\]$|^<\|.*\|>$/;
const CJK = /[㐀-鿿぀-ヿ가-힯]/;

// Tokens → words. A token starting with a space opens a word, the rest continue it (sub-word
// pieces); CJK tokens are words of their own. Special tokens ([_BEG_], [_TT_42]) are dropped.
export function wordsFromTokens(segments) {
  const words = [];
  let cur = null;
  const flush = () => { if (cur && cur.text) words.push(cur); cur = null; };
  for (const seg of segments) {
    for (const t of seg.tokens || []) {
      const raw = String(t.text || '');
      if (SPECIAL.test(raw.trim()) || !t.offsets) continue;
      const start = t.offsets.from / 1000;
      const end = t.offsets.to / 1000;
      const text = raw.trim();
      if (!text) { flush(); continue; }
      if (CJK.test(text) || /^\s/.test(raw) || !cur) {
        flush();
        cur = { text, start, end };
        if (CJK.test(text)) flush();
      } else {
        cur = { ...cur, text: cur.text + text, end };
      }
    }
    flush();
  }
  return words;
}

export function transcriptFrom(full) {
  const segs = full.transcription || [];
  const segments = segs.map((s) => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: String(s.text).trim() }));
  return {
    language: full.result?.language || null,
    text: segments.map((s) => s.text).join(' ').trim(),
    segments,
    words: wordsFromTokens(segs),
  };
}

export async function submit(capability, req, ctx) {
  if (capability !== 'speech.transcribe') throw new MediaError('unsupported', `whisper-local has no ${capability}`);
  const src = ctx.abs(req.params.file);
  if (!existsSync(src)) throw new MediaError('invalid', `no such file: ${req.params.file}`);
  const { whisper, ffmpeg } = binaries();
  const model = await ensureModel(ctx);
  const work = mkdtempSync(join(tmpdir(), 'tapvid-whisper-'));
  try {
    const wav = join(work, 'in.wav');
    const conv = await deps.exec(ffmpeg, ['-y', '-v', 'error', '-i', src, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    if (conv.code !== 0) throw new MediaError('invalid', `ffmpeg could not read ${req.params.file}: ${conv.stderr.trim().slice(-300)}`);
    const base = join(work, 'out');
    const language = req.params.language ? req.params.language.slice(0, 2).toLowerCase() : 'auto';
    const res = await deps.exec(whisper, ['-m', model, '-f', wav, '-l', language, '-ojf', '-of', base, '-np']);
    if (res.code !== 0 || !existsSync(`${base}.json`)) throw new MediaError('transient', `whisper-cli failed: ${String(res.stderr).trim().slice(-300)}`);
    const transcript = transcriptFrom(JSON.parse(readFileSync(`${base}.json`, 'utf-8')));
    const path = ctx.writeOut(req.out, Buffer.from(JSON.stringify(transcript, null, 2)), 'json');
    return { result: { files: [{ path, mime: 'application/json' }], cost: { usd: 0, credits: null, estimated: false } } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
