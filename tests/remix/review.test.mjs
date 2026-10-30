import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNTIME, readJson, requireRuntime, writeJson } from '../../skills/remix/scripts/lib/common.mjs';
import { slotRequestId, speechRequestId } from '../../skills/remix/scripts/lib/media/plan.mjs';
import { loadReplica } from '../../skills/remix/scripts/lib/replica.mjs';
import { assetGroups, fidelity, finalCuts, knownLimits, placeSfx, sfxKinds } from '../../skills/remix/scripts/review.mjs';
import { fakeTasks, makeClone, makeReplica, runtimeReady } from './render-helpers.mjs';

const SCRIPTS = join(import.meta.dirname, '..', '..', 'skills', 'remix', 'scripts');
const tmp = () => mkdtempSync(join(tmpdir(), 'tapvid-review-'));
const touch = (file, text = 'x') => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };

test('fidelity summarises compare/report.json; knownLimits reads the report section', () => {
  const dir = tmp();
  writeJson(join(dir, 'compare', 'report.json'), { rows: [{ struct: 0.97 }, { struct: 0.91 }, { struct: 0.99 }, { struct: 0.5, variant: 'b' }] });
  const f = fidelity(dir);
  assert.deepEqual([f.min, f.passed, f.samples], [0.91, 2, 3]);
  assert.ok(Math.abs(f.mean - 0.9567) < 1e-3);
  assert.equal(fidelity(tmp()), null);
  writeFileSync(join(dir, 'report.md'), '# Report\n\n## Boards\n- a\n\n## Known limits\n\n- Hand-held shake in shot 17\n- Font substituted\n\n## Next\n- no\n');
  assert.deepEqual(knownLimits(dir), ['Hand-held shake in shot 17', 'Font substituted']);
  writeFileSync(join(dir, 'report.md'), '# Report\n## Known limits\nShot 3 of the original is hand-held.\n');
  assert.deepEqual(knownLimits(dir), ['Shot 3 of the original is hand-held.']);
  assert.deepEqual(knownLimits(tmp()), []);
});

test('sfx: only kinds the boards trigger are placed into review/sfx', () => {
  const tpl = tmp();
  touch(join(tpl, 'boards', 'A.jsx'), '<div data-sfx="pop" /><span data-sfx=\'whoosh\' />');
  touch(join(tpl, 'boards', 'B.jsx'), '<div data-sfx="pop" />');
  touch(join(tpl, 'boards', 'B.json'), '{"x":"data-sfx=\\"ignored\\""}');
  assert.deepEqual(sfxKinds(tpl), ['pop', 'whoosh']);
  const review = tmp();
  const wav = join(tpl, 'w.wav');
  touch(wav, 'RIFF');
  const notes = [];
  const sfx = placeSfx(tpl, review, notes, (dir, kind) => { if (kind === 'whoosh') throw new Error('unknown'); return wav; });
  assert.deepEqual(sfx, { pop: 'sfx/pop.wav' });
  assert.equal(readFileSync(join(review, 'sfx', 'pop.wav'), 'utf-8'), 'RIFF');
  assert.deepEqual(notes, [{ code: 'sfx', detail: 'whoosh: unknown' }]);
});

test('finalCuts lists every out/*.mp4 with tapvid.mp4 first, only after the render', () => {
  const dir = tmp();
  const review = join(dir, 'review');
  assert.equal(finalCuts(dir, review), null);
  for (const f of ['tapvid-v2.mp4', 'tapvid.mp4', 'alt-music.mp4', 'notes.txt']) touch(join(dir, 'out', f));
  const cuts = finalCuts(dir, review);
  assert.deepEqual(cuts.versions, [
    { label: 'tapvid', path: 'final/tapvid.mp4', current: true },
    { label: 'alt-music', path: 'final/alt-music.mp4', current: false },
    { label: 'tapvid-v2', path: 'final/tapvid-v2.mp4', current: false },
  ]);
  assert.ok(existsSync(join(review, 'final', 'tapvid-v2.mp4')));
});

