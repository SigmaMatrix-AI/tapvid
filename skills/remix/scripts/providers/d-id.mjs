// D-ID Talks API (spec §5.6): a talking-head video from a portrait plus a script (TTS) or an
// audio file. POST /talks → { id }; GET /talks/{id} until done / error / rejected. D-ID only
// takes the portrait and audio by URL, so local files go through POST /images and /audios.
import { basename } from 'node:path';
import { MediaError, looksLikeModeration } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';

const BASE = 'https://api.d-id.com';
// Used when a tts request names no voice: a Microsoft neural voice D-ID ships by default.
const DEFAULT_VOICE = 'en-US-JennyNeural';

export const meta = {
  name: 'd-id',
  displayName: 'D-ID',
  docs: 'https://docs.d-id.com/reference/talks-overview',
  secrets: ['DID_API_KEY'],
  concurrency: 2,
  pollIntervalS: 5,
  capabilities: {
    'avatar.generate': {
      models: [{
        id: 'talks', default: true,
        modes: ['tts', 'audio'],
        price: { usdPerSecond: 0.05 }, // Build plan credits converted to USD, D-ID pricing page, 2026-10-27
      }],
    },
  },
};

// The key is used as issued (the "user:secret" pair D-ID hands out) in a Basic header.
const auth = (ctx) => ({ authorization: `Basic ${ctx.secret('DID_API_KEY')}` });

function uploader(path, field, ctx) {
  return async (abs) => {
    const form = new FormData();
    form.append(field, ctx.blob(abs), basename(abs));
    return (await ctx.json(`${BASE}${path}`, { headers: auth(ctx), form })).url;
  };
}

export async function verify(ctx) {
  await ctx.json(`${BASE}/credits`, { headers: auth(ctx) });
}

export async function estimate(capability, req) {
  const model = meta.capabilities[capability]?.models.find((m) => m.id === req.model);
  return estimateFromMeta(capability, req, model);
}

export async function submit(capability, req, ctx) {
  if (capability !== 'avatar.generate') throw new MediaError('unsupported', `${capability} is not implemented`);
  const p = req.params;
  if (!p.portrait) throw new MediaError('unsupported', 'd-id needs a local portrait image');
  let script;
  if (p.mode === 'tts') {
    if (!p.script) throw new MediaError('invalid', 'tts mode needs a script');
    script = { type: 'text', input: p.script, provider: { type: 'microsoft', voice_id: p.voice || DEFAULT_VOICE } };
  } else {
    if (!p.audio) throw new MediaError('invalid', 'audio mode needs an audio file');
    script = { type: 'audio', audio_url: await ctx.upload(p.audio, uploader('/audios', 'audio', ctx)) };
  }
  const source_url = await ctx.upload(p.portrait, uploader('/images', 'image', ctx));
  const res = await ctx.json(`${BASE}/talks`, { headers: auth(ctx), body: { source_url, script, config: { result_format: 'mp4' } } });
  return { jobId: res.id };
}

export async function poll(capability, jobId, ctx, req) {
  const res = await ctx.json(`${BASE}/talks/${jobId}`, { headers: auth(ctx) });
  if (res.status === 'done') {
    const file = { path: await ctx.download(res.result_url, req.out), mime: 'video/mp4' };
    if (res.duration) file.duration_s = res.duration;
    return { status: 'completed', result: { files: [file] } };
  }
  if (res.status === 'error' || res.status === 'rejected') {
    const msg = `${res.error?.kind || res.status} ${res.error?.description || ''}`.trim();
    // "rejected" is D-ID's moderation outcome (e.g. a face it will not animate).
    const kind = res.status === 'rejected' || looksLikeModeration(msg) ? 'moderation' : 'transient';
    return { status: 'failed', error: new MediaError(kind, `d-id: ${msg}`) };
  }
  return { status: 'running' };
}
