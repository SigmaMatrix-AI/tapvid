// HeyGen API v3 (spec §5.6): avatar videos from a HeyGen avatar look + script.
// POST /v3/videos → { data: { video_id } }; GET /v3/videos/{id} until completed / failed;
// the presigned video_url is downloaded at once. Avatars come from GET /v3/avatars/looks.
import { MediaError, looksLikeModeration } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';

const BASE = 'https://api.heygen.com';
// Looks per page is capped at 50; a few pages are enough to pick from.
const LOOKS_PAGE = 50;
const LOOKS_MAX_PAGES = 4;

export const meta = {
  name: 'heygen',
  displayName: 'HeyGen',
  docs: 'https://developers.heygen.com',
  secrets: ['HEYGEN_API_KEY'],
  concurrency: 3,
  pollIntervalS: 10,
  capabilities: {
    'avatar.generate': {
      models: [{
        id: 'avatar', default: true,
        modes: ['tts'],
        aspects: ['16:9', '9:16', '1:1'],
        price: { usdPerSecond: 0.033 }, // ~$1 per minute on the API pay-as-you-go plan, 2026-10-27
      }],
    },
    'avatar.list': { models: [] },
  },
};

const auth = (ctx) => ({ 'x-api-key': ctx.secret('HEYGEN_API_KEY') });

export async function verify(ctx) {
  await ctx.json(`${BASE}/v3/avatars/looks?limit=1`, { headers: auth(ctx) });
}

export async function estimate(capability, req) {
  const model = meta.capabilities[capability]?.models.find((m) => m.id === req.model);
  return estimateFromMeta(capability, req, model);
}

async function listLooks(req, ctx) {
  const items = [];
  let token = null;
  for (let page = 0; page < LOOKS_MAX_PAGES; page++) {
    const q = new URLSearchParams({ limit: String(LOOKS_PAGE), ...(token ? { token } : {}) });
    const res = await ctx.json(`${BASE}/v3/avatars/looks?${q}`, { headers: auth(ctx) });
    for (const l of res.data || []) {
      items.push({ id: l.id, name: l.name || l.id, gender: l.gender ?? null, preview_url: l.preview_image_url ?? null });
    }
    if (!res.has_more || !res.next_token) break;
    token = res.next_token;
  }
  const gender = req.params.gender;
  return gender ? items.filter((i) => !i.gender || i.gender.toLowerCase() === gender) : items;
}

export async function submit(capability, req, ctx) {
  if (capability === 'avatar.list') return { result: { items: await listLooks(req, ctx) } };
  if (capability !== 'avatar.generate') throw new MediaError('unsupported', `${capability} is not implemented`);
  const p = req.params;
  if (!p.avatar_id) throw new MediaError('unsupported', 'heygen needs a HeyGen avatar_id (a local portrait is not supported)');
  if (!p.script) throw new MediaError('invalid', 'tts mode needs a script');
  const body = { type: 'avatar', avatar_id: p.avatar_id, script: p.script, aspect_ratio: req.resolved_params.aspect, resolution: '1080p' };
  // Without voice_id HeyGen uses the avatar's default voice.
  if (p.voice) body.voice_id = p.voice;
  const res = await ctx.json(`${BASE}/v3/videos`, { headers: auth(ctx), body });
  return { jobId: res.data.video_id };
}

export async function poll(capability, jobId, ctx, req) {
  const { data } = await ctx.json(`${BASE}/v3/videos/${jobId}`, { headers: auth(ctx) });
  if (data.status === 'completed') {
    const file = { path: await ctx.download(data.video_url, req.out), mime: 'video/mp4' };
    if (data.duration) file.duration_s = data.duration;
    return { status: 'completed', result: { files: [file] } };
  }
  if (data.status === 'failed') {
    const msg = `${data.failure_code || ''} ${data.failure_message || ''}`.trim() || 'video failed';
    return { status: 'failed', error: new MediaError(looksLikeModeration(msg) ? 'moderation' : 'transient', `heygen: ${msg}`) };
  }
  return { status: 'running' };
}
