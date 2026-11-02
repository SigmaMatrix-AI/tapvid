import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner, dependenciesOf, paramsHash, spendFromTasks } from '../../skills/remix/scripts/lib/media/runner.mjs';
import { adaptToModel, estimateFromMeta, pickModel } from '../../skills/remix/scripts/lib/media/adapt.mjs';
import { providerOrder, route } from '../../skills/remix/scripts/lib/media/router.mjs';
import { MediaError, codeForStatus } from '../../skills/remix/scripts/lib/media/errors.mjs';
import { replayCase } from '../../skills/remix/scripts/lib/media/replay.mjs';
import { createCtx } from '../../skills/remix/scripts/lib/media/ctx.mjs';
import { idempotencyKey } from '../../skills/remix/scripts/providers/tapvid.mjs';
import { buildPlan, fieldPaths, requestId } from '../../skills/remix/scripts/lib/media/plan.mjs';
import { check, validate } from '../../skills/remix/scripts/lib/schema.mjs';
import { spawnSync } from 'node:child_process';

const tmp = () => mkdtempSync(join(tmpdir(), 'tapvid-test-'));

const VIDEO_MODEL = {
  id: 'v1', default: true, aspects: ['16:9', '9:16'], durations: [5, 10],
  resolutions: [{ name: '720p', shortEdge: 720 }, { name: '1080p', shortEdge: 1080 }],
  firstFrame: true, maxRefs: 2, maxRefVideos: 0, price: { usdPerSecond: { '720p': 0.1, '1080p': 0.2 } },
};

// A scripted fake provider: behaviours[i] decides call i ('ok' | 'job' | MediaError code).
function fakeProvider(name, { caps = ['video.generate', 'image.generate'], behaviours = [], models, concurrency = 4, items } = {}) {
  const calls = { submit: 0, poll: 0 };
  const capabilities = Object.fromEntries(caps.map((c) => [c, { models: models?.[c] || (c === 'video.generate' ? [VIDEO_MODEL] : [{ id: `${name}-${c}`, default: true, maxRefs: 4, price: { usdPerImage: 0.04 } }]) }]));
  return {
    calls,
    meta: { name, secrets: [`${name.toUpperCase()}_KEY`], concurrency, capabilities },
    async submit(cap, req, ctx) {
      const b = behaviours[calls.submit++] ?? 'ok';
      if (b instanceof Error) throw b;
      if (typeof b === 'string' && b !== 'ok' && b !== 'job') throw new MediaError(b, `${name} ${b}`);
      if (items) return { result: { items } };
      if (b === 'job') return { jobId: `${name}-job-${calls.submit}` };
      return { result: { files: [{ path: ctx.writeOut(req.out, Buffer.from(`${name}:${req.id}`), 'mp4'), mime: 'video/mp4' }] } };
    },
    async poll(cap, jobId, ctx, req) {
      calls.poll++;
      if (calls.poll === 1) return { status: 'running' };
      return { status: 'completed', result: { files: [{ path: ctx.writeOut(req.out, Buffer.from(jobId), 'mp4'), mime: 'video/mp4' }] } };
    },
  };
}

const allConfigured = { secret: () => 'x', configured: () => true };
const registryOf = (...ps) => new Map(ps.map((p) => [p.meta.name, p]));
const videoReq = (id, extra = {}) => ({ id, capability: 'video.generate', params: { prompt: 'p', aspect: '16:9', duration_s: 4, ...extra }, out: `gen/${id}` });
const noSleep = async () => {};

test('adaptToModel fits duration, resolution and aspect', () => {
  const r = adaptToModel('video.generate', { prompt: 'p', aspect: '1:1', duration_s: 6, min_short_edge: 900 }, VIDEO_MODEL);
  assert.equal(r.ok, true);
  assert.deepEqual([r.resolved.duration, r.resolved.resolution, r.resolved.crop], [10, '1080p', true]);
  const low = adaptToModel('video.generate', { prompt: 'p', aspect: '16:9', duration_s: 3, min_short_edge: 2000 }, VIDEO_MODEL);
  assert.equal(low.resolved.lowRes, true);
  assert.equal(adaptToModel('video.generate', { prompt: 'p', aspect: '16:9', duration_s: 11 }, VIDEO_MODEL).ok, false);
  const range = adaptToModel('video.generate', { prompt: 'p', aspect: '16:9', duration_s: 4.2 }, { id: 'r', duration: { min: 4, max: 15 } });
  assert.equal(range.resolved.duration, 5);
});

