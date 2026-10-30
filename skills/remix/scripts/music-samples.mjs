#!/usr/bin/env node
// Download and cache CC0 sample instruments (VSCO 2 CE) for code-composed BGM.
//   node music-samples.mjs --list
//   node music-samples.mjs <instrument>... [--one-shots bass-drum,crash]
// music-compose.mjs fetches what a score declares itself; running this first only warms the cache.
import { catalog, ensureSamples } from './lib/vsco.mjs';
import { parseArgs } from './lib/common.mjs';

const args = parseArgs();
if (args.list) {
  const c = catalog();
  console.log(JSON.stringify({ instruments: Object.keys(c.instruments), oneShots: Object.keys(c.oneShots) }, null, 2));
  process.exit(0);
}
const t0 = Date.now();
const res = await ensureSamples(args._, typeof args['one-shots'] === 'string' ? args['one-shots'].split(',') : []);
const counts = Object.fromEntries(Object.entries(res.instruments).map(([k, v]) => [k, Object.keys(v.urls).length]));
console.log(JSON.stringify({ instruments: counts, oneShots: Object.keys(res.oneShots), seconds: (Date.now() - t0) / 1000 }));
