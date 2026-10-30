import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaError } from '../../skills/remix/scripts/lib/media/errors.mjs';
import { MAX_ATTEMPTS, deleteKey, setKey } from '../../skills/remix/scripts/set-key.mjs';

function fakePlatform(answers) {
  const calls = { prompts: [], written: {}, deleted: [] };
  return {
    calls,
    promptSecret: (title, message) => { calls.prompts.push(message); return answers.shift() ?? null; },
    writeSecret: (n, v) => { calls.written[n] = v; },
    deleteSecret: (n) => calls.deleted.push(n),
  };
}

// verify() sees the entered key through ctx.secret and accepts only "good".
const provider = (secrets = ['FAKE_API_KEY']) => ({
  meta: { name: 'fake', displayName: 'Fake', secrets },
  verify: async (ctx) => { for (const n of secrets) if (ctx.secret(n) !== 'good') throw new MediaError('auth', 'bad key'); },
});

test('a valid key is verified then saved', async () => {
  const p = fakePlatform([' good ']);
  assert.equal(await setKey(provider(), { platform: p }), 'saved');
  assert.deepEqual(p.calls.written, { FAKE_API_KEY: 'good' });
});

test('a wrong key is re-prompted, then saved on a later try', async () => {
  const p = fakePlatform(['bad', 'good']);
  assert.equal(await setKey(provider(), { platform: p }), 'saved');
  assert.equal(p.calls.prompts.length, 2);
  assert.match(p.calls.prompts[1], /rejected/);
});

test('three wrong keys give invalid-key and save nothing', async () => {
  const p = fakePlatform(['a', 'b', 'c', 'good']);
  assert.equal(await setKey(provider(), { platform: p }), 'invalid-key');
  assert.equal(p.calls.prompts.length, MAX_ATTEMPTS);
  assert.deepEqual(p.calls.written, {});
});

test('cancelling the dialog gives cancelled', async () => {
  const p = fakePlatform([null]);
  assert.equal(await setKey(provider(), { platform: p }), 'cancelled');
  assert.deepEqual(p.calls.written, {});
});

test('providers with two secrets prompt for both; --delete removes both', async () => {
  const p = fakePlatform(['good', 'good']);
  assert.equal(await setKey(provider(['A_KEY', 'B_KEY']), { platform: p }), 'saved');
  assert.deepEqual(p.calls.written, { A_KEY: 'good', B_KEY: 'good' });
  assert.equal(deleteKey(provider(['A_KEY', 'B_KEY']), { platform: p }), 'deleted');
  assert.deepEqual(p.calls.deleted, ['A_KEY', 'B_KEY']);
});
