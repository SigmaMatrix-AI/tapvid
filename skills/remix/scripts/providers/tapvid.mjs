// TapVid open REST API (spec §5.6) — the same key and capabilities as the TapVid MCP.
// Request / response shapes follow the backend's public API DTOs (model/publicapi/*): every
// generation is POST /assets/<kind> → 202 + task, polled with GET /assets/task?task_id= until
// completed / failed. Local files go up once as asset materials (multipart, field `file`) and are
// referenced by their materialId. Prices are credits, as GET /assets/models reports them.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { MediaError, looksLikeModeration } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';
import { mimeOf } from '../lib/media/ctx.mjs';

const BASE = process.env.TAPVID_API_BASE || 'https://mcp.tapvid.ai/api/public/v1';

// ctx's extension table maps .mp3 to audio/mp3; report the registered type.
const mime = (path) => (path.endsWith('.mp3') ? 'audio/mpeg' : mimeOf(path));

const KIND = { 'image.generate': 'image', 'video.generate': 'video', 'avatar.generate': 'avatar', 'speech.synthesize': 'speech' };
const ASPECTS_16_9 = ['16:9', '9:16'];
const IMAGE_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'];

// "720p" → 720, "2K" → 1440, "4K" → 2160.
export function shortEdgeOf(name) {
  const k = String(name).match(/^(\d+)K$/i);
  if (k) return { 1: 1080, 2: 1440, 4: 2160 }[k[1]] || Number(k[1]) * 720;
  return Number(String(name).replace(/p$/i, '')) || 0;
}
const res = (...names) => names.map((name) => ({ name, shortEdge: shortEdgeOf(name) }));

// Snapshot of GET /assets/models (backend PixelModelEnum / Asset*ModelEnum), 2026-10-27; discover()
// refreshes it. A model taking exactly one image and no video is an image-to-video model: its one
// image is the first frame, so it declares firstFrame instead of a reference slot.
export const meta = {
  name: 'tapvid',
  displayName: 'TapVid',
  docs: 'https://mcp.tapvid.ai',
  secrets: ['TAPVID_API_KEY'],
  concurrency: 10, // the account's active-task limit (too_many_active_tasks past it)
  pollIntervalS: 5,
  capabilities: {
    'video.generate': {
      models: [
        { id: 'seedance-2.0-fast', default: true, aspects: ASPECTS_16_9, duration: { min: 5, max: 15 }, resolutions: res('480p', '720p'),
          firstFrame: true, maxRefs: 0, maxRefVideos: 0, price: { creditsPerSecond: { '480p': 8, '720p': 18 } } },
        { id: 'seedance-2.5', aspects: ASPECTS_16_9, duration: { min: 5, max: 15 }, resolutions: res('480p', '720p', '1080p'),
          maxRefs: 30, maxRefVideos: 10, refVideoMaxS: 15, billsReferenceVideo: true, price: { creditsPerSecond: { '480p': 16, '720p': 34, '1080p': 82 } } },
        { id: 'seedance-2.0', aspects: ASPECTS_16_9, duration: { min: 5, max: 15 }, resolutions: res('480p', '720p', '1080p'),
          maxRefs: 9, maxRefVideos: 3, refVideoMaxS: 15, billsReferenceVideo: true, price: { creditsPerSecond: { '480p': 10, '720p': 22, '1080p': 48 } } },
        { id: 'minimax-h3', aspects: ASPECTS_16_9, duration: { min: 5, max: 15 }, resolutions: res('480P', '768P', '2K'),
          maxRefs: 9, maxRefVideos: 3, refVideoMaxS: 15, freeRefs: 5, creditsPerExtraRef: 6, price: { creditsPerSecond: { '480P': 4, '768P': 5, '2K': 10 } } },
        { id: 'veo-3.1', aspects: ASPECTS_16_9, durations: [4, 6, 8], resolutions: res('720p', '1080p'),
          maxRefs: 3, maxRefVideos: 0, price: { creditsPerSecond: { '720p': 29, '1080p': 29 } } },
        { id: 'veo-3.1-fast', aspects: ASPECTS_16_9, durations: [4, 6, 8], resolutions: res('720p', '1080p'),
          firstFrame: true, maxRefs: 0, maxRefVideos: 0, price: { creditsPerSecond: { '720p': 11, '1080p': 11 } } },
        { id: 'happy-horse-1.0', aspects: ASPECTS_16_9, duration: { min: 5, max: 15 }, resolutions: res('720p', '1080p'),
          firstFrame: true, maxRefs: 0, maxRefVideos: 0, price: { creditsPerSecond: { '720p': 10, '1080p': 20 } } },
        { id: 'wand-1.5-pro', aspects: ASPECTS_16_9, duration: { min: 5, max: 15 }, resolutions: res('720P', '1080P'),
          firstFrame: true, maxRefs: 0, maxRefVideos: 0, price: { creditsPerSecond: { '720P': 20, '1080P': 44 } } },
        { id: 'grok-imagine-video', aspects: ASPECTS_16_9, duration: { min: 5, max: 15 }, resolutions: res('480p', '720p'),
          firstFrame: true, maxRefs: 0, maxRefVideos: 0, price: { creditsPerSecond: { '480p': 4, '720p': 5 } } },
      ],
    },
    'image.generate': {
      models: [
        { id: 'nano-banana-pro', default: true, aspects: IMAGE_ASPECTS, maxRefs: 14, price: { creditsPerImage: 21 } },
        { id: 'nano-banana', aspects: IMAGE_ASPECTS, maxRefs: 3, price: { creditsPerImage: 6 } },
      ],
    },
    // The digital human speaks a script in a catalog voice; there is no audio-driven mode.
    'avatar.generate': { models: [{ id: 'p-video-avatar', default: true, modes: ['tts'], maxRefs: 0, price: { creditsPerSecond: 2 } }] },
    'speech.synthesize': { models: [{ id: 'tapvid-tts', default: true, maxChars: 5000, price: { creditsPerSecond: 0.4 } }] },
    'speech.voices': { models: [] },
    'avatar.list': { models: [] },
  },
};

