// The media runner (spec §5.4): route each request, submit, poll, download, and keep a ledger
// (tasks.json) so a re-run never submits a finished or in-flight request twice.
//
// Requests may depend on one another: a params string "@<id>" (or "@<id>[n]") is replaced by
// that request's n-th output file once it completes, and "after": [ids] orders without a value.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJson, toPosixRel, writeJson } from '../common.mjs';
import { check } from '../schema.mjs';
import { estimateFromMeta, priceUnit } from './adapt.mjs';
import { createCtx, mimeOf } from './ctx.mjs';
import { MediaError, asMediaError } from './errors.mjs';
import { FAN_OUT, route } from './router.mjs';

// Requests in flight at once across all providers (the TapVid task limit is 10 too).
export const MAX_IN_FLIGHT = 10;
// Defaults when a provider's meta does not say: concurrent jobs, poll interval, job timeout.
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_POLL_S = 5;
const DEFAULT_TIMEOUT_S = 1800;

const REF = /^@([A-Za-z0-9._-]+)(?:\[(\d+)\])?$/;

export function paramsHash(request) {
  const { capability, provider = null, model = null, params } = request;
  return createHash('sha256').update(JSON.stringify({ capability, provider, model, params })).digest('hex').slice(0, 16);
}

export function dependenciesOf(request) {
  const deps = new Set(request.after || []);
  const walk = (v) => {
    if (typeof v === 'string') { const m = v.match(REF); if (m) deps.add(m[1]); } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(request.params);
  return [...deps];
}

function resolveRefs(value, results) {
  if (typeof value === 'string') {
    const m = value.match(REF);
    if (!m) return value;
    const files = results.get(m[1])?.files || [];
    const f = files[Number(m[2] || 0)];
    if (!f) throw new MediaError('invalid', `${value}: no such output`);
    return f.path;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, results));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, results)]));
  return value;
}

export function loadPlan(path) {
  const doc = readJson(path);
  return Array.isArray(doc.requests) ? doc.requests : [doc];
}

function validateRequests(requests) {
  const errors = [];
  const ids = new Set();
  for (const r of requests) {
    errors.push(...check('envelope', r, 'request').map((e) => `${r.id}: ${e}`));
    if (ids.has(r.id)) errors.push(`${r.id}: duplicate id`);
    ids.add(r.id);
    // "@id" placeholders are resolved later; validate everything else against the capability.
    const probe = JSON.parse(JSON.stringify(r.params || {}), (k, v) => (typeof v === 'string' && REF.test(v) ? 'ref' : v));
    if (r.capability) errors.push(...check(`capabilities/${r.capability}`, probe, 'params').map((e) => `${r.id}: ${e}`));
  }
  for (const r of requests) for (const d of dependenciesOf(r)) if (!ids.has(d)) errors.push(`${r.id}: depends on unknown ${d}`);
  return errors;
}

