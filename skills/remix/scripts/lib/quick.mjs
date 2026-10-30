// The low-tier template (references/specs/video-clone-tiers.spec.md §3.2): analysis/shots.json → one generic
// board per scene (the original's layout as layers — avatar, pixel, screen and code regions — under the
// original's on-screen texts), the analysis files the existing scripts read (boards.json, elements.json),
// template.json, design.js and skill/SKILL.md.
// Pure: quickTemplate() returns the files; quick.mjs writes them and builds the refs and previews.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN } from './common.mjs';

const BOARD_SOURCE = join(PLUGIN, 'scripts', 'lib', 'quick-board.jsx');
// Replacement text may run this much longer than the original before the field refuses it.
const TEXT_SLACK = 1.5;
const LINE_SLACK = 1.3;
// The low tier asks for at most a 720-pixel short edge (MiniMax H3 768P, upscaled in the render): sharp
// enough for full-frame phone footage at a fraction of the 1080p price; a smaller region asks for its size.
const SHORT_EDGE_PX = 720;
// The longest clip a reference-to-video model makes (TapVid's Seedance and MiniMax H3 stop at 15 s).
const MAX_GENERATED_S = 15;
// A word belongs to the scene its start falls in, with this much slack for a word starting on the cut.
const WORD_SLACK_S = 0.05;
const DEFAULT_PALETTE = { bg: '#000000', fg: '#FFFFFF', accent: '#FFD60A', plate: 'rgba(0,0,0,0.55)', shadow: 'rgba(0,0,0,0.45)' };
const ROLE = { avatar: 'presenter', pixel: 'broll', screen: 'screen' };
const ELEMENT = { avatar: ['presenter', 'footage'], pixel: ['footage', 'footage'], screen: ['screen', 'recording'], code: ['picture', 'still'] };
// Fills a reference video model generates, so a scene holding one is limited to MAX_GENERATED_S.
const GENERATED = ['pixel', 'screen'];
// Field keys the board already uses.
const RESERVED_KEYS = ['texts', 'say'];
// The aspect a region asks for: the nearest of these to its drawn shape (the provider fits it to what the
// model makes, and the board covers the region with it).
const ASPECTS = ['9:16', '2:3', '3:4', '4:5', '1:1', '5:4', '4:3', '3:2', '16:9', '21:9'];

const round = (v, n = 3) => Number(v.toFixed(n));
const pct = (v) => round(v * 100, 2);
const CJK = /[\u3000-\u9fff\uac00-\ud7af]/;

const ratio = (a) => { const [w, h] = a.split(':').map(Number); return w / h; };
const overlaps = ([ax, ay, aw, ah], [bx, by, bw, bh]) => ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;

export const canvasFor = ({ width, height }) => (width > height ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 });

// The layers become the board's fields: unique keys, the presenter field keyed `presenter` (one per scene),
// and a cutout only where its people cover a layer drawn before it.
function checkLayers(layers, where) {
  const keys = new Set();
  layers.forEach((l, i) => {
    if (RESERVED_KEYS.includes(l.key) || keys.has(l.key)) throw new Error(`${where}: layer key "${l.key}" is reserved or repeated`);
    keys.add(l.key);
    if ((l.fill === 'avatar') !== (l.key === 'presenter')) throw new Error(`${where}: the avatar layer is keyed "presenter", and only it`);
    if (l.cutout && !['avatar', 'pixel'].includes(l.fill)) throw new Error(`${where}: layer ${l.key} — only avatar and pixel layers are cut out`);
    if (l.cutout && !layers.slice(0, i).some((b) => overlaps(b.box, l.box))) throw new Error(`${where}: layer ${l.key} is cut out but covers no layer before it`);
  });
}

