// BytePlus ModelArk (international) / Volcengine Ark (China) (spec §5.6): Seedance video through
// the async contents/generations task API, Seedream images through the sync images API.
// ARK_REGION=cn switches to Volcengine; the two sites name the same models differently.
import { MediaError, looksLikeModeration } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';

const HOSTS = {
  intl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
  cn: 'https://ark.cn-beijing.volces.com/api/v3',
};
// meta ids are the BytePlus names; Volcengine prefixes Seedance with doubao- instead of dreamina-.
const CN_MODEL = { 'dreamina-seedance-2-0-260128': 'doubao-seedance-2-0-260128' };

// Seedream takes an explicit pixel size; 2K-class sizes per aspect from the Seedream docs.
const SIZE_2K = {
  '1:1': '2048x2048', '4:3': '2304x1728', '3:4': '1728x2304', '16:9': '2560x1440',
  '9:16': '1440x2560', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3024x1296',
};

export const meta = {
  name: 'ark',
  displayName: 'BytePlus ModelArk / Volcengine Ark',
  docs: 'https://docs.byteplus.com/en/docs/ModelArk',
  secrets: ['ARK_API_KEY'],
  concurrency: 5,
  pollIntervalS: 10,
  capabilities: {
    'video.generate': {
      models: [{
        id: 'dreamina-seedance-2-0-260128', default: true,
        aspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
        duration: { min: 4, max: 15 },
        resolutions: [{ name: '480p', shortEdge: 480 }, { name: '720p', shortEdge: 720 }, { name: '1080p', shortEdge: 1080 }],
        firstFrame: true, lastFrame: true, maxRefs: 9, maxRefVideos: 0,
        price: { usdPerSecond: { '480p': 0.05, '720p': 0.1, '1080p': 0.22 } }, // ModelArk pricing page, 2026-10-27
      }, {
        id: 'seedance-1-5-pro-251215',
        aspects: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
        duration: { min: 4, max: 12 },
        resolutions: [{ name: '480p', shortEdge: 480 }, { name: '720p', shortEdge: 720 }, { name: '1080p', shortEdge: 1080 }],
        firstFrame: true, lastFrame: true, maxRefs: 0, maxRefVideos: 0,
        price: { usdPerSecond: { '480p': 0.03, '720p': 0.06, '1080p': 0.12 } }, // ModelArk pricing page, 2026-10-27
      }],
    },
    'image.generate': {
      models: [{
        id: 'seedream-5-0-260128', default: true,
        aspects: Object.keys(SIZE_2K),
        resolutions: [{ name: '2K', shortEdge: 1296 }],
        maxRefs: 10,
        price: { usdPerImage: 0.035 }, // ModelArk pricing page, 2026-10-27
      }],
    },
  },
};

const region = () => (process.env.ARK_REGION === 'cn' ? 'cn' : 'intl');
const base = () => HOSTS[region()];
const modelName = (id) => (region() === 'cn' ? CN_MODEL[id] || id : id);
const auth = (ctx) => ({ authorization: `Bearer ${ctx.secret('ARK_API_KEY')}` });

// Ark returns { error: { code, message } } on failure; sensitive-content codes are moderation.
function arkError(err, fallback = 'transient') {
  const text = `${err?.code || ''} ${err?.message || ''}`.trim();
  return new MediaError(looksLikeModeration(text) ? 'moderation' : fallback, `ark: ${text || 'task failed'}`, err);
}

export async function verify(ctx) {
  await ctx.json(`${base()}/models`, { headers: auth(ctx) });
}

export async function estimate(capability, req) {
  const model = meta.capabilities[capability]?.models.find((m) => m.id === req.model);
  return estimateFromMeta(capability, req, model);
}

const image = (file, role, ctx) => ({ type: 'image_url', image_url: { url: ctx.dataUri(file) }, role });

export async function submit(capability, req, ctx) {
  const p = req.params;
  const r = req.resolved_params;
  if (capability === 'video.generate') {
    // Seedance takes either first/last frames or reference images in one task, not both.
    if (p.refs?.length && (p.first_frame || p.last_frame)) throw new MediaError('unsupported', 'Seedance cannot mix frames and reference images');
    const content = [{ type: 'text', text: p.prompt }];
    if (p.first_frame) content.push(image(p.first_frame, 'first_frame', ctx));
    if (p.last_frame) content.push(image(p.last_frame, 'last_frame', ctx));
    for (const ref of p.refs || []) content.push(image(ref.file, 'reference_image', ctx));
    const body = {
      model: modelName(r.model), content,
      ratio: r.aspect, duration: r.duration, resolution: r.resolution,
      generate_audio: Boolean(p.audio), watermark: false,
    };
    const res = await ctx.json(`${base()}/contents/generations/tasks`, { headers: auth(ctx), body });
    return { jobId: res.id };
  }
  if (capability === 'image.generate') {
    const body = {
      model: modelName(r.model), prompt: p.prompt, size: SIZE_2K[r.aspect] || '2K',
      response_format: 'url', watermark: false, sequential_image_generation: 'disabled',
    };
    if (p.refs?.length) body.image = p.refs.map((ref) => ctx.dataUri(ref.file));
    const res = await ctx.json(`${base()}/images/generations`, { headers: auth(ctx), body });
    if (res.error) throw arkError(res.error, 'invalid');
    const url = res.data?.[0]?.url;
    if (!url) throw arkError(res.data?.[0]?.error || { message: 'no image returned' });
    return { result: { files: [{ path: await ctx.download(url, req.out) }] } };
  }
  throw new MediaError('unsupported', `${capability} is not implemented`);
}

export async function poll(capability, jobId, ctx, req) {
  const res = await ctx.json(`${base()}/contents/generations/tasks/${jobId}`, { headers: auth(ctx) });
  if (res.status === 'succeeded') {
    return { status: 'completed', result: { files: [{ path: await ctx.download(res.content.video_url, req.out), mime: 'video/mp4' }] } };
  }
  if (res.status === 'failed' || res.status === 'expired' || res.status === 'cancelled') {
    return { status: 'failed', error: arkError(res.error || { message: res.status }) };
  }
  return { status: 'running' };
}
