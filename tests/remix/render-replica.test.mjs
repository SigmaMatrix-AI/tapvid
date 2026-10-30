import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from '../../skills/remix/scripts/lib/common.mjs';
import { check } from '../../skills/remix/scripts/lib/schema.mjs';
import { validateReplica } from '../../skills/remix/scripts/lib/validate-replica.mjs';
import { makeClone, makeReplica } from './render-helpers.mjs';

const SCRIPTS = join(import.meta.dirname, '..', '..', 'skills', 'remix', 'scripts');

test('replica-init writes a schema-valid skeleton seeded from the template', () => {
  const clone = makeClone();
  const out = execFileSync(process.execPath, [join(SCRIPTS, 'replica-init.mjs'), clone, 'nova-launch', '--topic', 'Nova launch'], { encoding: 'utf-8' }).trim();
  assert.equal(out, join(clone, 'replicas', 'nova-launch', 'replica.json'));
  const r = readJson(out);
  assert.deepEqual(check('replica', r), []);
  assert.equal(r.template, '../../template');
  assert.equal(r.language, 'zh');
  assert.deepEqual(r.scenes.map((s) => s.board), ['Title01', 'Points02']);
  assert.deepEqual(r.scenes[1].data.points.length, 2);
  assert.equal(r.scenes[0].narration, 'Meet Nova, the notes app that writes back.');
  assert.deepEqual(r.scenes[0].media.cover, {
    kind: 'video', source: 'ai', mode: 'text', ref: 'Title01.cover', replace: [], prompt: '', visual: '',
    aspect: '9:16', provider: null, sketch: null, file: null, duration_s: 2.5,
  });
  assert.deepEqual(r.scenes[1].media, {});
  assert.deepEqual(r.audio, { mode: 'narration', voice: null, captions: null, bgm: { brief: '', candidates: [], selected: 0, path: null, beats: null } });
  const again = spawnSync(process.execPath, [join(SCRIPTS, 'replica-init.mjs'), clone, 'nova-launch', '--topic', 'x'], { encoding: 'utf-8' });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /exists/);
});

test('validate-replica: the skeleton needs its sketch; a filled replica passes', () => {
  const clone = makeClone();
  execFileSync(process.execPath, [join(SCRIPTS, 'replica-init.mjs'), clone, 'raw', '--topic', 'x']);
  const raw = validateReplica(join(clone, 'replicas', 'raw'));
  assert.ok(raw.errors.some((e) => /media\.cover: needs a sketch/.test(e)), raw.errors.join('\n'));

  const dir = makeReplica(clone);
  assert.deepEqual(validateReplica(dir).errors, []);
});

test('validate-replica: limits, media paths, sources and replacements', () => {
  const dir = makeReplica(makeClone(), {
    edit: (r) => {
      r.scenes[1].data.points.push({ label: 'a', say: 'b' }, { label: 'c', say: 'd' }, { label: 'e', say: 'f' });
      r.scenes[1].data.heading = 'x'.repeat(31);
      r.scenes[1].media['points.0.shot'] = { kind: 'image', source: 'code' };
      r.scenes[0].media.cover = { ...r.scenes[0].media.cover, kind: 'avatar', mode: 'reference' };
      r.scenes[0].data.extra = 1;
      r.replace = [{ subject: 'ghost', with: { file: 'assets/user/none.png' } }];
      r.audio = { mode: 'music-only', voice: null, captions: null, bgm: null };
    },
  });
  const { errors } = validateReplica(dir);
  const has = (re) => assert.ok(errors.some((e) => re.test(e)), `${re}\n${errors.join('\n')}`);
  has(/Points02\.data\.points: 5 items, max 4/);
  has(/Points02\.data\.heading: 31 chars, max 30/);
  has(/Title01\.data\.extra: not a field of the board/);
  has(/media\.points\.0\.shot: no such media field path/);
  has(/media\.cover: avatar slots need narration mode/);
  has(/media\.cover: mode reference needs a ref with a clip/);
  has(/replace ghost: not a subject in refs\.json and not generated/);
  has(/replace ghost: assets\/user\/none\.png does not exist/);
});

test('validate.mjs CLI reports and exits non-zero on errors', () => {
  const clone = makeClone();
  const dir = makeReplica(clone);
  const ok = spawnSync(process.execPath, [join(SCRIPTS, 'validate.mjs'), 'replica', dir], { encoding: 'utf-8' });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout.trim().split('\n').pop(), /^ok$/);
  const r = readJson(join(dir, 'replica.json'));
  r.scenes[0].board = 'Missing09';
  writeJson(join(dir, 'replica.json'), r);
  const bad = spawnSync(process.execPath, [join(SCRIPTS, 'validate.mjs'), 'replica', dir], { encoding: 'utf-8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /error: scenes\[0\] Missing09: board Missing09 is not in the template/);
  const tpl = spawnSync(process.execPath, [join(SCRIPTS, 'validate.mjs'), 'template', clone], { encoding: 'utf-8' });
  if (!existsSync(join(SCRIPTS, 'lib', 'validate-template.mjs'))) assert.match(tpl.stderr, /validate-template\.mjs is missing/);
});

test('validate-replica: narration over the original window\'s syllable budget is a warning', () => {
  const clone = makeClone();
  const dir = makeReplica(clone);
  const budget = (words) => {
    writeJson(join(clone, 'source', 'timeline.json'), { fps: 30, duration_s: 5, frames: 150, shots: [], words });
    return validateReplica(dir);
  };
  // Title01 [0, 2.5): 2 syllables over 1 s of speech → ~5 in the window; the replica says 9.
  const slow = budget([{ text: 'Hi', start: 0, end: 0.5 }, { text: 'there', start: 0.6, end: 1.0 }]);
  assert.deepEqual(slow.errors, []);
  assert.ok(slow.warnings.some((w) => w === 'scenes[0] Title01: narration is ~9 syllables, the original says ~5 in this window — shorten it or the scene runs long/fast'), slow.warnings.join('\n'));
  // Points02's window has no speech: the whole film's rate (2 syl/s) budgets it.
  assert.ok(slow.warnings.some((w) => /^scenes\[1\] Points02: narration is ~11 syllables, the original says ~5/.test(w)), slow.warnings.join('\n'));
  const fast = budget([{ text: 'Meet the notes app that writes back to you, at last', start: 0, end: 2.4 }, { text: 'one two three four five six seven eight nine ten eleven', start: 2.5, end: 4.9 }]);
  assert.ok(!fast.warnings.some((w) => /syllables/.test(w)), fast.warnings.join('\n'));
});
