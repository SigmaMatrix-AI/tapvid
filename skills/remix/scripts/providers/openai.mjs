// OpenAI (spec §5.6): images, speech, a fixed voice list and transcription. All calls are
// synchronous. OpenAI has no video API any more (Sora's shut down 2026-09-24).
// Docs: developers.openai.com/api/docs/guides/{image-generation, text-to-speech, speech-to-text}.
import { statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MediaError } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';
import { HOME, ensureDir, run } from '../lib/common.mjs';
import { sha256File } from '../lib/media/ctx.mjs';

const BASE = 'https://api.openai.com/v1';

// Transcription uploads are capped at 25 MB; larger inputs (most videos) are sent as mono mp3.
const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

export const VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const RECOMMENDED = new Set(['marin', 'cedar']);

// Prices from developers.openai.com/api/docs/pricing, 2026-10-27. Images are billed in tokens
// ($30 / 1M output image tokens); ~$0.04 is a medium-quality 1024² image. TTS ≈ $0.015/min;
// whisper-1 $0.006/min; gpt-transcribe $0.0045/min.
export const meta = {
  name: 'openai',
  displayName: 'OpenAI',
  docs: 'https://developers.openai.com/api/docs',
  secrets: ['OPENAI_API_KEY'],
  concurrency: 4,
  capabilities: {
    'image.generate': {
      models: [{ id: 'gpt-image-2.5-flare', default: true, resolutions: [{ name: '1K', shortEdge: 1024 }, { name: '2K', shortEdge: 2048 }],
        maxRefs: 4, price: { usdPerImage: 0.04 } }],
    },
    'speech.synthesize': { models: [{ id: 'gpt-4o-mini-tts', default: true, maxChars: 4096, price: { usdPerSecond: 0.00025 } }] },
    'speech.voices': { models: [] },
    // whisper-1 is the only model with word / segment timestamps; gpt-transcribe returns text only.
    'speech.transcribe': {
      models: [
        { id: 'whisper-1', default: true, price: { usdPerSecond: 0.0001 } },
        { id: 'gpt-transcribe', price: { usdPerSecond: 0.000075 } },
      ],
    },
  },
};

const auth = (ctx) => ({ authorization: `Bearer ${ctx.secret('OPENAI_API_KEY')}` });

export async function verify(ctx) {
  await ctx.json(`${BASE}/models`, { headers: auth(ctx) });
}

export async function estimate(capability, req) {
  return estimateFromMeta(capability, req, meta.capabilities[capability]?.models.find((m) => m.id === req.model));
}

// Pixel size for an aspect at a short edge: multiples of 16, edges ≤ 3840, 655,360–8,294,400 pixels.
export function sizeFor(aspect = '1:1', shortEdge = 1024) {
  const [a, b] = aspect.split(':').map(Number);
  if (Math.max(a, b) / Math.min(a, b) > 3) throw new MediaError('unsupported', `aspect ${aspect} is outside 1:3–3:1`);
  let short = shortEdge;
  let long = (shortEdge * Math.max(a, b)) / Math.min(a, b);
  const scale = Math.min(1, 3840 / long, Math.sqrt(8_294_400 / (short * long)));
  short *= scale;
  long *= scale;
  const r16 = (n) => Math.max(16, Math.round(n / 16) * 16);
  return a >= b ? `${r16(long)}x${r16(short)}` : `${r16(short)}x${r16(long)}`;
}

async function image(req, ctx) {
  const r = req.resolved_params;
  const size = sizeFor(req.params.aspect, r.shortEdge);
  const refs = req.params.refs || [];
  let res;
  if (refs.length) {
    const form = new FormData();
    form.append('model', r.model);
    form.append('prompt', req.params.prompt);
    form.append('size', size);
    form.append('quality', 'medium');
    for (const ref of refs) form.append('image[]', ctx.blob(ref.file), basename(ref.file));
    res = await ctx.json(`${BASE}/images/edits`, { headers: auth(ctx), form, timeoutMs: 300_000 });
  } else {
    res = await ctx.json(`${BASE}/images/generations`, {
      headers: auth(ctx), timeoutMs: 300_000,
      body: { model: r.model, prompt: req.params.prompt, size, quality: 'medium', output_format: 'png', n: 1 },
    });
  }
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new MediaError('transient', 'openai returned no image');
  const [width, height] = size.split('x').map(Number);
  return { files: [{ path: ctx.writeOut(req.out, Buffer.from(b64, 'base64'), 'png'), mime: 'image/png', width, height }] };
}

async function speech(req, ctx) {
  const p = req.params;
  if (!VOICES.includes(p.voice)) throw new MediaError('unsupported', `${p.voice} is not an OpenAI voice`);
  const body = { model: req.resolved_params.model, voice: p.voice, input: p.text, response_format: 'mp3' };
  if (p.style) body.instructions = p.style;
  if (p.speed !== undefined) body.speed = p.speed;
  const { buffer } = await ctx.bytes(`${BASE}/audio/speech`, { headers: auth(ctx), body, timeoutMs: 300_000 });
  const file = { path: ctx.writeOut(req.out, buffer, 'mp3'), mime: 'audio/mpeg' };
  try {
    const d = ctx.probe(file.path).duration_s;
    if (d) file.duration_s = d;
  } catch { /* ffprobe missing: duration stays unknown */ }
  return { files: [file] };
}

// Inputs above the upload cap become a 64 kbps mono mp3 (cached by content hash).
function transcribable(ctx, file) {
  const src = ctx.abs(file);
  if (statSync(src).size <= MAX_TRANSCRIBE_BYTES) return src;
  const out = join(ensureDir(join(HOME, 'cache', 'audio')), `${sha256File(src).slice(0, 16)}.mp3`);
  run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-b:a', '64k', out]);
  if (statSync(out).size > MAX_TRANSCRIBE_BYTES) throw new MediaError('unsupported', `${file} is too long for OpenAI transcription (25 MB)`);
  return out;
}

async function transcribe(req, ctx) {
  const model = req.resolved_params.model;
  const file = transcribable(ctx, req.params.file);
  const form = new FormData();
  form.append('model', model);
  form.append('file', ctx.blob(file), basename(file));
  if (model === 'whisper-1') {
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    if (req.params.language) form.append('language', req.params.language.slice(0, 2));
  } else if (req.params.language) {
    ctx.log(`language hint not sent to ${model}`);
  }
  const res = await ctx.json(`${BASE}/audio/transcriptions`, { headers: auth(ctx), form, timeoutMs: 600_000 });
  const transcript = {
    language: res.language || res.languages?.[0]?.code || req.params.language || null,
    text: (res.text || '').trim(),
    segments: (res.segments || []).map((s) => ({ start: s.start, end: s.end, text: String(s.text).trim() })),
    words: (res.words || []).map((w) => ({ text: w.word, start: w.start, end: w.end })),
  };
  return { files: [{ path: ctx.writeOut(req.out, Buffer.from(JSON.stringify(transcript, null, 2)), 'json'), mime: 'application/json' }] };
}

export async function submit(capability, req, ctx) {
  if (capability === 'image.generate') return { result: await image(req, ctx) };
  if (capability === 'speech.synthesize') return { result: await speech(req, ctx) };
  if (capability === 'speech.transcribe') return { result: await transcribe(req, ctx) };
  if (capability === 'speech.voices') {
    return { result: { items: VOICES.map((id) => ({ id, name: id, gender: null, language: null, sample_url: null, recommended: RECOMMENDED.has(id) })) } };
  }
  throw new MediaError('unsupported', `openai has no ${capability}`);
}
