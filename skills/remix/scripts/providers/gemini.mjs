// Gemini API (spec §5.6). Everything goes through POST /v1beta/interactions; generated media
// comes back as content blocks of the "model_output" step (base64 `data`, or a Files API `uri`).
// Image, speech and video run as synchronous interactions. Video understanding uploads the
// clip through the Files API (resumable upload) in submit and asks for per-shot JSON in poll
// once the file is ACTIVE, so submit never blocks on processing.
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { MediaError, codeForStatus, looksLikeModeration } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';
import { mimeOf } from '../lib/media/ctx.mjs';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const UPLOAD = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
// Video generation is a synchronous interaction that can take minutes.
const VIDEO_TIMEOUT_MS = 15 * 60_000;
const MEDIA_TIMEOUT_MS = 5 * 60_000;
// Prebuilt TTS voices listed in the speech-generation guide.
const VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus',
  'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam',
  'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];

export const meta = {
  name: 'gemini',
  displayName: 'Google Gemini API',
  docs: 'https://ai.google.dev/gemini-api/docs',
  secrets: ['GEMINI_API_KEY'],
  concurrency: 4,
  pollIntervalS: 5,
  capabilities: {
    'image.generate': {
      models: [{
        id: 'gemini-nano-banana-2.1', default: true,
        aspects: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
        // image_size names the long edge class; short edges below are for 16:9.
        resolutions: [{ name: '1K', shortEdge: 768 }, { name: '2K', shortEdge: 1536 }, { name: '4K', shortEdge: 3072 }],
        maxRefs: 10,
        price: { usdPerImage: 0.0504 }, // 2K; 1K $0.0336, 4K $0.113 — ai.google.dev/gemini-api/docs/pricing, 2026-10-27
      }],
    },
    'speech.synthesize': {
      models: [{
        id: 'gemini-3.8-flash-tts', default: true,
        // $0.00225 per 10 s of output audio; ~15 chars/s gives ~$0.015 per 1k chars. Pricing page, 2026-10-27.
        price: { usdPer1kChars: 0.015 },
      }],
    },
    'speech.voices': { models: [] },
    'video.generate': {
      models: [{
        id: 'gemini-omni-1.1-flash', default: true,
        aspects: ['16:9', '9:16'],
        duration: { min: 3, max: 10 },
        resolutions: [{ name: '360p', shortEdge: 360 }, { name: '720p', shortEdge: 720 }, { name: '1080p', shortEdge: 1080 }, { name: '4k', shortEdge: 2160 }],
        firstFrame: true, lastFrame: true, maxRefs: 3, maxRefVideos: 0,
        price: { usdPerSecond: 0.1 }, // ~$0.10/s at 720p (only tier priced), pricing page, 2026-10-27
      }],
    },
    'video.understand': {
      models: [{
        id: 'gemini-3.8-flash', default: true,
        // $0.75 per 1M input tokens; a one-minute clip is ~18k tokens. Pricing page, 2026-10-27.
        price: { usdPerRequest: 0.02 },
      }],
    },
  },
};

const key = (ctx) => ({ 'x-goog-api-key': ctx.secret('GEMINI_API_KEY') });

// Gemini answers a bad key with HTTP 400 API_KEY_INVALID, which ctx.json files as invalid.
async function call(ctx, url, opts = {}) {
  try {
    return await ctx.json(url, { ...opts, headers: { ...key(ctx), ...opts.headers } });
  } catch (e) {
    if (/API_KEY_INVALID|API key not valid/.test(e.message)) throw new MediaError('auth', e.message, e.raw);
    throw e;
  }
}

export async function verify(ctx) {
  await call(ctx, `${BASE}/models?pageSize=1`);
}

export async function estimate(capability, req) {
  const model = meta.capabilities[capability]?.models.find((m) => m.id === req.model);
  return estimateFromMeta(capability, req, model);
}

const inline = (file, ctx) => ({ type: 'image', data: ctx.readFile(file).toString('base64'), mime_type: mimeOf(file) });

