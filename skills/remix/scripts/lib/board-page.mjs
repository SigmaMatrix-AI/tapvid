// A board's single-file preview page: esbuild bundles board + design.js + React into one
// inline IIFE (classic JSX transform, React from the runtime), template fonts are inlined as data
// URIs, and the page exposes window.scenePlayer { getDuration, seekTo, play, pause, getCurrentTime }.
// Also the Playwright helpers that screenshot such a page at a time.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromPosixRel, readJson, requireRuntime, runtimePath } from './common.mjs';
import { fieldAt } from './board-fields.mjs';

const ENTRY = readFileSync(new URL('./board-entry.jsx', import.meta.url), 'utf-8');
// Families every recording host has, or CSS generics: never linked from Google Fonts.
const SYSTEM_FONTS = new Set(['sans-serif', 'serif', 'monospace', 'system-ui', '-apple-system', 'ui-sans-serif',
  'cursive', 'helvetica', 'helvetica neue', 'arial', 'segoe ui', 'roboto', 'inter', 'times new roman', 'georgia']);
// How long a page may take to mount and to settle its videos after a seek.
const READY_TIMEOUT_MS = 20_000;

// A literal "</script" in the bundle would close the inline tag; "<\/script" is equivalent in JS.
const inlineSafe = (js) => js.replace(/<\/(script)/gi, '<\\/$1');

