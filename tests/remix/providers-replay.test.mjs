import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_DIR, loadRegistry } from '../../skills/remix/scripts/lib/media/registry.mjs';
import { replayProvider } from '../../skills/remix/scripts/lib/media/replay.mjs';
import { check } from '../../skills/remix/scripts/lib/schema.mjs';

const registry = await loadRegistry({ dirs: [BUILTIN_DIR] });
const FIXTURES = join(BUILTIN_DIR, '__fixtures__');

// Every built-in provider replays its recorded exchanges cleanly (what `media.mjs check` runs).
for (const [name, provider] of registry) {
  test(`provider ${name}: fixtures replay`, async () => {
    const cases = await replayProvider(provider, FIXTURES);
    assert.ok(cases.length > 0);
    for (const c of cases) assert.deepEqual(c.problems, [], `${name}/${c.name}`);
  });
}

test('every built-in provider declares known capabilities with model ids', () => {
  assert.ok(registry.size >= 19);
  for (const [name, p] of registry) {
    assert.equal(p.meta.name, name);
    for (const [cap, m] of Object.entries(p.meta.capabilities)) {
      assert.doesNotThrow(() => check(`capabilities/${cap}`, {}, 'params'), `${name}: ${cap}`);
      for (const model of m.models || []) assert.ok(model.id, `${name} ${cap} model without id`);
    }
  }
});

test('a custom provider overrides a built-in of the same name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapvid-custom-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pexels.mjs'), "export const meta = { name: 'pexels', secrets: [], capabilities: { 'image.search': { models: [] } } };\nexport async function submit() { return { result: { items: [] } }; }\n");
  writeFileSync(join(dir, '_ignored.mjs'), 'export const meta = {};');
  const reg = await loadRegistry({ dirs: [BUILTIN_DIR, dir] });
  assert.equal(reg.get('pexels').custom, true);
  assert.deepEqual(Object.keys(reg.get('pexels').meta.capabilities), ['image.search']);
  writeFileSync(join(dir, 'broken.mjs'), 'export const meta = {};');
  await assert.rejects(loadRegistry({ dirs: [dir] }), /not a provider/);
});
