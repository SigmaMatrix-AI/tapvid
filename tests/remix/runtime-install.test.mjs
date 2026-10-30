import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRuntime } from '../../skills/remix/scripts/lib/runtime-install.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tapvid runtime '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = join(dir, 'runtime');
  const packageFile = join(dir, 'package.json');
  const lockFile = join(dir, 'package-lock.json');
  writeFileSync(packageFile, JSON.stringify({ name: 'runtime-test', dependencies: {} }));
  writeFileSync(lockFile, JSON.stringify({ name: 'runtime-test', lockfileVersion: 3, packages: {} }));
  let browser = false;
  const calls = [];
  // Substitute only external installs and browser startup. File copying, cache
  // invalidation, sequencing and completion markers run through real code.
  const options = { runtime, packageFile, lockFile, npm: ['npm', []], log: () => {},
    browserReady: async () => browser,
    step: (command, args) => {
      calls.push([command, ...args]);
      if (command === 'npm') {
        assert.equal(args[0], 'ci');
        assert.equal(readFileSync(join(runtime, 'package-lock.json'), 'utf8'), readFileSync(lockFile, 'utf8'));
        mkdirSync(join(runtime, 'node_modules'), { recursive: true });
      } else {
        assert.deepEqual(args.slice(1), ['install', 'chromium']);
        browser = true;
      }
    },
  };
  return { options, calls, runtime, lockFile, removeBrowser: () => { browser = false; } };
}

test('locked runtime installs once and reinstalls when only the lockfile changes', async (t) => {
  const { options, calls, runtime, lockFile } = setup(t);
  await ensureRuntime(options);
  assert.ok(existsSync(join(runtime, '.installed')));
  const first = readFileSync(join(runtime, '.installed'), 'utf8');
  assert.equal(calls.filter(([cmd]) => cmd === 'npm').length, 1);
  calls.length = 0;
  await ensureRuntime(options);
  assert.equal(calls.length, 0);
  writeFileSync(lockFile, readFileSync(lockFile, 'utf8') + '\n');
  await ensureRuntime(options);
  assert.equal(calls.filter(([cmd]) => cmd === 'npm').length, 1);
  assert.notEqual(readFileSync(join(runtime, '.installed'), 'utf8'), first);
});

test('a deleted browser cache is repaired without reinstalling npm packages', async (t) => {
  const { options, calls, runtime, removeBrowser } = setup(t);
  await ensureRuntime(options);
  calls.length = 0;
  removeBrowser();
  await ensureRuntime(options);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.ok(existsSync(join(runtime, '.installed')));
});

test('failed browser setup never leaves a ready marker', async (t) => {
  const { options, runtime } = setup(t);
  await ensureRuntime(options);
  await assert.rejects(ensureRuntime({ ...options, browserReady: async () => false }), /Chromium/);
  assert.equal(existsSync(join(runtime, '.installed')), false);
});