const STALE_MATERIAL = /upload it again/i;

const auth = (ctx) => ({ authorization: `Bearer ${ctx.secret('TAPVID_API_KEY')}` });
const modelOf = (capability, id) => meta.capabilities[capability]?.models.find((m) => m.id === id);

export async function verify(ctx) {
  await ctx.json(`${BASE}/account`, { headers: auth(ctx) });
}

export async function account(ctx) {
  const res = await ctx.json(`${BASE}/account`, { headers: auth(ctx) });
  return { credits: Number(res.credit?.available ?? res.credit?.total ?? 0) };
}

// Credits beyond the generated seconds: reference video seconds (billed like output seconds, here
// at the model's per-clip cap since the files are not probed) and reference images past the free ones.
export async function estimate(capability, req) {
  const model = modelOf(capability, req.model);
  const est = estimateFromMeta(capability, req, model);
  if (capability !== 'video.generate' || !model || est.credits === null) return est;
  const rate = model.price.creditsPerSecond[req.resolved_params?.resolution] ?? Object.values(model.price.creditsPerSecond)[0];
  let extra = 0;
  if (model.billsReferenceVideo) extra += (req.params.ref_videos || []).length * (model.refVideoMaxS || 0) * rate;
  if (model.creditsPerExtraRef) extra += Math.max(0, (req.params.refs || []).length - (model.freeRefs || 0)) * model.creditsPerExtraRef;
  return { ...est, credits: Math.ceil(est.credits + extra) };
}

async function upload(ctx, file, fresh) {
  return ctx.upload(file, async (abs) => {
    const form = new FormData();
    form.append('file', ctx.blob(abs), basename(abs));
    const res = await ctx.json(`${BASE}/materials?usage=asset`, { headers: auth(ctx), form });
    if (!res.materialId) throw new MediaError('transient', 'tapvid upload returned no materialId');
    return String(res.materialId);
  }, { fresh });
}

