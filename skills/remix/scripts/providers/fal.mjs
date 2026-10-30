// fal.ai (spec §5.6): queue API for video (Seedance 2.5), image (Seedream v5 Pro) and avatar
// (OmniHuman, portrait + audio). POST https://queue.fal.run/<endpoint> → { request_id,
// status_url, response_url }; the status / result URLs carry only owner/app, so they are taken
// from the response, never rebuilt. jobId is the response_url; its status lives at <jobId>/status.
// Local files go to fal's CDN via the REST storage flow the official JS client uses
// (fal-ai/fal-js libs/client/src/storage.ts): POST rest.fal.ai/storage/upload/initiate, then PUT.
import { basename } from 'node:path';
import { MediaError, codeForStatus, looksLikeModeration } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';
import { mimeOf } from '../lib/media/ctx.mjs';
import { run } from '../lib/common.mjs';

const QUEUE = 'https://queue.fal.run';
const REST = 'https://rest.fal.ai';
const PLATFORM = 'https://api.fal.ai/v1';

// Single-shot uploads stop at 90 MB in the official client; reference videos are trimmed below it.
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
// OmniHuman takes audio under 30 s (model page).
const OMNIHUMAN_MAX_AUDIO_S = 30;

// Prices from the fal model pages, 2026-10-27: Seedance 2.5 t2v ≈ $0.2205/s (480p), $0.4730/s
// (720p); Seedream v5 Pro edit $0.0675 per image ≤ 1536², $0.135 above, +$0.0045 per input image
// after the first; OmniHuman $0.14/s.
export const meta = {
  name: 'fal',
  displayName: 'fal.ai',
  docs: 'https://fal.ai/docs',
  secrets: ['FAL_KEY'],
  concurrency: 4,
  pollIntervalS: 5,
  capabilities: {
    'video.generate': {
      models: [{
        id: 'bytedance/seedance-2.5', default: true,
        aspects: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
        duration: { min: 4, max: 30 },
        resolutions: [{ name: '480p', shortEdge: 480 }, { name: '720p', shortEdge: 720 }],
        firstFrame: true, lastFrame: true, maxRefs: 30, maxRefVideos: 10, refVideoMaxS: 30,
        price: { usdPerSecond: { '480p': 0.2205, '720p': 0.473 } },
      }],
    },
    'image.generate': {
      models: [{
        id: 'bytedance/seedream/v5/pro', default: true,
        resolutions: [{ name: '1K', shortEdge: 1080 }, { name: '2K', shortEdge: 1440 }],
        maxRefs: 10, price: { usdPerImage: 0.0675, usdPerImageAt: { '1K': 0.0675, '2K': 0.135 }, usdPerExtraRef: 0.0045 },
      }],
    },
    'avatar.generate': {
      models: [{ id: 'fal-ai/bytedance/omnihuman', default: true, modes: ['audio'], price: { usdPerSecond: 0.14 } }],
    },
  },
};

// ctx's extension table maps .mp3 to audio/mp3; send and report the registered type.
const mime = (path) => (path.endsWith('.mp3') ? 'audio/mpeg' : mimeOf(path));
const auth = (ctx) => ({ authorization: `Key ${ctx.secret('FAL_KEY')}` });
const modelOf = (capability, id) => meta.capabilities[capability]?.models.find((m) => m.id === id);

export async function verify(ctx) {
  await ctx.json(`${PLATFORM}/models/pricing?endpoint_id=bytedance/seedance-2.5/text-to-video`, { headers: auth(ctx) });
}

function audioSeconds(file) {
  try {
    return Number(JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file])).format.duration) || null;
  } catch {
    return null;
  }
}

export async function estimate(capability, req) {
  const model = modelOf(capability, req.model);
  if (capability === 'image.generate' && model) {
    const price = model.price.usdPerImageAt[req.resolved_params?.resolution] ?? model.price.usdPerImage;
    const extra = Math.max(0, (req.params.refs || []).length - 1) * model.price.usdPerExtraRef;
    return { usd: Number((price + extra).toFixed(4)), credits: null };
  }
  if (capability === 'avatar.generate' && model) {
    // Billed by the audio length; the 30 s cap is the bound when the file cannot be read from here.
    const s = audioSeconds(req.params.audio) ?? OMNIHUMAN_MAX_AUDIO_S;
    return { usd: Number((s * model.price.usdPerSecond).toFixed(4)), credits: null };
  }
  return estimateFromMeta(capability, req, model);
}

