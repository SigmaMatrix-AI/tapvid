// MiniMax (spec §5.6): H3 video (v2 API), image-01, T2A v2 speech, music-3.0.
// Docs: platform.minimax.io/docs/api-reference/{video-generation-v2-create, video-generation-v2-query,
// image-generation-t2i, image-generation-i2i, speech-t2a-http, music-generation, errorcode}.
// The v2 video API reports errors with real HTTP statuses; the v1 endpoints answer 200 with
// base_resp.status_code ≠ 0, classified by baseError(). Local files go inline as base64 data
// URIs (request body ≤ 64 MB), so there is no upload step.
import { MediaError } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';

const host = process.env.MINIMAX_HOST || 'api.minimax.io';
const BASE = /^https?:\/\//.test(host) ? host.replace(/\/$/, '') : `https://${host}`;

// Request body limit for inline media, with headroom for base64's 4/3 growth and the JSON.
const MAX_INLINE_BYTES = 45 * 1024 * 1024;
// Reference videos: ≤ 3 clips, each 2–15 s, 15 s combined (video-generation-v2-create).
const REF_VIDEO_TOTAL_S = 15;

const H3_ASPECTS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
// A system voice (POST /v1/get_voice, voice_type system) for the live check: MiniMax has no
// speech.voices capability here to pick one from.
const LIVE_VOICE = 'English_expressive_narrator';

// Prices: platform.minimax.io/docs/pricing/overview, pay-as-you-go, 2026-10-27.
export const meta = {
  name: 'minimax',
  displayName: 'MiniMax',
  docs: 'https://platform.minimax.io/docs',
  secrets: ['MINIMAX_API_KEY'],
  concurrency: 5,
  pollIntervalS: 10,
  capabilities: {
    'video.generate': {
      models: [
        { id: 'MiniMax-H3', default: true, aspects: H3_ASPECTS, duration: { min: 4, max: 15 },
          resolutions: [{ name: '768P', shortEdge: 768 }, { name: '2K', shortEdge: 1440 }],
          firstFrame: true, lastFrame: true, maxRefs: 9, maxRefVideos: 3, refVideoMinS: 2, refVideoMaxS: REF_VIDEO_TOTAL_S,
          price: { usdPerSecond: { '768P': 0.08, '2K': 0.13 } } },
        { id: 'MiniMax-H3-Highspeed', aspects: H3_ASPECTS, duration: { min: 4, max: 15 },
          resolutions: [{ name: '768P', shortEdge: 768 }],
          firstFrame: true, lastFrame: true, maxRefs: 9, maxRefVideos: 3, refVideoMinS: 2, refVideoMaxS: REF_VIDEO_TOTAL_S,
          price: { usdPerSecond: { '768P': 0.06 } } },
        { id: 'MiniMax-H3-Lite', aspects: H3_ASPECTS, duration: { min: 4, max: 15 },
          resolutions: [{ name: '480P', shortEdge: 480 }, { name: '768P', shortEdge: 768 }],
          firstFrame: true, lastFrame: true, maxRefs: 9, maxRefVideos: 3, refVideoMinS: 2, refVideoMaxS: REF_VIDEO_TOTAL_S,
          price: { usdPerSecond: { '480P': 0.025, '768P': 0.04 } } },
      ],
    },
    // image-01 sizes are fixed per aspect (16:9 = 1280×720, 1:1 = 1024×1024); 720 is the smallest short edge.
    'image.generate': {
      models: [{ id: 'image-01', default: true, aspects: ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'],
        resolutions: [{ name: 'standard', shortEdge: 720 }], maxRefs: 1, price: { usdPerImage: 0.0035 } }],
    },
    'speech.synthesize': { models: [{ id: 'speech-2.8-hd', default: true, maxChars: 9999, price: { usdPer1kChars: 0.1 } }] },
    // music-3.0 picks its own length (no duration parameter); $0.15 per song up to 5 minutes.
    // Closed to new paid accounts since 2026-08-20: they get HTTP 410 / status 2153, an `unsupported` error,
    // so the request moves on to the next music provider.
    'music.generate': { models: [{ id: 'music-3.0', default: true, price: { usdPerRequest: 0.15 } }] },
  },
  liveSamples: { 'speech.synthesize': { text: 'Hello from TapVid.', voice: LIVE_VOICE, language: 'en' } },
};

const auth = (ctx) => ({ authorization: `Bearer ${ctx.secret('MINIMAX_API_KEY')}` });
const modelOf = (capability, id) => meta.capabilities[capability]?.models.find((m) => m.id === id);