// Each scene's window and words, after checking the scenes tile the film in order. A scene covers whole
// shots unless `start` / `end` cut one, so a long shot can be split across consecutive scenes.
export function sceneWindows(shots, timeline) {
  const frame = 1 / timeline.fps;
  let at = 0;
  let lastShot = -1;
  const scenes = shots.scenes.map((s, i) => {
    const where = `scenes[${i}] ${s.name}`;
    s.shots.forEach((n, k) => {
      const allowed = k === 0 ? [lastShot, lastShot + 1] : [s.shots[0] + k];
      if (!allowed.includes(n)) throw new Error(`${where}: shots must continue from shot ${allowed.at(-1)}, got ${n}`);
    });
    const first = timeline.shots[s.shots[0]];
    const last = timeline.shots[s.shots.at(-1)];
    if (!first || !last) throw new Error(`${where}: shot ${s.shots.at(-1)} is not in source/timeline.json`);
    const start = s.start ?? first.start;
    const end = s.end ?? last.end;
    if (Math.abs(start - at) > frame) throw new Error(`${where}: starts at ${start}s, but the previous scene ends at ${at}s`);
    if (!(end > start) || start < first.start - frame || end > last.end + frame) throw new Error(`${where}: ${start}–${end}s is not inside its shots (${first.start}–${last.end}s)`);
    checkLayers(s.layers, where);
    const generated = s.layers.find((l) => GENERATED.includes(l.fill));
    if (generated && end - start > MAX_GENERATED_S + frame) {
      throw new Error(`${where}: ${round(end - start)}s with a ${generated.fill} layer — split it into scenes of at most ${MAX_GENERATED_S}s (start / end), the longest clip a reference video model makes`);
    }
    for (const t of s.texts || []) {
      if (!(t.out > t.in) || t.in < start - WORD_SLACK_S || t.out > end + WORD_SLACK_S) {
        throw new Error(`${where}: text "${t.text}" runs ${t.in}–${t.out}s, outside the scene's ${start}–${end}s`);
      }
    }
    at = end;
    lastShot = s.shots.at(-1);
    const words = (timeline.words || []).filter((w) => w.start >= start - WORD_SLACK_S && w.start < end - WORD_SLACK_S);
    const joined = words.map((w) => w.text.trim()).filter(Boolean);
    const say = joined.join(joined.some((w) => CJK.test(w)) ? '' : ' ');
    // Only a scene ending on its shot's end hands over through that shot's transition; a cut shot is a hard cut.
    const outShot = Math.abs(end - last.end) <= frame ? last : null;
    return { ...s, board: `${s.name}${String(i + 1).padStart(2, '0')}`, start, end, duration: round(end - start), say, outShot };
  });
  const filmEnd = timeline.shots.at(-1).end;
  if (lastShot !== timeline.shots.length - 1 || Math.abs(at - filmEnd) > frame) throw new Error(`scenes end at ${at}s (shot ${lastShot}); the film runs to ${filmEnd}s (shot ${timeline.shots.length - 1})`);
  return scenes;
}

const placeOf = ([x, y, w, h]) => `${pct(w)}% × ${pct(h)}% of the frame at (${pct(x)}%, ${pct(y)}%)`;

// A code layer is an element written per replica; every other layer is a video slot sized to its region.
function layerField(l, scene, canvas) {
  const place = placeOf(l.box);
  if (l.fill === 'code') {
    return { key: l.key, type: 'element', required: true, desc: `${l.describe || scene.role}. Fills ${place}; palette from Design, no text the texts field already carries.` };
  }
  const drawn = [l.box[2] * canvas.width, l.box[3] * canvas.height];
  const off = (a) => Math.abs(Math.log(ratio(a) / (drawn[0] / drawn[1])));
  const aspect = ASPECTS.reduce((best, a) => (off(a) < off(best) ? a : best));
  const [aw, ah] = aspect.split(':').map(Number);
  const shortEdge = Math.min(SHORT_EDGE_PX, Math.round(Math.min(...drawn)));
  return {
    key: l.key, type: 'video', required: true,
    desc: `${l.describe || scene.role} (${place})`,
    media: { role: ROLE[l.fill], aspect, minWidthPx: aw > ah ? Math.round((shortEdge * aw) / ah) : shortEdge,
      ...(l.describe ? { motion: l.describe } : {}), ...(l.cutout ? { cutout: true } : {}) },
  };
}