test('assetGroups labels generated assets by scene and role, with vendor, model and cost', () => {
  const clone = makeClone();
  const dir = makeReplica(clone, { edit: (r) => { r.scenes[1].media = { 'points.0.icon': { kind: 'image', source: 'user', file: 'assets/user/logo.png', visual: 'your logo' } }; } });
  touch(join(dir, 'assets', 'user', 'logo.png'));
  touch(join(dir, 'assets', 'gen', '01-Title01.cover.mp4'));
  touch(join(dir, 'assets', 'audio', '01-Title01.narration.mp3'));
  const cover = slotRequestId('demo', 0, 'Title01', 'cover');
  const speech = speechRequestId('demo', 0, 'Title01', 'narration');
  writeJson(join(dir, 'tasks.json'), { version: 1, tasks: {
    [cover]: { id: cover, capability: 'video.generate', status: 'completed', provider: 'tapvid', model: 'seedance-2.0-fast', cost: { credits: 40, estimated: false },
      result: { files: [{ path: 'assets/gen/01-Title01.cover.mp4', mime: 'video/mp4' }] } },
    [speech]: { id: speech, capability: 'speech.synthesize', status: 'completed', provider: 'elevenlabs', model: 'v3', cost: { usd: 0.012, credits: null, estimated: true },
      result: { files: [{ path: 'assets/audio/01-Title01.narration.mp3', mime: 'audio/mpeg' }] } },
    gone: { id: 'gone', capability: 'image.generate', status: 'failed', result: { files: [{ path: 'missing.png' }] } },
  } });
  const review = join(dir, 'review');
  const groups = assetGroups(loadReplica(dir), review, (p) => ({ tapvid: 'TapVid', elevenlabs: 'ElevenLabs' })[p] || p);
  assert.deepEqual(groups.map((g) => g.scene), [1, 2]);
  const [video, voice] = groups[0].cards;
  assert.deepEqual([video.label, video.vendor, video.model, video.cost, video.kind], [{ scene: 1, role: 'video' }, 'TapVid', 'seedance-2.0-fast', '40 credits', 'video']);
  assert.deepEqual([voice.label, voice.cost, voice.estimated, voice.kind], [{ scene: 1, role: 'speech' }, '$0.01', true, 'audio']);
  assert.equal(video.id, cover);
  assert.ok(existsSync(join(review, video.path)));
  const user = groups[1].cards[0];
  assert.deepEqual([user.label, user.user, user.visual, user.kind], [{ scene: 2, role: 'user' }, true, 'your logo', 'image']);
});

const node = (...args) => execFileSync(process.execPath, [join(SCRIPTS, 'review.mjs'), ...args, '--no-open'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pageData = (page) => JSON.parse(readFileSync(page, 'utf-8').match(/window\.__REVIEW__ = (.*);<\/script>/)[1]);
const skip = !runtimeReady && 'runtime not installed (node scripts/ensure-runtime.mjs)';

test('review.mjs <project> builds the clone review: clone comparison only, with fidelity and sfx', { skip, timeout: 90_000 }, () => {
  const clone = makeClone();
  appendFileSync(join(clone, 'template', 'boards', 'Title01.jsx'), '\n// <div data-sfx="pop" />\n');
  touch(join(clone, 'template', 'sfx', 'pop.wav'), 'RIFF');
  writeJson(join(clone, 'compare', 'report.json'), { rows: [{ board: 'Title01', window: 0, source_t: 0.5, struct: 0.96 }], timing: [] });
  const page = node(clone);
  assert.equal(page, join(clone, 'review', 'index.html'));
  const d = pageData(page);
  assert.equal(d.stage, 'clone');
  assert.equal(d.preview, undefined);
  assert.equal(d.clone.boards, 2);
  assert.equal(d.clone.fidelity.passed, 1);
  assert.deepEqual(d.sfx, { pop: 'sfx/pop.wav' });
  assert.ok(existsSync(join(clone, 'review', 'compare-project', 'index.html')));
  assert.ok(existsSync(join(clone, 'review', 'source.mp4')));
});

test('review.mjs <project> <slug> adds Final cut and Assets once out/tapvid.mp4 exists', { skip, timeout: 120_000 }, () => {
  const clone = makeClone();
  const dir = makeReplica(clone);
  const before = pageData(node(clone, 'demo'));
  assert.equal(before.stage, 'replica');
  assert.equal(before.final, null);
  assert.equal(before.assets, null);
  touch(join(dir, 'out', 'tapvid.mp4'));
  touch(join(dir, 'out', 'tapvid-v1.mp4'));
  const d = pageData(node(clone, 'demo'));
  assert.deepEqual(d.final.versions.map((v) => [v.label, v.current]), [['tapvid', true], ['tapvid-v1', false]]);
  assert.ok(Array.isArray(d.assets.groups));
  assert.ok(existsSync(join(dir, 'review', 'final', 'tapvid-v1.mp4')));
  assert.ok(readJson(join(dir, 'review', 'data.json')).storyboard.models);
});

// The dictionaries of the two pages, read from their source: review.html's DICT and the bridge's L.
const TEMPLATE = join(import.meta.dirname, '..', '..', 'skills', 'remix', 'assets', 'template');
const source = (file) => readFileSync(join(TEMPLATE, file), 'utf-8');
const objectAfter = (text, marker) => {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `${marker} not found`);
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}' && --depth === 0) return new Function(`return ${text.slice(open, i + 1)};`)();
  }
  throw new Error(`${marker}: unbalanced`);
};
const pageDict = () => objectAfter(source('review.html'), 'var DICT =');
const bridgeDict = () => objectAfter(source('template.html'), 'var L =');
const hasBoth = (dict) => Object.entries(dict).filter(([, v]) => !(v.en && v.zh)).map(([k]) => k);
const CJK = /[㐀-鿿＀-￯]/;

