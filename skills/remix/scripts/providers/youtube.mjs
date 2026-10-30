// YouTube Data API v3 (spec §5.6): video.search for reference videos. search.list gives ids and
// snippets; a second videos.list call adds duration and view counts. A search costs 100 quota
// units (≈100 searches/day on the default quota), videos.list 1 unit.
import { MediaError } from '../lib/media/errors.mjs';

const BASE = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_LIMIT = 10;
const ORDER = { views: 'viewCount', recent: 'date', relevance: 'relevance' };

export const meta = {
  name: 'youtube',
  displayName: 'YouTube',
  docs: 'https://developers.google.com/youtube/v3/docs/search/list',
  secrets: ['YOUTUBE_API_KEY'],
  concurrency: 4,
  capabilities: { 'video.search': { models: [] } },
};

// ISO 8601 duration (PT1H2M3S) → seconds.
export function isoSeconds(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((v) => Number(v || 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

const decode = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// YouTube reports a bad key as 400 keyInvalid and an exhausted quota as 403 quotaExceeded.
async function call(ctx, path, q) {
  try {
    return await ctx.json(`${BASE}/${path}?${new URLSearchParams({ ...q, key: ctx.secret('YOUTUBE_API_KEY') })}`);
  } catch (e) {
    if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(e.message)) throw new MediaError('quota', e.message, e.raw);
    if (/keyInvalid|API_KEY_INVALID|API key not valid/.test(e.message)) throw new MediaError('auth', e.message, e.raw);
    throw e;
  }
}

export async function verify(ctx) {
  await call(ctx, 'videos', { part: 'id', id: 'dQw4w9WgXcQ' });
}

export async function submit(capability, req, ctx) {
  if (capability !== 'video.search') throw new MediaError('unsupported', `${capability} is not implemented`);
  const p = req.params;
  if (p.orientation) throw new MediaError('unsupported', 'youtube search cannot filter by orientation');
  const q = { part: 'snippet', type: 'video', q: p.query, maxResults: String(p.limit || DEFAULT_LIMIT), order: ORDER[p.sort || 'relevance'] };
  if (p.duration) q.videoDuration = p.duration;
  // publishedAfter must be RFC 3339; a bare date means midnight UTC.
  if (p.published_after) q.publishedAfter = /T/.test(p.published_after) ? p.published_after : `${p.published_after}T00:00:00Z`;
  const search = await call(ctx, 'search', q);
  const hits = (search.items || []).filter((i) => i.id?.videoId);
  if (!hits.length) return { result: { items: [] } };
  const details = await call(ctx, 'videos', { part: 'contentDetails,statistics', id: hits.map((h) => h.id.videoId).join(',') });
  const byId = new Map((details.items || []).map((v) => [v.id, v]));
  const items = hits.map((h) => {
    const id = h.id.videoId;
    const d = byId.get(id);
    const s = h.snippet || {};
    const views = d?.statistics?.viewCount;
    return {
      id, provider: 'youtube', title: decode(s.title) || null, url: `https://www.youtube.com/watch?v=${id}`, download_url: null,
      thumbnail_url: s.thumbnails?.high?.url || s.thumbnails?.default?.url || null,
      duration_s: isoSeconds(d?.contentDetails?.duration), width: null, height: null,
      views: views !== undefined ? Number(views) : null, published_at: s.publishedAt || null,
      channel: decode(s.channelTitle) || null, license: null, attribution: null,
    };
  });
  return { result: { items } };
}
