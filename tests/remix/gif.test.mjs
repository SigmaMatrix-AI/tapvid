// GIF slots: the giphy provider (verify, schema-valid items, routing past the stock providers)
// and gif.mjs search / pick on a replica, offline (replayed search, local fake downloads).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../skills/remix/scripts/lib/common.mjs';
import { check } from '../../skills/remix/scripts/lib/schema.mjs';
import { createCtx } from '../../skills/remix/scripts/lib/media/ctx.mjs';
import { createReplayFetch } from '../../skills/remix/scripts/lib/media/replay.mjs';
import { createRunner } from '../../skills/remix/scripts/lib/media/runner.mjs';
import { BUILTIN_DIR } from '../../skills/remix/scripts/lib/media/registry.mjs';
import * as giphy from '../../skills/remix/scripts/providers/giphy.mjs';
import * as pexels from '../../skills/remix/scripts/providers/pexels.mjs';
import * as pixabay from '../../skills/remix/scripts/providers/pixabay.mjs';
import { pickGif, searchGifs } from '../../skills/remix/scripts/gif.mjs';
import { clip, makeClone, makeReplica } from './render-helpers.mjs';

const FIXTURES = join(BUILTIN_DIR, '__fixtures__');
const SEARCH = JSON.parse(readFileSync(join(FIXTURES, 'giphy', 'search.json'), 'utf-8'));
const secrets = { secret: (n) => `test-${n}`, configured: () => true };
const registry = new Map([pexels, pixabay, giphy].map((p) => [p.meta.name, p]));
const silent = () => {};

test('giphy verify runs one cheap search and maps a bad key to auth', async () => {
  const ok = createReplayFetch([{ request: { method: 'GET', url: '^https://api\\.giphy\\.com/v1/gifs/search\\?api_key=test-GIPHY_API_KEY&q=ok&limit=1&' }, response: { json: { data: [] } } }]);
  await giphy.verify(createCtx({ provider: 'giphy', secrets, fetchImpl: ok.fetchImpl }));
  assert.equal(ok.remaining(), 0);
  const bad = createReplayFetch([{ request: { method: 'GET', url: '^https://api\\.giphy\\.com/' }, response: { status: 403, json: { message: 'Invalid authentication credentials' } } }]);
  await assert.rejects(giphy.verify(createCtx({ provider: 'giphy', secrets, fetchImpl: bad.fetchImpl })), (e) => e.code === 'auth');
});

test('an animated image.search skips the stock providers and returns schema-valid giphy items', async () => {
  const { fetchImpl, remaining } = createReplayFetch(SEARCH.exchanges, FIXTURES);
  const runner = createRunner({ registry, secrets, fetchImpl, sleep: async () => {} });
  const planDir = join(makeClone(), 'plan');
  const [r] = await runner.runPlan([{ id: 'g1', capability: 'image.search', params: SEARCH.request.params }], { planDir });
  assert.equal(r.status, 'completed', JSON.stringify(r.error));
  assert.equal(r.provider, 'giphy');
  assert.equal(remaining(), 0);
  assert.deepEqual(check('capabilities/image.search', { items: r.items }, 'result'), []);
  assert.deepEqual(r.items[0], {
    id: '26ufdipQqU2lhNA4g', url: 'https://giphy.com/gifs/mind-blown-26ufdipQqU2lhNA4g',
    download_url: 'https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif', width: 480, height: 270,
    title: 'Mind Blown GIF by Reactions', author: 'Reactions',
    video: 'https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.mp4',
    preview_video: 'https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy-preview.mp4',
    duration_s: null, license: 'GIPHY Terms of Service', attribution: 'GIF by Reactions via GIPHY',
  });
  const tasks = readJson(join(planDir, 'tasks.json'));
  assert.deepEqual(tasks.tasks.g1.tried.map((t) => [t.provider, t.error.code]), [['pexels', 'unsupported'], ['pixabay', 'unsupported']]);
});