// Content blocks of the model output; a failed or blocked interaction becomes a MediaError.
function outputs(res, type) {
  if (res.status && res.status !== 'completed') {
    const msg = JSON.stringify(res.error || res.status);
    throw new MediaError(looksLikeModeration(msg) ? 'moderation' : 'transient', `gemini interaction ${res.status}: ${msg.slice(0, 300)}`);
  }
  const blocks = (res.steps || []).filter((s) => s.type === 'model_output').flatMap((s) => s.content || []);
  const hits = blocks.filter((b) => b.type === type);
  if (!hits.length) {
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    throw new MediaError(looksLikeModeration(text) ? 'moderation' : 'invalid', `gemini returned no ${type}: ${text.slice(0, 300)}`);
  }
  return hits;
}

async function save(block, ctx, out, ext) {
  if (block.data) return ctx.writeOut(out, Buffer.from(block.data, 'base64'), ext);
  // A Files API uri downloads from <uri>:download?alt=media with the API key.
  return ctx.download(`${block.uri}:download?alt=media`, out, { headers: key(ctx) });
}

const interact = (ctx, body, timeoutMs) => call(ctx, `${BASE}/interactions`, { body: { store: false, ...body }, timeoutMs });

async function image(req, ctx) {
  const { params: p, resolved_params: r } = req;
  const input = [{ type: 'text', text: p.prompt }, ...(p.refs || []).map((ref) => inline(ref.file, ctx))];
  const res = await interact(ctx, { model: r.model, input, response_format: { type: 'image', aspect_ratio: r.aspect, image_size: r.resolution } }, MEDIA_TIMEOUT_MS);
  const [block] = outputs(res, 'image');
  return { files: [{ path: await save(block, ctx, req.out, block.mime_type === 'image/jpeg' ? 'jpg' : 'png') }] };
}

async function speech(req, ctx) {
  const { params: p, resolved_params: r } = req;
  if (p.speed && p.speed !== 1) throw new MediaError('unsupported', 'gemini TTS has no speed control');
  const text = p.style ? `Say this ${p.style}: ${p.text}` : p.text;
  const res = await interact(ctx, {
    model: r.model, input: text,
    // No language field: the model speaks the language of the text.
    generation_config: { speech_config: [{ voice: p.voice }] },
    response_format: { type: 'audio' },
  }, MEDIA_TIMEOUT_MS);
  const [block] = outputs(res, 'audio');
  const path = await save(block, ctx, req.out, 'wav');
  // 24 kHz mono 16-bit PCM behind a 44-byte RIFF header.
  return { files: [{ path, mime: 'audio/wav', duration_s: Number(((statSync(path).size - 44) / 48_000).toFixed(3)) }] };
}

async function video(req, ctx) {
  const { params: p, resolved_params: r } = req;
  const input = [{ type: 'text', text: p.prompt }];
  if (p.first_frame) input.push(inline(p.first_frame, ctx));
  if (p.last_frame) input.push(inline(p.last_frame, ctx));
  for (const ref of p.refs || []) input.push(inline(ref.file, ctx));
  const body = {
    model: r.model, input,
    response_format: { type: 'video', aspect_ratio: r.aspect, resolution: r.resolution, duration: r.duration },
  };
  if (p.first_frame && !p.refs?.length) body.task = 'image_to_video';
  const res = await interact(ctx, body, VIDEO_TIMEOUT_MS);
  const [block] = outputs(res, 'video');
  return { files: [{ path: await save(block, ctx, req.out, 'mp4'), mime: 'video/mp4' }] };
}