export function fontFaceCss(templateDir) {
  const faces = readJson(join(templateDir, 'fonts.json'), { faces: [] }).faces || [];
  return faces.map((f) => {
    const file = fromPosixRel(templateDir, f.file);
    if (!f.file || !existsSync(file)) throw new Error(`fonts.json: ${f.file} is missing`);
    const family = String(f.family).replace(/["\\]/g, '');
    return `@font-face{font-family:"${family}";font-weight:${Number(f.weight) || 400};font-style:${f.style === 'italic' ? 'italic' : 'normal'};`
      + `src:url("data:font/woff2;base64,${readFileSync(file).toString('base64')}") format("woff2");font-display:block}`;
  }).join('\n');
}

// Google Fonts links for non-system families design.js names that fonts.json does not ship.
export function fontLinks(designSrc, shipped) {
  const families = [];
  for (const m of designSrc.matchAll(/font(?:Head)?\s*:\s*(["'`])(.*?)\1/g)) {
    for (const raw of m[2].split(',')) {
      const fam = raw.trim().replace(/^['"]+|['"]+$/g, '').trim();
      if (fam && !SYSTEM_FONTS.has(fam.toLowerCase()) && !shipped.has(fam) && !families.includes(fam)) families.push(fam);
    }
  }
  if (!families.length) return [];
  return [`https://fonts.googleapis.com/css2?${families.map((f) => `family=${f.replaceAll(' ', '+')}:wght@300..800`).join('&')}&display=swap`];
}

function shell({ width, height }, links, faceCss, js) {
  const head = links.map((href) => `<link rel="stylesheet" href="${href.replace(/"/g, '%22')}" />`).join('\n')
    + (faceCss ? `\n<style>${faceCss}</style>` : '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
${head}
<style>html,body{margin:0;padding:0;background:#000}#root{position:relative;width:${width}px;height:${height}px;overflow:hidden;container-type:size}</style>
</head>
<body>
<div id="root"></div>
<script>${inlineSafe(js)}</script>
</body>
</html>
`;
}

/**
 * Bundle one board into its single-file page.
 * @param {object} o
 * @param {string} o.templateDir  the template directory (design.js, fonts.json, boards/)
 * @param {string} o.board        board name (the jsx export)
 * @param {object} [o.data]       props (defaults to the board json's example_data)
 * @param {Array}  [o.segments]   segment timings for a segmented board (defaults to example_segments)
 * @param {object} [o.media]      slots { "<path>": { kind: "video" | "image", src, offset } }
 * @param {number} [o.duration]   seconds (defaults to example_duration_ms)
 * @param {object} [o.canvas]     { width, height } (defaults to template.json canvas)
 * @param {string} [o.outFile]    written when given
 * @returns {Promise<string>} the html
 */
export async function bundleBoardPage({ templateDir, board, data, segments, media = {}, duration, canvas, outFile }) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(board)) throw new Error(`invalid board name: ${board}`);
  const meta = readJson(join(templateDir, 'boards', `${board}.json`), {});
  const size = canvas || readJson(join(templateDir, 'template.json'), {}).canvas || { width: 1920, height: 1080 };
  const seconds = duration ?? (meta.example_duration_ms || 0) / 1000;
  if (!(seconds > 0)) throw new Error(`${board}: no duration (pass one or set example_duration_ms)`);
  const segs = segments ?? meta.example_segments;
  const props = { ...(data ?? meta.example_data ?? {}), ...(segs?.length ? { segments: segs } : {}) };
  const designSrc = readFileSync(join(templateDir, 'design.js'), 'utf-8');
  const faces = readJson(join(templateDir, 'fonts.json'), { faces: [] }).faces || [];

  const entry = ENTRY.replaceAll('__NAME__', board)
    .replace('__DURATION__', () => JSON.stringify(Math.round(seconds * 1000) / 1000))
    .replace('__PROPS__', () => JSON.stringify(props))
    .replace('__MEDIA__', () => JSON.stringify(media));
  const dir = mkdtempSync(join(tmpdir(), 'tapvid-board-'));
  let js;
  try {
    const files = { 'entry.jsx': entry, 'design.js': designSrc, [`boards/${board}.jsx`]: readFileSync(join(templateDir, 'boards', `${board}.jsx`), 'utf-8') };
    for (const [rel, src] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), src, 'utf-8');
    }
    const esbuild = requireRuntime('esbuild');
    const result = await esbuild.build({
      entryPoints: [join(dir, 'entry.jsx')], absWorkingDir: dir, nodePaths: [runtimePath()],
      bundle: true, format: 'iife', minify: true, jsx: 'transform', loader: { '.jsx': 'jsx', '.js': 'jsx' },
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', write: false,
    });
    js = result.outputFiles.map((f) => f.text).join('\n');
  } catch (e) {
    const details = (e.errors || []).map((x) => `${x.location?.file ?? ''}:${x.location?.line ?? ''} ${x.text}`).join('\n');
    throw new Error(`${board}: bundle failed: ${details || e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const html = shell(size, fontLinks(designSrc, new Set(faces.map((f) => f.family))), fontFaceCss(templateDir), js);
  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, html, 'utf-8');
  }
  return html;
}

// Media slots of `board` filled from template/refs (refs.mjs): a video slot plays its reference
// clip, offset so board time t shows source time start + t; an image slot shows the reference
// frame. `src(absPath)` turns a file into the URL the page uses.
export function refsMedia(templateDir, board, start, src) {
  const refsDir = join(templateDir, 'refs');
  const refs = readJson(join(refsDir, 'refs.json'), {});
  const fields = readJson(join(templateDir, 'boards', `${board}.json`), {}).schema?.fields || [];
  const media = {};
  for (const [key, ref] of Object.entries(refs)) {
    if (!key.startsWith(`${board}.`)) continue;
    const path = key.slice(board.length + 1);
    const kind = fieldAt(fields, path)?.type === 'image' ? 'image' : 'video';
    const file = kind === 'image' ? ref.frame : ref.clip;
    if (!file || !existsSync(fromPosixRel(refsDir, file))) continue;
    media[path] = { kind, src: src(fromPosixRel(refsDir, file)), ...(kind === 'video' ? { offset: Number((start - ref.window.start).toFixed(3)) } : {}) };
  }
  return media;
}

export async function launch() {
  const { chromium } = requireRuntime('playwright');
  return chromium.launch();
}

// Open a board page at its canvas size. `scale` < 1 screenshots smaller without changing layout.
export async function openPage(browser, htmlFile, { width, height }, { scale = 1 } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.goto(pathToFileURL(htmlFile).href);
  await page.waitForFunction(() => window.scenePlayer && document.fonts.status === 'loaded', null, { timeout: READY_TIMEOUT_MS });
  return page;
}

// Seek to `seconds`, wait for fonts and every <video> to land on its frame, screenshot #root.
export async function captureAt(page, seconds, pngFile) {
  await page.evaluate((s) => window.scenePlayer.seekTo(s), seconds);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).every((v) => v.readyState >= 2 && !v.seeking),
    null, { timeout: READY_TIMEOUT_MS });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  if (pngFile) mkdirSync(dirname(pngFile), { recursive: true });
  return page.locator('#root').screenshot({ path: pngFile });
}
