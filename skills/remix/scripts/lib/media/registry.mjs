// Provider registry: built-in providers under <skill>/scripts/providers and custom ones under
// ~/.tapvid-video/providers. A custom provider with a built-in's name replaces it (spec §5.7).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOME, PLUGIN, readJson } from '../common.mjs';

export const BUILTIN_DIR = join(PLUGIN, 'scripts', 'providers');
export const CUSTOM_DIR = join(HOME, 'providers');

const listModules = (dir) => (existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).map((f) => join(dir, f))
  : []);

export async function loadProvider(file) {
  const mod = await import(pathToFileURL(file).href);
  if (!mod.meta?.name || typeof mod.submit !== 'function') {
    throw new Error(`${file} is not a provider (needs export meta.name and submit)`);
  }
  return { ...mod, file };
}

// Map name → provider module. `dirs` is overridable for tests.
export async function loadRegistry({ dirs = [BUILTIN_DIR, CUSTOM_DIR] } = {}) {
  const registry = new Map();
  for (const dir of dirs) {
    for (const file of listModules(dir)) {
      const p = await loadProvider(file);
      registry.set(p.meta.name, { ...withDiscovered(p), custom: dir !== BUILTIN_DIR });
    }
  }
  return registry;
}

// Models refreshed by `media.mjs check --live` (discover) replace the static meta models.
function withDiscovered(p) {
  const cached = readJson(join(HOME, 'cache', 'models', `${p.meta.name}.json`), null);
  if (!cached?.capabilities) return p;
  const capabilities = { ...p.meta.capabilities };
  for (const [cap, m] of Object.entries(cached.capabilities)) if (capabilities[cap] && m?.models?.length) capabilities[cap] = { ...capabilities[cap], models: m.models };
  return { ...p, meta: { ...p.meta, capabilities } };
}

export function capabilitiesOf(provider) {
  return Object.keys(provider.meta.capabilities || {});
}