async function upload(ctx, file) {
  return ctx.upload(file, async (abs) => {
    const contentType = mime(abs);
    const init = await ctx.json(`${REST}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
      headers: auth(ctx), body: { content_type: contentType, file_name: basename(abs) },
    });
    if (!init.upload_url || !init.file_url) throw new MediaError('transient', 'fal storage initiate returned no upload_url');
    const put = await ctx.fetch(init.upload_url, { method: 'PUT', headers: { 'content-type': contentType }, body: ctx.readFile(abs), timeoutMs: 600_000 });
    if (!put.ok) throw new MediaError(codeForStatus(put.status), `fal storage upload HTTP ${put.status}`);
    return init.file_url;
  });
}

// Pixel size for an aspect at a short edge, inside Seedream's 921,600–4,624,220 pixel window.
export function sizeFor(aspect = '1:1', shortEdge = 1080) {
  const [a, b] = aspect.split(':').map(Number);
  const landscape = a >= b;
  let short = shortEdge;
  let long = Math.round((shortEdge * Math.max(a, b)) / Math.min(a, b));
  const scale = Math.sqrt(4_624_220 / (short * long));
  if (scale < 1) { short = Math.floor(short * scale); long = Math.floor(long * scale); }
  const even = (n) => n - (n % 8);
  return landscape ? { width: even(long), height: even(short) } : { width: even(short), height: even(long) };
}

async function videoInput(req, ctx) {
  const p = req.params;
  const r = req.resolved_params;
  const refs = p.refs || [];
  const refVideos = p.ref_videos || [];
  const frames = Boolean(p.first_frame || p.last_frame);
  if (frames && (refs.length || refVideos.length)) throw new MediaError('unsupported', 'Seedance cannot mix first/last frames with references');
  if (p.last_frame && !p.first_frame) throw new MediaError('unsupported', 'Seedance needs a first frame with a last frame');
  const input = { prompt: p.prompt, duration: String(r.duration), resolution: r.resolution, generate_audio: Boolean(p.audio) };
  if (frames) {
    // Image-to-video follows the frame's aspect (aspect_ratio is always auto there).
    input.image_url = await upload(ctx, p.first_frame);
    if (p.last_frame) input.end_image_url = await upload(ctx, p.last_frame);
    return { endpoint: `${r.model}/image-to-video`, input };
  }
  input.aspect_ratio = r.aspect;
  if (!refs.length && !refVideos.length) return { endpoint: `${r.model}/text-to-video`, input };
  input.image_urls = [];
  for (const ref of refs) input.image_urls.push(await upload(ctx, ref.file));
  if (refVideos.length) {
    // 30 s combined across the clips; split it evenly (each clip ≥ 2 s).
    const perClip = Math.max(2, Math.floor(r.refVideoMaxS / refVideos.length));
    input.video_urls = [];
    for (const ref of refVideos) input.video_urls.push(await upload(ctx, ctx.trim(ref.file, { maxS: perClip, maxBytes: MAX_UPLOAD_BYTES })));
  }
  return { endpoint: `${r.model}/reference-to-video`, input };
}

async function imageInput(req, ctx) {
  const r = req.resolved_params;
  const input = { prompt: req.params.prompt, image_size: sizeFor(r.aspect, r.shortEdge), num_images: 1, output_format: 'png' };
  const refs = req.params.refs || [];
  if (!refs.length) return { endpoint: `${r.model}/text-to-image`, input };
  input.image_urls = [];
  for (const ref of refs) input.image_urls.push(await upload(ctx, ref.file));
  return { endpoint: `${r.model}/edit`, input };
}

async function avatarInput(req, ctx) {
  const p = req.params;
  if (p.mode !== 'audio' || !p.audio) throw new MediaError('unsupported', 'OmniHuman animates a portrait from an audio file (mode audio)');
  if (!p.portrait) throw new MediaError('unsupported', 'OmniHuman needs a portrait image, not an avatar id');
  const seconds = ctx.probe(p.audio).duration_s;
  if (seconds && seconds >= OMNIHUMAN_MAX_AUDIO_S) throw new MediaError('unsupported', `OmniHuman audio must be under ${OMNIHUMAN_MAX_AUDIO_S}s (got ${seconds.toFixed(1)}s)`);
  // The output frames the portrait as given; there is no aspect parameter.
  return { endpoint: req.resolved_params.model, input: { image_url: await upload(ctx, p.portrait), audio_url: await upload(ctx, p.audio) } };
}

const INPUTS = { 'video.generate': videoInput, 'image.generate': imageInput, 'avatar.generate': avatarInput };

export async function submit(capability, req, ctx) {
  if (!INPUTS[capability]) throw new MediaError('unsupported', `fal has no ${capability}`);
  const { endpoint, input } = await INPUTS[capability](req, ctx);
  const res = await ctx.json(`${QUEUE}/${endpoint}`, { headers: auth(ctx), body: input });
  if (!res.response_url) throw new MediaError('transient', 'fal queue returned no response_url');
  return { jobId: res.response_url };
}

export async function poll(capability, jobId, ctx, req) {
  const st = await ctx.json(`${jobId}/status`, { headers: auth(ctx) });
  if (st.status !== 'COMPLETED') return { status: 'running' };
  // A failed request is COMPLETED too; its result call answers with the model's error status,
  // which ctx.json classifies (422 + content policy text → moderation).
  if (st.error) {
    const text = String(st.error);
    return { status: 'failed', error: new MediaError(looksLikeModeration(text) ? 'moderation' : 'transient', `fal: ${text.slice(0, 300)}`) };
  }
  const out = await ctx.json(jobId, { headers: auth(ctx) });
  if (capability === 'image.generate') {
    const img = out.images?.[0];
    if (!img?.url) return { status: 'failed', error: new MediaError(out.has_nsfw_concepts?.[0] ? 'moderation' : 'transient', 'fal returned no image') };
    const path = await ctx.download(img.url, req.out);
    return { status: 'completed', result: { files: [{ path, mime: mime(path), ...(img.width ? { width: img.width, height: img.height } : {}) }] } };
  }
  if (!out.video?.url) return { status: 'failed', error: new MediaError('transient', 'fal returned no video') };
  const file = { path: await ctx.download(out.video.url, req.out), mime: 'video/mp4' };
  const duration = out.duration ?? req.resolved_params?.duration;
  if (duration) file.duration_s = Number(duration);
  return { status: 'completed', result: { files: [file] } };
}
