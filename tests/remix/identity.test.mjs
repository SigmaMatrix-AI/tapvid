import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN, readJson, writeJson } from '../../skills/remix/scripts/lib/common.mjs';
import { identityProblems, identitySlots, signOff } from '../../skills/remix/scripts/lib/identity.mjs';
import { slotRequestId } from '../../skills/remix/scripts/lib/media/plan.mjs';
import { loadReplica } from '../../skills/remix/scripts/lib/replica.mjs';
import { validateReplica } from '../../skills/remix/scripts/lib/validate-replica.mjs';
import { buildReplica } from '../../skills/remix/scripts/replica-init.mjs';
import { clip, fakeTasks, makeClone, makeReplica } from './render-helpers.mjs';

const SCRIPTS = join(PLUGIN, 'scripts');
const COVER = slotRequestId('demo', 0, 'Title01', 'cover');

// A clone whose cover slot shows a person, as a replacement target.
function personClone({ tier } = {}) {
  const clone = makeClone();
  clip(join(clone, 'template', 'refs', 'Title01.cover.mp4'), 1);
  const refsPath = join(clone, 'template', 'refs', 'refs.json');
  const refs = readJson(refsPath);
  refs['Title01.cover'] = { ...refs['Title01.cover'], clip: 'Title01.cover.mp4', subjects: [{ id: 'presenter', kind: 'person', image: 'subjects/presenter.png' }] };
  writeJson(refsPath, refs);
  if (tier) writeJson(join(clone, 'analysis', 'brief.json'), { tier });
  return clone;
}

function generatedReplica({ tier, edit } = {}) {
  const dir = makeReplica(personClone({ tier }), {
    edit: (r) => {
      r.replace = [{ subject: 'presenter', with: { generate: 'A fictional woman.' } }];
      Object.assign(r.scenes[0].media.cover, { mode: 'keyframe', replace: ['presenter'], prompt: 'A woman.' });
      edit?.(r);
    },
  });
  fakeTasks(dir, { cover: 2 });
  return dir;
}

const inspect = (dir, id, ...flags) => JSON.parse(execFileSync(process.execPath, [join(SCRIPTS, 'inspect.mjs'), dir, id, ...flags], { encoding: 'utf-8' }));

test('a generated clip of a person is listed and blocks until it is signed off', () => {
  const ctx = loadReplica(generatedReplica());
  assert.deepEqual(identitySlots(ctx).map((s) => s.id), [COVER]);
  const problems = identityProblems(ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no identity check/);
});

test('sign-off is refused until the clip was inspected with --identity', () => {
  const dir = generatedReplica();
  assert.throws(() => signOff(loadReplica(dir), COVER, 'pass', { saw: 'the replacement woman' }), /inspect\.mjs .* --identity/);
  inspect(dir, COVER);
  assert.throws(() => signOff(loadReplica(dir), COVER, 'pass', { saw: 'the replacement woman' }), /--identity/, 'a plain inspect does not count');
});

test('--identity reads the first second at 8 fps and the rest at 2 fps, at full width', () => {
  const dir = generatedReplica();
  const out = inspect(dir, COVER, '--identity');
  const times = out.frames.map((f) => f.time);
  assert.deepEqual(times.slice(0, 8), [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]);
  assert.deepEqual(times.slice(8), [1, 1.5]);
  const width = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width', '-of', 'csv=p=0', join(dir, out.frames[0].path)], { encoding: 'utf-8' }).trim();
  assert.equal(width, '1920');
});

test('a pass needs what was seen, then clears the gate', () => {
  const dir = generatedReplica();
  inspect(dir, COVER, '--identity');
  assert.throws(() => signOff(loadReplica(dir), COVER, 'pass', {}), /--saw/);
  signOff(loadReplica(dir), COVER, 'pass', { saw: 'the replacement woman in every frame' });
  assert.deepEqual(identityProblems(loadReplica(dir)), []);
});

test('a regenerated clip voids its sign-off', () => {
  const dir = generatedReplica();
  inspect(dir, COVER, '--identity');
  signOff(loadReplica(dir), COVER, 'pass', { saw: 'the replacement woman' });
  const ctx = loadReplica(dir);
  clip(identitySlots(ctx)[0].clip, 3);
  const problems = identityProblems(loadReplica(dir));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /changed since/);
});