test('adaptToModel rejects reference videos, first frames and too many refs', () => {
  assert.equal(adaptToModel('video.generate', { prompt: 'p', aspect: '16:9', duration_s: 5, ref_videos: [{ file: 'a', role: 'motion' }] }, VIDEO_MODEL).ok, false);
  assert.equal(adaptToModel('video.generate', { prompt: 'p', aspect: '16:9', duration_s: 5, last_frame: 'a' }, VIDEO_MODEL).ok, false);
  assert.equal(adaptToModel('image.generate', { prompt: 'p', aspect: '1:1', refs: [{}, {}, {}] }, { id: 'i', maxRefs: 2 }).ok, false);
  assert.equal(adaptToModel('avatar.generate', { mode: 'audio', aspect: '9:16' }, { id: 'a', modes: ['tts'] }).ok, false);
});

test('pickModel prefers the configured model and falls through to one that fits', () => {
  const p = fakeProvider('p', { models: { 'video.generate': [VIDEO_MODEL, { id: 'ref', maxRefVideos: 1, duration: { min: 1, max: 20 } }] } });
  const fit = pickModel('video.generate', { prompt: 'p', aspect: '16:9', duration_s: 4, ref_videos: [{ file: 'a', role: 'motion' }] }, p);
  assert.equal(fit.resolved.model, 'ref');
});

test('providerOrder puts tapvid first and appends custom providers', () => {
  const custom = { ...fakeProvider('mine'), custom: true };
  const reg = registryOf(fakeProvider('fal'), fakeProvider('tapvid'), custom);
  assert.deepEqual(providerOrder('video.generate', reg, {}), ['tapvid', 'fal', 'mine']);
  assert.deepEqual(providerOrder('video.generate', reg, { routing: { 'video.generate': ['fal'] } }), ['fal', 'tapvid', 'mine']);
  const transcribers = new Map(['elevenlabs', 'whisper-local', 'openai'].map((name) => [name, { meta: { name, capabilities: { 'speech.transcribe': {} } } }]));
  assert.deepEqual(providerOrder('speech.transcribe', transcribers, {}), ['whisper-local', 'elevenlabs', 'openai']);
});

test('route skips unconfigured providers and explains why', () => {
  const reg = registryOf(fakeProvider('tapvid'), fakeProvider('fal'));
  const { candidates, skipped } = route(videoReq('a'), { registry: reg, isAvailable: (p) => p.meta.name === 'fal' });
  assert.deepEqual(candidates.map((c) => c.provider), ['fal']);
  assert.equal(skipped[0].reason, 'not configured');
});

test('runPlan handles sync results and async jobs, writing the ledger', async () => {
  const dir = tmp();
  const p = fakeProvider('fal', { behaviours: ['ok', 'job'] });
  const runner = createRunner({ registry: registryOf(p), secrets: allConfigured, sleep: noSleep });
  const res = await runner.runPlan([videoReq('a'), videoReq('b')], { planDir: dir });
  assert.deepEqual(res.map((r) => r.status), ['completed', 'completed']);
  assert.equal(res[0].files[0].path, 'gen/a.mp4');
  assert.equal(res[0].cost.estimated, true);
  const ledger = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf-8'));
  assert.equal(ledger.tasks.b.jobId, 'fal-job-2');
  assert.equal(ledger.tasks.b.status, 'completed');
});

test('a re-run skips completed requests and resubmits changed ones', async () => {
  const dir = tmp();
  const p = fakeProvider('fal');
  const runner = createRunner({ registry: registryOf(p), secrets: allConfigured, sleep: noSleep });
  await runner.runPlan([videoReq('a')], { planDir: dir });
  await runner.runPlan([videoReq('a')], { planDir: dir });
  assert.equal(p.calls.submit, 1);
  await runner.runPlan([videoReq('a', { prompt: 'changed' })], { planDir: dir });
  assert.equal(p.calls.submit, 2);
});

test('an interrupted job is polled again, not resubmitted', async () => {
  const dir = tmp();
  const req = videoReq('a');
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 1, tasks: { a: { id: 'a', hash: paramsHash(req), status: 'submitted', provider: 'fal', jobId: 'old-job' } } }));
  const p = fakeProvider('fal');
  const runner = createRunner({ registry: registryOf(p), secrets: allConfigured, sleep: noSleep });
  const [r] = await runner.runPlan([req], { planDir: dir });
  assert.equal(r.status, 'completed');
  assert.equal(p.calls.submit, 0);
  assert.equal(readFileSync(join(dir, 'gen/a.mp4'), 'utf-8'), 'old-job');
});

test('a dropped connection while polling or downloading keeps the job: polled again, never resubmitted', async () => {
  const dir = tmp();
  const p = fakeProvider('tapvid', { behaviours: ['job'] });
  const poll = p.poll;
  let drops = 2;
  p.poll = async (...a) => { if (drops-- > 0) throw new MediaError('transient', 'terminated'); return poll(...a); };
  const runner = createRunner({ registry: registryOf(p), secrets: allConfigured, sleep: noSleep });
  const [r] = await runner.runPlan([videoReq('d')], { planDir: dir });
  assert.equal(r.status, 'completed');
  assert.equal(p.calls.submit, 1);
  assert.equal(readFileSync(join(dir, 'gen/d.mp4'), 'utf-8'), 'tapvid-job-1');
});

