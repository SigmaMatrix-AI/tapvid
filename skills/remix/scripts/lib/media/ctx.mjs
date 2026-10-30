// The ctx object the runner hands to a provider (spec §5.3): secrets, fetch with error
// classification, download / upload helpers, ffprobe and trimming. `fetchImpl` is injectable,
// which is how fixture replay (replay.mjs) runs a provider without the network.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { HOME, readJson, run, writeJson } from '../common.mjs';
import { MediaError, codeForStatus, looksLikeModeration } from './errors.mjs';

// Request timeout for one HTTP call; generation itself is polled, so calls are short.
const DEFAULT_TIMEOUT_MS = 120_000;

const EXT = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/mp4': 'm4a',
  'application/json': 'json', 'text/plain': 'txt',
};

// Reverse map keeps the first (canonical) type per extension: mp3 → audio/mpeg, wav → audio/wav.
const MIME = Object.entries(EXT).reduce((acc, [m, e]) => (acc[e] ? acc : { ...acc, [e]: m }), {});
MIME.jpeg = 'image/jpeg';

export const mimeOf = (file) => MIME[extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
export const extOf = (contentType, url = '') => {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (EXT[ct]) return EXT[ct];
  const fromUrl = extname(new URL(url, 'http://x').pathname).slice(1).toLowerCase();
  return fromUrl || 'bin';
};

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function createCtx({ provider, secrets, fetchImpl = globalThis.fetch, cacheDir = join(HOME, 'cache'), logs = [], cwd = process.cwd() }) {
  const abs = (p) => (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) ? p : join(cwd, p));

  async function fetchClassified(url, opts = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = opts;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: ac.signal });
    } catch (err) {
      throw new MediaError('transient', `network error calling ${new URL(url).host}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function failFrom(res) {
    const text = await res.text().catch(() => '');
    const code = looksLikeModeration(text) && res.status < 500 ? 'moderation' : codeForStatus(res.status);
    throw new MediaError(code, `${provider} HTTP ${res.status}: ${text.slice(0, 500)}`, { status: res.status });
  }

  // JSON request/response. `body` objects are sent as JSON; `form` is a FormData.
  async function json(url, { method, headers = {}, body, form, timeoutMs } = {}) {
    const init = { method: method || (body || form ? 'POST' : 'GET'), headers: { ...headers }, timeoutMs };
    if (form) init.body = form;
    else if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers['content-type'] ??= 'application/json';
    }
    const res = await fetchClassified(url, init);
    if (!res.ok) await failFrom(res);
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new MediaError('transient', `${provider} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  // Binary request/response → { buffer, contentType }.
  async function bytes(url, { method, headers = {}, body, form, timeoutMs } = {}) {
    const init = { method: method || (body || form ? 'POST' : 'GET'), headers: { ...headers }, timeoutMs };
    if (form) init.body = form;
    else if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers['content-type'] ??= 'application/json';
    }
    const res = await fetchClassified(url, init);
    if (!res.ok) await failFrom(res);
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
  }

  function writeOut(outPrefix, buffer, ext) {
    // `out` is a prefix; one written with its extension already (`clip.mp4`) is taken as the file name.
    const path = outPrefix.toLowerCase().endsWith(`.${ext}`) ? abs(outPrefix) : `${abs(outPrefix)}.${ext}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buffer);
    return path;
  }

  async function download(url, outPrefix, { headers } = {}) {
    const { buffer, contentType } = await bytes(url, { headers, timeoutMs: 600_000 });
    return writeOut(outPrefix, buffer, extOf(contentType, url));
  }

  // Turn a local file into a provider reference once; cached by content hash + provider.
  // `fresh` skips the cached reference and replaces it: for a provider that refused the earlier upload.
  async function upload(file, via, { fresh = false } = {}) {
    const cachePath = join(cacheDir, 'uploads.json');
    const cache = readJson(cachePath, {});
    const key = `${provider}:${sha256File(abs(file))}`;
    if (cache[key] && !fresh) return cache[key].ref;
    const ref = await via(abs(file));
    writeJson(cachePath, { ...cache, [key]: { ref, file: basename(file), at: new Date().toISOString() } });
    return ref;
  }

  function dataUri(file) {
    return `data:${mimeOf(file)};base64,${readFileSync(abs(file)).toString('base64')}`;
  }

  function blob(file) {
    return new Blob([readFileSync(abs(file))], { type: mimeOf(file) });
  }

  function probe(file) {
    const out = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type',
      '-of', 'json', abs(file)]));
    const v = (out.streams || []).find((s) => s.codec_type === 'video') || {};
    return { duration_s: Number(out.format?.duration) || null, width: v.width ?? null, height: v.height ?? null };
  }

  // Cut a reference video to the model's limits (length and size), re-encoded to H.264.
  function trim(file, { maxS, maxBytes } = {}) {
    const src = abs(file);
    const info = probe(src);
    const tooLong = maxS && info.duration_s > maxS;
    const tooBig = maxBytes && statSync(src).size > maxBytes;
    if (!tooLong && !tooBig) return src;
    const out = join(cacheDir, 'trim', `${sha256File(src).slice(0, 16)}-${maxS || 'full'}-${maxBytes || 'any'}.mp4`);
    if (existsSync(out)) return out;
    mkdirSync(dirname(out), { recursive: true });
    const args = ['-y', '-v', 'error', '-i', src];
    if (tooLong) args.push('-t', String(maxS));
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', tooBig ? '28' : '20', '-vf', 'scale=-2:min(ih\\,1080)', '-an', out);
    run('ffmpeg', args);
    return out;
  }

  return {
    provider,
    MediaError, // for providers outside the plugin, which cannot import errors.mjs
    secret: (name) => secrets.secret(name),
    fetch: fetchClassified,
    json,
    bytes,
    download,
    writeOut,
    upload,
    dataUri,
    blob,
    readFile: (file) => readFileSync(abs(file)),
    abs,
    probe,
    trim,
    log: (msg) => logs.push(`[${provider}] ${msg}`),
  };
}