export function createRunner({ registry, secrets, config = {}, fetchImpl, cacheDir, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const disabled = new Set();
  const isAvailable = (p) => !disabled.has(p.meta.name) && secrets.configured(p);

  function candidatesFor(request) {
    return route(request, { registry, config, isAvailable });
  }

  async function estimate(requests) {
    const rows = [];
    const totals = {};
    const byModel = new Map();
    for (const r of requests) {
      const { candidates, skipped } = candidatesFor(r);
      const c = candidates[0];
      if (!c) { rows.push({ id: r.id, capability: r.capability, provider: null, note: skipped.map((s) => `${s.provider}: ${s.reason}`).join('; ') || 'no provider' }); continue; }
      const provider = registry.get(c.provider);
      const req = { ...r, model: c.model, resolved_params: c.resolved };
      const est = provider.estimate ? await provider.estimate(r.capability, req) : estimateFromMeta(r.capability, req, c.modelMeta);
      const usd = est?.usd ?? null;
      const credits = est?.credits ?? null;
      rows.push({ id: r.id, capability: r.capability, provider: c.provider, model: c.model, resolved_params: c.resolved, usd, credits });
      const t = (totals[c.provider] ??= { usd: 0, credits: 0 });
      t.usd += usd || 0;
      t.credits += credits || 0;
      const u = priceUnit(r.capability, req, c.modelMeta) || { unit: 'request', unitPrice: null, count: 1, currency: credits !== null ? 'credits' : 'usd' };
      const key = [c.provider, c.model, r.capability, u.unit, u.unitPrice, c.resolved?.resolution].join('|');
      const m = byModel.get(key) || { provider: c.provider, model: c.model, capability: r.capability, unit: u.unit, unitPrice: u.unitPrice,
        resolution: c.resolved?.resolution || null, count: 0, subtotal: 0, currency: u.currency };
      byModel.set(key, { ...m, count: m.count + u.count, subtotal: m.subtotal + ((m.currency === 'credits' ? credits : usd) || 0) });
    }
    return { rows, totals, byModel: [...byModel.values()].map(roundModelRow) };
  }

  // Run one request against its candidates. Returns the result envelope.
  async function runOne(request, record, ctxFor, persist) {
    const { candidates, skipped } = candidatesFor(request);
    if (!candidates.length) {
      const reason = skipped.map((s) => `${s.provider}: ${s.reason}`).join('; ') || `no provider for ${request.capability}`;
      return { id: request.id, status: 'failed', error: { code: 'unsupported', message: reason } };
    }
    if (FAN_OUT.has(request.capability) && !request.provider) return fanOut(request, candidates, ctxFor);
    let last;
    for (const c of candidates) {
      if (disabled.has(c.provider)) continue;
      const provider = registry.get(c.provider);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await execute(request, record, c, provider, ctxFor(c.provider), persist);
          return result;
        } catch (e) {
          const err = asMediaError(e);
          last = err;
          record.tried = [...(record.tried || []), { provider: c.provider, model: c.model, error: err.toJSON() }];
          // Only a job the provider reports failed is dropped; after a timeout or a lost connection the
          // job may still finish, so the next attempt (or a rerun) polls it again instead of resubmitting.
          if (e?.jobFailed) record.jobId = null;
          persist();
          log(`${request.id}: ${c.provider} failed (${err.code}) ${err.message}`);
          if (err.code === 'transient' && attempt === 0) continue;
          if (err.code === 'auth' || err.code === 'quota') disabled.add(c.provider);
          if (err.code === 'moderation') return { id: request.id, status: 'failed', provider: c.provider, model: c.model, error: err.toJSON() };
          break;
        }
      }
    }
    return { id: request.id, status: 'failed', error: (last || new MediaError('unsupported', 'all providers failed')).toJSON() };
  }

  async function execute(request, record, c, provider, ctx, persist) {
    const meta = provider.meta;
    const req = { ...request, provider: c.provider, model: c.model, resolved_params: c.resolved };
    let jobId = record.jobId && record.provider === c.provider ? record.jobId : null;
    let result;
    if (!jobId) {
      const sub = await provider.submit(request.capability, req, ctx);
      if (sub?.result) result = sub.result;
      else if (sub?.jobId) {
        jobId = sub.jobId;
        Object.assign(record, { provider: c.provider, model: c.model, resolved_params: c.resolved, jobId, status: 'submitted' });
        persist();
      } else throw new MediaError('transient', `${c.provider}.submit returned neither jobId nor result`);
    }
    if (!result) {
      const deadline = Date.now() + (meta.timeoutS || DEFAULT_TIMEOUT_S) * 1000;
      for (;;) {
        let st;
        try {
          st = await provider.poll(request.capability, jobId, ctx, req);
        } catch (e) {
          // A dropped connection while polling or downloading the result is not the job failing.
          const err = asMediaError(e);
          if (err.code !== 'transient' || Date.now() > deadline) throw err;
          log(`${request.id}: ${c.provider} poll of job ${jobId} failed (${err.message}); retrying`);
          await sleep((meta.pollIntervalS || DEFAULT_POLL_S) * 1000);
          continue;
        }
        if (st.status === 'completed') { result = st.result; break; }
        if (st.status === 'failed') {
          const err = asMediaError(st.error?.code ? st.error : new MediaError('transient', st.error?.message || 'job failed'));
          err.jobFailed = true;
          throw err;
        }
        if (Date.now() > deadline) throw new MediaError('transient', `${c.provider} job ${jobId} timed out`);
        await sleep((meta.pollIntervalS || DEFAULT_POLL_S) * 1000);
      }
    }
    return {
      id: request.id, status: 'completed', provider: c.provider, model: c.model, resolved_params: c.resolved,
      files: (result.files || null), items: result.items || null,
      cost: result.cost || estimateCost(request, req, provider, c),
      error: null,
    };
  }

  function estimateCost(request, req, provider, c) {
    const est = estimateFromMeta(request.capability, req, c.modelMeta);
    return { usd: est.usd, credits: est.credits, estimated: true };
  }

  async function fanOut(request, candidates, ctxFor) {
    const settled = await Promise.allSettled(candidates.map(async (c) => {
      const provider = registry.get(c.provider);
      const req = { ...request, provider: c.provider, model: c.model, resolved_params: c.resolved };
      const sub = await provider.submit(request.capability, req, ctxFor(c.provider));
      return (sub.result?.items || []).map((it) => ({ ...it, provider: c.provider }));
    }));
    const items = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value);
    const errors = settled.filter((s) => s.status === 'rejected').map((s) => asMediaError(s.reason).toJSON());
    if (!items.length && errors.length) return { id: request.id, status: 'failed', error: errors[0] };
    return { id: request.id, status: 'completed', provider: candidates.map((c) => c.provider).join(','), model: null, files: null, items, cost: null, error: null };
  }

  // Run a whole plan. `planDir` is where relative paths resolve and tasks.json lives.
  async function runPlan(requests, { planDir, tasksPath = join(planDir, 'tasks.json'), only } = {}) {
    const errors = validateRequests(requests);
    if (errors.length) throw new Error(`invalid plan:\n${errors.join('\n')}`);
    const ledger = readJson(tasksPath, { version: 1, tasks: {} });
    const persist = () => writeJson(tasksPath, ledger);
    const results = new Map();
    const logs = [];
    const ctxFor = (name) => createCtx({ provider: name, secrets, fetchImpl, logs, cwd: planDir, ...(cacheDir ? { cacheDir } : {}) });
    const selected = only ? requests.filter((r) => only.includes(r.id)) : requests;
    const byId = new Map(requests.map((r) => [r.id, r]));

    // Completed records with an unchanged request are reused as they are.
    for (const r of requests) {
      const rec = ledger.tasks[r.id];
      if (rec?.status === 'completed' && rec.hash === paramsHash(r) && filesExist(rec.result, planDir)) results.set(r.id, rec.result);
    }

    const pending = new Set(selected.filter((r) => !results.has(r.id)).map((r) => r.id));
    const inFlight = new Map();
    const perProvider = new Map();
    const deps = new Map(requests.map((r) => [r.id, dependenciesOf(r)]));
    // Dependencies outside --only that are not finished must run too.
    for (const id of [...pending]) for (const d of deps.get(id)) if (!results.has(d)) pending.add(d);

    const ready = (id) => deps.get(id).every((d) => results.get(d)?.status === 'completed');
    const blocked = (id) => deps.get(id).some((d) => results.get(d)?.status === 'failed');

    while (pending.size || inFlight.size) {
      for (const id of [...pending]) {
        if (blocked(id)) {
          pending.delete(id);
          const res = { id, status: 'failed', error: { code: 'invalid', message: `a request it depends on failed: ${deps.get(id).join(', ')}` } };
          results.set(id, res);
          ledger.tasks[id] = { ...(ledger.tasks[id] || {}), id, status: 'failed', result: res, updated_at: new Date().toISOString() };
          persist();
          continue;
        }
        if (!ready(id) || inFlight.size >= MAX_IN_FLIGHT) continue;
        const request = byId.get(id);
        const first = candidatesFor(request).candidates[0]?.provider;
        const limit = registry.get(first)?.meta.concurrency || DEFAULT_CONCURRENCY;
        if (first && (perProvider.get(first) || 0) >= limit) continue;
        pending.delete(id);
        if (first) perProvider.set(first, (perProvider.get(first) || 0) + 1);
        const hash = paramsHash(request);
        const prev = ledger.tasks[id];
        const record = prev && prev.hash === hash && prev.status !== 'failed'
          ? prev
          : { id, capability: request.capability, hash, attempts: (prev?.attempts || 0), created_at: new Date().toISOString() };
        record.attempts = (record.attempts || 0) + 1;
        record.status = record.jobId ? 'submitted' : 'running';
        ledger.tasks[id] = record;
        persist();
        const job = (async () => {
          let resolved;
          try {
            resolved = { ...request, params: resolveRefs(request.params, results) };
          } catch (e) {
            return { id, status: 'failed', error: asMediaError(e).toJSON() };
          }
          return runOne(resolved, record, ctxFor, persist);
        })().then((res) => {
          const normalized = normalizeResult(res, planDir);
          results.set(id, normalized);
          Object.assign(record, { status: normalized.status, provider: normalized.provider ?? record.provider, model: normalized.model ?? record.model,
            resolved_params: normalized.resolved_params ?? record.resolved_params, result: normalized, cost: normalized.cost ?? null, updated_at: new Date().toISOString() });
          persist();
        }).finally(() => {
          inFlight.delete(id);
          if (first) perProvider.set(first, perProvider.get(first) - 1);
        });
        inFlight.set(id, job);
      }
      if (inFlight.size) await Promise.race(inFlight.values());
      else if (pending.size) {
        // Nothing can start: a cycle or an unsatisfiable dependency.
        for (const id of pending) results.set(id, { id, status: 'failed', error: { code: 'invalid', message: 'dependency cycle' } });
        pending.clear();
      }
    }
    if (logs.length) ledger.log = [...(ledger.log || []), ...logs].slice(-500);
    persist();
    return selected.map((r) => results.get(r.id));
  }

  return { runPlan, estimate, candidatesFor, disabled };
}

