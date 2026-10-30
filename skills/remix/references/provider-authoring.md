# Writing a provider

For the agent connecting a service that is not built in: a new video model, a Douyin / TikTok data service, a
company's own API, or another vendor's key for a capability nothing ready covers. The user supplies two
things: the service's API docs (a link, a file or pasted pages) and the key — through the password box, never
in the chat. Everything else is yours.

## 1. The contract

A provider is one Node ESM file using only built-ins (`fetch`, `fs`, `crypto`). Start from
`$SKILL_ROOT/scripts/providers/_template.mjs`; built-in providers in `$SKILL_ROOT/scripts/providers/*.mjs` are working examples
(`youtube.mjs` and `pexels.mjs` for search, `minimax.mjs` for async generation).

| Export | Required | Does |
|---|---|---|
| `meta` | yes | `name` (lowercase, the file name), `displayName` (vendor name the user sees), `docs`, `secrets[]` (env-var style names, one password box each), `concurrency`, optional `pollIntervalS` / `timeoutS`, `capabilities: { '<capability>': { models: [...] } }`, optional `liveSamples: { '<capability>': params }` for `check --live` |
| `submit(capability, req, ctx)` | yes | send the request; return `{ jobId }` for an async API (never poll inside `submit`), or `{ result }` when the API answers directly |
| `poll(capability, jobId, ctx, req)` | async APIs | `{ status: 'running' }` / `{ status: 'completed', result }` / `{ status: 'failed', error }` |
| `estimate(capability, req)` | no | `{ usd }` or `{ credits }`; default `estimateFromMeta` over the model's `price` |
| `verify(ctx)` | recommended | the cheapest authenticated call; throws `auth` on a bad key; may return `{ unavailable: ['music.generate'] }` |
| `account(ctx)` | no | `{ usd }` or `{ credits }` balance |
| `discover(ctx)` | no | a fresh `capabilities` map from the API (models, tiers, prices), stored by `check --live` |

**Models** (`scripts/lib/media/adapt.mjs`): `{ id, default?, aspects?, duration?: { min, max, step? } |
durations?: [..], resolutions?: [{ name, shortEdge }], firstFrame?, lastFrame?, maxRefs?, maxRefVideos?,
refVideoMaxS?, modes?: ['tts', 'audio'], maxChars?, price?: { usdPerSecond? (number or per resolution),
usdPerImage?, usdPer1kChars?, usdPerRequest?, creditsPerSecond?, creditsPerImage? } }`. The runner fits each
request to the first model that can take it and hands you `req.resolved_params` (`model`, `resolution`,
`duration`, `aspect`, `crop`, `refVideoMaxS`). Search and download capabilities have no tiers; `models: []`
works, or one model per variant (§5 uses one per platform).

**Requests**: `req = { id, capability, params, model, resolved_params, out }`. `params` follow
`$SKILL_ROOT/assets/schemas/capabilities/<capability>.json` (local file paths in, never URLs). Map every param to the
API's name; one the API cannot honour throws `unsupported` — never drop it silently (a model without
reference video receiving `ref_videos`, a search API that cannot filter by `orientation`).

**Results**: `{ files: [{ path, mime, duration_s?, width?, height?, words? }] }` or `{ items: [...] }`, plus
optional `cost: { usd?, credits?, estimated: false }`. Files are written with `ctx.download(url, req.out)` or
`ctx.writeOut(req.out, buffer, ext)` — never return a remote or signed URL as a file.

