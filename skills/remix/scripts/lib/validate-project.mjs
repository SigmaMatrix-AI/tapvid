// Static checks of a generated render project (spec §4 step 9.2): every __ASSET alias
// resolves to a file, scene durations match replica.resolved, and sketches / elements follow
// the board determinism rules. Returns { errors, warnings }.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fromPosixRel, readJson } from './common.mjs';

// The board rules (spec §6.2) that keep a component a pure function of t.
const LINT_RULES = [
  [/\bMath\.random\s*\(/, 'Math.random — use a seeded hash of an index instead'],
  [/\bDate\.now\s*\(|\bnew Date\s*\(/, 'wall-clock time — derive everything from t'],
  [/\bperformance\.now\s*\(/, 'performance.now — derive everything from t'],
  [/\b(setTimeout|setInterval|requestAnimationFrame)\s*\(/, 'own timer — render from t only'],
  [/\b(useState|useEffect|useLayoutEffect)\b/, 'React state/effects — a frame must depend on t alone'],
  [/["']?\b(transition|animation)\b["']?\s*:/, 'CSS transition/animation — interpolate from t instead'],
  [/@keyframes/, 'CSS keyframes — interpolate from t instead'],
];

const IMPORT = /^\s*import\s[^'"]*['"]([^'"]+)['"]/gm;

export function lintDeterminism(source) {
  const problems = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const [re, msg] of LINT_RULES) if (re.test(code)) problems.push(msg);
  for (const m of code.matchAll(IMPORT)) if (m[1] !== 'react') problems.push(`imports ${m[1]} — only react may be imported`);
  return problems;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Scene entries of src/index.jsx: { id, duration }.
export function indexEntries(source) {
  return [...source.matchAll(/\{\s*id:\s*'([^']+)',\s*Scene:\s*\w+,\s*duration:\s*([\d.]+)/g)].map((m) => ({ id: m[1], duration: Number(m[2]) }));
}

export function validateProject(dir) {
  const errors = [];
  const warnings = [];
  const metaPath = join(dir, 'project.json');
  if (!existsSync(metaPath) || !existsSync(join(dir, 'src', 'index.jsx'))) return { errors: [`${dir} is not a generated project (run project.mjs)`], warnings };
  const meta = readJson(metaPath);
  const manifest = readJson(join(dir, 'assets', 'manifest.json'), {});
  const sources = walk(join(dir, 'src')).filter((f) => /\.(jsx?|mjs)$/.test(f));

  for (const file of sources) {
    for (const m of readFileSync(file, 'utf-8').matchAll(/__ASSET:([A-Za-z0-9_.-]+)__/g)) {
      const target = manifest[m[1]];
      if (!target) errors.push(`${m[1]}: alias not in assets/manifest.json`);
      else if (!existsSync(join(dir, ...target.split('/')))) errors.push(`${m[1]}: ${target} does not exist`);
    }
  }

  const entries = indexEntries(readFileSync(join(dir, 'src', 'index.jsx'), 'utf-8'));
  if (meta.mode === 'final') {
    const replica = readJson(join(fromPosixRel(dir, meta.replica), 'replica.json'));
    const tolerance = 0.5 / (meta.fps || 30);
    for (const e of entries) {
      const r = replica.resolved?.[e.id];
      if (!r) errors.push(`${e.id}: not in replica.resolved`);
      else if (Math.abs(r.duration - e.duration) > tolerance) errors.push(`${e.id}: duration ${e.duration} s, resolved says ${r.duration} s — regenerate the project`);
    }
    const extra = Object.keys(replica.resolved || {}).filter((k) => !entries.some((e) => e.id === k));
    if (extra.length) errors.push(`resolved has scenes the project lacks: ${extra.join(', ')}`);
  } else warnings.push(`${meta.mode} project: durations are estimates, not checked against resolved`);

  for (const file of sources.filter((f) => /[\\/]src[\\/](sketches|elements)[\\/]/.test(f))) {
    for (const p of lintDeterminism(readFileSync(file, 'utf-8'))) errors.push(`${file.slice(dir.length + 1)}: ${p}`);
  }
  for (const w of meta.warnings || []) warnings.push(w);
  return { errors, warnings };
}
