// Routing (spec §5.5): candidates for a request in order. A request that names a provider gets
// only that one; otherwise the configured order for its capability, else the built-in default
// order, filtered to providers that are configured, not disabled for this run, and fit the
// parameters. TapVid goes first wherever it is configured.
import { join } from 'node:path';
import { HOME, readJson } from '../common.mjs';
import { pickModel } from './adapt.mjs';

export const DEFAULT_ORDER = {
  'video.generate': ['tapvid', 'minimax', 'fal', 'ark', 'kling', 'runway', 'luma', 'gemini', 'replicate'],
  'image.generate': ['tapvid', 'fal', 'openai', 'gemini', 'minimax', 'ark', 'replicate'],
  'speech.synthesize': ['tapvid', 'elevenlabs', 'minimax', 'openai', 'gemini'],
  'speech.voices': ['tapvid', 'elevenlabs', 'minimax', 'openai', 'gemini'],
  'speech.transcribe': ['elevenlabs', 'whisper-local', 'openai'],
  'video.understand': ['gemini'],
  'music.generate': ['elevenlabs', 'minimax'],
  'music.search': ['jamendo'],
  'avatar.generate': ['tapvid', 'fal', 'replicate', 'heygen', 'd-id'],
  'avatar.list': ['tapvid', 'heygen'],
  'video.search': ['youtube', 'pexels', 'pixabay'],
  'video.download': ['ytdlp'],
  // giphy last: it answers animated searches only and the stock providers reject those, so each
  // request reaches the one provider that takes it without a network call to the others.
  'image.search': ['pexels', 'pixabay', 'giphy'],
};

// Capabilities that query every available provider and merge the items.
export const FAN_OUT = new Set(['video.search']);

export function loadConfig(path = join(HOME, 'config.json')) {
  return readJson(path, {});
}

export function providerOrder(capability, registry, config = {}) {
  const configured = config.routing?.[capability] || [];
  const defaults = DEFAULT_ORDER[capability] || [];
  const custom = [...registry.values()].filter((p) => p.custom && p.meta.capabilities?.[capability]).map((p) => p.meta.name);
  const names = [...configured, ...defaults, ...custom];
  if (!configured.length && names.includes('tapvid')) names.unshift('tapvid');
  return [...new Set(names)].filter((n) => registry.get(n)?.meta.capabilities?.[capability]);
}

// → { candidates: [{ provider, model, resolved, modelMeta }], skipped: [{ provider, reason }] }
export function route(request, { registry, config = {}, isAvailable }) {
  const names = request.provider ? [request.provider] : providerOrder(request.capability, registry, config);
  const candidates = [];
  const skipped = [];
  for (const name of names) {
    const provider = registry.get(name);
    if (!provider) { skipped.push({ provider: name, reason: 'unknown provider' }); continue; }
    if (!isAvailable(provider)) { skipped.push({ provider: name, reason: 'not configured' }); continue; }
    // An economy request without a pinned model takes the vendor's cheapest fitting model, over config defaults.
    const economy = request.tier === 'economy' && !request.model;
    const preferred = economy ? null : request.model || config.models?.[request.capability]?.[name];
    const fit = pickModel(request.capability, request.params, provider, preferred, economy ? 'economy' : undefined);
    if (!fit.ok) { skipped.push({ provider: name, reason: fit.reason }); continue; }
    candidates.push({ provider: name, model: fit.resolved.model, resolved: fit.resolved, modelMeta: fit.modelMeta });
  }
  return { candidates, skipped };
}
