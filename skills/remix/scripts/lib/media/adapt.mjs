// Fit a request to one model's capabilities (spec §5.2 "fit to the model"). A model entry in a
// provider's meta.capabilities[cap].models looks like:
//
//   { id, default?, aspects?: ['16:9', …],
//     duration?: { min, max, step? } | durations?: [5, 10],        // video / music, seconds
//     resolutions?: [{ name: '768P', shortEdge: 768 }, …],          // video / image, ascending
//     firstFrame?, lastFrame?, maxRefs?, maxRefVideos?, refVideoMaxS?,
//     modes?: ['tts', 'audio'],                                     // avatar
//     maxChars?,                                                    // speech
//     price?: { usdPerSecond?: n | { <resolution>: n }, usdPerImage?, usdPer1kChars?, usdPerRequest?,
//               creditsPerSecond?: n | { <resolution>: n }, creditsPerImage? } }
//
// adaptToModel returns { ok: true, resolved } with the parameters to send, or { ok: false, reason }.

const ratio = (aspect) => {
  const [w, h] = String(aspect).split(':').map(Number);
  return w / h;
};

function fitAspect(aspect, aspects) {
  if (!aspect || !aspects?.length || aspects.includes(aspect)) return { aspect, crop: false };
  const target = ratio(aspect);
  const best = [...aspects].sort((a, b) => Math.abs(Math.log(ratio(a) / target)) - Math.abs(Math.log(ratio(b) / target)))[0];
  return { aspect: best, crop: true };
}

function fitDuration(need, model) {
  if (need === undefined) return { ok: true };
  if (model.durations?.length) {
    const sorted = [...model.durations].sort((a, b) => a - b);
    const pick = sorted.find((d) => d >= need - 1e-6);
    return pick === undefined ? { ok: false, reason: `duration ${need}s exceeds ${sorted.at(-1)}s` } : { ok: true, duration: pick };
  }
  if (model.duration) {
    const { min = 0, max = Infinity, step = 1 } = model.duration;
    const d = Math.max(min, Math.ceil((need - 1e-6) / step) * step);
    return d > max ? { ok: false, reason: `duration ${need}s exceeds ${max}s` } : { ok: true, duration: d };
  }
  return { ok: true, duration: need };
}

function fitResolution(minShortEdge, resolutions) {
  if (!resolutions?.length) return {};
  const sorted = [...resolutions].sort((a, b) => a.shortEdge - b.shortEdge);
  if (!minShortEdge) return { resolution: sorted[0].name, shortEdge: sorted[0].shortEdge };
  const pick = sorted.find((r) => r.shortEdge >= minShortEdge);
  if (pick) return { resolution: pick.name, shortEdge: pick.shortEdge };
  const top = sorted.at(-1);
  return { resolution: top.name, shortEdge: top.shortEdge, lowRes: true };
}

export function adaptToModel(capability, params, model) {
  const resolved = { model: model.id };
  const refs = params.refs || [];
  const refVideos = params.ref_videos || [];
  if (refs.length > (model.maxRefs ?? 0)) return { ok: false, reason: `${refs.length} reference images > ${model.maxRefs ?? 0}` };
  if (refVideos.length > (model.maxRefVideos ?? 0)) return { ok: false, reason: `reference video not supported (max ${model.maxRefVideos ?? 0})` };
  if (params.first_frame && !model.firstFrame) return { ok: false, reason: 'first frame not supported' };
  if (params.last_frame && !model.lastFrame) return { ok: false, reason: 'last frame not supported' };
  if (capability === 'avatar.generate' && model.modes && !model.modes.includes(params.mode)) {
    return { ok: false, reason: `avatar mode ${params.mode} not supported` };
  }
  if (capability === 'speech.synthesize' && model.maxChars && params.text.length > model.maxChars) {
    return { ok: false, reason: `text longer than ${model.maxChars} chars` };
  }
  if (params.aspect) Object.assign(resolved, fitAspect(params.aspect, model.aspects));
  if (capability === 'video.generate' || capability === 'music.generate') {
    const d = fitDuration(params.duration_s, model);
    if (!d.ok) return d;
    if (d.duration !== undefined) resolved.duration = d.duration;
  }
  if (capability === 'video.generate' || capability === 'image.generate') {
    Object.assign(resolved, fitResolution(params.min_short_edge, model.resolutions));
  }
  if (refVideos.length && model.refVideoMaxS) resolved.refVideoMaxS = model.refVideoMaxS;
  return { ok: true, resolved };
}

