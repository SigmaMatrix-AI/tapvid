#!/usr/bin/env node
// Step 0 (spec §4): install missing system tools with the platform's package manager (local,
// free infrastructure — no question asked), then the shared runtime into ~/.tapvid-video/runtime.
// Idempotent: npm ci is keyed by manifest + lockfile; Chromium is checked on every run. Output: one line
// per finding; the last line is "ready", or "missing: <tools>" when no package manager can install
// them (no Homebrew / winget, or a manual step such as whisper.cpp on Windows).
//   node ensure-runtime.mjs
//   node ensure-runtime.mjs --tool yt-dlp|whisper-cli     ensure one optional tool only
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PLUGIN, RUNTIME, parseArgs } from './lib/common.mjs';
import { npmCommand, platform } from './lib/platform.mjs';
import { ensureRuntime } from './lib/runtime-install.mjs';

const MIN_NODE_MAJOR = 20;
const OPTIONAL_TOOLS = ['yt-dlp', 'whisper-cli'];
const PACKAGE = join(PLUGIN, 'scripts', 'runtime-package.json');
const LOCKFILE = join(PLUGIN, 'scripts', 'runtime-package-lock.json');

function report(missing) {
  const install = platform.installCommand(missing);
  if (install?.text) console.log(`install with: ${install.text}`);
  for (const m of install?.manual || []) console.log(`manual: ${m}`);
  console.log(`missing: ${missing.join(' ')}`);
}

// Install with brew / winget when that package manager is present; returns the tools still missing.
function install(tools) {
  const cmd = platform.installCommand(tools);
  if (!cmd?.cmd || !platform.which(cmd.cmd)) return tools;
  console.log(`installing: ${cmd.text}`);
  spawnSync(cmd.cmd, cmd.args, { stdio: ['ignore', 'inherit', 'inherit'] });
  return tools.filter((t) => !platform.which(t));
}

const args = parseArgs();
if (args.tool) {
  if (!OPTIONAL_TOOLS.includes(args.tool)) {
    console.log(`unknown tool ${args.tool} (expected ${OPTIONAL_TOOLS.join(' | ')})`);
    process.exit(2);
  }
  const left = platform.which(args.tool) ? [] : install([args.tool]);
  if (left.length) report(left);
  else console.log(`${args.tool}: ${platform.which(args.tool)}\nready`);
  process.exit(0);
}

const missing = [];
const major = Number(process.versions.node.split('.')[0]);
if (major < MIN_NODE_MAJOR) {
  console.log(`node ${process.version} is older than ${MIN_NODE_MAJOR}`);
  missing.push('node');
}
for (const tool of ['ffmpeg', 'ffprobe']) if (!platform.which(tool)) missing.push(tool);
const npm = npmCommand();
if (!npm) missing.push('npm');
if (missing.length) {
  // npm ships with node, so installing node covers it; a new node only applies to the next run.
  const left = install([...new Set(missing.map((m) => (m === 'npm' ? 'node' : m)))]);
  if (left.length || missing.includes('node') || missing.includes('npm')) {
    report(left.length ? left : ['node']);
    process.exit(0);
  }
}

try {
  await ensureRuntime({ runtime: RUNTIME, packageFile: PACKAGE, lockFile: LOCKFILE, npm });
  console.log('ready');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
