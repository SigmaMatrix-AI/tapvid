import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchFonts, latinUrl, patient } from '../../skills/remix/scripts/fonts.mjs';
import { readJson, writeJson } from '../../skills/remix/scripts/lib/common.mjs';

const CSS = (family, weight) => `/* cyrillic */
@font-face { font-family: '${family}'; font-weight: ${weight}; src: url(https://fonts.gstatic.com/s/x/cyr-${weight}.woff2) format('woff2'); }
/* latin */
@font-face { font-family: '${family}'; font-weight: ${weight}; src: url(https://fonts.gstatic.com/s/x/latin-${weight}.woff2) format('woff2'); }
`;

// Offline Google Fonts: Inter and Fredoka are OFL, everything else is unknown.
function fakeFetch(calls = []) {
  return async (url, init = {}) => {
    calls.push(url);
    const res = (status, body = '') => ({ ok: status < 400, status, text: async () => body, arrayBuffer: async () => Buffer.from(body) });
    if (url.includes('raw.githubusercontent.com')) return res(/\/ofl\/(inter|fredoka)\//.test(url) && init.method === 'HEAD' ? 200 : 404);
    const css = url.match(/css2\?family=([^:]+):wght@(\d+)/);
    if (css) return res(200, CSS(decodeURIComponent(css[1]), css[2]));
    if (url.includes('fonts.gstatic.com')) return res(200, `woff2:${url}`);
    return res(404);
  };
}

test('latinUrl picks the latin face', () => {
  assert.equal(latinUrl(CSS('Inter', 700)), 'https://fonts.gstatic.com/s/x/latin-700.woff2');
});

test('fonts downloads open faces and merges fonts.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapvid-fonts-'));
  writeJson(join(dir, 'fonts.json'), { faces: [{ family: 'Inter', weight: 400, style: 'normal', file: 'fonts/old.woff2', license: 'OFL-1.1' },
    { family: 'Caveat', weight: 400, style: 'normal', file: 'fonts/Caveat-400.woff2', license: 'OFL-1.1' }] });
  const out = await fetchFonts({ templateDir: dir, family: 'Inter', weights: [700, 400], fetchImpl: fakeFetch(), log: () => {} });
  assert.equal(out.substitutedFrom, null);
  assert.deepEqual(readJson(join(dir, 'fonts.json')).faces.map((f) => `${f.family}-${f.weight}:${f.file}`),
    ['Caveat-400:fonts/Caveat-400.woff2', 'Inter-400:fonts/Inter-400.woff2', 'Inter-700:fonts/Inter-700.woff2']);
  assert.equal(readFileSync(join(dir, 'fonts', 'Inter-700.woff2'), 'utf-8'), 'woff2:https://fonts.gstatic.com/s/x/latin-700.woff2');
});

test('a non-open family needs --substitute and is swapped for the nearest open one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapvid-fonts-'));
  await assert.rejects(fetchFonts({ templateDir: dir, family: 'Circular', weights: [500], fetchImpl: fakeFetch(), log: () => {} }), /--substitute to use Fredoka/);
  const logs = [];
  const out = await fetchFonts({ templateDir: dir, family: 'Circular', weights: [500], substitute: true, fetchImpl: fakeFetch(), log: (m) => logs.push(m) });
  assert.deepEqual([out.family, out.substitutedFrom], ['Fredoka', 'Circular']);
  assert.ok(logs[0].startsWith('substituting Circular -> Fredoka'));
  assert.deepEqual(readJson(join(dir, 'fonts.json')).faces, [{ family: 'Fredoka', weight: 500, style: 'normal', file: 'fonts/Fredoka-500.woff2', license: 'OFL-1.1' }]);
  assert.ok(existsSync(join(dir, 'fonts', 'Fredoka-500.woff2')));
});

test('patient retries a failed request and gives up after three attempts', async () => {
  let n = 0;
  const flaky = patient(async (url, init) => { n++; assert.ok(init.signal); if (n < 3) throw new TypeError('fetch failed'); return { ok: true, url }; });
  assert.deepEqual(await flaky('https://x'), { ok: true, url: 'https://x' });
  assert.equal(n, 3);
  let m = 0;
  await assert.rejects(() => patient(async () => { m++; throw new TypeError('fetch failed'); })('https://x'), /fetch failed/);
  assert.equal(m, 3);
});
