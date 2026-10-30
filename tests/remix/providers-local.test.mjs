// Local (child-process) providers: ytdlp and whisper-local, driven through the real runner with
// the child processes replaced via each provider's setDeps seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from '../../skills/remix/scripts/lib/common.mjs';
import { createRunner } from '../../skills/remix/scripts/lib/media/runner.mjs';
import * as ytdlp from '../../skills/remix/scripts/providers/ytdlp.mjs';
import * as whisper from '../../skills/remix/scripts/providers/whisper-local.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tapvid-local-'));
const noSecrets = { secret: () => null, configured: () => true };
const which = (tool) => `/fake/bin/${tool}`;

async function runOne(provider, capability, params, { fetchImpl } = {}) {
  const planDir = tmp();
  const runner = createRunner({ registry: new Map([[provider.meta.name, provider]]), secrets: noSecrets, fetchImpl, sleep: async () => {} });
  const [r] = await runner.runPlan([{ id: 'r1', capability, provider: provider.meta.name, params, out: 'out/result' }], { planDir });
  return { r, planDir };
}

// The yt-dlp output template is the argument after -o: "<prefix>.%(ext)s".
const outPrefix = (args) => args[args.indexOf('-o') + 1].replace(/\.%\(ext\)s$/, '');

test('ytdlp downloads the mp4 and writes a slim info.json', async () => {
  let seen;
  const restore = ytdlp.setDeps({
    which,
    exec: async (cmd, args) => {
      seen = { cmd, args };
      const prefix = outPrefix(args);
      writeFileSync(`${prefix}.mp4`, 'video');
      writeFileSync(`${prefix}.info.json`, JSON.stringify({ id: 'abc', title: 'Launch', uploader: 'Acme', duration: 12.5, webpage_url: 'https://youtu.be/abc', width: 1920, height: 1080, formats: [{}, {}] }));
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  try {
    const { r, planDir } = await runOne(ytdlp, 'video.download', { url: 'https://youtu.be/abc' });
    assert.equal(r.status, 'completed');
    assert.equal(seen.cmd, '/fake/bin/yt-dlp');
    assert.ok(seen.args.includes('--no-playlist') && seen.args.includes('--write-info-json'));
    assert.equal(seen.args.at(-1), 'https://youtu.be/abc');
    assert.deepEqual(r.files.map((f) => [f.path, f.mime]), [['out/result.mp4', 'video/mp4'], ['out/result.info.json', 'application/json']]);
    assert.deepEqual([r.files[0].duration_s, r.files[0].width, r.files[0].height], [12.5, 1920, 1080]);
    const info = JSON.parse(readFileSync(join(planDir, 'out/result.info.json'), 'utf-8'));
    assert.deepEqual([info.title, info.uploader, info.duration_s, info.url, info.formats], ['Launch', 'Acme', 12.5, 'https://youtu.be/abc', undefined]);
  } finally {
    restore();
  }
});

test('ytdlp classifies yt-dlp errors', async () => {
  const cases = [
    ['ERROR: Unsupported URL: https://example.com/page', 'unsupported'],
    ['ERROR: [youtube] abc: Video unavailable. This video is private', 'invalid'],
    ['ERROR: unable to download video data: HTTP Error 503', 'transient'],
  ];
  for (const [stderr, code] of cases) {
    const restore = ytdlp.setDeps({ which, exec: async () => ({ code: 1, stdout: '', stderr: `WARNING: x\n${stderr}\n` }) });
    try {
      const { r } = await runOne(ytdlp, 'video.download', { url: 'https://example.com/v' });
      assert.equal(r.status, 'failed');
      assert.equal(r.error.code, code, stderr);
    } finally {
      restore();
    }
  }
});

test('ytdlp without the binary is unsupported, and rejects non-http urls before running', async () => {
  let ran = false;
  const restore = ytdlp.setDeps({ which: () => null, exec: async () => { ran = true; return { code: 0 }; } });
  try {
    await assert.rejects(ytdlp.verify(), (e) => e.code === 'unsupported');
    const { r } = await runOne(ytdlp, 'video.download', { url: 'https://youtu.be/abc' });
    assert.equal(r.error.code, 'unsupported');
    const local = await runOne(ytdlp, 'video.download', { url: 'file:///etc/hosts' });
    assert.equal(local.r.error.code, 'invalid');
    assert.equal(ran, false);
  } finally {
    restore();
  }
});

// whisper-cli -ojf output shape (examples/cli/cli.cpp), offsets in ms.
const WHISPER_JSON = {
  result: { language: 'en' },
  transcription: [
    { offsets: { from: 0, to: 1500 }, text: ' Hello transcription.',
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 }, id: 50365, p: 0.9 },
        { text: ' Hello', offsets: { from: 0, to: 400 }, id: 1, p: 0.9 },
        { text: ' trans', offsets: { from: 450, to: 800 }, id: 2, p: 0.9 },
        { text: 'cription', offsets: { from: 800, to: 1200 }, id: 3, p: 0.9 },
        { text: '.', offsets: { from: 1200, to: 1300 }, id: 4, p: 0.9 },
        { text: '[_TT_75]', offsets: { from: 1500, to: 1500 }, id: 50440, p: 0.9 },
      ] },
    { offsets: { from: 1500, to: 2500 }, text: '你好',
      tokens: [{ text: '你', offsets: { from: 1500, to: 1900 } }, { text: '好', offsets: { from: 1900, to: 2400 } }] },
  ],
};

