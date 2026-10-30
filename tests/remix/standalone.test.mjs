import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Catches dependencies on repository-root assets, cwd, or package metadata when a
// user installs only this skill. Spaces and non-ASCII paths must work as well.
test('a standalone remix install replays providers, validates templates, and loads user extensions', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tapvid standalone '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const skill = join(dir, '安装 remix');
  const home = join(dir, 'user data');
  cpSync(new URL('../../skills/remix/', import.meta.url), skill, { recursive: true });
  cpSync(new URL('./fixtures/sample-clone/', import.meta.url), join(dir, 'clone sample'), { recursive: true });
  assert.ok(existsSync(join(skill, 'scripts', 'media.mjs')), `standalone copy has no entry script: ${JSON.stringify({ root: readdirSync(dir), skill: readdirSync(skill, { recursive: true }).slice(0, 15) })}`);
  const invoke = (script, ...args) => {
    const r = spawnSync(process.execPath, [join(skill, 'scripts', script), ...args], {
      cwd: dir, env: { ...process.env, TAPVID_VIDEO_HOME: home }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout;
  };
  const checks = invoke('media.mjs', 'check', 'tapvid').trim().split('\n');
  assert.ok(checks.length > 0 && checks.every((line) => line.startsWith('✓ ')));
  invoke('validate.mjs', 'template', join(dir, 'clone sample', 'template'));
  mkdirSync(join(home, 'providers'), { recursive: true });
  writeFileSync(join(home, 'providers', 'local-demo.mjs'), `export const meta = { name: 'local-demo', capabilities: {} }; export async function submit() { return {}; }`);
  // Registry import runs from the standalone install, never from this checkout.
  const code = `import { loadRegistry } from './安装 remix/scripts/lib/media/registry.mjs'; const registry = await loadRegistry(); console.log(JSON.stringify([...registry.keys()].sort()));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, env: { ...process.env, TAPVID_VIDEO_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const names = JSON.parse(r.stdout);
  assert.equal(names.length, 21);
  assert.ok(names.includes('local-demo'));
  assert.ok(names.includes('tapvid'));
});
