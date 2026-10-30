#!/usr/bin/env node
// Media layer runner (spec §5.4).
//   node media.mjs providers [--json] [--verify]
//   node media.mjs plan <replica.json>
//   node media.mjs estimate <plan.json> [--json]
//   node media.mjs run <plan.json | request.json> [--only id1,id2]
//   node media.mjs check <provider> [--live --spend]
//   node media.mjs prices <provider> [--json]
//   node media.mjs spend <replica dir | tasks.json> [--json]
//   node media.mjs account
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HOME, PLUGIN, fail, parseArgs, readJson, writeJson } from './lib/common.mjs';
import { loadRegistry, capabilitiesOf } from './lib/media/registry.mjs';
import { createSecrets } from './lib/media/secrets.mjs';
import { loadConfig } from './lib/media/router.mjs';
import { createRunner, loadPlan, planDirOf, spendFromTasks } from './lib/media/runner.mjs';
import { replayProvider } from './lib/media/replay.mjs';
import { liveCheck, liveEstimate, modelCachePath, refreshModels } from './lib/media/live.mjs';
import { createCtx } from './lib/media/ctx.mjs';
import { check as checkSchema } from './lib/schema.mjs';
import { buildPlan } from './lib/media/plan.mjs';

// verify() results are cached so `providers` does not hit every API on each run.
const VERIFY_TTL_MS = 12 * 3600 * 1000;

const args = parseArgs();
const [cmd, target] = args._;
const registry = await loadRegistry();
const secrets = createSecrets();
const config = loadConfig();

async function verifyProvider(p) {
  if (!secrets.configured(p)) return { ok: false, reason: 'not configured' };
  if (typeof p.verify !== 'function') return { ok: true, reason: 'no verify' };
  const cachePath = join(HOME, 'cache', 'verify.json');
  const cache = readJson(cachePath, {});
  const hit = cache[p.meta.name];
  if (!args.verify && hit && Date.now() - hit.at < VERIFY_TTL_MS) return hit.result;
  let result;
  try {
    const extra = await p.verify(createCtx({ provider: p.meta.name, secrets }));
    result = { ok: true, ...(extra && typeof extra === 'object' ? { unavailable: extra.unavailable || [] } : {}) };
  } catch (e) {
    result = { ok: false, reason: `${e.code || 'error'}: ${e.message}` };
  }
  writeJson(cachePath, { ...cache, [p.meta.name]: { at: Date.now(), result } });
  return result;
}

async function providers() {
  const rows = [];
  for (const p of registry.values()) {
    const configured = secrets.configured(p);
    const v = configured ? await verifyProvider(p) : { ok: false, reason: 'not configured' };
    const unavailable = v.unavailable || [];
    rows.push({
      name: p.meta.name, displayName: p.meta.displayName || p.meta.name, custom: Boolean(p.custom),
      secrets: p.meta.secrets || [], configured, ready: configured && v.ok,
      capabilities: capabilitiesOf(p).filter((c) => !unavailable.includes(c)), reason: v.ok ? null : v.reason,
    });
  }
  const byCapability = {};
  for (const r of rows) for (const c of r.capabilities) (byCapability[c] ??= []).push({ provider: r.name, ready: r.ready });
  if (args.json) { console.log(JSON.stringify({ providers: rows, byCapability }, null, 2)); return; }
  for (const r of rows) {
    console.log(`${r.ready ? '✓' : r.configured ? '!' : '·'} ${r.name.padEnd(14)} ${r.capabilities.join(', ')}${r.reason && r.configured ? `  (${r.reason})` : ''}`);
  }
}

const money = (v, currency) => (currency === 'credits' ? `${v} credits` : `$${v.toFixed(2)}`);
const unitText = (v, currency) => (currency === 'credits' ? `${v} credits` : `$${Number(v.toFixed(4))}`);

