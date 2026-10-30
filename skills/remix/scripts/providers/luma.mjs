// Luma Dream Machine API (spec §5.6): POST /generations/video, GET /generations/{id} until
// completed / failed. Luma only takes keyframe images by public URL and has no upload API, so
// local first frames cannot be sent: models declare firstFrame: false and routing skips them.
import { MediaError, looksLikeModeration } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';

const BASE = 'https://api.lumalabs.ai/dream-machine/v1';

const RES = [{ name: '540p', shortEdge: 540 }, { name: '720p', shortEdge: 720 }, { name: '1080p', shortEdge: 1080 }, { name: '4k', shortEdge: 2160 }];
const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];

export const meta = {
  name: 'luma',
  displayName: 'Luma Dream Machine',
  docs: 'https://docs.lumalabs.ai/docs/api',
  secrets: ['LUMA_API_KEY'],
  concurrency: 3,
  pollIntervalS: 5,
  capabilities: {
    'video.generate': {
      models: [{
        id: 'ray-2', default: true, aspects: ASPECTS, durations: [5, 9], resolutions: RES,
        firstFrame: false, lastFrame: false, maxRefs: 0, maxRefVideos: 0,
        price: { usdPerSecond: { '540p': 0.08, '720p': 0.14, '1080p': 0.32, '4k': 1.28 } }, // Luma API pricing, 2026-10-27
      }, {
        id: 'ray-flash-2', aspects: ASPECTS, durations: [5, 9], resolutions: RES,
        firstFrame: false, lastFrame: false, maxRefs: 0, maxRefVideos: 0,
        price: { usdPerSecond: { '540p': 0.03, '720p': 0.05, '1080p': 0.11, '4k': 0.44 } }, // Luma API pricing, 2026-10-27
      }],
    },
  },
};

const auth = (ctx) => ({ authorization: `Bearer ${ctx.secret('LUMA_API_KEY')}` });

export async function verify(ctx) {
  await ctx.json(`${BASE}/credits`, { headers: auth(ctx) });
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
  const body = { prompt: p.prompt, model: r.model, resolution: r.resolution, duration: `${r.duration}s`, aspect_ratio: r.aspect };
  const res = await ctx.json(`${BASE}/generations/video`, { headers: auth(ctx), body });
  return { jobId: res.id };
}

export async function poll(capability, jobId, ctx, req) {
  const res = await ctx.json(`${BASE}/generations/${jobId}`, { headers: auth(ctx) });
  if (res.state === 'completed') {
    return { status: 'completed', result: { files: [{ path: await ctx.download(res.assets.video, req.out), mime: 'video/mp4' }] } };
  }
  if (res.state === 'failed') {
    const msg = res.failure_reason || 'generation failed';
    return { status: 'failed', error: new MediaError(looksLikeModeration(msg) ? 'moderation' : 'transient', `luma: ${msg}`) };
  }
  return { status: 'running' };
}