const roundModelRow = (m) => ({ ...m, count: Number(m.count.toFixed(2)), subtotal: Number(m.subtotal.toFixed(m.currency === 'credits' ? 0 : 4)) });

// Actual spend from a tasks.json ledger, aggregated like estimate().byModel: one row per vendor /
// model / capability with the generated assets and their recorded cost (estimated when the vendor
// reported none), plus totals per vendor.
export function spendFromTasks(ledger) {
  const byModel = new Map();
  const totals = {};
  for (const t of Object.values(ledger?.tasks || {})) {
    const cost = t.cost ?? t.result?.cost;
    const provider = t.provider ?? t.result?.provider;
    if (t.status !== 'completed' || !cost || !provider) continue;
    const model = t.model ?? t.result?.model ?? null;
    const currency = cost.credits !== null && cost.credits !== undefined ? 'credits' : 'usd';
    const amount = (currency === 'credits' ? cost.credits : cost.usd) || 0;
    const key = [provider, model, t.capability].join('|');
    const m = byModel.get(key) || { provider, model, capability: t.capability || null, count: 0, subtotal: 0, currency, estimated: false };
    byModel.set(key, { ...m, count: m.count + 1, subtotal: m.subtotal + amount, estimated: m.estimated || Boolean(cost.estimated) });
    const tot = totals[provider] || { usd: 0, credits: 0 };
    totals[provider] = { ...tot, [currency]: tot[currency] + amount };
  }
  return { byModel: [...byModel.values()].map(roundModelRow), totals };
}

function filesExist(result, planDir) {
  return (result?.files || []).every((f) => existsSync(join(planDir, ...f.path.split('/'))) || existsSync(f.path));
}

// Store output paths POSIX-relative to the plan directory and fill in missing mime types.
function normalizeResult(res, planDir) {
  if (!res.files) return res;
  return {
    ...res,
    files: res.files.map((f) => ({ ...f, path: toPosixRel(planDir, f.path), mime: f.mime || mimeOf(f.path) })),
  };
}

export const planDirOf = (planPath) => dirname(planPath);