// Models in preference order: the configured one, then defaults, then the rest as listed.
export function orderedModels(capMeta, preferredId) {
  const models = capMeta?.models || [];
  const preferred = models.filter((m) => m.id === preferredId);
  const defaults = models.filter((m) => m.default && m.id !== preferredId);
  const rest = models.filter((m) => !m.default && m.id !== preferredId);
  return [...preferred, ...defaults, ...rest];
}

// tier 'economy' (small, short-lived slots): the cheapest fitting model instead of the first one,
// among those that meet the resolution and aspect when any does.
export function pickModel(capability, params, provider, preferredId, tier) {
  const capMeta = provider.meta.capabilities?.[capability];
  if (!capMeta) return { ok: false, reason: `${provider.meta.name} has no ${capability}` };
  const models = orderedModels(capMeta, preferredId);
  if (!models.length) return { ok: true, resolved: { model: null } };
  const reasons = [];
  const fits = [];
  for (const m of models) {
    const fit = adaptToModel(capability, params, m);
    if (fit.ok && tier !== 'economy') return { ...fit, modelMeta: m };
    if (fit.ok) fits.push({ ...fit, modelMeta: m });
    else reasons.push(`${m.id}: ${fit.reason}`);
  }
  if (!fits.length) return { ok: false, reason: reasons.join('; ') };
  const exact = fits.filter((f) => !f.resolved.lowRes && !f.resolved.crop);
  const price = (f) => {
    const est = estimateFromMeta(capability, { params, resolved_params: f.resolved }, f.modelMeta);
    return est.credits ?? est.usd ?? Infinity;
  };
  return [...(exact.length ? exact : fits)].sort((a, b) => price(a) - price(b))[0];
}

const perRes = (v, res) => (typeof v === 'object' && v !== null ? v[res] ?? Object.values(v)[0] : v);

// Generic estimate from a model's price table; providers call it from estimate().
export function estimateFromMeta(capability, request, modelMeta) {
  const price = modelMeta?.price;
  if (!price) return { usd: null, credits: null };
  const r = request.resolved_params || {};
  const p = request.params || {};
  const seconds = r.duration ?? p.duration_s ?? estimateSpeechSeconds(p.text || p.script);
  const out = { usd: null, credits: null };
  if (price.usdPerSecond !== undefined) out.usd = perRes(price.usdPerSecond, r.resolution) * seconds;
  if (price.usdPerImage !== undefined) out.usd = price.usdPerImage;
  if (price.usdPer1kChars !== undefined) out.usd = (price.usdPer1kChars * (p.text || p.script || '').length) / 1000;
  if (price.usdPerRequest !== undefined) out.usd = (out.usd ?? 0) + price.usdPerRequest;
  if (price.creditsPerSecond !== undefined) out.credits = perRes(price.creditsPerSecond, r.resolution) * seconds;
  if (price.creditsPerImage !== undefined) out.credits = price.creditsPerImage;
  if (out.usd !== null) out.usd = Number(out.usd.toFixed(4));
  if (out.credits !== null) out.credits = Math.ceil(out.credits);
  return out;
}

// The billing unit of a model's price table and how many of them one request uses, with the same
// precedence as estimateFromMeta (credits first) → { unit, unitPrice, count, currency } or null.
export function priceUnit(capability, request, modelMeta) {
  const price = modelMeta?.price;
  if (!price) return null;
  const r = request.resolved_params || {};
  const p = request.params || {};
  const seconds = () => r.duration ?? p.duration_s ?? estimateSpeechSeconds(p.text || p.script);
  if (price.creditsPerImage !== undefined) return { unit: 'image', unitPrice: price.creditsPerImage, count: 1, currency: 'credits' };
  if (price.creditsPerSecond !== undefined) return { unit: 'second', unitPrice: perRes(price.creditsPerSecond, r.resolution), count: seconds(), currency: 'credits' };
  if (price.usdPerImage !== undefined) return { unit: 'image', unitPrice: price.usdPerImage, count: 1, currency: 'usd' };
  if (price.usdPerSecond !== undefined) return { unit: 'second', unitPrice: perRes(price.usdPerSecond, r.resolution), count: seconds(), currency: 'usd' };
  if (price.usdPer1kChars !== undefined) return { unit: '1k chars', unitPrice: price.usdPer1kChars, count: (p.text || p.script || '').length / 1000, currency: 'usd' };
  if (price.usdPerRequest !== undefined) return { unit: 'request', unitPrice: price.usdPerRequest, count: 1, currency: 'usd' };
  return null;
}

// Rough speech length for estimates: CJK ~4.5 chars/s, otherwise ~15 chars/s.
export function estimateSpeechSeconds(text = '') {
  const cjk = (String(text).match(/[㐀-鿿぀-ヿ가-힯]/g) || []).length;
  return cjk / 4.5 + (String(text).length - cjk) / 15;
}
