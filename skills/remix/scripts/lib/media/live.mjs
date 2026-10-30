// `media.mjs check <provider> --live`: one minimal real call per capability, plus a refresh of
// the provider's model list when it can discover models (discover(ctx) → capabilities map,
// cached in ~/.tapvid-video/cache/models/<name>.json and merged over meta by the registry).
// Real calls cost money: media.mjs runs this only with --spend, after the user said yes to the
// cost liveEstimate() lists. discover() only lists models and is free (refreshModels).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOME, PLUGIN, writeJson } from '../common.mjs';
import { createRunner } from './runner.mjs';
import { createCtx } from './ctx.mjs';

const ASSETS = join(PLUGIN, 'scripts', 'providers', '__fixtures__', '_assets');

// The cheapest request per capability; a provider may override with meta.liveSamples[cap].
export const LIVE_SAMPLES = {
  'image.generate': { prompt: 'A single red apple on a white table, studio light', aspect: '1:1' },
  'video.generate': { prompt: 'A slow push-in on a cup of coffee on a wooden table, soft morning light', aspect: '16:9', duration_s: 1 },
  'speech.synthesize': { text: 'Hello from TapVid.', voice: '__first__', language: 'en' },
  'speech.voices': { language: 'en' },
  'speech.transcribe': { file: join(ASSETS, 'tiny.wav'), language: 'en' },
  'video.understand': { file: join(ASSETS, 'tiny.mp4') },
  'music.generate': { prompt: 'calm ambient pad, slow', duration_s: 10, instrumental: true },
  'music.search': { query: 'ambient', limit: 3 },
  'avatar.list': {},
  'video.search': { query: 'product launch video', limit: 3 },
  'image.search': { query: 'coffee', limit: 3 },
};

export const modelCachePath = (name) => join(HOME, 'cache', 'models', `${name}.json`);

// Fetch the provider's current model list and prices into the cache the registry overlays.
export async function refreshModels(provider, ctx) {
  const caps = await provider.discover(ctx);
  writeJson(modelCachePath(provider.meta.name), { at: new Date().toISOString(), capabilities: caps });
  return caps;
}

const capsInOrder = (provider) => Object.keys(provider.meta.capabilities || {}).sort((a, b) => (a === 'speech.voices' ? -1 : b === 'speech.voices' ? 1 : 0));
const sampleOf = (provider, cap) => provider.meta.liveSamples?.[cap] ?? LIVE_SAMPLES[cap];

// What `check --live` would run, each sample with its estimated cost, without calling anything.
export async function liveEstimate(provider) {
  const registry = new Map([[provider.meta.name, provider]]);
  const runner = createRunner({ registry, secrets: { configured: () => true, secret: () => null } });
  const requests = capsInOrder(provider).filter((cap) => sampleOf(provider, cap)).map((cap) => {
    const params = { ...sampleOf(provider, cap) };
    if (params.voice === '__first__') params.voice = 'sample';
    return { id: `live-${cap.replace('.', '-')}`, capability: cap, provider: provider.meta.name, params };
  });
  return runner.estimate(requests);
}

export async function liveCheck(provider, { secrets }) {
  const out = [];
  const ctx = createCtx({ provider: provider.meta.name, secrets });
  if (typeof provider.discover === 'function') {
    try {
      const caps = await refreshModels(provider, ctx);
      out.push({ capability: 'discover', ok: true, detail: `${Object.keys(caps).length} capabilities refreshed` });
    } catch (e) {
      out.push({ capability: 'discover', ok: false, error: e.message });
    }
  }
  const work = mkdtempSync(join(tmpdir(), 'tapvid-live-'));
  try {
    const registry = new Map([[provider.meta.name, provider]]);
    const runner = createRunner({ registry, secrets });
    let voice = null;
    for (const cap of capsInOrder(provider)) {
      const sample = sampleOf(provider, cap);
      if (!sample) { out.push({ capability: cap, ok: true, detail: '(no live sample; skipped)' }); continue; }
      const params = { ...sample };
      if (params.voice === '__first__') {
        if (!voice) { out.push({ capability: cap, ok: false, error: 'no voice from speech.voices' }); continue; }
        params.voice = voice;
      }
      const [r] = await runner.runPlan([{ id: `live-${cap.replace('.', '-')}`, capability: cap, provider: provider.meta.name, params, out: `out/${cap}` }],
        { planDir: work });
      if (cap === 'speech.voices' && r.items?.length) voice = (r.items.find((v) => v.recommended) || r.items[0]).id;
      out.push(r.status === 'completed'
        ? { capability: cap, ok: true, detail: `${r.model || ''} ${r.files ? `${r.files.length} file(s)` : `${r.items?.length ?? 0} item(s)`}` }
        : { capability: cap, ok: false, error: `${r.error?.code}: ${r.error?.message}` });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return out;
}