test('a job the provider reports failed is dropped and resubmitted', async () => {
  const dir = tmp();
  const p = fakeProvider('tapvid', { behaviours: ['job', 'job'] });
  let failed = false;
  const poll = p.poll;
  p.poll = async (...a) => { if (!failed) { failed = true; return { status: 'failed', error: new MediaError('transient', 'boom') }; } return poll(...a); };
  const runner = createRunner({ registry: registryOf(p), secrets: allConfigured, sleep: noSleep });
  const [r] = await runner.runPlan([videoReq('f')], { planDir: dir });
  assert.equal(r.status, 'completed');
  assert.equal(p.calls.submit, 2);
});

test('the TapVid idempotency key repeats for a retried request, never across projects or changed parameters', () => {
  const req = { id: 'film-01-Hook01-presenter', out: '/a/clone-x/replicas/film/assets/gen/01-Hook01.presenter' };
  const fields = { script: 'Hello', voiceId: 'v1' };
  const key = idempotencyKey(req, fields);
  assert.match(key, /^film-01-Hook01-presenter-[0-9a-f]{16}$/);
  assert.equal(idempotencyKey({ ...req }, { ...fields }), key);
  assert.notEqual(idempotencyKey({ ...req, out: '/a/clone-y/replicas/film/assets/gen/01-Hook01.presenter' }, fields), key);
  assert.notEqual(idempotencyKey(req, { ...fields, script: 'Hi' }), key);
  assert.ok(idempotencyKey({ ...req, id: 'x'.repeat(80) }, fields).length <= 64);
});

test('transient errors retry once, then the next provider takes over', async () => {
  const dir = tmp();
  const a = fakeProvider('tapvid', { behaviours: ['transient', 'transient'] });
  const b = fakeProvider('fal');
  const runner = createRunner({ registry: registryOf(a, b), secrets: allConfigured, sleep: noSleep });
  const [r] = await runner.runPlan([videoReq('x')], { planDir: dir });
  assert.equal(a.calls.submit, 2);
  assert.equal(r.provider, 'fal');
});

test('auth disables a provider for the run; moderation stops without fallback', async () => {
  const dir = tmp();
  const a = fakeProvider('tapvid', { behaviours: ['auth'] });
  const b = fakeProvider('fal', { behaviours: ['ok', 'moderation'] });
  const runner = createRunner({ registry: registryOf(a, b), secrets: allConfigured, sleep: noSleep });
  const res = await runner.runPlan([videoReq('x'), { ...videoReq('y'), after: ['x'] }], { planDir: dir });
  assert.equal(a.calls.submit, 1, 'tapvid is not retried after auth');
  assert.equal(res[0].provider, 'fal');
  assert.equal(res[1].status, 'failed');
  assert.equal(res[1].error.code, 'moderation');
  assert.ok(runner.disabled.has('tapvid'));
});

test('unsupported moves on; no provider at all fails with the reasons', async () => {
  const dir = tmp();
  const a = fakeProvider('tapvid', { behaviours: ['unsupported'] });
  const b = fakeProvider('fal');
  const runner = createRunner({ registry: registryOf(a, b), secrets: allConfigured, sleep: noSleep });
  const [r] = await runner.runPlan([videoReq('x')], { planDir: dir });
  assert.equal(r.provider, 'fal');
  const none = createRunner({ registry: registryOf(fakeProvider('fal')), secrets: { secret: () => null, configured: () => false }, sleep: noSleep });
  const [n] = await none.runPlan([videoReq('y')], { planDir: dir });
  assert.equal(n.error.code, 'unsupported');
  assert.match(n.error.message, /not configured/);
});

test('@id references wait for and resolve to the dependency output', async () => {
  const dir = tmp();
  const p = fakeProvider('fal');
  const runner = createRunner({ registry: registryOf(p), secrets: allConfigured, sleep: noSleep });
  const kf = { id: 'kf', capability: 'image.generate', params: { prompt: 'p', aspect: '16:9' }, out: 'gen/kf' };
  const vid = videoReq('v', { first_frame: '@kf' });
  assert.deepEqual(dependenciesOf(vid), ['kf']);
  const res = await runner.runPlan([vid, kf], { planDir: dir });
  assert.deepEqual(res.map((r) => r.status), ['completed', 'completed']);
});

