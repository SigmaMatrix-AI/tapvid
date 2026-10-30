#!/usr/bin/env node
// Static and determinism checks (spec §4 steps 3.9, 4 and 9.2).
//   node validate.mjs template <clone-project | template-dir>
//   node validate.mjs replica <replica-dir | replica.json>
//   node validate.mjs project <project-dir>
// Prints "error: …" / "warning: …" lines, then "ok" or "<n> error(s)"; exits 1 on errors.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fail, parseArgs } from './lib/common.mjs';
import { validateReplica } from './lib/validate-replica.mjs';
import { validateProject } from './lib/validate-project.mjs';

// validate-template.mjs belongs to the template-building half of the plugin; load it lazily
// so replica and project checks work without it.
async function templateCheck(path) {
  const dir = existsSync(join(path, 'template', 'template.json')) ? join(path, 'template') : path;
  let mod;
  try {
    mod = await import('./lib/validate-template.mjs');
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    fail('template checks are unavailable: scripts/lib/validate-template.mjs is missing from this plugin version');
  }
  const out = await mod.validateTemplate(dir);
  return Array.isArray(out) ? { errors: out, warnings: [] } : { errors: out?.errors || [], warnings: out?.warnings || [] };
}

const args = parseArgs();
const [kind, target] = args._;
const checks = { template: templateCheck, replica: validateReplica, project: validateProject };
if (!checks[kind] || !target) fail('usage: validate.mjs template|replica|project <path>', 2);
// A file path (replica.json, template.json) stands for its directory.
const path = resolve(target);
const { errors, warnings } = await checks[kind](path.endsWith('.json') ? dirname(path) : path);
for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error: ${e}`);
console.log(errors.length ? `${errors.length} error(s)` : 'ok');
if (errors.length) process.exitCode = 1;
