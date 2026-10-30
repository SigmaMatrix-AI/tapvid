// Pexels API (spec §5.6): stock video.search and image.search. The key goes in a bare
// Authorization header (no Bearer). Results are free to use under the Pexels License.
import { MediaError } from '../lib/media/errors.mjs';

const BASE = 'https://api.pexels.com';
const DEFAULT_LIMIT = 10;
// Preferred download rendition: the largest mp4 whose long edge fits 1920 (1080p class).
const MAX_LONG_EDGE = 1920;
// The schema's duration classes, as YouTube defines them: < 4 min, 4–20 min, > 20 min.
const DURATION = { short: [0, 240], medium: [240, 1200], long: [1200, Infinity] };
const LICENSE = 'Pexels License';

export const meta = {
  name: 'pexels',
  displayName: 'Pexels',
  docs: 'https://www.pexels.com/api/documentation/',
  secrets: ['PEXELS_API_KEY'],
  concurrency: 4,
  capabilities: { 'video.search': { models: [] }, 'image.search': { models: [] } },
};

const auth = (ctx) => ({ authorization: ctx.secret('PEXELS_API_KEY') });

export async function verify(ctx) {
  await ctx.json(`${BASE}/v1/curated?per_page=1`, { headers: auth(ctx) });
}

function bestFile(files = []) {
  const mp4 = files.filter((f) => f.file_type === 'video/mp4' && f.link);
  const fit = mp4.filter((f) => Math.max(f.width || 0, f.height || 0) <= MAX_LONG_EDGE);
  const pool = fit.length ? fit : mp4;
  return pool.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0] || null;
}

async function videos(p, ctx) {
  // Pexels ranks by relevance only and has no date filter.
  if (p.sort && p.sort !== 'relevance') throw new MediaError('unsupported', `pexels cannot sort by ${p.sort}`);
  if (p.published_after) throw new MediaError('unsupported', 'pexels cannot filter by publish date');
  const q = new URLSearchParams({ query: p.query, per_page: String(p.limit || DEFAULT_LIMIT) });
  if (p.orientation) q.set('orientation', p.orientation);
  const res = await ctx.json(`${BASE}/videos/search?${q}`, { headers: auth(ctx) });
  const [min, max] = DURATION[p.duration] || [0, Infinity];
  return (res.videos || []).filter((v) => v.duration >= min && v.duration < max).map((v) => {
    const f = bestFile(v.video_files);
    return {
      id: String(v.id), provider: 'pexels', title: null, url: v.url, download_url: f?.link ?? null,
      thumbnail_url: v.image || null, duration_s: v.duration ?? null, width: v.width ?? null, height: v.height ?? null,
      views: null, published_at: null, channel: v.user?.name || null,
      license: LICENSE, attribution: v.user?.name ? `Video by ${v.user.name} on Pexels` : 'Pexels',
    };
  });
}

async function images(p, ctx) {
  // Stock photos only; animated searches move on to a GIF provider (giphy).
  if (p.animated) throw new MediaError('unsupported', 'pexels has no animated images');
  const q = new URLSearchParams({ query: p.query, per_page: String(p.limit || DEFAULT_LIMIT) });
  if (p.orientation) q.set('orientation', p.orientation);
  const res = await ctx.json(`${BASE}/v1/search?${q}`, { headers: auth(ctx) });
  return (res.photos || []).map((ph) => ({
    id: String(ph.id), url: ph.url, download_url: ph.src?.original || ph.src?.large2x,
    width: ph.width ?? null, height: ph.height ?? null,
    license: LICENSE, attribution: ph.photographer ? `Photo by ${ph.photographer} on Pexels` : 'Pexels',
  }));
}

export async function submit(capability, req, ctx) {
  if (capability === 'video.search') return { result: { items: await videos(req.params, ctx) } };
  if (capability === 'image.search') return { result: { items: await images(req.params, ctx) } };
  throw new MediaError('unsupported', `${capability} is not implemented`);
}