// Files API resumable upload: start (returns the upload URL in a header), then upload + finalize.
async function uploadFile(file, ctx) {
  const abs = ctx.abs(file);
  const size = statSync(abs).size;
  const start = await ctx.fetch(UPLOAD, {
    method: 'POST',
    headers: {
      ...key(ctx), 'content-type': 'application/json',
      'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(size), 'x-goog-upload-header-content-type': mimeOf(abs),
    },
    body: JSON.stringify({ file: { display_name: basename(abs) } }),
  });
  const url = start.headers.get('x-goog-upload-url');
  if (!start.ok || !url) await uploadFailed(start);
  // ctx.json would JSON-encode a Buffer body, so the bytes go through ctx.fetch.
  const res = await ctx.fetch(url, {
    method: 'POST', timeoutMs: 600_000,
    headers: { 'x-goog-upload-offset': '0', 'x-goog-upload-command': 'upload, finalize' },
    body: ctx.readFile(abs),
  });
  if (!res.ok) await uploadFailed(res);
  return (await res.json()).file;
}

async function uploadFailed(res) {
  const text = await res.text().catch(() => '');
  throw new MediaError(codeForStatus(res.status), `gemini upload HTTP ${res.status}: ${text.slice(0, 300)}`);
}

const SHOT = {
  type: 'object',
  required: ['start', 'end', 'description', 'subjects', 'camera'],
  properties: {
    start: { type: 'number' }, end: { type: 'number' }, description: { type: 'string' },
    subjects: { type: 'array', items: { type: 'string' } }, camera: { type: 'string' },
  },
};

function understandPrompt(p) {
  const lines = ['Describe this video shot by shot. For each shot give start and end in seconds, what is on screen and what happens',
    '(description), the people or objects in it (subjects), and how the camera moves (camera).'];
  if (p.shots?.length) lines.push(`Use exactly these shot windows, in order: ${p.shots.map((s) => `${s.start}-${s.end}s`).join(', ')}.`);
  if (p.question) lines.push(`Also answer this question about the video in "answer": ${p.question}`);
  return lines.join(' ');
}

async function understand(fileName, req, ctx) {
  const file = await call(ctx, `${BASE}/${fileName}`);
  if (file.state === 'FAILED') return { status: 'failed', error: new MediaError('invalid', `gemini could not process the video: ${JSON.stringify(file.error || {})}`) };
  if (file.state !== 'ACTIVE') return { status: 'running' };
  const p = req.params;
  const schema = { type: 'object', required: ['shots'], properties: { shots: { type: 'array', items: SHOT }, ...(p.question ? { answer: { type: 'string' } } : {}) } };
  const res = await interact(ctx, {
    model: req.resolved_params.model,
    input: [{ type: 'video', uri: file.uri, mime_type: file.mimeType || mimeOf(p.file) }, { type: 'text', text: understandPrompt(p) }],
    response_format: { type: 'text', mime_type: 'application/json', schema },
  }, MEDIA_TIMEOUT_MS);
  const text = outputs(res, 'text').map((b) => b.text).join('');
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new MediaError('transient', `gemini returned non-JSON understanding: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(doc.shots)) throw new MediaError('transient', 'gemini understanding has no shots[]');
  const path = ctx.writeOut(req.out, Buffer.from(`${JSON.stringify(doc, null, 2)}\n`), 'json');
  return { status: 'completed', result: { files: [{ path, mime: 'application/json' }] } };
}

export async function submit(capability, req, ctx) {
  if (capability === 'image.generate') return { result: await image(req, ctx) };
  if (capability === 'speech.synthesize') return { result: await speech(req, ctx) };
  if (capability === 'video.generate') return { result: await video(req, ctx) };
  if (capability === 'speech.voices') {
    return { result: { items: VOICES.map((v) => ({ id: v, name: v, gender: null, language: null, sample_url: null, recommended: v === 'Kore' })) } };
  }
  // Uploaded files expire after 48 h, so the file is not cached through ctx.upload.
  if (capability === 'video.understand') return { jobId: (await uploadFile(req.params.file, ctx)).name };
  throw new MediaError('unsupported', `${capability} is not implemented`);
}

export async function poll(capability, jobId, ctx, req) {
  if (capability !== 'video.understand') throw new MediaError('unsupported', `${capability} has no async jobs`);
  return understand(jobId, req, ctx);
}
