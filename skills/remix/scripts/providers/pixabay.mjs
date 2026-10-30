// Pixabay API (spec §5.6): stock video.search and image.search, key as a query parameter.
// Results are free to use under the Pixabay Content License.
import { MediaError } from '../lib/media/errors.mjs';

const BASE = 'https://pixabay.com/api';
const DEFAULT_LIMIT = 10;
// per_page must be 3–200; smaller limits are trimmed after the call.
const MIN_PER_PAGE = 3;
// The schema's duration classes, as YouTube defines them: < 4 min, 4–20 min, > 20 min.
const DURATION = { short: [0, 240], medium: [240, 1200], long: [1200, Infinity] };
const ORDER = { views: 'popular', recent: 'latest' };
const LICENSE = 'Pixabay Content License';

export const meta = {
  name: 'pixabay',
  displayName: 'Pixabay',
  docs: 'https://pixabay.com/api/docs/',
  secrets: ['PIXABAY_API_KEY'],
  concurrency: 4,
  capabilities: { 'video.search': { models: [] }, 'image.search': { models: [] } },
};

// Orientation from pixel size; Pixabay videos cannot be filtered by it server-side.
const orientationOf = (w, h) => (w > h ? 'landscape' : w < h ? 'portrait' : 'square');

// Pixabay answers a bad key with 400 "[ERROR 400] Invalid or missing API key".
async function call(ctx, path, q) {
  const query = new URLSearchParams({ key: ctx.secret('PIXABAY_API_KEY'), ...q });
  try {
    return await ctx.json(`${BASE}${path}?${query}`);
  } catch (e) {
    if (/API key/i.test(e.message)) throw new MediaError('auth', e.message, e.raw);
    throw e;
  }
}

export async function verify(ctx) {
  await call(ctx, '/', { q: 'test', per_page: String(MIN_PER_PAGE) });
}

const baseQuery = (p) => {
  if (p.published_after) throw new MediaError('unsupported', 'pixabay cannot filter by publish date');
  const q = { q: p.query, per_page: String(Math.max(MIN_PER_PAGE, p.limit || DEFAULT_LIMIT)), safesearch: 'true' };
  if (p.sort && p.sort !== 'relevance') q.order = ORDER[p.sort];
  return q;
};

async function videos(p, ctx) {
  const res = await call(ctx, '/videos/', baseQuery(p));
  const [min, max] = DURATION[p.duration] || [0, Infinity];
  const items = (res.hits || []).map((h) => {
    // `large` is an empty object/url when the source is below 1080p; fall back to `medium`.
    const v = h.videos?.large?.url ? h.videos.large : h.videos?.medium || {};
    return {
      id: String(h.id), provider: 'pixabay', title: h.tags || null, url: h.pageURL, download_url: v.url || null,
      thumbnail_url: v.thumbnail || null, duration_s: h.duration ?? null, width: v.width ?? null, height: v.height ?? null,
      views: h.views ?? null, published_at: null, channel: h.user || null,
      license: LICENSE, attribution: h.user ? `Video by ${h.user} on Pixabay` : 'Pixabay',
    };
  });
  return items
    .filter((i) => i.duration_s === null || (i.duration_s >= min && i.duration_s < max))
    .filter((i) => !p.orientation || (i.width && orientationOf(i.width, i.height) === p.orientation))
    .slice(0, p.limit || DEFAULT_LIMIT);
}

async function images(p, ctx) {
  // Stock photos only; animated searches move on to a GIF provider (giphy).
  if (p.animated) throw new MediaError('unsupported', 'pixabay has no animated images');
  const q = { ...baseQuery(p), image_type: 'photo' };
  if (p.orientation === 'landscape') q.orientation = 'horizontal';
  if (p.orientation === 'portrait') q.orientation = 'vertical';
  const res = await call(ctx, '/', q);
  return (res.hits || [])
    .filter((h) => p.orientation !== 'square' || h.imageWidth === h.imageHeight)
    .map((h) => ({
      id: String(h.id), url: h.pageURL, download_url: h.largeImageURL,
      width: h.imageWidth ?? null, height: h.imageHeight ?? null,
      license: LICENSE, attribution: h.user ? `Image by ${h.user} on Pixabay` : 'Pixabay',
    }))
    .slice(0, p.limit || DEFAULT_LIMIT);
}

export async function submit(capability, req, ctx) {
  if (capability === 'video.search') return { result: { items: await videos(req.params, ctx) } };
  if (capability === 'image.search') return { result: { items: await images(req.params, ctx) } };
  throw new MediaError('unsupported', `${capability} is not implemented`);
}