function fakeWhisper(calls) {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd.endsWith('ffmpeg')) { writeFileSync(args.at(-1), 'wav'); return { code: 0, stdout: '', stderr: '' }; }
    writeFileSync(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify(WHISPER_JSON));
    return { code: 0, stdout: '', stderr: '' };
  };
}

test('whisper-local builds transcript.json with merged sub-word tokens and no special tokens', async () => {
  const dir = tmp();
  const model = join(dir, 'ggml-large-v3-turbo.bin');
  writeFileSync(model, 'model');
  const audio = join(dir, 'in.mp4');
  writeFileSync(audio, 'media');
  const calls = [];
  const restore = whisper.setDeps({ which, exec: fakeWhisper(calls), modelPath: () => model });
  try {
    const { r, planDir } = await runOne(whisper, 'speech.transcribe', { file: audio, language: 'en-US' });
    assert.equal(r.status, 'completed', JSON.stringify(r.error));
    assert.deepEqual(r.files.map((f) => f.mime), ['application/json']);
    const [ff, wc] = calls;
    assert.deepEqual(ff.args.slice(ff.args.indexOf('-ar'), ff.args.indexOf('-ar') + 4), ['-ar', '16000', '-ac', '1']);
    assert.deepEqual([wc.args[wc.args.indexOf('-m') + 1], wc.args[wc.args.indexOf('-l') + 1]], [model, 'en']);
    assert.ok(wc.args.includes('-ojf'));
    const t = JSON.parse(readFileSync(join(planDir, r.files[0].path), 'utf-8'));
    assert.equal(t.language, 'en');
    assert.equal(t.text, 'Hello transcription. 你好');
    assert.deepEqual(t.segments.map((s) => [s.start, s.end]), [[0, 1.5], [1.5, 2.5]]);
    assert.deepEqual(t.words, [
      { text: 'Hello', start: 0, end: 0.4 },
      { text: 'transcription.', start: 0.45, end: 1.3 },
      { text: '你', start: 1.5, end: 1.9 },
      { text: '好', start: 1.9, end: 2.4 },
    ]);
  } finally {
    restore();
  }
});

test('whisper-local downloads the model on first use and auto-detects language', async () => {
  const dir = tmp();
  const model = join(dir, 'models', 'ggml-large-v3-turbo.bin');
  const audio = join(dir, 'in.wav');
  writeFileSync(audio, 'wav');
  const calls = [];
  const fetched = [];
  const fetchImpl = async (url) => { fetched.push(String(url)); return new Response('model-bytes'); };
  const restore = whisper.setDeps({ which, exec: fakeWhisper(calls), modelPath: () => model });
  try {
    const { r } = await runOne(whisper, 'speech.transcribe', { file: audio }, { fetchImpl });
    assert.equal(r.status, 'completed', JSON.stringify(r.error));
    assert.deepEqual(fetched, ['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin']);
    assert.equal(readFileSync(model, 'utf-8'), 'model-bytes');
    assert.equal(existsSync(`${model}.part`), false);
    assert.equal(calls[1].args[calls[1].args.indexOf('-l') + 1], 'auto');
  } finally {
    restore();
  }
});

test('whisper-local without whisper-cli is unsupported; a missing input is invalid', async () => {
  const restore = whisper.setDeps({ which: () => null });
  try {
    await assert.rejects(whisper.verify(), (e) => e.code === 'unsupported');
    const audio = join(tmp(), 'in.wav');
    writeFileSync(audio, 'wav');
    assert.equal((await runOne(whisper, 'speech.transcribe', { file: audio })).r.error.code, 'unsupported');
    assert.equal((await runOne(whisper, 'speech.transcribe', { file: join(tmp(), 'nope.wav') })).r.error.code, 'invalid');
  } finally {
    restore();
  }
});

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin';
const MIRROR = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin';
const CDN = 'https://cdn-lfs.hf.co/repos/x/ggml-large-v3-turbo.bin';
const BYTES = 'model-bytes';
const SHA = createHash('sha256').update(BYTES).digest('hex');
// A body that sends a few bytes and then stalls until it is cancelled.
const stalled = () => new ReadableStream({ start: (c) => c.enqueue(new Uint8Array(10)) });

