// yt-dlp (spec §5.6): download a public video page as mp4 plus a slim info.json. Runs the local
// binary (installed with consent by step 0, spec §2.1); no key. The child process goes through
// `deps` so tests can replace it (setDeps).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MediaError } from '../lib/media/errors.mjs';
import { runAsync } from '../lib/common.mjs';
import { platform } from '../lib/platform.mjs';

const FORMAT = 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4] / bv*+ba/b';

const defaults = { exec: runAsync, which: (tool) => platform.which(tool) };
let deps = defaults;

// Test seam: replace the child-process runner and executable lookup; returns a restore function.
export function setDeps(overrides) {
  deps = { ...defaults, ...overrides };
  return () => { deps = defaults; };
}

export const meta = {
  name: 'ytdlp',
  displayName: 'yt-dlp',
  docs: 'https://github.com/yt-dlp/yt-dlp',
  secrets: [],
  concurrency: 2,
  timeoutS: 1800,
  capabilities: { 'video.download': { models: [] } },
};

function binary() {
  const bin = deps.which('yt-dlp');
  if (!bin) throw new MediaError('unsupported', 'yt-dlp not installed (install it with consent, spec §2.1)');
  return bin;
}

export async function verify() {
  binary();
}

export async function estimate() {
  return { usd: 0, credits: null };
}

// yt-dlp exits non-zero with an "ERROR: …" line; unsupported sites route elsewhere, gone or
// private videos are the request's fault, anything else (network, throttling) is worth a retry.
function failure(stderr) {
  const line = String(stderr).split(/\r?\n/).reverse().find((l) => l.startsWith('ERROR')) || String(stderr).trim().slice(-300);
  if (/Unsupported URL/i.test(line)) return new MediaError('unsupported', `yt-dlp: ${line}`);
  if (/unavailable|private|removed|not available|sign in|log in|login|age.restricted|copyright/i.test(line)) return new MediaError('invalid', `yt-dlp: ${line}`);
  return new MediaError('transient', `yt-dlp: ${line || 'download failed'}`);
}

export async function submit(capability, req, ctx) {
  if (capability !== 'video.download') throw new MediaError('unsupported', `ytdlp has no ${capability}`);
  // Only web pages: yt-dlp would otherwise read local files or other schemes.
  if (!/^https?:\/\//i.test(req.params.url)) throw new MediaError('invalid', `not an http(s) url: ${req.params.url}`);
  const bin = binary();
  const out = ctx.abs(req.out);
  mkdirSync(dirname(out), { recursive: true });
  const args = ['-f', FORMAT, '--merge-output-format', 'mp4', '--write-info-json', '--no-playlist', '--no-progress', '-o', `${out}.%(ext)s`, req.params.url];
  const res = await deps.exec(bin, args);
  if (res.code !== 0) throw failure(res.stderr);
  const video = `${out}.mp4`;
  const infoPath = `${out}.info.json`;
  if (!existsSync(video)) throw new MediaError('transient', `yt-dlp finished without ${video}`);
  const info = existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, 'utf-8')) : {};
  // Keep what the pipeline uses; the raw file lists every format and runs to megabytes.
  const slim = {
    id: info.id ?? null, title: info.title ?? null, uploader: info.uploader ?? info.channel ?? null,
    channel: info.channel ?? null, duration_s: info.duration ?? null, url: info.webpage_url || req.params.url,
    extractor: info.extractor_key ?? info.extractor ?? null, upload_date: info.upload_date ?? null,
    view_count: info.view_count ?? null, width: info.width ?? null, height: info.height ?? null,
  };
  writeFileSync(infoPath, JSON.stringify(slim, null, 2) + '\n');
  const file = { path: video, mime: 'video/mp4' };
  if (slim.duration_s) file.duration_s = slim.duration_s;
  if (slim.width) Object.assign(file, { width: slim.width, height: slim.height });
  return { result: { files: [file, { path: infoPath, mime: 'application/json' }] } };
}
