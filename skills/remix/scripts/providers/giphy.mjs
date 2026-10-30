// GIPHY API (https://developers.giphy.com/docs/api/endpoint#search): animated image.search.
// The key (GIPHY_API_KEY, free from https://developers.giphy.com/dashboard/) goes in the
// api_key query parameter. Each GIF comes with mp4 renditions, which are what the render plays.
import { MediaError } from '../lib/media/errors.mjs';

const BASE = 'https://api.giphy.com/v1/gifs';
const DEFAULT_LIMIT = 10;
// Beta (free) keys accept at most 50 results per search call.
const MAX_LIMIT = 50;
// pg-13 keeps reaction GIFs usable in a marketing film while leaving out R-rated ones.
const RATING = 'pg-13';

export const meta = {
  name: 'giphy',
  displayName: 'GIPHY',
  docs: 'https://developers.giphy.com/docs/api/',
  secrets: ['GIPHY_API_KEY'],
  concurrency: 4,
  capabilities: { 'image.search': { models: [{ id: 'gifs', default: true, price: { usdPerRequest: 0 } }] } },
};

const searchUrl = (ctx, query, limit) => `${BASE}/search?${new URLSearchParams({
  api_key: ctx.secret('GIPHY_API_KEY'), q: query, limit: String(limit), rating: RATING, lang: 'en',
})}`;

export async function verify(ctx) {
  await ctx.json(searchUrl(ctx, 'ok', 1));
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const orientationOf = (w, h) => (w > h ? 'landscape' : w < h ? 'portrait' : 'square');

function toItem(g) {
  const original = g.images?.original || {};
  const preview = g.images?.preview?.mp4 ? g.images.preview : g.images?.fixed_height || {};
  const author = g.user?.display_name || g.username || null;
  return {
    id: String(g.id), url: g.url || null, download_url: original.url || original.mp4,
    width: num(original.width), height: num(original.height),
    title: g.title || null, author, video: original.mp4 || null, preview_video: preview.mp4 || null,
    duration_s: null, // the API reports frames but not the frame rate; probe the mp4 when it matters
    license: 'GIPHY Terms of Service', attribution: author ? `GIF by ${author} via GIPHY` : 'via GIPHY',
  };
}

async function search(p, ctx) {
  const limit = Math.min(MAX_LIMIT, p.limit || DEFAULT_LIMIT);
  const res = await ctx.json(searchUrl(ctx, p.query, limit));
  // GIPHY cannot filter by orientation; it is applied to the results instead.
  return (res.data || []).map(toItem)
    .filter((i) => i.download_url)
    .filter((i) => !p.orientation || (i.width && orientationOf(i.width, i.height) === p.orientation));
}

export async function submit(capability, req, ctx) {
  if (capability !== 'image.search') throw new MediaError('unsupported', `${capability} is not implemented`);
  // GIPHY only has animated pictures. A still-photo search answers unsupported so the runner keeps
  // sending it to the stock providers (Pexels, Pixabay) instead of returning GIFs nobody asked for.
  if (!req.params.animated) throw new MediaError('unsupported', 'giphy only answers animated searches');
  return { result: { items: await search(req.params, ctx) } };
}
