#!/usr/bin/env node
// Animated pictures (reaction GIFs) for a replica's image / video slots, from a GIF search
// provider (GIPHY) instead of an AI still.
//   node gif.mjs search <replica> --slot <slot> --query "<English query>" [--limit 8]
//   node gif.mjs pick <replica> --slot <slot> --n <i>
// <slot> is "<sceneKey>.<fieldPath>": the scene key as in assets/gen and tasks.json
// ("03-Popup03", scene number + board) and the media path as in the scene's `media` map
// ("cover", "items.0.pic"), e.g. "03-Popup03.items.0.pic".
// `search` runs one animated image.search through the media runner (ledger in tasks.json),
// downloads each candidate's small preview to assets/gif/<slot>/cand-<i>.mp4, writes the contact
// sheet assets/gif/<slot>/sheet.png (one row of frames per candidate, in legend order) and prints
// the legend. `pick` downloads candidate i at full size to assets/gif/<slot>.mp4 (H.264, no audio)
// and makes it the slot's user file with loop: true and a credit. The render loops it to the scene
// length itself, so the clip is never stretched here.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseArgs, readJson, run, toPosixRel, writeJson } from './lib/common.mjs';
import { loadReplica, mediaPaths, sceneKey } from './lib/replica.mjs';
import { requestId } from './lib/media/plan.mjs';
import { loadRegistry } from './lib/media/registry.mjs';
import { createSecrets } from './lib/media/secrets.mjs';
import { loadConfig } from './lib/media/router.mjs';
import { createRunner } from './lib/media/runner.mjs';

// Eight candidates fill one contact sheet that still reads at a glance.
const DEFAULT_LIMIT = 8;
// Frames per candidate row and the cell they are fitted into (4:3, large enough to read a face).
const FRAMES = 4;
const CELL = { w: 256, h: 192 };
const DOWNLOAD_TIMEOUT_MS = 120_000;

// "<sceneKey>.<fieldPath>" → the scene and the media field it names.
export function resolveSlot(ctx, slot) {
  const dot = String(slot || '').indexOf('.');
  if (dot < 0) throw new Error(`--slot must be <sceneKey>.<fieldPath>, got ${slot}`);
  const key = slot.slice(0, dot);
  const path = slot.slice(dot + 1);
  const index = ctx.replica.scenes.findIndex((s, i) => sceneKey(i, s.board) === key);
  if (index < 0) throw new Error(`no scene ${key} (scene keys: ${ctx.replica.scenes.map((s, i) => sceneKey(i, s.board)).join(', ')})`);
  const scene = ctx.replica.scenes[index];
  const fields = ctx.boards.get(scene.board)?.json.schema?.fields || [];
  const field = mediaPaths(fields, scene.data).find((p) => p.path === path && p.type !== 'element');
  if (!field) throw new Error(`${key} has no image or video field ${path}`);
  return { index, scene, path, type: field.type };
}

const slotDir = (dir, slot) => join(dir, 'assets', 'gif', slot);

async function fetchTo(fetchImpl, url, file) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const probeDuration = (file) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim()) || null;

// One row of FRAMES evenly spaced frames per candidate, stacked in candidate order.
function contactSheet(files, out) {
  const rows = files.map((f, i) => {
    const step = (probeDuration(f) || 1) / FRAMES;
    return `[${i}:v]select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${step.toFixed(3)})',`
      + `scale=${CELL.w}:${CELL.h}:force_original_aspect_ratio=decrease,pad=${CELL.w}:${CELL.h}:(ow-iw)/2:(oh-ih)/2,setsar=1,tile=${FRAMES}x1[r${i}]`;
  });
  const stack = files.length > 1 ? `;${files.map((_, i) => `[r${i}]`).join('')}vstack=inputs=${files.length}[out]` : '';
  const last = files.length > 1 ? '[out]' : '[r0]';
  run('ffmpeg', ['-y', '-v', 'error', ...files.flatMap((f) => ['-i', f]), '-filter_complex', rows.join(';') + stack, '-map', last, '-frames:v', '1', out]);
  return out;
}