// Runs a transcription with no model on disk; `routes` answers each URL. → { r, model, fetched, logs }
async function withModelDownload(routes, { probeMs = 30 } = {}) {
  const dir = tmp();
  const model = join(dir, 'models', 'ggml-large-v3-turbo.bin');
  const audio = join(dir, 'in.wav');
  writeFileSync(audio, 'wav');
  const fetched = [];
  const fetchImpl = async (url, init) => {
    fetched.push([String(url), init.redirect]);
    const answer = routes[String(url)];
    if (!answer) throw new Error(`unexpected ${url}`);
    return answer();
  };
  const restore = whisper.setDeps({ which, exec: fakeWhisper([]), modelPath: () => model, speedProbeMs: probeMs });
  try {
    const { r, planDir } = await runOne(whisper, 'speech.transcribe', { file: audio }, { fetchImpl });
    const logs = readJson(join(planDir, 'tasks.json')).log || [];
    return { r, model, fetched: fetched.map(([u]) => u), redirects: fetched.map(([, m]) => m), logs };
  } finally {
    restore();
  }
}

test('whisper-local drops a crawling Hugging Face for hf-mirror.com and checks the sha256 Hugging Face reported', async () => {
  const { r, model, fetched, redirects, logs } = await withModelDownload({
    [HF]: () => new Response(null, { status: 302, headers: { location: CDN, 'x-linked-etag': `"${SHA}"`, 'x-linked-size': '11' } }),
    [CDN]: () => new Response(stalled(), { headers: { 'content-length': '1600000000' } }),
    [MIRROR]: () => new Response(BYTES, { headers: { 'content-length': String(BYTES.length) } }),
  });
  assert.equal(r.status, 'completed', JSON.stringify(r.error));
  assert.deepEqual(fetched, [HF, CDN, MIRROR]);
  assert.ok(redirects.every((m) => m === 'manual'));
  assert.equal(readFileSync(model, 'utf-8'), BYTES);
  assert.equal(existsSync(`${model}.part`), false);
  assert.ok(logs.some((l) => /huggingface\.co failed: too slow \(\d+ KB\/s\)/.test(l)), logs.join('\n'));
});

test('whisper-local rejects a mirror file whose sha256 differs from Hugging Face\'s, and a short file', async () => {
  const bad = await withModelDownload({
    [HF]: () => new Response('nope', { status: 500, headers: { 'x-linked-etag': `"${'0'.repeat(64)}"` } }),
    [MIRROR]: () => new Response(BYTES),
  });
  assert.equal(bad.r.status, 'failed');
  assert.equal(bad.r.error.code, 'transient');
  assert.match(bad.r.error.message, /huggingface\.co: HTTP 500; hf-mirror\.com: sha256 [0-9a-f]{64} does not match 0{64}/);
  assert.equal(existsSync(bad.model), false);
  assert.equal(existsSync(`${bad.model}.part`), false);

  const short = await withModelDownload({
    [HF]: () => { throw new Error('ECONNRESET'); },
    [MIRROR]: () => new Response(BYTES, { headers: { 'content-length': '99' } }),
  });
  assert.equal(short.r.status, 'failed');
  assert.match(short.r.error.message, /huggingface\.co: network error .*ECONNRESET; hf-mirror\.com: incomplete: 11 of 99 bytes/);
});

test('TAPVID_WHISPER_MODEL_URL replaces both hosts and is never dropped as slow', async () => {
  const own = 'https://models.example.com/ggml-large-v3-turbo.bin';
  const prev = process.env.TAPVID_WHISPER_MODEL_URL;
  process.env.TAPVID_WHISPER_MODEL_URL = own;
  try {
    const chunks = () => new ReadableStream({
      async start(c) { c.enqueue(new TextEncoder().encode('model-')); await new Promise((r) => setTimeout(r, 60)); c.enqueue(new TextEncoder().encode('bytes')); c.close(); },
    });
    const { r, model, fetched } = await withModelDownload({ [own]: () => new Response(chunks()) }, { probeMs: 10 });
    assert.equal(r.status, 'completed', JSON.stringify(r.error));
    assert.deepEqual(fetched, [own]);
    assert.equal(readFileSync(model, 'utf-8'), BYTES);
  } finally {
    if (prev === undefined) delete process.env.TAPVID_WHISPER_MODEL_URL;
    else process.env.TAPVID_WHISPER_MODEL_URL = prev;
  }
});