test('review.html: every dictionary key has en and zh, every key the page names exists', () => {
  const dict = pageDict();
  assert.deepEqual(hasBoth(dict), []);
  for (const [k, v] of Object.entries(dict)) for (const s of [v.en, v.zh].flat()) assert.equal(typeof s, 'string', k);
  const html = source('review.html');
  const named = new Set();
  for (const m of html.matchAll(/data-t="([^"]+)"/g)) named.add(m[1]);
  for (const m of html.matchAll(/dataset\.t = '([^']+)'/g)) named.add(m[1]);
  // T('key', …), or T(cond ? 'a.b' : 'c.d'); a prefix ending in '.' is completed from the data.
  for (const m of html.matchAll(/\bT\(([^(),]*)/g)) {
    const lits = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    const whole = /^'[^']*'$/.test(m[1].trim());
    for (const k of lits) if (whole ? !k.endsWith('.') : k.includes('.') && !k.endsWith('.')) named.add(k);
  }
  assert.ok(named.size > 50, String(named.size));
  assert.deepEqual([...named].filter((k) => !dict[k]), []);
  // Outside the dictionary and the language switch, the page has no Chinese UI text left.
  const body = html.replace(/var DICT = \{[\s\S]*?\n    \};/, '').split('\n')
    .filter((l) => !/^\s*(\/\/|<!--)/.test(l) && !/data-lang="zh"/.test(l) && !/^\s+render final\/|D\.stage 'clone' shows/.test(l));
  assert.deepEqual(body.filter((l) => CJK.test(l.replace(/\/\/.*$/, ''))), []);
});