test('a failed dependency fails its dependents without calling them', async () => {
  const dir = tmp();
  const p = fakeProvider('fal', { behaviours: ['invalid'] });
  const runner = createRunner({ registry: registryOf(p), secrets: allConfigured, sleep: noSleep });
  const kf = { id: 'kf', capability: 'image.generate', params: { prompt: 'p', aspect: '16:9' }, out: 'gen/kf' };
  const res = await runner.runPlan([kf, videoReq('v', { first_frame: '@kf' })], { planDir: dir });
  assert.equal(res[1].status, 'failed');
  assert.equal(p.calls.submit, 1);
});

test('runPlan rejects invalid plans', async () => {
  const runner = createRunner({ registry: registryOf(fakeProvider('fal')), secrets: allConfigured, sleep: noSleep });
  await assert.rejects(runner.runPlan([{ id: 'a', capability: 'video.generate', params: { prompt: 'p' } }], { planDir: tmp() }), /aspect/);
  await assert.rejects(runner.runPlan([videoReq('a', { first_frame: '@missing' })], { planDir: tmp() }), /unknown missing/);
});

test('video.search fans out to every provider and merges items', async () => {
  const yt = fakeProvider('youtube', { caps: ['video.search'], items: [{ id: '1', url: 'u1' }], models: { 'video.search': [] } });
  const px = fakeProvider('pexels', { caps: ['video.search'], items: [{ id: '2', url: 'u2' }], models: { 'video.search': [] } });
  const runner = createRunner({ registry: registryOf(yt, px), secrets: allConfigured, sleep: noSleep });
  const [r] = await runner.runPlan([{ id: 's', capability: 'video.search', params: { query: 'q' } }], { planDir: tmp() });
  assert.deepEqual(r.items.map((i) => i.provider).sort(), ['pexels', 'youtube']);
});

test('estimate totals per provider', async () => {
  const runner = createRunner({ registry: registryOf(fakeProvider('fal')), secrets: allConfigured });
  const out = await runner.estimate([videoReq('a', { min_short_edge: 1080 })]);
  assert.equal(out.rows[0].usd, 1); // 5 s × $0.2
  assert.equal(out.totals.fal.usd, 1);
  assert.deepEqual(estimateFromMeta('speech.synthesize', { params: { text: 'abc' } }, { price: { usdPer1kChars: 1 } }), { usd: 0.003, credits: null });
});

test('codeForStatus maps HTTP statuses', () => {
  assert.deepEqual([401, 402, 410, 422, 503].map(codeForStatus), ['auth', 'quota', 'unsupported', 'invalid', 'transient']);
  assert.throws(() => new MediaError('nope', 'x'));
});

test('replayCase drives a provider through recorded exchanges', async () => {
  const fixturesDir = tmp();
  mkdirSync(join(fixturesDir, '_assets'));
  writeFileSync(join(fixturesDir, '_assets', 'f.png'), 'png');
  const provider = {
    meta: { name: 'demo', secrets: ['DEMO_KEY'], capabilities: { 'video.generate': { models: [VIDEO_MODEL] } } },
    async submit(cap, req, ctx) {
      const res = await ctx.json('https://api.demo/v', { headers: { authorization: `Bearer ${ctx.secret('DEMO_KEY')}` }, body: { prompt: req.params.prompt, resolution: req.resolved_params.resolution } });
      return { jobId: res.id };
    },
    async poll(cap, jobId, ctx, req) {
      const res = await ctx.json(`https://api.demo/v/${jobId}`);
      if (res.status !== 'done') return { status: 'running' };
      return { status: 'completed', result: { files: [{ path: await ctx.download(res.url, req.out), mime: 'video/mp4' }] } };
    },
  };
  const fixture = {
    capability: 'video.generate',
    request: { params: { prompt: 'hi', aspect: '16:9', duration_s: 5, first_frame: '_assets/f.png' } },
    exchanges: [
      { request: { method: 'POST', url: 'https://api.demo/v', headers: { authorization: 'Bearer test-DEMO_KEY' }, bodyIncludes: { resolution: '720p' } }, response: { json: { id: 'j1' } } },
      { request: { url: 'https://api.demo/v/j1' }, response: { json: { status: 'queued' } } },
      { request: { url: 'https://api.demo/v/j1' }, response: { json: { status: 'done', url: 'https://cdn.demo/o.mp4' } } },
      { request: { url: '^https://cdn\\.demo/' }, response: { headers: { 'content-type': 'video/mp4' }, text: 'bytes' } },
    ],
    expect: { status: 'completed', files: [{ mime: 'video/mp4' }] },
  };
  const ok = await replayCase(provider, fixture, fixturesDir);
  assert.deepEqual(ok.problems, []);
  const bad = await replayCase(provider, { ...fixture, exchanges: [{ ...fixture.exchanges[0], response: { status: 400, text: 'violates content policy' } }], expect: { status: 'failed', error: 'moderation' } }, fixturesDir);
  assert.deepEqual(bad.problems, []);
});