function boardJson(scene, { narrated, captioned, canvas }) {
  const texts = (scene.texts || []).map((t) => t.text);
  const first = scene.texts?.[0];
  const fields = scene.layers.map((l) => layerField(l, scene, canvas));
  if (texts.length) {
    fields.push({
      key: 'texts', type: 'string[]', required: true, minItems: texts.length, maxItems: texts.length,
      maxChars: Math.ceil(Math.max(...texts.map((t) => t.length)) * TEXT_SLACK),
      desc: `On-screen text, one item per text in the original's order and place (use \\n where the original breaks the line): ${texts.map((t) => JSON.stringify(t)).join(', ')}`,
    });
  }
  const say = narrated && scene.say ? scene.say : '';
  if (say) {
    fields.push({ key: 'say', type: 'narration', required: true, maxChars: Math.max(10, Math.ceil(say.length * LINE_SLACK)),
      desc: `What is said over this scene, at the original's pace (${scene.duration}s): ${scene.role}` });
  }
  return {
    node: scene.name.toLowerCase(),
    schema: { fields },
    meta: {
      displays: scene.role,
      minDuration: round(Math.max(0.5, scene.duration * 0.5), 1),
      maxDuration: round(Math.max(1, scene.duration * 2), 1),
      durationModel: say ? 'segments' : 'scene',
      ...(captioned ? { captions: Boolean(say) } : {}),
    },
    example_data: { ...(texts.length ? { texts } : {}), ...(say ? { say } : {}) },
    ...(say ? { example_segments: [{ key: 'say', start: 0, end: scene.duration }] } : {}),
    example_duration_ms: Math.round(scene.duration * 1000),
    // The preview frame shows the first text, so checking the board against the original covers it.
    preview_t: first ? round(Math.min(1, Math.max(0, ((first.in + first.out) / 2 - scene.start) / scene.duration))) : 0.5,
  };
}

function boardJsx(scene, source) {
  const layers = scene.layers.map((l) => ({ key: l.key, box: l.box.map(pct), shape: l.shape || 'rect',
    ...(l.fill === 'code' ? { code: true } : {}), ...(l.cutout ? { cut: `${l.key}Cutout` } : {}) }));
  const texts = (scene.texts || []).map((t) => ({
    box: t.box.map(pct),
    in: round(Math.min(1, Math.max(0, (t.in - scene.start) / scene.duration))),
    out: round(Math.min(1, Math.max(0, (t.out - scene.start) / scene.duration))),
    enter: t.enter || 'fade',
    color: t.color || 'fg',
    plate: Boolean(t.plate),
    lines: t.text.split('\n').length,
  }));
  return source.replaceAll('__NAME__', scene.board).replace('__LAYOUT__', JSON.stringify({ background: scene.background || 'bg', layers, texts }));
}

function elementsOf(scene) {
  return [
    ...scene.layers.map((l, i) => {
      const [kind, content] = ELEMENT[l.fill];
      // A layer drawn before a cutout it overlaps sits behind that cutout's people.
      const cover = scene.layers.slice(i + 1).find((c) => c.cutout && overlaps(c.box, l.box));
      return { id: `${scene.board}.${l.key}`, board: scene.board, kind, path: l.key, in: scene.start, out: scene.end, box: l.box, enter: 'cut', exit: 'cut', content,
        ...(cover ? { behind: cover.key } : {}) };
    }),
    ...(scene.texts || []).map((t, i) => ({ id: `${scene.board}.texts.${i}`, board: scene.board, kind: 'title', in: t.in, out: t.out,
      box: t.box, enter: t.enter || 'fade', exit: 'cut', content: 'still', font: 'font' })),
  ];
}

