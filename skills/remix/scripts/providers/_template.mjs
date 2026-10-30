// Provider template (spec §5.3). Copy to ~/.tapvid-video/providers/<name>.mjs, rename, and
// implement against the service's official docs. Node built-ins only — no npm packages.
//
// Contract:
//   meta                 name, displayName, docs, secrets[], concurrency, pollIntervalS?, timeoutS?,
//                        capabilities: { '<capability>': { models: [model…] } } — model fields in
//                        scripts/lib/media/adapt.mjs (aspects, duration/durations, resolutions,
//                        firstFrame, lastFrame, maxRefs, maxRefVideos, refVideoMaxS, modes, maxChars, price)
//   verify(ctx)          optional: cheapest authenticated call; throw MediaError('auth') on a bad key.
//                        May return { unavailable: ['music.generate'] } for capabilities the account lacks.
//   estimate(cap, req)   optional: { usd } | { credits }; default estimateFromMeta() on the model's price.
//   submit(cap, req, ctx) → { jobId } for async APIs, or { result } when the API answers directly.
//   poll(cap, jobId, ctx, req) → { status: 'running' } | { status: 'completed', result } | { status: 'failed', error }
//   account(ctx)         optional: { usd } | { credits }.
//   discover(ctx)        optional: fresh capabilities map (models, prices) from the API.
//
// req = { id, capability, params, model, resolved_params, out }. params follow
// schemas/capabilities/<capability>.json; resolved_params hold what the runner fitted to the
// model (model, resolution, duration, aspect, crop, refVideoMaxS). Map them to the API's names;
// throw MediaError('unsupported') for anything the API cannot do — never drop it silently.
//
// result = { files: [{ path, mime, duration_s?, width?, height?, words? }] } or { items: [...] },
// optionally cost: { usd?, credits?, estimated: false }. Write files with ctx.download(url, req.out)
// or ctx.writeOut(req.out, buffer, ext); never return a remote URL as a file.
//
// ctx: secret(name), json(url, opts), bytes(url, opts), fetch(url, init), download(url, outPrefix),
// writeOut(outPrefix, buffer, ext), upload(file, via), dataUri(file), blob(file), readFile(file),
// probe(file), trim(file, { maxS, maxBytes }), log(msg). json/bytes throw a classified MediaError
// on non-2xx (401/403 auth, 402/429 quota, 400/422 invalid, moderation text → moderation, else transient).
import { MediaError } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';

const BASE = 'https://api.example.com/v1';

export const meta = {
  name: 'example',
  displayName: 'Example',
  docs: 'https://docs.example.com',
  secrets: ['EXAMPLE_API_KEY'],
  concurrency: 4,
  pollIntervalS: 5,
  capabilities: {
    'video.generate': {
      models: [{
        id: 'example-video-1', default: true,
        aspects: ['16:9', '9:16'],
        duration: { min: 5, max: 10 },
        resolutions: [{ name: '720p', shortEdge: 720 }, { name: '1080p', shortEdge: 1080 }],
        firstFrame: true, maxRefs: 0, maxRefVideos: 0,
        price: { usdPerSecond: { '720p': 0.05, '1080p': 0.1 } }, // from the price page, YYYY-MM-DD
      }],
    },
  },
};

const auth = (ctx) => ({ authorization: `Bearer ${ctx.secret('EXAMPLE_API_KEY')}` });

export async function verify(ctx) {
  await ctx.json(`${BASE}/me`, { headers: auth(ctx) });
}

export async function estimate(capability, req) {
  const model = meta.capabilities[capability]?.models.find((m) => m.id === req.model);
  return estimateFromMeta(capability, req, model);
}

export async function submit(capability, req, ctx) {
  if (capability !== 'video.generate') throw new MediaError('unsupported', `${capability} is not implemented`);
  const r = req.resolved_params;
  const body = {
    model: r.model,
    prompt: req.params.prompt,
    aspect_ratio: r.aspect,
    duration: r.duration,
    resolution: r.resolution,
  };
  if (req.params.first_frame) body.image = ctx.dataUri(req.params.first_frame);
  const res = await ctx.json(`${BASE}/videos`, { headers: auth(ctx), body });
  return { jobId: res.id };
}

export async function poll(capability, jobId, ctx, req) {
  const res = await ctx.json(`${BASE}/videos/${jobId}`, { headers: auth(ctx) });
  if (res.status === 'succeeded') {
    return { status: 'completed', result: { files: [{ path: await ctx.download(res.video_url, req.out), mime: 'video/mp4' }] } };
  }
  if (res.status === 'failed') return { status: 'failed', error: new MediaError('transient', res.error || 'generation failed') };
  return { status: 'running' };
}