test('validate covers types, required, enums, refs and arrays', () => {
  const schema = { $defs: { n: { type: 'integer', minimum: 1 } }, type: 'object', required: ['a'], additionalProperties: false,
    properties: { a: { enum: ['x'] }, b: { type: 'array', items: { $ref: '#/$defs/n' }, maxItems: 2 } } };
  assert.deepEqual(validate(schema, { a: 'x', b: [1] }), []);
  const errs = validate(schema, { b: [0, 1, 2], c: 1 });
  assert.equal(errs.length, 4);
});

test('buildPlan turns a replica into requests with keyframe fallback', () => {
  const root = tmp();
  const tpl = join(root, 'template');
  mkdirSync(join(tpl, 'boards'), { recursive: true });
  mkdirSync(join(tpl, 'refs'), { recursive: true });
  writeFileSync(join(tpl, 'template.json'), JSON.stringify({ version: 1, id: 't', title: 't', canvas: { width: 1920, height: 1080 }, fps: 30, category: 'no_avatar', audio: { source_mode: 'narration' }, boards: ['Hook01'] }));
  writeFileSync(join(tpl, 'boards', 'Hook01.json'), JSON.stringify({ schema: { fields: [
    { key: 'cover', type: 'video', desc: 'd', media: { role: 'broll', aspect: '16:9', minWidthPx: 1920 } },
    { key: 'points', type: 'object[]', desc: 'd', fields: [{ key: 'say', type: 'narration', desc: 'd' }] },
  ] }, meta: { minDuration: 1, maxDuration: 10 }, example_data: {}, example_duration_ms: 3000 }));
  writeFileSync(join(tpl, 'refs', 'refs.json'), JSON.stringify({ 'Hook01.cover': { clip: 'Hook01.cover.mp4', frame: 'Hook01.cover.png', window: { start: 0, end: 3 }, describe: 'slow push-in' } }));
  const rep = join(root, 'replicas', 'demo');
  mkdirSync(rep, { recursive: true });
  const replica = {
    version: 1, slug: 'demo', topic: 't', language: 'en', template: '../../template',
    replace: [{ subject: 'presenter', with: { generate: 'a young man in a blue shirt' } }],
    audio: { mode: 'narration', voice: { provider: 'elevenlabs', id: 'v1' } },
    scenes: [{ board: 'Hook01', data: { points: [{ say: 'one' }, { say: 'two' }] }, media: { cover: { kind: 'video', source: 'ai', mode: 'reference', ref: 'Hook01.cover', replace: ['presenter'], prompt: 'a man at a desk' } } }],
  };
  writeFileSync(join(rep, 'replica.json'), JSON.stringify(replica));
  const plan = buildPlan(join(rep, 'replica.json'), { route: (req) => ({ candidates: req.params.ref_videos?.length ? [] : [{}] }) });
  const ids = plan.requests.map((r) => r.id);
  assert.deepEqual(ids, ['demo-replace-presenter', 'demo-01-Hook01-speech-points.0.say', 'demo-01-Hook01-speech-points.1.say', 'demo-01-Hook01-cover-keyframe', 'demo-01-Hook01-cover']);
  const video = plan.requests.at(-1);
  assert.equal(video.params.first_frame, '@demo-01-Hook01-cover-keyframe');
  assert.equal(video.params.duration_s, 3);
  assert.equal(plan.requests[3].params.refs[1].file, '@demo-replace-presenter');
  assert.match(plan.warnings[0], /falling back to keyframe/);
  assert.equal(fieldPaths([{ key: 'a', type: 'narration' }], {}, 'narration')[0].path, 'a');
  assert.ok(requestId('x'.repeat(80)).length <= 64);
  assert.ok(existsSync(join(rep, 'replica.json')));
});

