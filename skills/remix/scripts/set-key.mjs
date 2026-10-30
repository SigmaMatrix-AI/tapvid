#!/usr/bin/env node
// Enter a provider's key(s) in a native password dialog, verify, and store them (spec §5.5).
//   node set-key.mjs <provider>            prints exactly one of: saved | cancelled | invalid-key
//   node set-key.mjs <provider> --delete   removes the stored key(s); prints deleted
// The key never reaches stdout, files or logs: it lives in memory until writeSecret.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOME, fail, parseArgs, readJson, writeJson } from './lib/common.mjs';
import { platform as defaultPlatform } from './lib/platform.mjs';
import { createCtx } from './lib/media/ctx.mjs';
import { loadRegistry } from './lib/media/registry.mjs';

// Wrong keys get re-prompted; three tries is enough for a typo, few enough to stop a loop.
export const MAX_ATTEMPTS = 3;

// Returns 'saved' | 'cancelled' | 'invalid-key'. `makeCtx` is injectable for tests.
export async function setKey(provider, { platform = defaultPlatform, makeCtx = createCtx } = {}) {
  const names = provider.meta.secrets || [];
  const label = provider.meta.displayName || provider.meta.name;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const entered = {};
    for (const name of names) {
      const retry = attempt > 1 ? ' (the previous key was rejected)' : '';
      const value = platform.promptSecret(`TapVid video · ${label}`, `Paste your ${label} key (${name})${retry}`);
      if (value === null || value === undefined || !value.trim()) return 'cancelled';
      entered[name] = value.trim();
    }
    // The entered values are exposed to verify() only; nothing else can read them.
    const secrets = { secret: (n) => entered[n] ?? null, configured: () => true };
    try {
      if (typeof provider.verify === 'function') await provider.verify(makeCtx({ provider: provider.meta.name, secrets }));
    } catch {
      continue;
    }
    for (const [name, value] of Object.entries(entered)) platform.writeSecret(name, value);
    return 'saved';
  }
  return 'invalid-key';
}

export function deleteKey(provider, { platform = defaultPlatform } = {}) {
  for (const name of provider.meta.secrets || []) platform.deleteSecret(name);
  return 'deleted';
}

// media.mjs caches verify() results; a changed key must be re-verified.
function forgetVerify(name) {
  const path = join(HOME, 'cache', 'verify.json');
  const cache = readJson(path, {});
  if (!cache[name]) return;
  const { [name]: _drop, ...rest } = cache;
  writeJson(path, rest);
}

async function main() {
  const args = parseArgs();
  const name = args._[0];
  if (!name) fail('usage: set-key.mjs <provider> [--delete]', 2);
  const registry = await loadRegistry();
  const provider = registry.get(name);
  if (!provider) fail(`unknown provider ${name} (known: ${[...registry.keys()].join(', ')})`, 2);
  if (!(provider.meta.secrets || []).length) fail(`${name} needs no key`, 2);
  const result = args.delete ? deleteKey(provider) : await setKey(provider);
  if (result === 'saved' || result === 'deleted') forgetVerify(name);
  console.log(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
