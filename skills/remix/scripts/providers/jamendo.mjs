// Jamendo API v3 (spec §5.6): music.search for background music under Creative Commons.
// Only instrumental tracks whose artists allow downloads are returned; each item carries its
// CC license URL and an attribution line. Jamendo reports errors in a 200 body
// ({ headers: { status: 'failed', code, error_message } }).
import { MediaError } from '../lib/media/errors.mjs';

const BASE = 'https://api.jamendo.com/v3.0';
const DEFAULT_LIMIT = 10;
// Over-fetch so dropping download-disabled tracks still leaves `limit` results.
const FETCH_FACTOR = 2;
const MAX_FETCH = 200;

export const meta = {
  name: 'jamendo',
  displayName: 'Jamendo',
  docs: 'https://developer.jamendo.com/v3.0/tracks',
  secrets: ['JAMENDO_CLIENT_ID'],
  concurrency: 4,
  capabilities: { 'music.search': { models: [] } },
};

// Jamendo error codes: 5 invalid client id, 6 rate limit, 11 not enough credentials.
function check(res) {
  const h = res.headers || {};
  if (h.status !== 'failed') return res;
  const code = Number(h.code);
  const kind = code === 5 || code === 11 ? 'auth' : code === 6 ? 'quota' : code === 12 ? 'transient' : 'invalid';
  throw new MediaError(kind, `jamendo ${code}: ${h.error_message || 'request failed'}`, h);
}

const tracks = async (ctx, q) => check(await ctx.json(`${BASE}/tracks/?${new URLSearchParams({ client_id: ctx.secret('JAMENDO_CLIENT_ID'), format: 'json', ...q })}`));

export async function verify(ctx) {
  await tracks(ctx, { limit: '1' });
}

export async function submit(capability, req, ctx) {
  if (capability !== 'music.search') throw new MediaError('unsupported', `${capability} is not implemented`);
  const p = req.params;
  const limit = p.limit || DEFAULT_LIMIT;
  const q = {
    search: p.query, vocalinstrumental: 'instrumental', include: 'licenses', audiodlformat: 'mp32',
    limit: String(Math.min(MAX_FETCH, limit * FETCH_FACTOR)),
  };
  if (p.min_s !== undefined || p.max_s !== undefined) q.durationbetween = `${Math.floor(p.min_s ?? 0)}_${Math.ceil(p.max_s ?? 99999)}`;
  const res = await tracks(ctx, q);
  const items = (res.results || [])
    .filter((t) => t.audiodownload_allowed && t.audiodownload)
    .slice(0, limit)
    .map((t) => ({
      id: String(t.id), title: t.name || null, duration_s: t.duration ?? null, download_url: t.audiodownload,
      license: t.license_ccurl || null,
      attribution: `"${t.name}" by ${t.artist_name} (Jamendo)${t.license_ccurl ? `, licensed under ${t.license_ccurl}` : ''}`,
    }));
  return { result: { items } };
}