// One table of per-model rows (estimate().byModel / spendFromTasks().byModel) and totals per vendor.
function printByModel(byModel, totals) {
  for (const m of byModel) {
    const rate = m.unitPrice !== null && m.unitPrice !== undefined ? `${unitText(m.unitPrice, m.currency)}/${m.unit}${m.resolution ? ` (${m.resolution})` : ''} × ${m.count}` : `${m.count} ×`;
    console.log(`  ${m.provider.padEnd(12)} ${(m.model || '—').padEnd(24)} ${(m.capability || '').padEnd(18)} ${rate.padEnd(34)} ${money(m.subtotal, m.currency)}${m.estimated ? ' (estimated)' : ''}`);
  }
  for (const [p, t] of Object.entries(totals)) console.log(`total ${p}: ${[t.credits ? `${t.credits} credits` : null, t.usd ? `$${t.usd.toFixed(2)}` : null].filter(Boolean).join(' + ') || '0'}`);
}

async function estimate() {
  const runner = createRunner({ registry, secrets, config });
  const out = await runner.estimate(loadPlan(resolve(target)));
  if (args.json) { console.log(JSON.stringify(out, null, 2)); return; }
  for (const r of out.rows) {
    const cost = r.credits ? `${r.credits} credits` : r.usd !== null && r.usd !== undefined ? `$${r.usd.toFixed(2)}` : '-';
    console.log(`${r.id.padEnd(40)} ${(r.provider || '—').padEnd(12)} ${(r.model || '').padEnd(28)} ${cost}${r.note ? `  ${r.note}` : ''}`);
  }
  console.log('\nby model:');
  printByModel(out.byModel, out.totals);
}

// What a replica actually spent, from its tasks.json (for the delivery report).
async function spend() {
  const path = target.endsWith('.json') ? resolve(target) : join(resolve(target), 'tasks.json');
  if (!existsSync(path)) fail(`no ${path}`);
  const out = spendFromTasks(readJson(path));
  if (args.json) { console.log(JSON.stringify(out, null, 2)); return; }
  printByModel(out.byModel, out.totals);
}

const PRICE_UNITS = { creditsPerSecond: ['credits', 's'], creditsPerImage: ['credits', 'image'], usdPerSecond: ['usd', 's'],
  usdPerImage: ['usd', 'image'], usdPer1kChars: ['usd', '1k chars'], usdPerRequest: ['usd', 'request'] };

function priceText(price) {
  return Object.entries(price || {}).filter(([k]) => PRICE_UNITS[k]).flatMap(([k, v]) => {
    const [currency, unit] = PRICE_UNITS[k];
    return typeof v === 'object' && v !== null
      ? Object.entries(v).map(([res, n]) => `${unitText(Number(n), currency)}/${unit} (${res})`)
      : [`${unitText(Number(v), currency)}/${unit}`];
  }).join(' · ') || '—';
}

// A provider's models and price tables per capability; refreshed through discover() (a free model
// listing) when the provider has one and is configured. Never generates anything.
async function prices() {
  let p = registry.get(target);
  if (!p) fail(`unknown provider ${target}`);
  if (typeof p.discover === 'function' && secrets.configured(p)) {
    try {
      await refreshModels(p, createCtx({ provider: target, secrets }));
      p = (await loadRegistry()).get(target);
    } catch (e) {
      console.error(`discover failed (${e.message}); showing the last known prices`);
    }
  }
  const cached = readJson(modelCachePath(target), null);
  const source = cached?.at ? `model list from ${p.meta.displayName || target}, ${cached.at}` : 'built-in price table';
  const models = Object.entries(p.meta.capabilities || {}).flatMap(([capability, m]) => (m.models || []).map((x) => ({
    capability, model: x.id, default: Boolean(x.default), price: x.price || null, text: priceText(x.price),
  })));
  if (args.json) { console.log(JSON.stringify({ provider: target, source, models }, null, 2)); return; }
  console.log(`${p.meta.displayName || target} (${source})`);
  let cap = null;
  for (const m of models) {
    if (m.capability !== cap) { cap = m.capability; console.log(cap); }
    console.log(`  ${m.default ? '*' : ' '} ${m.model.padEnd(28)} ${m.text}`);
  }
}

async function runCmd() {
  const planPath = resolve(target);
  const runner = createRunner({ registry, secrets, config, log: (m) => console.error(m) });
  const only = typeof args.only === 'string' ? args.only.split(',') : undefined;
  const results = await runner.runPlan(loadPlan(planPath), { planDir: planDirOf(planPath), only });
  console.log(JSON.stringify(results.map((r) => ({ id: r.id, status: r.status, provider: r.provider, model: r.model,
    files: r.files?.map((f) => f.path), items: r.items?.length, cost: r.cost, error: r.error })), null, 2));
  if (results.some((r) => r.status !== 'completed')) process.exitCode = 2;
}