export async function searchGifs(dirArg, { slot, query, limit = DEFAULT_LIMIT, runner, registry, fetchImpl = globalThis.fetch, log = console.log }) {
  if (!query) throw new Error('--query is required (English works best)');
  const ctx = loadReplica(dirArg);
  resolveSlot(ctx, slot);
  const outDir = slotDir(ctx.dir, slot);
  const listPath = join(outDir, 'candidates.json');
  const n = (readJson(listPath, { n: 0 }).n || 0) + 1;
  const id = requestId(ctx.replica.slug, 'gif', slot, n);
  const request = { id, capability: 'image.search', params: { query, animated: true, limit }, out: toPosixRel(ctx.dir, join(outDir, 'search')) };
  const [res] = await runner.runPlan([request], { planDir: ctx.dir });
  if (res.status !== 'completed') throw new Error(`search failed: ${res.error?.code} ${res.error?.message}`);

  // A new search replaces the previous candidates, so the sheet never mixes two queries.
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (/^cand-\d+\.mp4$|^sheet\.png$/.test(f)) rmSync(join(outDir, f));
  const items = [];
  for (const item of (res.items || []).slice(0, limit)) {
    const src = item.preview_video || item.video;
    if (!src) continue;
    const file = join(outDir, `cand-${items.length + 1}.mp4`);
    try {
      await fetchTo(fetchImpl, src, file);
    } catch (e) {
      log(`skipped ${item.id}: ${e.message}`);
      continue;
    }
    items.push({ ...item, i: items.length + 1, file: toPosixRel(ctx.dir, file), duration_s: item.duration_s ?? probeDuration(file) });
  }
  if (!items.length) throw new Error(`no animated results for "${query}"`);
  const via = registry?.get(res.provider)?.meta.displayName || res.provider;
  writeJson(listPath, { n, request: id, query, provider: res.provider, via, items });
  const sheet = contactSheet(items.map((it) => join(ctx.dir, ...it.file.split('/'))), join(outDir, 'sheet.png'));
  for (const it of items) {
    const size = it.width && it.height ? `${it.width}×${it.height}` : '?';
    log(`${it.i}: ${it.title || it.id} (${size}, ${it.duration_s ? `${it.duration_s.toFixed(1)}s` : '?'})`);
  }
  log(sheet);
  return { sheet, items };
}

export async function pickGif(dirArg, { slot, n, fetchImpl = globalThis.fetch, log = console.log }) {
  const ctx = loadReplica(dirArg);
  const { index, path, type } = resolveSlot(ctx, slot);
  const list = readJson(join(slotDir(ctx.dir, slot), 'candidates.json'), null);
  if (!list) throw new Error(`no candidates for ${slot}; run gif.mjs search first`);
  const cand = list.items.find((it) => it.i === Number(n));
  if (!cand) throw new Error(`no candidate ${n} for ${slot} (1–${list.items.length})`);
  const src = cand.video || cand.preview_video || cand.download_url;
  const out = join(ctx.dir, 'assets', 'gif', `${slot}.mp4`);
  const tmp = join(slotDir(ctx.dir, slot), 'full.download');
  await fetchTo(fetchImpl, src, tmp);
  try {
    // H.264 / yuv420p with even dimensions plays in every browser; GIFs carry no sound.
    run('ffmpeg', ['-y', '-v', 'error', '-i', tmp, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', out]);
  } finally {
    rmSync(tmp, { force: true });
  }
  const entry = {
    source: 'user',
    // An image field keeps kind image (it plays the mp4 as an animated picture); a video field is video.
    kind: type === 'image' ? 'image' : 'video',
    file: toPosixRel(ctx.dir, out),
    loop: true,
    credit: { title: cand.title ?? null, url: cand.url ?? null, author: cand.author ?? null, via: list.via },
  };
  const replica = {
    ...ctx.replica,
    scenes: ctx.replica.scenes.map((s, i) => (i === index ? { ...s, media: { ...s.media, [path]: entry } } : s)),
  };
  writeJson(ctx.path, replica);
  log(out);
  return { file: out, entry };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  const [cmd, dir] = args._;
  const usage = 'usage: node gif.mjs search <replica> --slot <sceneKey>.<fieldPath> --query "…" [--limit 8]\n'
    + '       node gif.mjs pick <replica> --slot <sceneKey>.<fieldPath> --n <i>';
  if (!dir || typeof args.slot !== 'string' || !['search', 'pick'].includes(cmd)) fail(usage);
  try {
    if (cmd === 'search') {
      const registry = await loadRegistry();
      const runner = createRunner({ registry, secrets: createSecrets(), config: loadConfig(), log: (m) => console.error(m) });
      const limit = args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1) fail(`--limit must be a positive integer, got ${args.limit}`);
      await searchGifs(dir, { slot: args.slot, query: typeof args.query === 'string' ? args.query : '', limit, runner, registry });
    } else {
      await pickGif(dir, { slot: args.slot, n: args.n });
    }
  } catch (e) {
    fail(e.message);
  }
}
