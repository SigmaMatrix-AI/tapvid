// Runway API (spec §5.6): POST /v1/image_to_video or /v1/text_to_video, then GET /v1/tasks/{id}
// until SUCCEEDED / FAILED / CANCELLED. Every call carries the pinned X-Runway-Version.
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { MediaError } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';

const BASE = 'https://api.dev.runwayml.com';
const VERSION = '2024-11-06';
// Runway accepts images as data URIs up to 5 MB encoded; bigger files go through /v1/uploads.
const DATA_URI_MAX_BYTES = 3 * 1024 * 1024;
// Runway names ratios in pixels.
const RATIO = { '16:9': '1280:720', '9:16': '720:1280' };

export const meta = {
  name: 'runway',
  displayName: 'Runway',
  docs: 'https://docs.dev.runwayml.com/api/',
  secrets: ['RUNWAYML_API_SECRET'],
  concurrency: 2,
  pollIntervalS: 6,
  capabilities: {
    'video.generate': {
      models: [{
        id: 'gen4.5', default: true,
        aspects: ['16:9', '9:16'],
        duration: { min: 2, max: 10 },
        resolutions: [{ name: '720p', shortEdge: 720 }],
        firstFrame: true, lastFrame: false, maxRefs: 0, maxRefVideos: 0,
        price: { usdPerSecond: 0.12 }, // 12 credits/s at $0.01 per credit, Runway API pricing, 2026-10-27
      }],
    },
  },
};

const headers = (ctx) => ({ authorization: `Bearer ${ctx.secret('RUNWAYML_API_SECRET')}`, 'x-runway-version': VERSION });

async function imageRef(file, ctx) {
  if (statSync(ctx.abs(file)).size <= DATA_URI_MAX_BYTES) return ctx.dataUri(file);
  return ctx.upload(file, async (abs) => {
    const up = await ctx.json(`${BASE}/v1/uploads`, { headers: headers(ctx), body: { filename: basename(abs), type: 'ephemeral' } });
    const form = new FormData();
    for (const [k, v] of Object.entries(up.fields || {})) form.append(k, v);
    form.append('file', ctx.blob(abs), basename(abs));
    const res = await ctx.fetch(up.uploadUrl, { method: 'POST', body: form });
    if (!res.ok) throw new MediaError('transient', `runway upload HTTP ${res.status}`);
    return up.runwayUri;
  });
}

export async function verify(ctx) {
  await ctx.json(`${BASE}/v1/organization`, { headers: headers(ctx) });
}

export async function estimate(capability, req) {
  const model = meta.capabilities[capability]?.models.find((m) => m.id === req.model);
  return estimateFromMeta(capability, req, model);
}

export async function submit(capability, req, ctx) {
  if (capability !== 'video.generate') throw new MediaError('unsupported', `${capability} is not implemented`);
  const p = req.params;
  const r = req.resolved_params;
  if (p.audio) throw new MediaError('unsupported', `${r.model} does not generate audio`);
  const body = { model: r.model, promptText: p.prompt, ratio: RATIO[r.aspect], duration: r.duration };
  let path = '/v1/text_to_video';
  if (p.first_frame) {
    body.promptImage = await imageRef(p.first_frame, ctx);
    path = '/v1/image_to_video';
  }
  const res = await ctx.json(`${BASE}${path}`, { headers: headers(ctx), body });
  return { jobId: res.id };
}

export async function poll(capability, jobId, ctx, req) {
  const res = await ctx.json(`${BASE}/v1/tasks/${jobId}`, { headers: headers(ctx) });
  if (res.status === 'SUCCEEDED') {
    return { status: 'completed', result: { files: [{ path: await ctx.download(res.output[0], req.out), mime: 'video/mp4' }] } };
  }
  if (res.status === 'FAILED' || res.status === 'CANCELLED') {
    // failureCode SAFETY.* is a content moderation rejection; ASSET.INVALID is a bad input.
    const code = String(res.failureCode || '');
    const kind = code.startsWith('SAFETY') ? 'moderation' : code.startsWith('ASSET') || code.startsWith('INPUT') ? 'invalid' : 'transient';
    return { status: 'failed', error: new MediaError(kind, `runway ${code || res.status}: ${res.failure || ''}`) };
  }
  return { status: 'running' };
}