// A one-board template with a presenter slot, two narration lines and two image fields.
function avatarPlanFixture({ resolved } = {}) {
  const root = tmp();
  const tpl = join(root, 'template');
  mkdirSync(join(tpl, 'boards'), { recursive: true });
  mkdirSync(join(tpl, 'refs'), { recursive: true });
  writeFileSync(join(tpl, 'template.json'), JSON.stringify({ version: 1, id: 't', title: 't', canvas: { width: 1920, height: 1080 }, fps: 30, category: 'avatar', audio: { source_mode: 'narration' }, boards: ['Talk01'] }));
  writeFileSync(join(tpl, 'boards', 'Talk01.json'), JSON.stringify({ schema: { fields: [
    { key: 'presenter', type: 'video', desc: 'd', media: { role: 'presenter', aspect: '9:16', minWidthPx: 1215 } },
    { key: 'sticker', type: 'image', desc: 'd', media: { role: 'broll', aspect: '1:1', minWidthPx: 600 } },
    { key: 'shot', type: 'image', desc: 'd', media: { role: 'broll', aspect: '16:9', minWidthPx: 2880 } },
    { key: 'points', type: 'object[]', desc: 'd', fields: [{ key: 'say', type: 'narration', desc: 'd' }] },
  ] }, meta: { minDuration: 1, maxDuration: 20 }, example_data: {}, example_duration_ms: 4000 }));
  writeFileSync(join(tpl, 'refs', 'refs.json'), '{}');
  const rep = join(root, 'replicas', 'demo');
  mkdirSync(rep, { recursive: true });
  const ai = (kind, extra = {}) => ({ kind, source: 'ai', mode: 'text', replace: [], prompt: 'p', ...extra });
  writeFileSync(join(rep, 'replica.json'), JSON.stringify({
    version: 1, slug: 'demo', topic: 't', language: 'en', template: '../../template',
    replace: [{ subject: 'host', with: { file: 'assets/user/me.png' } }],
    audio: { mode: 'narration', voice: { provider: 'tapvid', id: 'v1' } },
    scenes: [{ board: 'Talk01', data: { points: [{ say: 'First line.' }, { say: 'Second line.' }] },
      media: { presenter: ai('avatar', { replace: ['host'] }), sticker: ai('image'), shot: ai('image') } }],
    ...(resolved ? { resolved } : {}),
  }));
  return join(rep, 'replica.json');
}

test('buildPlan: a self-voiced avatar gets no separate narration takes', () => {
  const noLipSync = (req) => ({ candidates: req.capability === 'avatar.generate' && req.params.mode === 'audio' ? [] : [{}] });
  const plan = buildPlan(avatarPlanFixture(), { route: noLipSync });
  assert.equal(plan.requests.filter((r) => r.capability === 'speech.synthesize').length, 0);
  const avatar = plan.requests.find((r) => r.capability === 'avatar.generate');
  assert.equal(avatar.params.mode, 'tts');
  assert.equal(avatar.params.script, 'First line. Second line.');
  assert.ok(plan.warnings.some((w) => /demo-01-Talk01-presenter: the avatar voices the script itself; this scene's timing comes from the avatar's own voice/.test(w)), plan.warnings.join('\n'));
  assert.ok(!plan.warnings.some((w) => /no separate narration take/.test(w)));
});

test('buildPlan: a lip-synced avatar keeps its narration takes and audio mode', () => {
  const plan = buildPlan(avatarPlanFixture(), { route: () => ({ candidates: [{}] }) });
  assert.deepEqual(plan.requests.filter((r) => r.capability === 'speech.synthesize').map((r) => r.id),
    ['demo-01-Talk01-speech-points.0.say', 'demo-01-Talk01-speech-points.1.say']);
  const avatar = plan.requests.find((r) => r.capability === 'avatar.generate');
  assert.deepEqual(avatar.params, { mode: 'audio', audio: '@demo-01-Talk01-speech-points.0.say', portrait: 'assets/user/me.png', aspect: '9:16' });
});

test('buildPlan: small or briefly seen images ask for the economy tier', () => {
  const route = () => ({ candidates: [{}] });
  const tier = (plan, path) => plan.requests.find((r) => r.id === `demo-01-Talk01-${path}`).tier;
  const plan = buildPlan(avatarPlanFixture(), { route });
  assert.equal(tier(plan, 'sticker'), 'economy', '600 px is under half the 1920 canvas ×1.5');
  assert.equal(tier(plan, 'shot'), undefined, 'a full-width image stays on the default tier');
  const brief = buildPlan(avatarPlanFixture({ resolved: { '01-Talk01': { duration: 2.4 } } }), { route });
  assert.equal(tier(brief, 'shot'), 'economy', 'seen for under 3 s');
});

test('economy tier picks the cheapest model that still fits; a pinned model wins', async () => {
  const models = { 'image.generate': [
    { id: 'pro', default: true, maxRefs: 4, resolutions: [{ name: '2K', shortEdge: 1440 }], price: { creditsPerImage: 21 } },
    { id: 'tiny', maxRefs: 0, resolutions: [{ name: '1K', shortEdge: 720 }], price: { creditsPerImage: 2 } },
    { id: 'lite', maxRefs: 1, resolutions: [{ name: '1K', shortEdge: 1080 }], price: { creditsPerImage: 6 } },
  ] };
  const p = fakeProvider('tapvid', { caps: ['image.generate'], models });
  const params = { prompt: 'p', aspect: '1:1', min_short_edge: 1000, refs: [{ file: 'a.png', role: 'subject' }] };
  assert.equal(pickModel('image.generate', params, p).resolved.model, 'pro');
  assert.equal(pickModel('image.generate', params, p, undefined, 'economy').resolved.model, 'lite');
  assert.equal(pickModel('image.generate', { prompt: 'p', aspect: '1:1', min_short_edge: 700 }, p, undefined, 'economy').resolved.model, 'tiny');
  const runner = createRunner({ registry: registryOf(p), secrets: allConfigured });
  const req = { id: 'pop', capability: 'image.generate', tier: 'economy', params, out: 'gen/pop' };
  assert.equal(runner.candidatesFor(req).candidates[0].model, 'lite');
  assert.equal(runner.candidatesFor({ ...req, model: 'pro' }).candidates[0].model, 'pro');
  const est = await runner.estimate([req]);
  assert.equal(est.rows[0].credits, 6);
});