// base_resp.status_code → media error code (platform.minimax.io/docs/api-reference/errorcode).
const BASE_CODES = { 1004: 'auth', 2049: 'auth', 1008: 'quota', 1002: 'quota', 2053: 'quota', 2056: 'quota', 1026: 'moderation', 1027: 'moderation', 1040: 'moderation', 2013: 'invalid', 2014: 'invalid', 2022: 'unsupported', 2068: 'unsupported', 2069: 'unsupported', 2153: 'unsupported', 20132: 'invalid', 2054: 'invalid' };
const TRANSIENT = new Set([1000, 1001, 1024, 1033, 1039, 1041, 2045, 2064, 2066]);

export function baseError(res) {
  const code = Number(res?.base_resp?.status_code ?? 0);
  if (!code) return null;
  const kind = BASE_CODES[code] || (TRANSIENT.has(code) ? 'transient' : 'invalid');
  return new MediaError(kind, `minimax ${code}: ${res.base_resp.status_msg || ''}`.trim(), res.base_resp);
}

async function call(ctx, path, body) {
  const res = await ctx.json(`${BASE}${path}`, { headers: auth(ctx), body });
  const err = baseError(res);
  if (err) throw err;
  return res;
}

const audioExt = (buf) => (buf.subarray(0, 4).toString('latin1') === 'RIFF' ? 'wav' : 'mp3');
const imageExt = (buf) => (buf[0] === 0x89 && buf[1] === 0x50 ? 'png' : buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : 'webp');

export async function verify(ctx) {
  await call(ctx, '/v1/get_voice', { voice_type: 'system' });
}

export async function estimate(capability, req) {
  return estimateFromMeta(capability, req, modelOf(capability, req.model));
}

function inline(ctx, file) {
  const uri = ctx.dataUri(file);
  if (uri.length > MAX_INLINE_BYTES) throw new MediaError('unsupported', `${file} is too large to send inline to MiniMax`);
  return uri;
}

function videoBody(req, ctx) {
  const p = req.params;
  const r = req.resolved_params;
  const frames = Boolean(p.first_frame || p.last_frame);
  const refs = p.refs || [];
  const refVideos = p.ref_videos || [];
  // H3 is either image-to-video (first / last frame) or reference-to-video, never both.
  if (frames && (refs.length || refVideos.length)) throw new MediaError('unsupported', 'MiniMax H3 cannot mix first/last frames with references');
  if (p.last_frame && !p.first_frame) throw new MediaError('unsupported', 'MiniMax H3 needs a first frame with a last frame');
  const content = [{ type: 'text', text: p.prompt }];
  if (p.first_frame) content.push({ type: 'image_url', image_url: { url: inline(ctx, p.first_frame) }, role: 'first_frame' });
  if (p.last_frame) content.push({ type: 'image_url', image_url: { url: inline(ctx, p.last_frame) }, role: 'last_frame' });
  for (const ref of refs) content.push({ type: 'image_url', image_url: { url: inline(ctx, ref.file) }, role: 'reference_image' });
  // Split the 15 s combined allowance between the clips (each must stay ≥ 2 s).
  const perClip = refVideos.length ? Math.max(2, Math.floor(REF_VIDEO_TOTAL_S / refVideos.length)) : 0;
  for (const ref of refVideos) {
    const file = ctx.trim(ref.file, { minS: r.refVideoMinS, maxS: perClip, maxBytes: 30 * 1024 * 1024 });
    content.push({ type: 'video_url', video_url: { url: inline(ctx, file) }, role: 'reference_video' });
  }
  // Image-to-video always follows the frame's aspect; the ratio is ignored there (adaptive).
  return { model: r.model, content, resolution: r.resolution, duration: r.duration, ratio: frames ? 'adaptive' : r.aspect };
}

function imageBody(req, ctx) {
  const refs = req.params.refs || [];
  if (refs.some((ref) => ref.role !== 'subject')) throw new MediaError('unsupported', 'image-01 only takes a subject (character) reference');
  const body = { model: req.resolved_params.model, prompt: req.params.prompt, aspect_ratio: req.resolved_params.aspect, n: 1, response_format: 'base64' };
  if (refs.length) body.subject_reference = refs.map((ref) => ({ type: 'character', image_file: inline(ctx, ref.file) }));
  return body;
}