function designJs({ palette, family, captions }) {
  const design = { palette: { ...DEFAULT_PALETTE, ...palette }, font: family ? `'${family}', sans-serif` : 'sans-serif', ...(captions ? { captions } : {}) };
  return `export const Design = ${JSON.stringify(design, null, 2)};\nexport default Design;\n`;
}

function skillMd({ id, title, scenes, duration }) {
  const sections = scenes.map((s) => [
    `    - beat: ${JSON.stringify(s.name)}`,
    `      node: ${JSON.stringify(s.name.toLowerCase())}`,
    `      brief: ${JSON.stringify(s.role)}`,
    `      scenes: [{ durationS: ${s.duration}, narration: ${JSON.stringify(s.say)} }]`,
  ].join('\n'));
  return `---\nname: ${id}\ndescription: ${JSON.stringify(`${title}: ${scenes.length} scenes in the original's order, ${round(duration, 1)} s`)}\nmetadata:\n  schema_version: 1\n  sections:\n${sections.join('\n')}\n---\n\n`
    + 'Follows the original shot by shot: each scene keeps its length, its on-screen texts and their places; the copy and the people change.\n';
}

/**
 * @param {object} o
 * @param {object} o.shots     analysis/shots.json
 * @param {object} o.timeline  source/timeline.json
 * @param {object} o.size      the source's { width, height }
 * @param {string} o.id        template id
 * @param {string} [o.title]
 * @param {string} [o.family]  the font family fonts.json ships (after any substitution)
 * @returns {{ analysis: object, elements: object, template: object, design: string, skill: string, boards: object, describe: object }}
 */
export function quickTemplate({ shots, timeline, size, id, title = id, family = null }) {
  const canvas = canvasFor(size);
  const scenes = sceneWindows(shots, timeline);
  const narrated = (timeline.words || []).length > 0;
  const captioned = narrated && Boolean(shots.captions);
  const source = readFileSync(BOARD_SOURCE, 'utf-8');
  const boards = Object.fromEntries(scenes.map((s) => [s.board, { jsx: boardJsx(s, source), json: boardJson(s, { narrated, captioned, canvas }) }]));
  const transitions = scenes.slice(1).flatMap((s, i) => {
    const out = scenes[i].outShot?.transition_out;
    return out?.type === 'soft' && out.end > out.start ? [{ from: scenes[i].board, to: s.board, type: 'crossfade', duration: round(out.end - out.start) }] : [];
  });
  const duration = scenes.at(-1).end;
  return {
    analysis: {
      fps: timeline.fps, canvas, cover_t: round((scenes[0].start + scenes[0].end) / 2),
      boards: scenes.map((s) => ({ name: s.board, start: s.start, end: s.end, shots: s.shots,
        media: Object.fromEntries(s.layers.filter((l) => l.fill !== 'code').map((l) => [l.key,
          { crop: l.box, subjects: (l.subjects || []).map((x) => ({ ...x, t: x.t ?? round((s.start + s.end) / 2) })) }])) })),
    },
    elements: { elements: scenes.flatMap(elementsOf) },
    template: {
      version: 1, id, title, canvas, fps: timeline.fps,
      category: scenes.some((s) => s.layers.some((l) => l.fill === 'avatar')) ? 'avatar' : 'no_avatar',
      audio: { source_mode: narrated ? 'narration' : 'music-only', captions: captioned ? (shots.captions.plate ? 'word-highlight' : 'creator') : null, bpm: timeline.beats?.bpm ?? null },
      source: { file: '../source/source.mp4', duration_s: timeline.duration_s, url: null },
      boards: scenes.map((s) => s.board),
      transitions,
    },
    design: designJs({ palette: shots.palette, family, captions: captioned ? shots.captions : null }),
    skill: skillMd({ id, title, scenes, duration }),
    boards,
    describe: Object.fromEntries(scenes.flatMap((s) => s.layers.filter((l) => l.fill !== 'code' && l.describe).map((l) => [`${s.board}.${l.key}`, l.describe]))),
  };
}