test('the envelope accepts tier economy | standard only', () => {
  const req = { id: 'a', capability: 'image.generate', params: { prompt: 'p', aspect: '1:1' } };
  assert.deepEqual(check('envelope', { ...req, tier: 'economy' }, 'request'), []);
  assert.notDeepEqual(check('envelope', { ...req, tier: 'cheap' }, 'request'), []);
});

test('estimate lists cost per model: unit, unit price, count and subtotal', async () => {
  const img = { id: 'img', default: true, maxRefs: 2, price: { usdPerImage: 0.04 } };
  const runner = createRunner({ registry: registryOf(fakeProvider('fal', { models: { 'image.generate': [img] } })), secrets: allConfigured });
  const imgReq = (id) => ({ id, capability: 'image.generate', params: { prompt: 'p', aspect: '1:1' } });
  const out = await runner.estimate([videoReq('a', { min_short_edge: 1080 }), videoReq('b', { min_short_edge: 1080 }), videoReq('c'), imgReq('i1'), imgReq('i2')]);
  assert.deepEqual(out.byModel, [
    { provider: 'fal', model: 'v1', capability: 'video.generate', unit: 'second', unitPrice: 0.2, resolution: '1080p', count: 10, subtotal: 2, currency: 'usd' },
    { provider: 'fal', model: 'v1', capability: 'video.generate', unit: 'second', unitPrice: 0.1, resolution: '720p', count: 5, subtotal: 0.5, currency: 'usd' },
    { provider: 'fal', model: 'img', capability: 'image.generate', unit: 'image', unitPrice: 0.04, resolution: null, count: 2, subtotal: 0.08, currency: 'usd' },
  ]);
  assert.equal(out.totals.fal.usd, 2.58);
});

test('spendFromTasks aggregates the ledger by model with the recorded cost', () => {
  const ledger = { tasks: {
    a: { id: 'a', capability: 'video.generate', status: 'completed', provider: 'tapvid', model: 'seedance', cost: { credits: 90, usd: null, estimated: false } },
    b: { id: 'b', capability: 'video.generate', status: 'completed', provider: 'tapvid', model: 'seedance', cost: { credits: 40, usd: null, estimated: true } },
    c: { id: 'c', capability: 'image.generate', status: 'completed', provider: 'fal', model: 'img', cost: { usd: 0.04, credits: null } },
    d: { id: 'd', capability: 'image.generate', status: 'failed', provider: 'fal', model: 'img', cost: { usd: 0.04 } },
    s: { id: 's', capability: 'video.search', status: 'completed', provider: 'youtube,pexels', cost: null },
  } };
  const out = spendFromTasks(ledger);
  assert.deepEqual(out.byModel, [
    { provider: 'tapvid', model: 'seedance', capability: 'video.generate', count: 2, subtotal: 130, currency: 'credits', estimated: true },
    { provider: 'fal', model: 'img', capability: 'image.generate', count: 1, subtotal: 0.04, currency: 'usd', estimated: false },
  ]);
  assert.deepEqual(out.totals, { tapvid: { usd: 0, credits: 130 }, fal: { usd: 0.04, credits: 0 } });
});

// A custom provider in a scratch TAPVID_VIDEO_HOME whose submit leaves a marker: proves the CLI
// paths below never generate anything.
function cliHome() {
  const home = tmp();
  mkdirSync(join(home, 'providers'), { recursive: true });
  const marker = join(home, 'submitted');
  writeFileSync(join(home, 'providers', 'fakep.mjs'), `import { writeFileSync } from 'node:fs';
export const meta = { name: 'fakep', displayName: 'Fake P', secrets: ['FAKEP_KEY'], capabilities: {
  'image.generate': { models: [{ id: 'old', default: true, maxRefs: 0, price: { usdPerImage: 0.5 } }] } } };
export async function submit() { writeFileSync(${JSON.stringify(marker)}, 'x'); return { result: { files: [] } }; }
export async function discover() { return { 'image.generate': { models: [{ id: 'new', default: true, maxRefs: 0, price: { usdPerImage: 0.02 } }] } }; }
`);
  return { home, marker };
}
const MEDIA = join(import.meta.dirname, '..', '..', 'skills', 'remix', 'scripts', 'media.mjs');
const media = (home, ...args) => spawnSync(process.execPath, [MEDIA, ...args], { encoding: 'utf-8', env: { ...process.env, TAPVID_VIDEO_HOME: home, FAKEP_KEY: 'k' } });

