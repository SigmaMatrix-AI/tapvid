#!/usr/bin/env node
// Step 3.4 (spec §4): download the template's fonts.
//   node fonts.mjs <project> --family "Inter" --weights 400,700 [--substitute]
// Fetches latin woff2 faces from the Google Fonts css2 API into template/fonts/ and records them
// in template/fonts.json { faces: [{ family, weight, style, file, license }] }. Only OFL and
// Apache families ship with a template; any other face needs --substitute, which takes the
// nearest open family and prints the swap (it belongs in report.md).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneDir, fail, parseArgs, readJson, writeJson } from './lib/common.mjs';

const CSS_API = 'https://fonts.googleapis.com/css2';
// google/fonts keeps every family under its licence directory; a METADATA.pb there is the proof.
const LICENSE_ROOT = 'https://raw.githubusercontent.com/google/fonts/main';
const LICENSES = [['ofl', 'OFL-1.1'], ['apache', 'Apache-2.0'], ['ufl', 'UFL-1.0']];
const SHIPPABLE = new Set(['OFL-1.1', 'Apache-2.0']);
// A browser UA makes the css2 API answer with woff2 instead of ttf.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Nearest open family by shape for faces that cannot ship (fetch_font.py's table).
export const SUBSTITUTES = {
  'proxima nova': 'Inter', helvetica: 'Inter', 'helvetica neue': 'Inter', arial: 'Inter',
  'sf pro': 'Inter', 'sf pro display': 'Inter', 'sf pro text': 'Inter', 'segoe ui': 'Inter', avenir: 'Inter',
  gotham: 'Inter', montserrat: 'Inter', circular: 'Fredoka', poppins: 'Fredoka', nunito: 'Fredoka',
  quicksand: 'Fredoka', futura: 'Fredoka',
};
const DEFAULT_SUBSTITUTE = 'Inter';

// A request that hangs is cut off and tried again: a stalled connection to Google Fonts once held a
// clone run for two minutes before failing, and the next attempt took a second.
const FETCH_TIMEOUT_MS = 15000;
const FETCH_ATTEMPTS = 3;

export const patient = (fetchImpl) => async (url, opts = {}) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (e) {
      if (attempt >= FETCH_ATTEMPTS) throw e;
    }
  }
};

const slugOf = (family) => family.toLowerCase().replace(/[^a-z0-9]/g, '');

export async function licenseOf(family, fetchImpl = fetch) {
  for (const [dir, license] of LICENSES) {
    const res = await fetchImpl(`${LICENSE_ROOT}/${dir}/${slugOf(family)}/METADATA.pb`, { method: 'HEAD' });
    if (res.ok) return license;
  }
  return null;
}

// The latin subset's woff2 URL from a css2 response (one @font-face per subset, each after a
// `/* <subset> */` comment); the first face when there is no latin block.
export function latinUrl(css) {
  const parts = css.split(/\/\*\s*([a-z0-9-]+)\s*\*\//);
  const urls = {};
  for (let i = 1; i < parts.length - 1; i += 2) {
    const m = parts[i + 1].match(/src:\s*url\((https:\/\/[^)]+)\)\s*format\(['"]woff2['"]\)/);
    if (m) urls[parts[i]] = m[1];
  }
  const loose = css.match(/src:\s*url\((https:\/\/[^)]+)\)\s*format\(['"]woff2['"]\)/);
  return urls.latin || Object.values(urls)[0] || loose?.[1] || null;
}

export async function fetchFonts({ templateDir, family, weights = [400], substitute = false, fetchImpl: rawFetch = fetch, log = console.log }) {
  const fetchImpl = patient(rawFetch);
  let use = family;
  let license = await licenseOf(family, fetchImpl);
  if (!SHIPPABLE.has(license)) {
    const swap = SUBSTITUTES[family.toLowerCase()] || DEFAULT_SUBSTITUTE;
    if (!substitute) {
      throw new Error(`${family} is ${license ? `licensed ${license}` : 'not an open Google Fonts family'} and cannot ship with the template; `
        + `re-run with --substitute to use ${swap}`);
    }
    use = swap;
    license = await licenseOf(swap, fetchImpl);
    log(`substituting ${family} -> ${use} (${license}); record this in report.md`);
  }
  const fontsDir = join(templateDir, 'fonts');
  mkdirSync(fontsDir, { recursive: true });
  const faces = [];
  for (const weight of [...new Set(weights)].sort((a, b) => a - b)) {
    const res = await fetchImpl(`${CSS_API}?family=${encodeURIComponent(use)}:wght@${weight}&display=swap`, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Google Fonts has no ${use} ${weight} (HTTP ${res.status})`);
    const url = latinUrl(await res.text());
    if (!url) throw new Error(`no woff2 face for ${use} ${weight}`);
    const font = await fetchImpl(url, { headers: { 'User-Agent': UA } });
    if (!font.ok) throw new Error(`download failed for ${use} ${weight} (HTTP ${font.status})`);
    const file = `fonts/${use.replace(/\s+/g, '')}-${weight}.woff2`;
    const bytes = Buffer.from(await font.arrayBuffer());
    writeFileSync(join(templateDir, ...file.split('/')), bytes);
    faces.push({ family: use, weight, style: 'normal', file, license });
    log(`wrote template/${file} (${Math.round(bytes.length / 1024)} KB)`);
  }
  const manifestPath = join(templateDir, 'fonts.json');
  const kept = (readJson(manifestPath, { faces: [] }).faces || [])
    .filter((f) => !faces.some((n) => n.family === f.family && n.weight === f.weight && n.style === f.style));
  writeJson(manifestPath, { faces: [...kept, ...faces] });
  return { family: use, substitutedFrom: use === family ? null : family, faces };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  if (!args._[0] || typeof args.family !== 'string') fail('usage: node fonts.mjs <project> --family "Inter" --weights 400,700 [--substitute]');
  const weights = typeof args.weights === 'string' ? args.weights.split(',').map(Number) : [400];
  if (weights.some((w) => !Number.isInteger(w) || w < 100 || w > 900)) fail(`--weights must be 100..900, got ${args.weights}`);
  try {
    const out = await fetchFonts({ templateDir: join(cloneDir(args._[0]), 'template'), family: args.family, weights, substitute: Boolean(args.substitute) });
    console.log(`design.js should name this family: font: "'${out.family}', sans-serif"`);
  } catch (e) {
    fail(e.message);
  }
}
