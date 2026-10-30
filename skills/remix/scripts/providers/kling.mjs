// Kling official API (spec §5.6). Auth is a short-lived JWT (HS256, iss = access key) signed
// with the secret key and sent as a Bearer token. The model is part of the path
// (POST /image-to-video/<model>, /text-to-video/<model>); GET /tasks?task_ids= polls.
// Responses wrap everything in { code, message, data }; a non-zero code is an error even on 200.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MediaError } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';

const BASE = 'https://api-singapore.klingai.com';
// Token lifetime from the Kling auth docs (30 min); nbf is backdated for clock skew.
const TOKEN_TTL_S = 1800;
const CLOCK_SKEW_S = 5;

export const meta = {
  name: 'kling',
  displayName: 'Kling AI',
  docs: 'https://kling.ai/document-api',
  secrets: ['KLING_ACCESS_KEY', 'KLING_SECRET_KEY'],
  concurrency: 3,
  pollIntervalS: 10,
  capabilities: {
    'video.generate': {
      models: [{
        id: 'kling-4.0', default: true,
        aspects: ['16:9', '9:16', '1:1'],
        duration: { min: 3, max: 30 },
        resolutions: [{ name: '720p', shortEdge: 720 }, { name: '1080p', shortEdge: 1080 }],
        firstFrame: true, lastFrame: true, maxRefs: 0, maxRefVideos: 0,
        price: { usdPerSecond: { '720p': 0.07, '1080p': 0.1 } }, // Kling API pricing page, 2026-10-27
      }, {
        id: 'kling-2.6',
        aspects: ['16:9', '9:16', '1:1'],
        durations: [5, 10],
        resolutions: [{ name: '720p', shortEdge: 720 }, { name: '1080p', shortEdge: 1080 }],
        firstFrame: true, lastFrame: true, maxRefs: 0, maxRefVideos: 0,
        price: { usdPerSecond: { '720p': 0.05, '1080p': 0.07 } }, // Kling API pricing page, 2026-10-27
      }],
    },
  },
};

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export function signJwt(accessKey, secretKey, nowS = Math.floor(Date.now() / 1000)) {
  const head = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url({ iss: accessKey, exp: nowS + TOKEN_TTL_S, nbf: nowS - CLOCK_SKEW_S });
  const sig = createHmac('sha256', secretKey).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const auth = (ctx) => ({ authorization: `Bearer ${signJwt(ctx.secret('KLING_ACCESS_KEY'), ctx.secret('KLING_SECRET_KEY'))}` });

// Business codes from the Kling error table: 1000–1004 auth, 1100–1102 account / balance,
// 1301 content safety, 1302–1304 rate and concurrency limits, 5xxx server side.
function klingError(code, message) {
  const kind = code >= 1000 && code <= 1004 ? 'auth'
    : (code >= 1100 && code <= 1102) || (code >= 1302 && code <= 1304) ? 'quota'
      : code === 1300 || code === 1301 ? 'moderation'
        : code >= 5000 ? 'transient' : 'invalid';
  return new MediaError(kind, `kling ${code}: ${message || ''}`, { code });
}

// Errors arrive as HTTP 4xx with the business code in the body, or as 200 with a non-zero code.
async function call(ctx, url, opts) {
  let res;
  try {
    res = await ctx.json(url, { headers: auth(ctx), ...opts });
  } catch (e) {
    const code = Number(e.message.match(/"code"\s*:\s*(\d+)/)?.[1]);
    throw code ? klingError(code, e.message) : e;
  }
  if (res.code) throw klingError(res.code, res.message);
  return res.data;
}

export async function verify(ctx) {
  await call(ctx, `${BASE}/tasks?task_ids=verify`);
}

export async function estimate(capability, req) {
  const model = meta.capabilities[capability]?.models.find((m) => m.id === req.model);
  return estimateFromMeta(capability, req, model);
}

// Kling takes images as a URL or as raw Base64 (no data: prefix).
const frame = (file, type, ctx) => ({ type, url: readFileSync(ctx.abs(file)).toString('base64') });

export async function submit(capability, req, ctx) {
  if (capability !== 'video.generate') throw new MediaError('unsupported', `${capability} is not implemented`);
  const p = req.params;
  const r = req.resolved_params;
  const contents = [];
  if (p.first_frame) contents.push(frame(p.first_frame, 'first_frame', ctx));
  if (p.last_frame) contents.push(frame(p.last_frame, 'last_frame', ctx));
  if (p.last_frame && !p.first_frame) throw new MediaError('unsupported', 'kling needs a first frame with a last frame');
  const body = {
    prompt: p.prompt,
    settings: { duration: r.duration, resolution: r.resolution, aspect_ratio: r.aspect, sound: p.audio ? 'on' : 'off' },
  };
  if (contents.length) body.contents = contents;
  const path = contents.length ? 'image-to-video' : 'text-to-video';
  const data = await call(ctx, `${BASE}/${path}/${r.model}`, { body });
  return { jobId: data.task_id };
}

export async function poll(capability, jobId, ctx, req) {
  const data = await call(ctx, `${BASE}/tasks?task_ids=${encodeURIComponent(jobId)}`);
  const task = [data].flat().find((t) => t.task_id === jobId) || [data].flat()[0];
  if (!task) return { status: 'running' };
  if (task.status === 'succeeded') {
    const url = task.outputs?.[0]?.url;
    if (!url) return { status: 'failed', error: new MediaError('transient', 'kling task succeeded without output') };
    return { status: 'completed', result: { files: [{ path: await ctx.download(url, req.out), mime: 'video/mp4' }] } };
  }
  if (task.status === 'failed') {
    return { status: 'failed', error: task.code ? klingError(task.code, task.message) : new MediaError('transient', `kling: ${task.message || 'task failed'}`) };
  }
  return { status: 'running' };
}