test('check --live without --spend lists the paid samples and exits 2 without calling', () => {
  const { home, marker } = cliHome();
  const r = media(home, 'check', 'fakep', '--live');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /image\.generate\s+old\s+\$0\.50/);
  assert.match(r.stdout, /costs money/);
  assert.equal(existsSync(marker), false);
});

test('prices refreshes through discover and lists the models without generating', () => {
  const { home, marker } = cliHome();
  const r = media(home, 'prices', 'fakep', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.models.map((m) => [m.capability, m.model, m.text]), [['image.generate', 'new', '$0.02/image']]);
  assert.match(out.source, /model list from Fake P/);
  assert.equal(existsSync(marker), false);
});

test('spend prints the actual cost per model from tasks.json', () => {
  const { home } = cliHome();
  const dir = tmp();
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ tasks: { a: { id: 'a', capability: 'image.generate', status: 'completed', provider: 'fakep', model: 'new', cost: { usd: 0.02 } } } }));
  const r = media(home, 'spend', dir, '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).byModel[0].subtotal, 0.02);
  assert.match(media(home, 'spend', dir).stdout, /total fakep: \$0\.02/);
});

test('an out path that already carries the extension is written as given, never doubled', () => {
  const dir = tmp();
  const ctx = createCtx({ provider: 'demo', secrets: allConfigured, cwd: dir, cacheDir: join(dir, 'cache') });
  assert.equal(ctx.writeOut('gen/clip', Buffer.from('a'), 'mp4'), join(dir, 'gen', 'clip.mp4'));
  assert.equal(ctx.writeOut('gen/out.mp4', Buffer.from('a'), 'mp4'), join(dir, 'gen', 'out.mp4'));
  assert.equal(ctx.writeOut('gen/out.MP4', Buffer.from('a'), 'mp4'), join(dir, 'gen', 'out.MP4'));
  assert.equal(ctx.writeOut('gen/out.png', Buffer.from('a'), 'mp4'), join(dir, 'gen', 'out.png.mp4'));
});

test('buildPlan: a pinned provider and model reach the reference video request; a keyframe fallback is routed afresh', () => {
  const replicaPath = (() => {
    const root = tmp();
    const tpl = join(root, 'template');
    mkdirSync(join(tpl, 'boards'), { recursive: true });
    mkdirSync(join(tpl, 'refs'), { recursive: true });
    writeFileSync(join(tpl, 'template.json'), JSON.stringify({ version: 1, id: 't', title: 't', canvas: { width: 1080, height: 1920 }, fps: 30, category: 'no_avatar', audio: { source_mode: 'music-only' }, boards: ['Shot01'] }));
    writeFileSync(join(tpl, 'boards', 'Shot01.json'), JSON.stringify({ schema: { fields: [{ key: 'footage', type: 'video', desc: 'd', media: { role: 'broll', aspect: '9:16' } }] }, meta: { minDuration: 1, maxDuration: 10 }, example_data: {}, example_duration_ms: 4000 }));
    writeFileSync(join(tpl, 'refs', 'refs.json'), JSON.stringify({ 'Shot01.footage': { clip: 'Shot01.footage.mp4', frame: 'Shot01.footage.png', window: { start: 0, end: 4 } } }));
    const rep = join(root, 'replicas', 'demo');
    mkdirSync(rep, { recursive: true });
    writeFileSync(join(rep, 'replica.json'), JSON.stringify({ version: 1, slug: 'demo', topic: 't', language: 'en', template: '../../template', replace: [], audio: { mode: 'music-only' },
      scenes: [{ board: 'Shot01', data: {}, media: { footage: { kind: 'video', source: 'ai', mode: 'reference', ref: 'Shot01.footage', replace: [], prompt: 'p', provider: 'tapvid', model: 'minimax-h3' } } }] }));
    return join(rep, 'replica.json');
  })();
  const ref = buildPlan(replicaPath, { route: () => ({ candidates: [{}] }) }).requests.at(-1);
  assert.equal(ref.provider, 'tapvid');
  assert.equal(ref.model, 'minimax-h3');
  assert.equal(ref.params.ref_videos.length, 1);
  const kf = buildPlan(replicaPath, { route: (req) => ({ candidates: req.params.ref_videos?.length ? [] : [{}] }) }).requests;
  assert.equal(kf[0].model, undefined);
  assert.equal(kf[1].model, undefined);
});