**ctx** (`scripts/lib/media/ctx.mjs`): `secret(name)`; `json(url, { method, headers, body, form, timeoutMs })`
and `bytes(url, …)` — they throw a classified error on non-2xx (401/403 `auth`, 402/429 `quota`,
400/404/409/413/422 `invalid`, moderation wording → `moderation`, else `transient`); `fetch`; `download(url,
outPrefix, { headers })` (extension from Content-Type); `writeOut(outPrefix, buffer, ext)`; `upload(file, via)`
(caches `via(absPath)`'s reference per file hash in `~/.tapvid-video/cache/uploads.json`); `dataUri(file)`;
`blob(file)` (for `FormData`); `readFile(file)`; `probe(file)` → `{ duration_s, width, height }`;
`trim(file, { maxS, maxBytes })`; `log(msg)` — never log a key.

**Errors** (`scripts/lib/media/errors.mjs`): `throw new ctx.MediaError(code, message, raw)` with `code` one of
`auth`, `quota`, `moderation`, `invalid`, `unsupported`, `transient`. Refine `ctx.json`'s classification
where the vendor's body says more (a 400 whose message is "insufficient balance" is `quota`). A provider in
`~/.tapvid-video/providers/` does not import anything from the plugin (its path changes with every plugin
update): it throws `new ctx.MediaError(code, message)`, or any `Error` whose `.code` is one of the codes
above. It also omits `estimate` — the runner prices requests from `meta`'s `price` tables.

## 2. Steps

1. **Read the docs.** Decide which capabilities the service covers; the auth scheme; the submit / poll / result
   endpoints; how local files get in (multipart, a storage upload, base64, public URL only); per model the
   resolutions, durations, aspects, frame / reference limits and prices (with the price page's date). Use
   WebFetch / WebSearch on the docs; an OpenAPI file is the most reliable source (`curl -s <spec> -o <dir>/openapi.json`
   into its own empty directory, then `jq '.paths | keys[]'`).
2. **Write** `~/.tapvid-video/providers/<name>.mjs` from `_template.mjs` (never inside the plugin — updates
   replace it). A file of the same name as a built-in replaces the built-in.
3. **Fixtures**: `~/.tapvid-video/providers/__fixtures__/<name>/<case>.json`, from the docs' request and
   response examples — one per capability, plus an error case. Copy the sample files once:
   `cp -R "$SKILL_ROOT/scripts/providers/__fixtures__/_assets" ~/.tapvid-video/providers/__fixtures__/`. Format (top of
   `scripts/lib/media/replay.mjs`):

   ```json
   { "capability": "video.generate",
     "request": { "params": { "prompt": "…", "aspect": "16:9", "duration_s": 5, "first_frame": "_assets/tiny.png" }, "model": "x-1" },
     "secrets": { "EXAMPLE_API_KEY": "k" },
     "exchanges": [
       { "request": { "method": "POST", "url": "https://api.example.com/v1/videos", "bodyIncludes": { "duration": 5 },
                      "headers": { "authorization": "Bearer k" } },
         "response": { "status": 200, "json": { "id": "job-1" } } },
       { "request": { "method": "GET", "url": "^https://api.example.com/v1/videos/job-1" },
         "response": { "json": { "status": "succeeded", "video_url": "https://cdn.example.com/a.mp4" } } },
       { "request": { "method": "GET", "url": "https://cdn.example.com/a.mp4" },
         "response": { "headers": { "content-type": "video/mp4" }, "file": "_assets/tiny.mp4" } } ],
     "expect": { "status": "completed", "files": [{ "mime": "video/mp4" }] } }
   ```

   Exchanges are consumed in order; `url` is exact or a `^regex`; `headers` values exact or `^regex`;
   `bodyIncludes` is a subset match (FormData fields show as strings, files as `<file mime>`); responses take
   `json`, `text`, `base64` or `file`. Secrets default to `test-<NAME>`. `expect` is
   `{ status: 'completed', files?, items?: n }` or `{ status: 'failed', error: '<code>' }`; every exchange must
   be used on a completed case.
4. **Check offline**: `node "$SKILL_ROOT/scripts/media.mjs" check <name>` — fix until every case passes.
5. **Key**: `node "$SKILL_ROOT/scripts/set-key.mjs" <name>` (the user pastes into the box; `verify` runs).
6. **Live check**: tell the user what one minimal real call per capability costs (from `meta` prices, and the
   service's price page), and with their yes run `node "$SKILL_ROOT/scripts/media.mjs" check <name> --live`. Fix the
   mapping from what the real responses show, and update the fixtures to match them.
7. **Routing**: put it first for the capabilities the user wants it for, in `~/.tapvid-video/config.json`:
   `{ "routing": { "video.search": ["tikhub"] } }` (merge into existing keys); set `models` there to pick a
   default model per capability. Then `media.mjs providers --json` shows it ready.

Tell the user in plain words what was connected and what it will be used for; never show the code.

## 3. Mapping checklist

- Aspect: the vendor's names (`16:9`, `landscape`, `1280x720`) from `resolved_params.aspect`; `crop: true`
  means the runner will crop after generation — send the fitted aspect.
- Duration and resolution: send `resolved_params.duration` / `resolution` exactly, in the vendor's units.
- Local files: `ctx.upload(file, async (abs) => …)` returning the vendor's file id or URL, cached; base64 only
  when the vendor documents it, and check its body-size limit.
- Reference videos longer than the model accepts: `ctx.trim(file, { maxS: resolved_params.refVideoMaxS })`.
- Images in `refs[]` carry a `role` (`composition`, `subject`, `style`); map to the vendor's roles where it has
  them and keep the order (prompts say "image 1", "image 2").
- `audio: false` on video means no model-made sound; a model that always adds sound is fine (the render
  ignores it), one that cannot be silenced is noted in `meta` comments.
- Async: return the job id at once; poll maps the vendor's states to `running` / `completed` / `failed`; a
  failed job's message decides the code (moderation wording → `moderation`).
- Price constants come from the vendor's price page, with the date in a comment.

## 4. Search and download providers

- `video.search` results: `{ id, provider, title, url, download_url, thumbnail_url, duration_s, width, height,
  views, published_at, channel, license, attribution }`, `null` where the platform has no value; at most
  `limit` items (≤ 20). `sort`: `views` / `recent` / `relevance`; `duration`: `short` (< 4 min) / `medium`
  (4–20) / `long`; `orientation`; `published_after` (ISO date). A filter the API lacks may be applied to the
  results after the call (orientation from width / height) instead of failing.
- `video.download`: `{ url }` → two files: the mp4 and `<out>.json` info (`title`, `author`, `duration_s`,
  `url`). Fetch the platform's watermark-free play address when the API offers one; send the headers the CDN
  needs (`Referer`, `User-Agent`).
- Only what the user picked is downloaded; licensing and platform terms are the user's to respect — say so
  when the video is someone else's.

## 5. Worked example: TikHub for Douyin and TikTok

TikHub (`https://api.tikhub.io`, Bearer key) wraps Douyin and TikTok. One provider, two models — `douyin`
(default) and `tiktok` — so `config.json` `models: { "video.search": { "tikhub": "tiktok" } }` or a request's
`model` picks the platform; downloads pick it from the link's host.

`~/.tapvid-video/providers/tikhub.mjs`:

```js
// TikHub (https://api.tikhub.io, docs https://api.tikhub.io/docs): Douyin / TikTok search and download.
// Endpoints and fields from the TikHub OpenAPI spec (api.tikhub.io/openapi.json), 2026-10-27.

const BASE = 'https://api.tikhub.io';
// Per-request prices from TikHub's endpoint price list, 2026-10-27; confirm with
// GET /api/v1/tikhub/user/calculate_price before relying on them.
const PRICE = { search: 0.01, detail: 0.001 };
const DEFAULT_LIMIT = 10;

export const meta = {
  name: 'tikhub',
  displayName: 'TikHub',
  docs: 'https://api.tikhub.io/docs',
  secrets: ['TIKHUB_API_KEY'],
  concurrency: 3,
  capabilities: {
    'video.search': { models: [{ id: 'douyin', default: true, price: { usdPerRequest: PRICE.search } }, { id: 'tiktok', price: { usdPerRequest: PRICE.search } }] },
    'video.download': { models: [{ id: 'auto', default: true, price: { usdPerRequest: PRICE.detail } }] },
  },
  liveSamples: { 'video.download': { url: 'https://www.tiktok.com/@tiktok/video/7106594312292453675' } },
};

const auth = (ctx) => ({ authorization: `Bearer ${ctx.secret('TIKHUB_API_KEY')}` });
const first = (list) => (Array.isArray(list) && list.length ? list[0] : null);

async function call(ctx, path, { query, body } = {}) {
  const url = `${BASE}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const res = await ctx.json(url, { headers: auth(ctx), body });
  // TikHub wraps every answer as { code, message, data }; a non-200 code inside a 200 is an error.
  if (res.code !== undefined && res.code !== 200) {
    const code = /balance|credit|quota/i.test(res.message || '') ? 'quota' : 'invalid';
    throw new ctx.MediaError(code, `tikhub ${path}: ${res.message || res.code}`, res);
  }
  return res.data ?? {};
}

export async function verify(ctx) {
  await call(ctx, '/api/v1/tikhub/user/get_user_info');
}

export async function account(ctx) {
  const d = await call(ctx, '/api/v1/tikhub/user/get_user_info');
  // Check the balance field name against the current get_user_info response.
  return { usd: Number(d.user_data?.balance ?? d.balance ?? NaN) };
}

const daysSince = (iso) => (Date.now() - Date.parse(iso)) / 86_400_000;
// Douyin's publish_time buckets: 1, 7, 180 days; TikTok's: 1, 7, 30, 90, 180.
const bucket = (iso, steps) => (iso ? String(steps.find((d) => daysSince(iso) <= d) ?? 0) : '0');

function toItem(a, platform) {
  const v = a.video || {};
  const author = a.author || {};
  const url = platform === 'douyin'
    ? a.share_url || `https://www.douyin.com/video/${a.aweme_id}`
    : `https://www.tiktok.com/@${author.unique_id}/video/${a.aweme_id}`;
  return {
    id: String(a.aweme_id), provider: 'tikhub', title: a.desc || null, url, download_url: null,
    thumbnail_url: first(v.cover?.url_list), duration_s: v.duration ? v.duration / 1000 : null,
    width: v.width ?? null, height: v.height ?? null, views: a.statistics?.play_count || null,
    published_at: a.create_time ? new Date(a.create_time * 1000).toISOString() : null,
    channel: author.nickname || null, license: null, attribution: null,
  };
}

const orientationOf = (i) => (!i.width || !i.height ? null : i.width > i.height ? 'landscape' : i.width < i.height ? 'portrait' : 'square');

async function search(req, ctx) {
  const p = req.params;
  const platform = req.resolved_params?.model || 'douyin';
  let awemes;
  if (platform === 'douyin') {
    const data = await call(ctx, '/api/v1/douyin/search/fetch_video_search_v2', { body: {
      keyword: p.query, cursor: 0, search_id: '', backtrace: '', content_type: '1',
      sort_type: { views: '1', recent: '2', relevance: '0' }[p.sort || 'relevance'], // "1" = most likes, the closest to views
      publish_time: bucket(p.published_after, [1, 7, 180]),
      filter_duration: { short: '0-1', medium: '1-5', long: '5-10000' }[p.duration] || '0',
    } });
    // Check the nesting against a live response: business_data[].data.aweme_info.
    awemes = (data.business_data || data.data?.business_data || []).map((b) => b.data?.aweme_info).filter(Boolean);
  } else {
    if (p.sort === 'recent') throw new ctx.MediaError('unsupported', 'TikTok search sorts by relevance or likes only');
    const data = await call(ctx, '/api/v1/tiktok/app/v3/fetch_video_search_result', { query: {
      keyword: p.query, offset: '0', count: String(Math.min(20, p.limit || DEFAULT_LIMIT)),
      sort_type: p.sort === 'views' ? '1' : '0', publish_time: bucket(p.published_after, [1, 7, 30, 90, 180]), region: 'US',
    } });
    // Check the list name against a live response: search_item_list[].aweme_info.
    awemes = (data.search_item_list || data.data || []).map((x) => x.aweme_info || x).filter((a) => a?.aweme_id);
  }
  const items = awemes.map((a) => toItem(a, platform))
    .filter((i) => !p.orientation || orientationOf(i) === p.orientation)
    .slice(0, p.limit || DEFAULT_LIMIT);
  return { result: { items } }; // cost: the runner estimates it from meta's usdPerRequest
}

const platformOf = (url) => (/douyin\.com|iesdouyin\.com/.test(url) ? 'douyin' : /tiktok\.com/.test(url) ? 'tiktok' : null);

async function download(req, ctx) {
  const platform = platformOf(req.params.url);
  if (!platform) throw new ctx.MediaError('unsupported', 'not a Douyin or TikTok link');
  const path = platform === 'douyin' ? '/api/v1/douyin/app/v3/fetch_one_video_by_share_url' : '/api/v1/tiktok/app/v3/fetch_one_video_by_share_url';
  const data = await call(ctx, path, { query: { share_url: req.params.url } });
  const a = data.aweme_detail || first(data.aweme_details); // check against a live response
  if (!a) throw new ctx.MediaError('invalid', `video unavailable (filter reason ${data.filter_list?.[0]?.reason ?? 'unknown'})`);
  const best = [...(a.video?.bit_rate || [])].sort((x, y) => (y.bit_rate || 0) - (x.bit_rate || 0))[0];
  const src = first(best?.play_addr?.url_list) || first(a.video?.play_addr?.url_list);
  if (!src) throw new ctx.MediaError('invalid', 'no play address in the response');
  const referer = platform === 'douyin' ? 'https://www.douyin.com/' : 'https://www.tiktok.com/';
  // The CDN serves mp4 without a reliable Content-Type or extension, so write the bytes as .mp4.
  const { buffer } = await ctx.bytes(src, { headers: { referer, 'user-agent': 'Mozilla/5.0' }, timeoutMs: 600_000 });
  const file = ctx.writeOut(req.out, buffer, 'mp4');
  const item = toItem(a, platform);
  const info = { title: item.title, author: item.channel, duration_s: item.duration_s, url: req.params.url };
  const infoFile = ctx.writeOut(req.out, Buffer.from(JSON.stringify(info, null, 2)), 'json');
  return { result: { files: [{ path: file, mime: 'video/mp4' }, { path: infoFile, mime: 'application/json' }] } };
}

export async function submit(capability, req, ctx) {
  if (capability === 'video.search') return search(req, ctx);
  if (capability === 'video.download') return download(req, ctx);
  throw new ctx.MediaError('unsupported', `${capability} is not implemented`);
}
```

Fixture `~/.tapvid-video/providers/__fixtures__/tikhub/douyin-search.json`:

```json
{ "capability": "video.search",
  "request": { "params": { "query": "SaaS launch", "sort": "views", "limit": 1 }, "model": "douyin" },
  "exchanges": [
    { "request": { "method": "POST", "url": "https://api.tikhub.io/api/v1/douyin/search/fetch_video_search_v2",
                   "headers": { "authorization": "Bearer test-TIKHUB_API_KEY" },
                   "bodyIncludes": { "keyword": "SaaS launch", "sort_type": "1", "content_type": "1" } },
      "response": { "json": { "code": 200, "data": { "business_data": [ { "type": 1, "data": { "aweme_info": {
        "aweme_id": "7400000000000000001", "desc": "New feature launch", "create_time": 1767225600,
        "author": { "nickname": "Acme" }, "statistics": { "play_count": 120000 },
        "video": { "duration": 31000, "width": 1080, "height": 1920, "cover": { "url_list": ["https://p.example/c.jpg"] } } } } } ] } } } } ],
  "expect": { "status": "completed", "items": 1 } }
```

Fixture `…/tikhub/download.json`:

```json
{ "capability": "video.download",
  "request": { "params": { "url": "https://www.tiktok.com/@acme/video/7300000000000000002" } },
  "exchanges": [
    { "request": { "method": "GET", "url": "^https://api.tikhub.io/api/v1/tiktok/app/v3/fetch_one_video_by_share_url\\?share_url=" },
      "response": { "json": { "code": 200, "data": { "aweme_detail": { "aweme_id": "7300000000000000002", "desc": "Launch",
        "author": { "nickname": "Acme", "unique_id": "acme" },
        "video": { "duration": 12000, "play_addr": { "url_list": ["https://v.example/a.mp4"] } } } } } } },
    { "request": { "method": "GET", "url": "https://v.example/a.mp4" },
      "response": { "headers": { "content-type": "video/mp4" }, "file": "_assets/tiny.mp4" } } ],
  "expect": { "status": "completed", "files": [{ "mime": "video/mp4" }, { "mime": "application/json" }] } }
```

Plus `auth-error.json`: the search exchange answering `{ "status": 401, "json": { "detail": "Invalid token" } }`
with `"expect": { "status": "failed", "error": "auth" }`.

Then `media.mjs check tikhub`, `set-key.mjs tikhub`, the live check after stating its cost (about $0.01 for one
search and $0.001 for one download on TikHub's list), and `config.json`:

```json
{ "routing": { "video.search": ["tikhub", "youtube"], "video.download": ["tikhub", "ytdlp"] } }
```

Lines marked "check against a live response" are where TikHub's response nesting is documented loosely; the
live check settles them — fix the path and the fixture together.
