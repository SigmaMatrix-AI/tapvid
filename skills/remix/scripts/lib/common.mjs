// Shared helpers for tapvid scripts. Runtime packages (playwright, esbuild, tone…) live in
// ~/.tapvid-video/runtime, installed by ensure-runtime.mjs; scripts load them from there with
// createRequire so the skill directory itself needs no node_modules.
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ASSETS_DIR = join(SKILL_ROOT, 'assets');
// Compatibility alias for existing internal callers and integrations.
export const PLUGIN = SKILL_ROOT;
export const HOME = process.env.TAPVID_VIDEO_HOME || join(homedir(), '.tapvid-video');
export const RUNTIME = join(HOME, 'runtime');

export const requireRuntime = createRequire(join(RUNTIME, 'package.json'));

export function runtimePath(...parts) {
  return join(RUNTIME, 'node_modules', ...parts);
}

export function readJson(path, fallback) {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

// Synchronous child process with an argument array (never a shell string).
export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', maxBuffer: 1 << 28, ...opts });
}

// Asynchronous child process; resolves { code, stdout, stderr } (stdout as Buffer when binary).
export function runAsync(cmd, args, { input, binary = false, cwd, env } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', rej);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out);
      res({ code, stdout: binary ? stdout : stdout.toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8') });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Positional args and --flags (a flag followed by a non-flag takes it as its value).
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

export async function launchBrowser() {
  const { chromium } = requireRuntime('playwright');
  return chromium.launch();
}

// Seconds rounded to whole frames.
export const toFrame = (sec, rate) => Number((Math.round(sec * rate) / rate).toFixed(3));

// Paths stored in json are POSIX-style and relative to the file's directory, so a project
// copies between macOS and Windows. toPosixRel writes them, fromPosixRel reads them back.
export function toPosixRel(fromDir, target) {
  const rel = isAbsolute(target) ? relative(fromDir, target) : target;
  return rel.split(sep).join('/');
}

export function fromPosixRel(fromDir, stored) {
  if (!stored) return stored;
  return isAbsolute(stored) ? stored : resolve(fromDir, ...stored.split('/'));
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

// Clone project root: a directory holding source/ or template/.
export function cloneDir(arg) {
  const dir = resolve(arg || '.');
  if (existsSync(join(dir, 'template', 'template.json')) || existsSync(join(dir, 'source'))) return dir;
  if (existsSync(join(dir, 'template.json'))) return dirname(dir);
  throw new Error(`${dir} is not a clone project (no source/ or template/)`);
}

export function replicaDir(project, slug) {
  return join(project, 'replicas', slug);
}

export function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}
