// Offline contract tests for providers (`media.mjs check <provider>`): replay recorded HTTP
// exchanges against the provider through the real runner, with no network and no waiting.
//
// A fixture is <fixtures>/<provider>/<case>.json:
//   { "capability": "video.generate",
//     "request": { "params": {…}, "model"?: "…" },          // id / provider are filled in
//     "secrets"?: { "NAME": "value" },                        // default: "test-<NAME>" per meta.secrets
//     "exchanges": [ { "request": { "method": "POST", "url": "https://…" | "^regex",
//                                   "bodyIncludes"?: {…},                  // string values may be "^regex"
//                                   "headers"?: { "name": "value" | "^regex" } },
//                      "response": { "status"?: 200, "headers"?: {…},
//                                    "json"? | "text"? | "base64"? | "file"?: "_assets/tiny.mp4" } } ],
//     "expect": { "status": "completed", "files"?: [{ "mime": "video/mp4" }], "items"?: n }
//            | { "status": "failed", "error": "moderation" } }
// Input files in params ("_assets/tiny.png") resolve against the fixtures directory.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from './runner.mjs';

function subset(expected, actual) {
  if (typeof expected === 'string' && typeof actual === 'string') return matchText(expected, actual);
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (actual === null || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([k, v]) => subset(v, actual[k]));
}

const matchText = (pattern, value) => (pattern.startsWith('^') ? new RegExp(pattern).test(value) : pattern === value);

async function bodyOf(init) {
  if (!init?.body) return null;
  if (typeof init.body === 'string') { try { return JSON.parse(init.body); } catch { return init.body; } }
  if (init.body instanceof FormData) return Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${v.type}>`]));
  return null;
}

function headerOf(init, name) {
  const h = init?.headers || {};
  if (h instanceof Headers) return h.get(name);
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : null;
}

export function createReplayFetch(exchanges, fixturesDir) {
  const queue = [...exchanges];
  const fetchImpl = async (url, init = {}) => {
    const next = queue.shift();
    const method = (init.method || 'GET').toUpperCase();
    if (!next) throw new Error(`unexpected request ${method} ${url} (no exchange left)`);
    const want = next.request;
    if ((want.method || 'GET').toUpperCase() !== method || !matchText(want.url, String(url))) {
      throw new Error(`request mismatch: got ${method} ${url}, expected ${want.method || 'GET'} ${want.url}`);
    }
    for (const [name, pattern] of Object.entries(want.headers || {})) {
      const got = headerOf(init, name);
      if (got === null || !matchText(pattern, got)) throw new Error(`header ${name} mismatch on ${url}: got ${got}`);
    }
    if (want.bodyIncludes && !subset(want.bodyIncludes, await bodyOf(init))) {
      throw new Error(`body mismatch on ${url}: ${JSON.stringify(await bodyOf(init)).slice(0, 400)}`);
    }
    const r = next.response || {};
    let body = '';
    const headers = { ...(r.headers || {}) };
    if (r.json !== undefined) { body = JSON.stringify(r.json); headers['content-type'] ??= 'application/json'; }
    else if (r.text !== undefined) body = r.text;
    else if (r.base64 !== undefined) body = Buffer.from(r.base64, 'base64');
    else if (r.file) body = readFileSync(join(fixturesDir, r.file));
    return new Response(body, { status: r.status || 200, headers });
  };
  return { fetchImpl, remaining: () => queue.length };
}

function resolveAssets(value, fixturesDir) {
  if (typeof value === 'string' && value.startsWith('_assets/')) return join(fixturesDir, value);
  if (Array.isArray(value)) return value.map((v) => resolveAssets(v, fixturesDir));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveAssets(v, fixturesDir)]));
  return value;
}

export async function replayCase(provider, fixture, fixturesDir) {
  const work = mkdtempSync(join(tmpdir(), 'tapvid-replay-'));
  try {
    const { fetchImpl, remaining } = createReplayFetch(fixture.exchanges || [], fixturesDir);
    const values = fixture.secrets || Object.fromEntries((provider.meta.secrets || []).map((n) => [n, `test-${n}`]));
    const secrets = { secret: (n) => values[n] ?? null, configured: () => true };
    const registry = new Map([[provider.meta.name, provider]]);
    // A per-case cache so upload caching never leaks between cases or into ~/.tapvid-video.
    const runner = createRunner({ registry, secrets, fetchImpl, cacheDir: join(work, 'cache'), sleep: async () => {} });
    const request = {
      id: 'replay-1', capability: fixture.capability, provider: provider.meta.name, model: fixture.request.model ?? null,
      params: resolveAssets(fixture.request.params, fixturesDir), out: 'out/result',
    };
    const [result] = await runner.runPlan([request], { planDir: work });
    const problems = [];
    const exp = fixture.expect || { status: 'completed' };
    if (result.status !== exp.status) problems.push(`status ${result.status} (expected ${exp.status}) ${JSON.stringify(result.error || '')}`);
    if (exp.error && result.error?.code !== exp.error) problems.push(`error ${result.error?.code} (expected ${exp.error})`);
    if (exp.files) {
      exp.files.forEach((f, i) => {
        const got = result.files?.[i];
        if (!got) problems.push(`missing file ${i}`);
        else {
          if (f.mime && got.mime !== f.mime) problems.push(`file ${i} mime ${got.mime} (expected ${f.mime})`);
          if (!existsSync(join(work, ...got.path.split('/')))) problems.push(`file ${i} not written: ${got.path}`);
        }
      });
    }
    if (exp.items !== undefined && (result.items || []).length !== exp.items) problems.push(`items ${(result.items || []).length} (expected ${exp.items})`);
    if (exp.status === 'completed' && remaining()) problems.push(`${remaining()} exchange(s) not used`);
    return { ok: problems.length === 0, problems, result };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function replayProvider(provider, fixturesRoot) {
  const dir = join(fixturesRoot, provider.meta.name);
  if (!existsSync(dir)) return [{ name: '(none)', ok: false, problems: [`no fixtures in ${dir}`] }];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const fixture = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    try {
      const r = await replayCase(provider, fixture, fixturesRoot);
      out.push({ name: f, ...r });
    } catch (e) {
      out.push({ name: f, ok: false, problems: [e.message] });
    }
  }
  return out;
}
