#!/usr/bin/env node
/*
 * Build a render project into ONE self-contained index.html.
 *
 * esbuild bundles src/index.jsx (the generated timeline entry: every scene wrapper, the
 * template's boards, sketches, elements, design tokens and the runtime) with React into a
 * single inline IIFE. Then:
 *   - `__ASSET:<alias>__` literals are resolved through assets/manifest.json to paths
 *     relative to the output page; an unknown alias fails the build (a broken src would
 *     only show up as a blank frame in the render);
 *   - fonts.json faces are inlined as @font-face rules with the woff2 as data URIs.
 *
 *   node build.mjs [--out index.html]
 *
 * node_modules is a link to ~/.tapvid-video/runtime/node_modules made by project.mjs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const outFile = join(here, opt('out') || 'index.html');
const entry = join(here, 'src', 'index.jsx');
if (!existsSync(entry)) {
  console.error('src/index.jsx not found — run project.mjs to generate the entry.');
  process.exit(1);
}

function resolveAssets(code) {
  const manifestPath = join(here, 'assets', 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf-8')) : {};
  const missing = new Set();
  const out = code.replace(/__ASSET:([A-Za-z0-9_.-]+)__/g, (m, alias) => {
    const target = manifest[alias];
    if (!target) { missing.add(alias); return m; }
    return relative(dirname(outFile), join(here, ...target.split('/'))).split(sep).join('/');
  });
  if (missing.size) {
    console.error(`unknown asset alias(es): ${[...missing].join(', ')} — add them to assets/manifest.json`);
    process.exit(1);
  }
  return out;
}

function fontFaces() {
  const path = join(here, 'fonts.json');
  if (!existsSync(path)) return '';
  const faces = JSON.parse(readFileSync(path, 'utf-8')).faces || [];
  const rules = [];
  for (const f of faces) {
    const rel = f.file || f.path || f.src;
    if (!f.family || !rel) continue;
    const file = [join(here, ...rel.split('/')), join(here, 'fonts', basename(rel))].find((p) => existsSync(p));
    if (!file) { console.error(`font file missing: ${rel}`); process.exit(1); }
    const data = readFileSync(file).toString('base64');
    rules.push(`@font-face{font-family:${JSON.stringify(f.family)};font-weight:${f.weight || 400};font-style:${f.style || 'normal'};`
      + `font-display:block;src:url(data:font/woff2;base64,${data}) format("woff2")}`);
  }
  return rules.join('\n');
}

// Any literal "</script" in the inlined JS would close the <script> tag early. It can only
// occur inside a JS string/regex/comment, where "<\/script" is equivalent.
const escapeForInlineScript = (js) => js.replace(/<\/(script)/gi, '<\\/$1');

const result = await esbuild.build({
  entryPoints: [entry],
  absWorkingDir: here,
  bundle: true,
  format: 'iife',
  minify: true,
  jsx: 'transform',
  loader: { '.jsx': 'jsx', '.js': 'jsx', '.woff2': 'dataurl', '.woff': 'empty', '.ttf': 'empty' },
  outdir: 'out', // never written (write: false); names the CSS output
  logLevel: 'silent',
  write: false,
}).catch((err) => {
  console.error(err.errors?.map((e) => `${e.location?.file || ''}:${e.location?.line || ''} ${e.text}`).join('\n') || err.message);
  process.exit(1);
});

const js = result.outputFiles.filter((f) => f.path.endsWith('.js')).map((f) => f.text).join('\n');
const css = result.outputFiles.filter((f) => f.path.endsWith('.css')).map((f) => f.text).join('\n');
const template = readFileSync(join(here, 'template.html'), 'utf-8');
let html = template.replace('/*__BUNDLE__*/', () => escapeForInlineScript(resolveAssets(js)));
const styles = [fontFaces(), css].filter(Boolean).join('\n');
if (styles) html = html.replace('</head>', () => `<style>${styles}</style>\n</head>`);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html, 'utf-8');
console.log(`built ${relative(here, outFile)} (${(html.length / 1024).toFixed(0)} kb, self-contained)`);