async function videoBody(req, ctx, fresh) {
  const p = req.params;
  const r = req.resolved_params;
  if (p.audio) throw new MediaError('unsupported', 'TapVid video has no audio switch');
  const references = [];
  if (p.first_frame) references.push({ kind: 'image', documentId: await upload(ctx, p.first_frame, fresh) });
  for (const ref of p.refs || []) references.push({ kind: 'image', documentId: await upload(ctx, ref.file, fresh) });
  for (const ref of p.ref_videos || []) {
    const file = r.refVideoMaxS ? ctx.trim(ref.file, { maxS: r.refVideoMaxS }) : ref.file;
    references.push({ kind: 'video', documentId: await upload(ctx, file, fresh) });
  }
  return {
    prompt: p.prompt, model: r.model, aspectRatio: r.aspect, resolution: r.resolution,
    duration: r.duration !== undefined ? String(r.duration) : undefined,
    ...(references.length ? { references } : {}),
  };
}

async function imageBody(req, ctx, fresh) {
  const ids = [];
  for (const ref of req.params.refs || []) ids.push(await upload(ctx, ref.file, fresh));
  return { prompt: req.params.prompt, model: req.resolved_params.model, aspectRatio: req.resolved_params.aspect, ...(ids.length ? { referenceDocumentIds: ids } : {}) };
}

function speechBody(req, ctx) {
  const p = req.params;
  if (p.speed !== undefined && p.speed !== 1) throw new MediaError('unsupported', 'TapVid speech has no speed control');
  if (p.style) ctx.log('style hint ignored: TapVid speech takes no tone instructions');
  return { script: p.text, voiceId: p.voice, model: req.resolved_params.model };
}

async function avatarBody(req, ctx, fresh) {
  const p = req.params;
  if (p.mode !== 'tts') throw new MediaError('unsupported', 'TapVid avatars speak a script; audio-driven mode is not offered');
  if (!p.script) throw new MediaError('invalid', 'avatar mode tts needs a script');
  // Framing follows the portrait / preset avatar; the API takes no aspect ratio.
  const body = { script: p.script, voiceId: p.voice, language: p.language, model: req.resolved_params.model };
  if (p.portrait) body.imageDocumentId = await upload(ctx, p.portrait, fresh);
  else if (p.avatar_id) body.avatarId = p.avatar_id;
  return body;
}

const BODIES = { 'video.generate': videoBody, 'image.generate': imageBody, 'speech.synthesize': speechBody, 'avatar.generate': avatarBody };

// The backend returns the earlier task for a key it has seen on this account, so the key carries a hash
// of what is asked and where it lands: the same request retried maps to its task, while the same
// request id in another project, or with changed parameters, is a new generation.
export function idempotencyKey(req, fields) {
  const digest = createHash('sha256').update(JSON.stringify([fields, req.out || null])).digest('hex').slice(0, 16);
  return `${String(req.id).slice(0, 47)}-${digest}`;
}

export async function submit(capability, req, ctx) {
  if (capability === 'speech.voices') return { result: { items: await voices(req.params, ctx) } };
  if (capability === 'avatar.list') return { result: { items: await avatars(req.params, ctx) } };
  if (!BODIES[capability]) throw new MediaError('unsupported', `tapvid has no ${capability}`);
  const post = async (fresh) => {
    const fields = await BODIES[capability](req, ctx, fresh);
    return ctx.json(`${BASE}/assets/${KIND[capability]}`, { headers: auth(ctx), body: { ...fields, idempotencyKey: idempotencyKey(req, fields) } });
  };
  let task;
  try {
    task = await post(false);
  } catch (e) {
    // A material cached from an upload the backend can no longer use (e.g. a video stored before its
    // length was measured) is refused with this message; uploading the same files again fixes it.
    if (e.code !== 'invalid' || !STALE_MATERIAL.test(e.message)) throw e;
    ctx.log('tapvid refused a cached upload; uploading the files again');
    task = await post(true);
  }
  if (!task.taskId) throw new MediaError('transient', 'tapvid returned no taskId');
  return { jobId: String(task.taskId) };
}