// Every remote mp4 is a small local test clip; the full-size one has odd dimensions.
function fakeDownloads(dir) {
  const preview = join(dir, 'preview.mp4');
  const full = join(dir, 'full.mp4');
  clip(preview, 1, '160x90');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=241x135:rate=10:duration=1', '-f', 'lavfi', '-i', 'sine=duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-c:a', 'aac', '-shortest', full]);
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(String(url));
    if (String(url).includes('tall1')) return new Response('gone', { status: 404 });
    return new Response(readFileSync(String(url).endsWith('giphy.mp4') ? full : preview));
  };
  return { fetchImpl, fetched };
}

const streams = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt', '-of', 'json', file], { encoding: 'utf-8' })).streams;

test('gif.mjs search writes candidates and a contact sheet; pick sets a looping user file with credit', async () => {
  const dir = makeReplica(makeClone());
  const { fetchImpl, fetched } = fakeDownloads(dir);
  // Without orientation both results come back; the second one's preview fails to download and is dropped.
  const exchanges = [{ ...SEARCH.exchanges[0], request: { method: 'GET', url: '^https://api\\.giphy\\.com/v1/gifs/search\\?api_key=test-GIPHY_API_KEY&q=mind\\+blown&limit=8&' } }];
  const replay = createReplayFetch(exchanges, FIXTURES);
  const runner = createRunner({ registry, secrets, fetchImpl: replay.fetchImpl, sleep: async () => {} });
  const lines = [];
  const slot = '01-Title01.cover';
  const { sheet, items } = await searchGifs(dir, { slot, query: 'mind blown', runner, registry, fetchImpl, log: (l) => lines.push(l) });

  assert.equal(items.length, 1);
  assert.equal(sheet, join(dir, 'assets', 'gif', slot, 'sheet.png'));
  assert.deepEqual(streams(sheet).map((s) => [s.width, s.height]), [[1024, 192]]);
  assert.ok(existsSync(join(dir, 'assets', 'gif', slot, 'cand-1.mp4')));
  assert.equal(existsSync(join(dir, 'assets', 'gif', slot, 'cand-2.mp4')), false);
  assert.match(lines.find((l) => l.startsWith('1:')), /^1: Mind Blown GIF by Reactions \(480×270, 1\.0s\)$/);
  const list = readJson(join(dir, 'assets', 'gif', slot, 'candidates.json'));
  assert.deepEqual([list.n, list.request, list.provider, list.via], [1, 'demo-gif-01-Title01.cover-1', 'giphy', 'GIPHY']);
  assert.equal(readJson(join(dir, 'tasks.json')).tasks['demo-gif-01-Title01.cover-1'].status, 'completed');

  await pickGif(dir, { slot, n: 1, fetchImpl, log: silent });
  assert.equal(fetched.at(-1), 'https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.mp4');
  const out = join(dir, 'assets', 'gif', `${slot}.mp4`);
  const s = streams(out);
  assert.deepEqual(s.map((x) => [x.codec_type, x.codec_name, x.width, x.height, x.pix_fmt]), [['video', 'h264', 240, 134, 'yuv420p']]);
  const replica = readJson(join(dir, 'replica.json'));
  assert.deepEqual(replica.scenes[0].media.cover, {
    source: 'user', kind: 'video', file: 'assets/gif/01-Title01.cover.mp4', loop: true,
    credit: { title: 'Mind Blown GIF by Reactions', url: 'https://giphy.com/gifs/mind-blown-26ufdipQqU2lhNA4g', author: 'Reactions', via: 'GIPHY' },
  });
  assert.equal(replica.scenes[1].board, 'Points02');
});

test('gif.mjs rejects unknown slots and candidates', async () => {
  const dir = makeReplica(makeClone());
  const runner = { runPlan: async () => assert.fail('no search for a bad slot') };
  await assert.rejects(searchGifs(dir, { slot: 'cover', query: 'x', runner, log: silent }), /<sceneKey>\.<fieldPath>/);
  await assert.rejects(searchGifs(dir, { slot: '09-Nope.cover', query: 'x', runner, log: silent }), /no scene 09-Nope/);
  await assert.rejects(searchGifs(dir, { slot: '02-Points02.heading', query: 'x', runner, log: silent }), /no image or video field heading/);
  await assert.rejects(pickGif(dir, { slot: '01-Title01.cover', n: 1, log: silent }), /run gif\.mjs search first/);
});