// Word timings from the subtitle file (non-streaming T2A returns it as a link). Its exact layout
// is not in the reference; accept a list of segments or { subtitles: [...] } with timestamped_words.
async function subtitleWords(ctx, url) {
  try {
    const raw = await ctx.json(url);
    const segments = Array.isArray(raw) ? raw : raw.subtitles || raw.data || [];
    return segments.flatMap((s) => s.timestamped_words || [])
      .map((w) => ({ text: String(w.word ?? '').trim(), start: (w.time_begin || 0) / 1000, end: (w.time_end || 0) / 1000 }))
      .filter((w) => w.text);
  } catch (e) {
    ctx.log(`subtitle file unreadable, no word timings: ${e.message}`);
    return [];
  }
}

async function speech(req, ctx) {
  const p = req.params;
  if (p.style) ctx.log('style hint ignored: MiniMax T2A takes a fixed emotion list, not free text');
  const res = await call(ctx, '/v1/t2a_v2', {
    model: req.resolved_params.model, text: p.text, stream: false, output_format: 'hex',
    voice_setting: { voice_id: p.voice, speed: p.speed ?? 1 },
    audio_setting: { format: 'mp3', sample_rate: 44100, bitrate: 128000, channel: 1 },
    subtitle_enable: true, subtitle_type: 'word',
  });
  if (!res.data?.audio) throw new MediaError('transient', 'minimax returned no audio');
  const file = { path: ctx.writeOut(req.out, Buffer.from(res.data.audio, 'hex'), 'mp3'), mime: 'audio/mpeg' };
  if (res.extra_info?.audio_length) file.duration_s = res.extra_info.audio_length / 1000;
  const words = res.data.subtitle_file ? await subtitleWords(ctx, res.data.subtitle_file) : [];
  if (words.length) file.words = words;
  return { files: [file] };
}

async function music(req, ctx) {
  const p = req.params;
  const instrumental = p.instrumental ?? true;
  ctx.log(`music-3.0 chooses its own length; requested ${p.duration_s}s is trimmed or looped downstream`);
  const res = await call(ctx, '/v1/music_generation', {
    model: req.resolved_params.model, prompt: p.prompt, is_instrumental: instrumental,
    ...(instrumental ? {} : { lyrics_optimizer: true }), output_format: 'hex',
    audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
  });
  if (!res.data?.audio) throw new MediaError('transient', 'minimax returned no music');
  const buf = Buffer.from(res.data.audio, 'hex');
  const ext = audioExt(buf);
  const file = { path: ctx.writeOut(req.out, buf, ext), mime: ext === 'wav' ? 'audio/wav' : 'audio/mpeg', bpm: null };
  if (res.extra_info?.music_duration) file.duration_s = res.extra_info.music_duration / 1000;
  return { files: [file] };
}

export async function submit(capability, req, ctx) {
  if (capability === 'video.generate') {
    const res = await ctx.json(`${BASE}/v2/video_generation`, { headers: auth(ctx), body: videoBody(req, ctx) });
    if (!res.task_id) throw baseError(res) || new MediaError('transient', 'minimax returned no task_id');
    return { jobId: String(res.task_id) };
  }
  if (capability === 'image.generate') {
    const res = await call(ctx, '/v1/image_generation', imageBody(req, ctx));
    const b64 = res.data?.image_base64?.[0];
    if (!b64) throw new MediaError(Number(res.metadata?.failed_count) ? 'moderation' : 'transient', 'minimax returned no image');
    const buf = Buffer.from(b64, 'base64');
    const ext = imageExt(buf);
    return { result: { files: [{ path: ctx.writeOut(req.out, buf, ext), mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` }] } };
  }
  if (capability === 'speech.synthesize') return { result: await speech(req, ctx) };
  if (capability === 'music.generate') return { result: await music(req, ctx) };
  throw new MediaError('unsupported', `minimax has no ${capability}`);
}

export async function poll(capability, jobId, ctx, req) {
  const { task = {} } = await ctx.json(`${BASE}/v2/query/video_generation/${encodeURIComponent(jobId)}`, { headers: auth(ctx) });
  if (task.status === 'failed' || task.status === 'cancelled') {
    const kind = BASE_CODES[Number(task.error?.code)] || 'transient';
    return { status: 'failed', error: new MediaError(kind, `minimax ${task.error?.code || task.status}: ${task.error?.message || ''}`.trim(), task.error) };
  }
  if (task.status !== 'succeeded') return { status: 'running' };
  if (!task.content?.url) return { status: 'failed', error: new MediaError('transient', 'minimax task succeeded without a video url') };
  const file = { path: await ctx.download(task.content.url, req.out), mime: 'video/mp4' };
  if (task.duration) file.duration_s = task.duration;
  return { status: 'completed', result: { files: [file] } };
}