export async function poll(capability, jobId, ctx, req) {
  const task = await ctx.json(`${BASE}/assets/task?task_id=${encodeURIComponent(jobId)}`, { headers: auth(ctx) });
  if (task.status === 'failed') {
    const text = `${task.error?.code || ''} ${task.error?.message || ''}`.trim() || 'generation failed';
    return { status: 'failed', error: new MediaError(looksLikeModeration(text) ? 'moderation' : 'transient', `tapvid: ${text}`, task.error) };
  }
  if (task.status !== 'completed') return { status: 'running' };
  const doc = task.document || {};
  if (!doc.url) return { status: 'failed', error: new MediaError('transient', 'tapvid task completed without a document') };
  const path = await ctx.download(doc.url, req.out);
  const file = { path, mime: mime(path) };
  if (doc.durationMs) file.duration_s = doc.durationMs / 1000;
  if (doc.width) file.width = doc.width;
  if (doc.height) file.height = doc.height;
  const charged = task.chargedCredits ?? null;
  return { status: 'completed', result: { files: [file], ...(charged !== null ? { cost: { credits: Number(charged), estimated: false } } : {}) } };
}

async function voices(params, ctx) {
  const q = new URLSearchParams({ language: params.language, page_size: '100' });
  if (params.gender) q.set('gender', params.gender);
  const res = await ctx.json(`${BASE}/voices/list?${q}`, { headers: auth(ctx) });
  return (res.voices || []).map((v) => ({
    id: String(v.voiceId), name: v.displayNameEn || v.displayNameZh || String(v.voiceId), gender: v.gender ?? null,
    language: v.language ?? null, sample_url: v.sampleAudioUrl ?? null, recommended: Boolean(v.isRecommended),
  }));
}

async function avatars(params, ctx) {
  const list = await ctx.json(`${BASE}/avatars/list`, { headers: auth(ctx) });
  return (Array.isArray(list) ? list : [])
    .filter((a) => !params.gender || a.gender === params.gender)
    .map((a) => ({ id: a.avatarId, name: a.name || a.avatarId, gender: a.gender ?? null, preview_url: a.previewImageUrl ?? null }));
}

// GET /assets/models → capabilities map in the adapt.mjs model shape.
export function modelsToCapabilities(list) {
  const caps = { 'video.generate': [], 'image.generate': [], 'avatar.generate': [], 'speech.synthesize': [] };
  for (const m of list || []) {
    const base = { id: m.model, ...(m.isDefault ? { default: true } : {}) };
    if (m.kind === 'video') {
      const frameModel = m.maxReferenceImages === 1 && !m.maxReferenceVideos;
      caps['video.generate'].push({
        ...base, aspects: m.aspectRatios || undefined,
        ...(m.durationChoices?.length ? { durations: m.durationChoices } : { duration: { min: m.durationMin ?? 1, max: m.durationMax ?? 15 } }),
        resolutions: (m.resolutions || []).map((name) => ({ name, shortEdge: shortEdgeOf(name) })),
        firstFrame: frameModel, maxRefs: frameModel ? 0 : m.maxReferenceImages || 0, maxRefVideos: m.maxReferenceVideos || 0,
        ...(m.maxReferenceVideos ? { refVideoMaxS: 15 } : {}),
        ...(m.billsReferenceVideo ? { billsReferenceVideo: true } : {}),
        ...(m.creditsPerExtraImage ? { freeRefs: m.freeReferenceImages || 0, creditsPerExtraRef: m.creditsPerExtraImage } : {}),
        price: { creditsPerSecond: Object.fromEntries(Object.entries(m.creditsPerSecond || {}).map(([k, v]) => [k, Number(v)])) },
      });
    } else if (m.kind === 'image') {
      caps['image.generate'].push({ ...base, aspects: m.aspectRatios || undefined, maxRefs: m.maxReferenceImages || 0, price: { creditsPerImage: Number(m.creditsPerImage) } });
    } else if (m.kind === 'avatar') {
      caps['avatar.generate'].push({ ...base, modes: ['tts'], maxRefs: 0, price: { creditsPerSecond: Number(Object.values(m.creditsPerSecond || {})[0] ?? 0) } });
    } else if (m.kind === 'speech') {
      caps['speech.synthesize'].push({ ...base, maxChars: m.maxScriptChars || undefined, price: { creditsPerSecond: Number(m.creditsPerSecond?.audio ?? 0) } });
    }
  }
  return Object.fromEntries(Object.entries(caps).filter(([, models]) => models.length).map(([cap, models]) => [cap, { models }]));
}

export async function discover(ctx) {
  return modelsToCapabilities(await ctx.json(`${BASE}/assets/models`, { headers: auth(ctx) }));
}
