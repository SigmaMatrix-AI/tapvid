// Replicate (spec §5.6): one async prediction API in front of many community models.
// POST /v1/models/{owner}/{name}/predictions → GET /v1/predictions/{id} until succeeded /
// failed / canceled. Output URLs are deleted after about an hour, so poll downloads at once.
import { statSync } from 'node:fs';
import { MediaError, looksLikeModeration } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';

const BASE = 'https://api.replicate.com/v1';
// Replicate takes data URLs for small inputs; larger files go through POST /v1/files.
const DATA_URI_MAX_BYTES = 256 * 1024;

export const meta = {
  name: 'replicate',
  displayName: 'Replicate',
  docs: 'https://replicate.com/docs/reference/http',
  secrets: ['REPLICATE_API_TOKEN'],
  concurrency: 4,
  pollIntervalS: 5,
  capabilities: {
    'video.generate': {
      models: [{
        id: 'bytedance/seedance-1-pro', default: true,
        aspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
        duration: { min: 2, max: 12 },
        resolutions: [{ name: '480p', shortEdge: 480 }, { name: '1080p', shortEdge: 1080 }],
        firstFrame: true, lastFrame: true, maxRefs: 0, maxRefVideos: 0,
        price: { usdPerSecond: { '480p': 0.03, '1080p': 0.15 } }, // replicate.com model page, 2026-10-27
      }],
    },
    'image.generate': {
      models: [{
        id: 'bytedance/seedream-4', default: true,
        aspects: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'],
        resolutions: [{ name: '1K', shortEdge: 1024 }, { name: '2K', shortEdge: 2048 }, { name: '4K', shortEdge: 4096 }],
        maxRefs: 10,
        price: { usdPerImage: 0.03 }, // replicate.com model page, 2026-10-27
      }],
    },
    'avatar.generate': {
      models: [{
        id: 'bytedance/omni-human', default: true,
        modes: ['audio'],
        price: { usdPerSecond: 0.14 }, // replicate.com model page, 2026-10-27
      }],
    },
  },
};

const auth = (ctx) => ({ authorization: `Bearer ${ctx.secret('REPLICATE_API_TOKEN')}` });

// A local file as a model input: a data URL when small, otherwise an uploaded file's URL.
async function fileInput(file, ctx) {
  if (statSync(ctx.abs(file)).size <= DATA_URI_MAX_BYTES) return ctx.dataUri(file);
  return ctx.upload(file, async (abs) => {
    const form = new FormData();
    form.append('content', ctx.blob(abs), abs.split(/[\\/]/).pop());
    const res = await ctx.json(`${BASE}/files`, { headers: auth(ctx), form });
    return res.urls.get;
  });
}

export async function verify(ctx) {
  await ctx.json(`${BASE}/account`, { headers: auth(ctx) });
}

export async function estimate(capability, req) {
  const model = meta.capabilities[capability]?.models.find((m) => m.id === req.model);
  return estimateFromMeta(capability, req, model);
}

async function inputFor(capability, req, ctx) {
  const p = req.params;
  const r = req.resolved_params;
  if (capability === 'video.generate') {
    if (p.audio) throw new MediaError('unsupported', `${r.model} does not generate audio`);
    const input = { prompt: p.prompt, duration: r.duration, resolution: r.resolution, aspect_ratio: r.aspect };
    if (p.first_frame) input.image = await fileInput(p.first_frame, ctx);
    if (p.last_frame) input.last_frame_image = await fileInput(p.last_frame, ctx);
    return input;
  }
  if (capability === 'image.generate') {
    const input = { prompt: p.prompt, size: r.resolution, aspect_ratio: r.aspect, max_images: 1 };
    if (p.refs?.length) input.image_input = await Promise.all(p.refs.map((ref) => fileInput(ref.file, ctx)));
    return input;
  }
  if (capability === 'avatar.generate') {
    if (!p.portrait || !p.audio) throw new MediaError('unsupported', 'omni-human needs a local portrait and audio file');
    return { image: await fileInput(p.portrait, ctx), audio: await fileInput(p.audio, ctx) };
  }
  throw new MediaError('unsupported', `${capability} is not implemented`);
}

export async function submit(capability, req, ctx) {
  const input = await inputFor(capability, req, ctx);
  const res = await ctx.json(`${BASE}/models/${req.resolved_params.model}/predictions`, { headers: auth(ctx), body: { input } });
  return { jobId: res.id };
}

export async function poll(capability, jobId, ctx, req) {
  const res = await ctx.json(`${BASE}/predictions/${jobId}`, { headers: auth(ctx) });
  if (res.status === 'succeeded') {
    const urls = [res.output].flat().filter(Boolean);
    if (!urls.length) return { status: 'failed', error: new MediaError('transient', 'prediction succeeded without output') };
    const files = [];
    for (const [i, url] of urls.entries()) {
      // mime is filled in by the runner from the downloaded file's extension.
      files.push({ path: await ctx.download(url, i ? `${req.out}-${i}` : req.out) });
    }
    // metrics.predict_time is billed GPU time, not the output price; leave cost to the estimate.
    return { status: 'completed', result: { files } };
  }
  if (res.status === 'failed' || res.status === 'canceled') {
    const msg = String(res.error || res.status);
    return { status: 'failed', error: new MediaError(looksLikeModeration(msg) ? 'moderation' : 'transient', `replicate: ${msg}`) };
  }
  return { status: 'running' };
}