test("template.html's bridge translates every overlay code project.mjs can emit", () => {
  const L = bridgeDict();
  assert.deepEqual(hasBoth(L), []);
  const project = readFileSync(join(SCRIPTS, 'lib', 'project.mjs'), 'utf-8');
  const expand = { '${type}': ['image', 'video'], '${kind}': ['image', 'video', 'avatar'] };
  const badges = new Set();
  for (const m of project.matchAll(/(['`])((?:slot|gen|sketch):[^'`]*|portrait|ref|user|code)\1/g)) {
    const [head, tail] = m[2].split(':');
    for (const v of tail === undefined ? [null] : expand[tail] || [tail]) badges.add(v === null ? head : `${head}:${v}`);
  }
  assert.ok(badges.size >= 12, [...badges].join());
  const subjects = JSON.parse(project.match(/SUBJECT_KINDS = new Set\((\[[^\]]+\])\)/)[1].replace(/'/g, '"'));
  const targets = [...project.match(/const target = ([^;]+);/)[1].matchAll(/[?:] '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(targets.sort(), ['ai', 'file', 'photo', 'tbd']);
  const parts = ['Title card', 'Sticker', 'Badge', 'Icon', 'Heading', 'Call to action', 'Captions', 'Step number', 'Screen card'];
  const captions = readFileSync(join(TEMPLATE, 'src', 'components', 'Captions.jsx'), 'utf-8');
  for (const m of captions.matchAll(/data-part="([^"]+)"/g)) assert.ok(parts.includes(m[1]), m[1]);
  const codes = [...badges, ...subjects.map((x) => `subject:${x}`), ...targets.map((x) => `target:${x}`), 'part', ...parts.map((x) => `part:${x}`)];
  assert.deepEqual(codes.filter((c) => !L[c]), []);
  for (const p of parts) assert.equal(L[`part:${p}`].en, p, 'English part names show as written');
});

test('review data carries codes, not Chinese: kinds, modes, units, notes, flags, BGM and asset labels', { skip, timeout: 120_000 }, (t) => {
  // Estimation uses static provider prices, but routing still requires a configured key.
  // Keep this offline fixture independent of personal credentials, routes and model caches.
  const home = tmp();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  symlinkSync(RUNTIME, join(home, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  const env = { ...process.env, TAPVID_VIDEO_HOME: home, TAPVID_API_KEY: 'offline-review-test', TAPVID_API_BASE: 'http://127.0.0.1:1' };
  const clone = makeClone();
  const dir = makeReplica(clone, {
    edit: (r) => {
      r.audio.mode = 'narration';
      r.audio.bgm = { brief: '', candidates: [{ path: 'bgm/a.mp3' }], selected: 0, path: null, beats: null };
      r.scenes[0].media.cover.provider = 'tapvid';
      r.scenes[0].media.cover.model = 'seedance-2.0-fast';
      r.scenes[0].narration = 'Meet Nova, the notes app that writes back to you, sorts your week, drafts the replies you owe and reminds you of every promise you made in a meeting.';
    },
  });
  touch(join(dir, 'bgm', 'a.mp3'));
  fakeTasks(dir);
  touch(join(dir, 'out', 'tapvid.mp4'));
  execFileSync(process.execPath, [join(SCRIPTS, 'media.mjs'), 'plan', join(dir, 'replica.json')], { cwd: dir, env, stdio: 'ignore' });
  const page = execFileSync(process.execPath, [join(SCRIPTS, 'review.mjs'), clone, 'demo', '--no-open'], { env, encoding: 'utf8' }).trim();
  const d = pageData(page);
  const dict = pageDict();
  assert.equal(CJK.test(JSON.stringify(d)), false, 'no Chinese in the review data');
  assert.deepEqual(d.preview.bgm[0].title, { index: 1 });
  const flag = d.preview.scenes[0].flag;
  assert.deepEqual([flag.code, flag.board, flag.max, typeof flag.natural], ['over', 'Title01', 6, 'number']);
  assert.ok(dict[`flag.${flag.code}`]);
  const slots = d.storyboard.rows.flatMap((r) => r.slots);
  assert.ok(slots.length);
  for (const s of slots) {
    assert.ok(dict[`kind.${s.kind}`], s.kind);
    if (s.mode) assert.ok(dict[`mode.${s.mode}`], s.mode);
  }
  for (const n of d.storyboard.notes) assert.ok(dict[`note.${n.code}`] && typeof n.detail === 'string', JSON.stringify(n));
  assert.deepEqual(d.storyboard.models.map((m) => [m.capability, m.price, m.unit, m.resolution, m.count, m.subtotal, m.estimated]),
    [['video', '18 credits', 'second', '720p', 5, '90 credits', false]]);
  for (const m of [...d.storyboard.models, ...d.assets.spend.models]) {
    if (m.unit) assert.ok(dict[`unit.${m.unit}`] && dict[`count.${m.unit}`], m.unit);
    assert.equal(typeof m.estimated, 'boolean');
  }
  const cards = d.assets.groups.flatMap((g) => g.cards);
  assert.ok(cards.length >= 2);
  for (const c of cards) {
    assert.ok(dict[`kind.${c.label.role}`], c.label.role);
    assert.equal(typeof c.label.scene, 'number');
  }
  assert.deepEqual(d.assets.groups.map((g) => g.scene), [1, 2]);
});

test('review page: English by default, the language switch changes every label live and is remembered', { skip, timeout: 120_000 }, async () => {
  const clone = makeClone();
  const dir = makeReplica(clone);
  touch(join(dir, 'out', 'tapvid.mp4'));
  const url = pathToFileURL(node(clone, 'demo')).href;
  const { chromium } = requireRuntime('playwright');
  const browser = await chromium.launch();
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(url);
      const preview = page.frames().find((f) => f.url().includes('preview-project'));
      const badge = () => preview.locator('#slot-layer .badge').first().textContent();
      const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      assert.equal(await page.getAttribute('html', 'lang'), 'en');
      assert.equal(await page.textContent('nav button[data-tab="preview"]'), 'Replica preview');
      assert.match(await page.title(), / · Replica review$/);
      await preview.waitForSelector('#slot-layer .badge');
      assert.equal(await badge(), 'AI video · Sketch');
      assert.ok(await noScroll(), `${width}px en: horizontal scroll`);
      await page.click('.lang button[data-lang="zh"]');
      assert.equal(await page.getAttribute('html', 'lang'), 'zh');
      assert.equal(await page.textContent('nav button[data-tab="preview"]'), '复刻预览');
      assert.equal(await page.textContent('nav button[data-tab="board"]'), '分镜与费用');
      assert.match(await page.textContent('#board'), /旁白 \/ 文案/);
      assert.match(await page.textContent('#assets'), /还没有素材/);
      await preview.waitForFunction(() => document.querySelector('#slot-layer .badge')?.textContent === 'AI 视频 · 草图');
      assert.ok(await noScroll(), `${width}px zh: horizontal scroll`);
      await page.reload();
      assert.equal(await page.textContent('nav button[data-tab="final"]'), '成片', 'the choice is remembered');
      await page.click('.lang button[data-lang="en"]');
      assert.equal(await page.textContent('nav button[data-tab="final"]'), 'Final cut');
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