test('a failed clip blocks, and voids the passes of every reference clip of the film', () => {
  const second = slotRequestId('demo', 2, 'Title01', 'cover');
  const third = slotRequestId('demo', 3, 'Title01', 'cover');
  const dir = generatedReplica({
    edit: (r) => {
      const copy = (mode) => ({ ...structuredClone(r.scenes[0]), media: { cover: { ...r.scenes[0].media.cover, mode } } });
      r.scenes.push(copy('reference'), copy('keyframe'));
    },
  });
  const tasks = readJson(join(dir, 'tasks.json'));
  for (const [id, name] of [[second, 'b'], [third, 'c']]) {
    clip(join(dir, 'assets', 'gen', `${name}.mp4`), 2);
    tasks.tasks[id] = { id, status: 'completed', result: { files: [{ path: `assets/gen/${name}.mp4`, mime: 'video/mp4' }] } };
  }
  writeJson(join(dir, 'tasks.json'), tasks);
  for (const id of [COVER, second, third]) {
    inspect(dir, id, '--identity');
    signOff(loadReplica(dir), id, 'pass', { saw: 'the replacement woman' });
  }
  signOff(loadReplica(dir), COVER, 'fail', { saw: 'the original man in the opening frames' });
  const problems = identityProblems(loadReplica(dir)).join('\n');
  assert.match(problems, new RegExp(`${COVER}: failed`));
  assert.match(problems, new RegExp(`${second}: no identity check`), 'the reference clip must be checked again');
  assert.doesNotMatch(problems, new RegExp(third), 'a keyframe clip keeps its own check');
});

test('slots without a person, the user\'s own files and ungenerated slots are not gated', () => {
  const clone = makeClone();
  const plain = makeReplica(clone, { edit: (r) => { r.scenes[0].media.cover.replace = []; } });
  fakeTasks(plain, { cover: 2 });
  assert.deepEqual(identityProblems(loadReplica(plain)), [], 'no person in the slot');

  const user = generatedReplica({ edit: (r) => {
    Object.assign(r.scenes[0].media.cover, { source: 'user', file: 'assets/gen/mine.mp4', mode: undefined });
  } });
  assert.deepEqual(identitySlots(loadReplica(user)), []);

  const failed = generatedReplica();
  const tasks = readJson(join(failed, 'tasks.json'));
  tasks.tasks[COVER].status = 'failed';
  writeJson(join(failed, 'tasks.json'), tasks);
  assert.deepEqual(identityProblems(loadReplica(failed)), [], 'no clip reaches the film: it falls back to the sketch');
});

test('a digital human is always gated', () => {
  const dir = generatedReplica({ edit: (r) => { r.scenes[0].media.cover.kind = 'avatar'; } });
  assert.equal(identityProblems(loadReplica(dir)).length, 1);
});

test('render.mjs refuses a film with an unchecked person, before any build', () => {
  const dir = generatedReplica();
  const res = spawnSync(process.execPath, [join(SCRIPTS, 'render.mjs'), dir], { encoding: 'utf-8' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /identity/);
  assert.match(res.stderr, new RegExp(COVER));
  assert.deepEqual(readdirSync(dir).filter((f) => f === 'project' || f === 'out'), []);
});

test('the identity CLI signs off and reports status', () => {
  const dir = generatedReplica();
  const run = (...a) => spawnSync(process.execPath, [join(SCRIPTS, 'identity.mjs'), ...a], { encoding: 'utf-8' });
  assert.equal(run('status', dir).status, 1);
  inspect(dir, COVER, '--identity');
  assert.equal(run('pass', dir, COVER, '--saw', 'the replacement woman').status, 0);
  assert.equal(run('status', dir).status, 0);
});

test('validate: at high a person in a reference slot is an error unless it gives a reason', () => {
  const reference = (tier, extra = {}) => {
    const dir = makeReplica(personClone({ tier }), {
      edit: (r) => {
        r.replace = [{ subject: 'presenter', with: { generate: 'A fictional woman.' } }];
        Object.assign(r.scenes[0].media.cover, { mode: 'reference', replace: ['presenter'], prompt: 'A woman.', ...extra });
      },
    });
    return validateReplica(dir).errors.filter((e) => /person|schema/.test(e));
  };
  assert.equal(reference('high').length, 1);
  assert.match(reference('high')[0], /keyframe/);
  assert.deepEqual(reference('low'), []);
  assert.deepEqual(reference(undefined), []);
  assert.deepEqual(reference('high', { reference_ok: 'a silhouette, no recognisable person' }), []);
});

test('replica-init: at high a slot with a person starts as keyframe, at low as reference', () => {
  const modeAt = (tier) => buildReplica(personClone({ tier }), 'demo', { topic: 'Nova', language: 'en' }).scenes[0].media.cover.mode;
  assert.equal(modeAt('high'), 'keyframe');
  assert.equal(modeAt('low'), 'reference');
});

