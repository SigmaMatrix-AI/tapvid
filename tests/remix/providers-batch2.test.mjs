import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signJwt } from '../../skills/remix/scripts/providers/kling.mjs';
import { isoSeconds } from '../../skills/remix/scripts/providers/youtube.mjs';
import * as replicate from '../../skills/remix/scripts/providers/replicate.mjs';
import { createCtx } from '../../skills/remix/scripts/lib/media/ctx.mjs';
import { createReplayFetch } from '../../skills/remix/scripts/lib/media/replay.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tapvid-batch2-'));

test('kling JWT is HS256 over iss/exp/nbf and verifies with the secret key', () => {
  const now = 1_761_552_000;
  const token = signJwt('ak-123', 'sk-456', now);
  const [head, body, sig] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url')), { iss: 'ak-123', exp: now + 1800, nbf: now - 5 });
  assert.equal(sig, createHmac('sha256', 'sk-456').update(`${head}.${body}`).digest('base64url'));
  assert.notEqual(signJwt('ak-123', 'other', now).split('.')[2], sig);
});

test('youtube ISO 8601 durations convert to seconds', () => {
  assert.equal(isoSeconds('PT1M3S'), 63);
  assert.equal(isoSeconds('PT2H'), 7200);
  assert.equal(isoSeconds('P1DT1S'), 86401);
  assert.equal(isoSeconds('bogus'), null);
});

test('replicate uploads files over the data-URI limit once and reuses the URL', async () => {
  const dir = tmp();
  const big = join(dir, 'big.png');
  writeFileSync(big, Buffer.alloc(300 * 1024, 1));
  const upload = {
    request: { method: 'POST', url: 'https://api.replicate.com/v1/files' },
    response: { status: 201, json: { id: 'f1', urls: { get: 'https://api.replicate.com/v1/files/f1' } } },
  };
  const predict = (id) => ({
    request: { method: 'POST', url: 'https://api.replicate.com/v1/models/bytedance/seedream-4/predictions',
      bodyIncludes: { input: { image_input: ['https://api.replicate.com/v1/files/f1'] } } },
    response: { status: 201, json: { id } },
  });
  const { fetchImpl, remaining } = createReplayFetch([upload, predict('p1'), predict('p2')], dir);
  const ctx = createCtx({ provider: 'replicate', secrets: { secret: () => 'tok' }, fetchImpl, cacheDir: join(dir, 'cache'), cwd: dir });
  const req = { params: { prompt: 'p', aspect: '1:1', refs: [{ file: big, role: 'subject' }] }, resolved_params: { model: 'bytedance/seedream-4', aspect: '1:1', resolution: '1K' }, out: 'out/x' };
  assert.deepEqual(await replicate.submit('image.generate', req, ctx), { jobId: 'p1' });
  assert.deepEqual(await replicate.submit('image.generate', req, ctx), { jobId: 'p2' });
  assert.equal(remaining(), 0);
});
