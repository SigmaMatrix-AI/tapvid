// CC0 sample instruments from VSCO 2 Community Edition, downloaded on demand and cached
// as mp3 under ~/.tapvid-video/samples. The repository is ~2.3 GB, so only the files an
// instrument needs are fetched (at most `maxSamples` notes; Tone.Sampler repitches the rest).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, ASSETS_DIR, readJson, run, writeJson } from './common.mjs';

const REPO = 'sgossner/VSCO-2-CE';
const RAW = `https://raw.githubusercontent.com/${REPO}/master/`;
const CACHE = join(HOME, 'samples');
const TREE = join(CACHE, 'vsco-tree.json');
const TREE_TTL_MS = 30 * 24 * 3600 * 1000;

export const catalog = () => readJson(join(ASSETS_DIR, 'template/music/instruments.json'));

async function tree() {
  if (existsSync(TREE) && Date.now() - statSync(TREE).mtimeMs < TREE_TTL_MS) return readJson(TREE);
  const res = await fetch(`https://api.github.com/repos/${REPO}/git/trees/master?recursive=1`,
    { headers: { 'User-Agent': 'tapvid-video' } });
  if (!res.ok) throw new Error(`VSCO tree fetch failed: HTTP ${res.status}`);
  const paths = (await res.json()).tree.filter((x) => x.type === 'blob').map((x) => x.path);
  writeJson(TREE, paths);
  return paths;
}

const NOTE = /(?:^|_)([A-G](?:#|b)?-?\d)(?=_|\.|$)/;
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midiOf(note) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(note);
  return 12 * (Number(m[3]) + 1) + SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteOf = (midi) => `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

// One file per note: the first `prefer` token that matches wins, then evenly thin the
// notes down to maxSamples across the instrument's range.
function pick(paths, spec, maxSamples) {
  const inDir = paths.filter((p) => p.startsWith(`${spec.dir}/`) && p.endsWith('.wav')
    && !p.slice(spec.dir.length + 1).includes('/'));
  const matched = spec.match ? inDir.filter((p) => new RegExp(spec.match).test(p)) : inDir;
  const byMidi = new Map();
  for (const p of matched) {
    const file = p.split('/').pop();
    let midi;
    if (spec.pianoMap) midi = 21 + 2 * Number(/_(\d{3})\.wav$/.exec(file)[1]);
    else { const m = NOTE.exec(file); if (!m) continue; midi = midiOf(m[1]); }
    const rank = (spec.prefer || []).findIndex((tok) => file.includes(tok));
    const score = rank < 0 ? 99 : rank;
    const cur = byMidi.get(midi);
    if (!cur || score < cur.score) byMidi.set(midi, { path: p, score });
  }
  const notes = [...byMidi.keys()].sort((a, b) => a - b);
  const keep = notes.length <= maxSamples ? notes
    : Array.from({ length: maxSamples }, (_, i) => notes[Math.round((i * (notes.length - 1)) / (maxSamples - 1))]);
  return keep.map((midi) => ({ note: noteOf(midi), path: byMidi.get(midi).path }));
}

async function fetchMp3(repoPath, dest, maxSeconds) {
  if (existsSync(dest)) return;
  const res = await fetch(RAW + repoPath.split('/').map(encodeURIComponent).join('/'));
  if (!res.ok) throw new Error(`download failed (${res.status}): ${repoPath}`);
  const wav = `${dest}.wav`;
  writeFileSync(wav, Buffer.from(await res.arrayBuffer()));
  const fade = Math.max(0.1, maxSeconds - 1);
  run('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-t', String(maxSeconds),
    '-af', `afade=t=out:st=${fade}:d=1`, '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '160k', dest]);
  rmSync(wav, { force: true });
}

// Returns { instruments: { name: { release, urls: { note: absPath } } }, oneShots: { name: absPath } }.
export async function ensureSamples(names = [], oneShots = []) {
  const cat = catalog();
  const unknown = [...names.filter((n) => !cat.instruments[n]), ...oneShots.filter((n) => !cat.oneShots[n])];
  if (unknown.length) throw new Error(`unknown instrument(s): ${unknown.join(', ')}`);
  const out = { instruments: {}, oneShots: {} };
  if (!names.length && !oneShots.length) return out;
  const paths = await tree();
  for (const name of names) {
    const spec = cat.instruments[name];
    const dir = join(CACHE, name);
    mkdirSync(dir, { recursive: true });
    const manifest = join(dir, 'notes.json');
    let notes = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf-8')) : null;
    if (!notes) {
      notes = pick(paths, spec, cat.maxSamples);
      if (!notes.length) throw new Error(`no samples matched for ${name}`);
    }
    const urls = {};
    await Promise.all(notes.map(async ({ note, path }) => {
      const dest = join(dir, `${note.replace('#', 's')}.mp3`);
      await fetchMp3(path, dest, 6);
      urls[note] = dest;
    }));
    writeJson(manifest, notes);
    out.instruments[name] = { release: spec.release ?? 1, urls };
  }
  for (const name of oneShots) {
    const dir = join(CACHE, 'one-shots');
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${name}.mp3`);
    await fetchMp3(cat.oneShots[name], dest, 8);
    out.oneShots[name] = dest;
  }
  return out;
}