async function checkCmd() {
  const p = registry.get(target);
  if (!p) fail(`unknown provider ${target}`);
  const problems = [];
  if (!p.meta.capabilities || !Object.keys(p.meta.capabilities).length) problems.push('meta.capabilities is empty');
  for (const [cap, m] of Object.entries(p.meta.capabilities || {})) {
    try { checkSchema(`capabilities/${cap}`, {}, 'params'); } catch { problems.push(`unknown capability ${cap}`); }
    for (const model of m.models || []) if (!model.id) problems.push(`${cap}: a model without id`);
  }
  for (const fn of ['submit']) if (typeof p[fn] !== 'function') problems.push(`missing export ${fn}`);
  const fixturesRoot = p.custom ? join(HOME, 'providers', '__fixtures__') : join(PLUGIN, 'scripts', 'providers', '__fixtures__');
  const cases = await replayProvider(p, fixturesRoot);
  for (const c of cases) console.log(`${c.ok ? '✓' : '✗'} ${target}/${c.name}${c.ok ? '' : `\n    ${c.problems.join('\n    ')}`}`);
  if (problems.length) console.log(`✗ meta\n    ${problems.join('\n    ')}`);
  const offlineOk = !problems.length && cases.every((c) => c.ok);
  if (args.live && !args.spend) {
    const est = await liveEstimate(p);
    console.log('\n--live makes real, paid calls. It would run one sample per capability:');
    for (const r of est.rows) {
      const cost = r.credits ? `${r.credits} credits` : r.usd !== null && r.usd !== undefined ? `$${r.usd.toFixed(2)}` : r.note ? `(${r.note})` : 'free / unknown';
      console.log(`  ${r.capability.padEnd(18)} ${(r.model || '').padEnd(24)} ${cost}`);
    }
    for (const [name, t] of Object.entries(est.totals)) console.log(`total ${name}: ${[t.credits ? `${t.credits} credits` : null, t.usd ? `$${t.usd.toFixed(2)}` : null].filter(Boolean).join(' + ') || '0'}`);
    console.log('This costs money. Ask the user for an explicit yes, then rerun with --live --spend. Prices alone: media.mjs prices ' + target);
    process.exitCode = 2;
    return;
  }
  if (args.live) {
    const live = await liveCheck(p, { secrets });
    for (const l of live) console.log(`${l.ok ? '✓' : '✗'} live ${l.capability}${l.ok ? ` ${l.detail || ''}` : `: ${l.error}`}`);
    if (live.some((l) => !l.ok)) process.exitCode = 1;
  }
  if (!offlineOk) process.exitCode = 1;
}

async function account() {
  for (const p of registry.values()) {
    if (typeof p.account !== 'function' || !secrets.configured(p)) continue;
    try {
      const a = await p.account(createCtx({ provider: p.meta.name, secrets }));
      console.log(`${p.meta.name}: ${a.credits !== undefined ? `${a.credits} credits` : `$${a.usd}`}`);
    } catch (e) {
      console.log(`${p.meta.name}: ${e.message}`);
    }
  }
}

async function planCmd() {
  const replicaPath = resolve(target);
  const runner = createRunner({ registry, secrets, config });
  const plan = buildPlan(replicaPath, { route: (req) => runner.candidatesFor(req) });
  writeJson(join(planDirOf(replicaPath), 'plan.json'), plan);
  console.log(`plan.json: ${plan.requests.length} requests`);
  for (const w of plan.warnings || []) console.log(`warning: ${w}`);
}

const commands = { providers, estimate, run: runCmd, check: checkCmd, prices, spend, account, plan: planCmd };
if (!commands[cmd]) fail('usage: media.mjs providers|plan|estimate|run|check|prices|spend|account …');
if (cmd !== 'providers' && cmd !== 'account' && !target) fail(`usage: media.mjs ${cmd} <target>`);
await commands[cmd]();
