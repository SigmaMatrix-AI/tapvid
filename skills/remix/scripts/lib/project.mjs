// Render project generation (spec §8): copy the template/ skeleton, the template's boards,
// design, fonts and transition extension, the replica's sketches and elements, then write one
// scene wrapper per scene and the mountProject timeline.
//
//   preview  replica scenes; AI slots show their reference clip (with review overlay data) or
//            their sketch; durations estimated from the text (narration) or the source windows
//   final    replica scenes; media from tasks.json / media.file; durations from replica.resolved
//   compare  template boards in default order with example_data and reference clips, durations
//            from analysis/boards.json — the template's reconstruction of the source
import { cpSync, existsSync, linkSync, copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import { ASSETS_DIR, PLUGIN, fromPosixRel, run, runtimePath, toFrame, toPosixRel, writeJson } from './common.mjs';
import { cutoutFresh, cutoutPath } from './matte.mjs';
import { fieldForPath, fieldPaths, replaceRequestId, slotRequestId } from './media/plan.mjs';
import { wordTokens } from './pace.mjs';
import { layoutNarration, scaleSourceSegments } from './timing.mjs';
import {
  boardFields, estimateSpeechSeconds, incomingTransition, loadReplica, mediaPaths, narrationLines,
  occurrences, round3, sceneKey, sourceWindow, taskFiles, weightedWords,
} from './replica.mjs';

const SKELETON = join(ASSETS_DIR, 'template');
// Subject kinds a replacement chip names; template.html's bridge translates them (another id shows as written).
const SUBJECT_KINDS = new Set(['person', 'product', 'logo', 'object', 'animal', 'other']);

const ident = (s) => s.replace(/[^A-Za-z0-9]/g, '_');
const aliasOf = (key, path) => `${key}-${path}`.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/\./g, '-');

// Hard-link when possible (generated clips can be large), copy across devices.
function place(src, dest) {
  mkdirSync(join(dest, '..'), { recursive: true });
  rmSync(dest, { force: true });
  try { linkSync(src, dest); } catch { copyFileSync(src, dest); }
}

// The cutout of a clip, matting it first when it is missing or older than the clip (minutes per clip,
// once; matte.mjs installs the engine on first use). Null when matting fails.
function ensureCutout(file) {
  if (cutoutFresh(file)) return cutoutPath(file);
  const r = spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'matte.mjs'), file], { stdio: ['ignore', 'ignore', 'inherit'] });
  return r.status === 0 && cutoutFresh(file) ? cutoutPath(file) : null;
}

function copySkeleton(out, canvas) {
  rmSync(join(out, 'src'), { recursive: true, force: true });
  rmSync(join(out, 'assets'), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyFileSync(join(SKELETON, 'build.mjs'), join(out, 'build.mjs'));
  const html = readFileSync(join(SKELETON, 'template.html'), 'utf-8')
    .replaceAll('CANVAS_WIDTH', String(canvas.width)).replaceAll('CANVAS_HEIGHT', String(canvas.height));
  writeFileSync(join(out, 'template.html'), html, 'utf-8');
  cpSync(join(SKELETON, 'src'), join(out, 'src'), { recursive: true });
  mkdirSync(join(out, 'src', 'scenes'), { recursive: true });
  const nm = join(out, 'node_modules');
  if (!existsSync(nm) && existsSync(runtimePath())) symlinkSync(runtimePath(), nm, process.platform === 'win32' ? 'junction' : 'dir');
}

function copyTemplateParts(ctx, out) {
  cpSync(join(ctx.templateDir, 'boards'), join(out, 'src', 'boards'), { recursive: true, filter: (f) => !/\.(json|mp3|html|png)$/.test(f) });
  copyFileSync(join(ctx.templateDir, 'design.js'), join(out, 'src', 'system', 'design.js'));
  const ext = join(ctx.templateDir, 'transitions.js');
  if (existsSync(ext)) copyFileSync(ext, join(out, 'src', 'system', 'transitions.extra.js'));
  rmSync(join(out, 'fonts'), { recursive: true, force: true });
  if (existsSync(join(ctx.templateDir, 'fonts.json'))) copyFileSync(join(ctx.templateDir, 'fonts.json'), join(out, 'fonts.json'));
  if (existsSync(join(ctx.templateDir, 'fonts'))) cpSync(join(ctx.templateDir, 'fonts'), join(out, 'fonts'), { recursive: true });
}

function chipsFor(ctx, ref, subjects) {
  const kinds = Object.fromEntries((ref?.subjects || []).map((s) => [s.id, s.kind]));
  return (subjects || []).map((id) => {
    const r = (ctx.replica?.replace || []).find((x) => x.subject === id);
    const subject = SUBJECT_KINDS.has(kinds[id]) ? kinds[id] : id;
    const target = r?.with?.file ? (kinds[id] === 'person' ? 'photo' : 'file') : r?.with?.generate ? 'ai' : 'tbd';
    return { subject, target };
  });
}

// One scene's media: the JSX expression for each media path plus imports and asset files.
function sceneMedia(ctx, mode, scene, index, key, out) {
  const imports = [];
  const assets = {};
  const exprs = {};
  const warnings = [];
  const fields = boardFields(ctx, scene.board);
  // A looping clip (the board field's media.loop or the replica slot's loop) repeats under a longer scene.
  const loops = (path) => Boolean(fieldForPath(fields, path)?.media?.loop || scene.media?.[path]?.loop);
  const asset = (path, file, tag, attrs = '') => {
    const alias = aliasOf(key, path);
    const name = `${alias}${extname(file).toLowerCase()}`;
    place(file, join(out, 'assets', 'media', name));
    assets[alias] = `assets/media/${name}`;
    return tag === 'img'
      ? `<img src="__ASSET:${alias}__" alt=""${attrs} />`
      : `<video src="__ASSET:${alias}__" muted playsInline data-offset="0"${loops(path) ? ' data-loop="1"' : ''}${attrs} />`;
  };
  const component = (path, file, dir) => {
    const id = `${dir === 'sketches' ? 'Sketch' : 'Element'}_${ident(`${key}_${path}`)}`;
    const dest = `${dir}/${basename(file)}`;
    imports.push(`import * as ${id}_mod from '../${dest}';`, `const ${id} = ${id}_mod.default || Object.values(${id}_mod).find((v) => typeof v === 'function');`);
    return id;
  };
  // A media.cutout field's clip also reaches the board as `<key>Cutout`: the clip with only its people
  // opaque, matted locally (references/boards.md §8), so elements behind the person stay behind them.
  const withCutout = (path, file) => {
    if (!fieldForPath(fields, path)?.media?.cutout || !/\.(mp4|webm|mov)$/i.test(file)) return;
    const cut = ensureCutout(file);
    if (cut) exprs[`${path}Cutout`] = asset(`${path}Cutout`, cut, 'video');
    else warnings.push(`${key}.${path}: matting failed; the elements behind the person show in front (run matte.mjs ${file})`);
  };
  // Review overlay data as codes (template.html translates and draws the badge, chips and prompt).
  const slotAttrs = (path, badge, chips = [], prompt = '') => ` data-slot={${JSON.stringify(`${key}.${path}`)}} data-badge={${JSON.stringify(badge)}}`
    + (chips.length ? ` data-replace={${JSON.stringify(JSON.stringify(chips))}}` : '')
    + (prompt ? ` data-prompt={${JSON.stringify(prompt)}}` : '');

  if (mode === 'compare') {
    for (const { path, type } of mediaPaths(fields, scene.data)) {
      const ref = ctx.refs[`${scene.board}.${path}`];
      const file = type === 'image' ? ref?.frame : ref?.clip;
      if (file && existsSync(join(ctx.refsDir, file))) {
        exprs[path] = asset(path, join(ctx.refsDir, file), type === 'image' ? 'img' : 'video', slotAttrs(path, `slot:${type}`));
        if (type === 'video') withCutout(path, join(ctx.refsDir, file));
      }
    }
    return { imports, assets, exprs, warnings };
  }

  for (const [path, m] of Object.entries(scene.media || {})) {
    // An image slot may carry an animated picture (a GIF converted to mp4): it plays as a video.
    const tag = m.kind === 'image' && !/\.(mp4|webm|mov)$/i.test(m.file || '') ? 'img' : 'video';
    const userFile = m.file && existsSync(fromPosixRel(ctx.dir, m.file)) ? fromPosixRel(ctx.dir, m.file) : null;
    const sketchFile = m.sketch && existsSync(fromPosixRel(ctx.dir, m.sketch)) ? fromPosixRel(ctx.dir, m.sketch) : null;
    const sketch = (badge, prompt) => {
      if (!sketchFile) { warnings.push(`${key}.${path}: no sketch to show`); return null; }
      const C = component(path, sketchFile, 'sketches');
      const attrs = mode === 'preview' && badge ? slotAttrs(path, badge, chipsFor(ctx, ctx.refs[m.ref], m.replace), prompt) : '';
      return `<div style={{ position: 'relative', width: '100%', height: '100%' }}${attrs}><${C} t={t} duration={${m.duration_s || 'duration'}} Design={Design} /></div>`;
    };
    if (m.kind === 'element') {
      if (!userFile) { warnings.push(`${key}.${path}: element file ${m.file} is missing`); continue; }
      exprs[path] = `<${component(path, userFile, 'elements')} t={t} duration={duration} Design={Design} />`;
      continue;
    }
    if (m.source === 'code') { exprs[path] = sketch('code', ''); continue; }
    if (m.source === 'user') {
      if (userFile) {
        exprs[path] = asset(path, userFile, tag, mode === 'preview' ? slotAttrs(path, 'user') : '');
        withCutout(path, userFile);
      } else warnings.push(`${key}.${path}: user file ${m.file} is missing`);
      continue;
    }
    const kind = m.kind === 'avatar' || m.kind === 'image' ? m.kind : 'video';
    const task = taskFiles(ctx.tasks, slotRequestId(ctx.replica.slug, index, scene.board, path))[0];
    // timing.mjs may have sped a self-voiced avatar clip up to the film's tempo: that copy plays.
    const sped = ctx.replica.resolved?.[key]?.media?.[path];
    const gen = (sped && fromPosixRel(ctx.dir, sped)) || userFile || (task && fromPosixRel(ctx.dir, task.path));
    // Once generated, the preview shows the new material; the reference / sketch is only a stand-in.
    if (mode === 'preview' && gen && existsSync(gen)) {
      exprs[path] = asset(path, gen, tag, slotAttrs(path, `gen:${kind}`, [], m.prompt));
      withCutout(path, gen);
      continue;
    }
    if (mode === 'preview') {
      // A digital human previews as its portrait: the original's presenter footage carries the
      // original's burned-in titles and captions, which would sit under the new ones.
      const rep = m.kind === 'avatar' ? (ctx.replica.replace || []).find((r) => r.subject === (m.replace || [])[0]) : null;
      const made = rep ? taskFiles(ctx.tasks, replaceRequestId(ctx.replica.slug, rep.subject))[0]?.path : null;
      const portrait = rep ? rep.with?.file || made || rep.with?.from : null;
      if (portrait && existsSync(fromPosixRel(ctx.dir, portrait))) {
        exprs[path] = asset(path, fromPosixRel(ctx.dir, portrait), 'img', slotAttrs(path, 'portrait'));
        continue;
      }
      const ref = m.ref ? ctx.refs[m.ref] : null;
      const refFile = ref && (m.kind === 'image' ? ref.frame : ref.clip);
      if (m.mode === 'reference' && refFile && existsSync(join(ctx.refsDir, refFile))) {
        exprs[path] = asset(path, join(ctx.refsDir, refFile), tag, slotAttrs(path, 'ref', chipsFor(ctx, ref, m.replace), m.prompt));
        if (tag === 'video') withCutout(path, join(ctx.refsDir, refFile));
      } else exprs[path] = sketch(`sketch:${kind}`, m.prompt);
      continue;
    }
    if (gen && existsSync(gen)) {
      exprs[path] = asset(path, gen, tag);
      withCutout(path, gen);
    } else {
      warnings.push(`${key}.${path}: no generated file; falling back to its sketch`);
      exprs[path] = sketchFile ? sketch(null, '') : null;
    }
  }
  return { imports, assets, exprs, warnings };
}

// The data object as JSX source, with media paths replaced by element expressions.
function dataSource(data, exprs) {
  const clone = JSON.parse(JSON.stringify(data || {}));
  const tokens = [];
  for (const [path, expr] of Object.entries(exprs)) {
    const parts = path.split('.');
    let o = clone;
    for (const p of parts.slice(0, -1)) { o[p] ??= /^\d+$/.test(p) ? [] : {}; o = o[p]; }
    o[parts[parts.length - 1]] = `__MEDIA_${tokens.length}__`;
    tokens.push(expr ?? 'null');
  }
  return JSON.stringify(clone, null, 2).replace(/"__MEDIA_(\d+)__"/g, (_, n) => tokens[Number(n)]);
}

// Within-line cues on the words actually spoken (boards.md §6): every object with a string `cue`
// gets `cueAt`, seconds from its line's start. The line is the nearest enclosing object's
// narration field (else the scene's first line); its start is the line's segment start (what a
// segmented board times from), else the scene start. Returns { data, warnings }; data is new.
export function resolveCues(fields, data, { words, segments, key }) {
  const lineKeys = fieldPaths(fields, data, 'narration').map((p) => p.path);
  const firstLine = lineKeys[0] || 'narration';
  const warnings = [];
  const heard = (words || []).map((w) => ({ w, toks: wordTokens(w.text) }));
  const lineOf = (path) => {
    const parts = path ? path.split('.') : [];
    for (let n = parts.length; n >= 0; n--) {
      const prefix = parts.slice(0, n).join('.');
      const hit = lineKeys.find((k) => k.split('.').length === n + 1 && (n === 0 || k.startsWith(`${prefix}.`)));
      if (hit) return hit;
    }
    return firstLine;
  };
  const cueAt = (cue, path) => {
    const line = lineOf(path);
    const lineStart = (segments || []).find((s) => s.key === line)?.start ?? 0;
    const want = wordTokens(cue);
    const flat = heard.filter((h) => h.w.start >= lineStart - 1e-6).flatMap((h) => h.toks.map((t) => ({ t, w: h.w })));
    const i = want.length ? flat.findIndex((_, k) => want.every((t, j) => flat[k + j]?.t === t)) : -1;
    return i < 0 ? null : Number((flat[i].w.start - lineStart).toFixed(3));
  };
  const walk = (v, path) => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, path ? `${path}.${i}` : String(i)));
    if (!v || typeof v !== 'object') return v;
    const next = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k)]));
    if (typeof v.cue !== 'string') return next;
    const at = cueAt(v.cue, path);
    if (at === null) { warnings.push(`${key}: cue "${v.cue}"${path ? ` at ${path}` : ''} is not in its line's words; cueAt kept`); return next; }
    return { ...next, cueAt: at };
  };
  return { data: walk(data || {}, ''), warnings };
}

// A board's own caption rule (board meta.captions, decided when the board is built): false = the board
// shows none; { off: [narration fields] } = no captions while those lines play (a title card that is
// its own caption); any other key overrides a Design.captions token for this board (position, size …).
// Returns { words, style } for the scene, or null when it has no captions.
export function boardCaptions(rule, words, segments) {
  if (rule === false) return null;
  const { off = [], ...style } = rule && typeof rule === 'object' ? rule : {};
  const field = (key) => key.split('.').filter((p) => !/^\d+$/.test(p)).join('.');
  const muted = (segments || []).filter((s) => off.includes(field(s.key)));
  const heard = (words || []).filter((w) => !muted.some((s) => w.start >= s.start - 1e-6 && w.start < s.end));
  return { words: heard, style };
}

function sceneSource({ board, duration, segments, words, captions, captionStyle = {}, media, data }) {
  const lines = [
    "import React from 'react';",
    "import { Design } from '../system/design.js';",
    `import { ${board} } from '../boards/${board}.jsx';`,
  ];
  if (captions) lines.push("import { Captions } from '../components/Captions.jsx';");
  lines.push(...media.imports, '', `export const duration = ${duration};`, `const segments = ${JSON.stringify(segments)};`);
  if (captions) lines.push(`const words = ${JSON.stringify(words || [])};`);
  const body = dataSource(data, media.exprs).split('\n').map((l, i) => (i ? `  ${l}` : l)).join('\n');
  lines.push('', 'export default function Scene({ t }) {', `  const data = ${body};`, '  return (',
    "    <div style={{ position: 'absolute', inset: 0, containerType: 'size' }}>",
    `      <${board} t={t} duration={duration} segments={segments} Design={Design} {...data} />`);
  const design = Object.keys(captionStyle).length ? `{{ ...Design, captions: { ...Design.captions, ...${JSON.stringify(captionStyle)} } }}` : '{Design}';
  if (captions) lines.push(`      <Captions t={t} words={words} variant=${JSON.stringify(captions)} Design=${design} />`);
  lines.push('    </div>', '  );', '}', '');
  return lines.join('\n');
}

function indexSource(items) {
  const imports = ["import { mountProject } from './system/projectPlayer.js';"];
  const entries = items.map((it) => {
    imports.push(`import Scene_${ident(it.key)} from './scenes/${it.key}.jsx';`);
    const tr = it.transitionIn ? `, transition: ${JSON.stringify(it.transitionIn)}` : '';
    return `  { id: '${it.key}', Scene: Scene_${ident(it.key)}, duration: ${it.duration}${tr} },`;
  });
  return `${imports.join('\n')}\n\nmountProject([\n${entries.join('\n')}\n]);\n`;
}

// Durations and segments for a scene that has not been through timing.mjs.
function estimateScene(ctx, mode, scene, transitionIn, occurrence) {
  const board = ctx.boards.get(scene.board)?.json || {};
  const narrated = mode === 'preview' && ctx.replica.audio?.mode === 'narration';
  const win = !narrated && sourceWindow(ctx.analysis, scene.board, occurrence);
  if (win) return { ...scaleSourceSegments(win, scene.data), words: null, flag: null };
  const lines = narrated ? narrationLines(boardFields(ctx, scene.board), scene) : [];
  const min = board.meta?.minDuration;
  const max = board.meta?.maxDuration;
  if (!lines.length) {
    const d = (board.example_duration_ms || 0) / 1000 || min || 3;
    return { duration: d, segments: board.example_segments || [], words: null, flag: null };
  }
  const lay = layoutNarration(lines.map((l) => ({ ...l, duration: estimateSpeechSeconds(l.text) })), { transitionIn, min, max });
  const words = lay.placed.flatMap((l) => weightedWords(l.text, l.start, l.end, ctx.replica.language));
  const segmented = board.meta?.durationModel === 'segments' || lines.length > 1;
  return {
    duration: Math.min(lay.duration, max ?? Infinity), segments: segmented ? lay.segments : [], words,
    flag: lay.over ? { code: 'over', natural: Number(lay.natural.toFixed(1)), board: scene.board, max } : null,
  };
}

export function projectDirFor(replicaDir, mode) {
  return mode === 'compare' ? join(replicaDir, 'review', 'compare-project') : join(replicaDir, 'project');
}

// Generate the project. Returns its meta (also written to <out>/project.json).
export function generateProject(replicaDirArg, { mode, out: outArg } = {}) {
  if (!['preview', 'final', 'compare'].includes(mode)) throw new Error(`mode must be preview | final | compare, got ${mode}`);
  const ctx = loadReplica(replicaDirArg);
  const { replica, template } = ctx;
  const fps = template.fps || 30;
  const out = outArg || projectDirFor(ctx.dir, mode);
  copySkeleton(out, template.canvas);
  copyTemplateParts(ctx, out);
  if (mode !== 'compare') {
    for (const d of ['sketches', 'elements']) if (existsSync(join(ctx.dir, d))) cpSync(join(ctx.dir, d), join(out, 'src', d), { recursive: true });
  }

  const scenes = mode === 'compare'
    ? template.boards.map((b) => ({ board: b, data: ctx.boards.get(b)?.json.example_data || {}, media: {} }))
    : replica.scenes;
  const order = scenes.map((s) => s.board);
  const occ = occurrences(order);
  const captions = mode !== 'compare' && replica.audio?.mode === 'narration' ? replica.audio?.captions || null : null;
  const manifest = {};
  const warnings = [];
  const items = [];
  let start = 0;
  scenes.forEach((scene, i) => {
    const key = sceneKey(i, scene.board);
    if (!ctx.boards.has(scene.board)) throw new Error(`${key}: board ${scene.board} is not in the template`);
    const transitionIn = incomingTransition(template, order, i);
    let timing;
    const resolved = replica.resolved?.[key];
    if (mode === 'preview' && resolved) {
      // After timing.mjs the preview runs on the real narration clock, like the final cut.
      timing = { duration: resolved.duration, segments: resolved.segments || [], words: resolved.words, flag: null };
    } else if (mode === 'final') {
      const r = resolved;
      if (!r) throw new Error(`${key}: replica.resolved is missing — run timing.mjs first`);
      timing = { duration: r.duration, segments: r.segments || [], words: r.words, flag: null };
    } else timing = estimateScene(ctx, mode, scene, transitionIn, occ[i]);
    const duration = toFrame(timing.duration, fps);
    const media = sceneMedia(ctx, mode, scene, i, key, out);
    Object.assign(manifest, media.assets);
    warnings.push(...media.warnings);
    const segments = (timing.segments || []).map((s) => ({ key: s.key, start: round3(s.start), end: round3(s.end) }));
    const cued = mode !== 'compare' && resolved?.words?.length
      ? resolveCues(boardFields(ctx, scene.board), scene.data, { words: resolved.words, segments, key })
      : { data: scene.data, warnings: [] };
    warnings.push(...cued.warnings);
    const cap = captions ? boardCaptions(ctx.boards.get(scene.board)?.json.meta?.captions, timing.words, segments) : null;
    writeFileSync(join(out, 'src', 'scenes', `${key}.jsx`), sceneSource({
      board: scene.board, duration, segments, words: cap?.words, captions: cap ? captions : null, captionStyle: cap?.style, media, data: cued.data,
    }), 'utf-8');
    items.push({ key, board: scene.board, beat: scene.beat || null, start: round3(start), duration, transitionIn, segments, narration: scene.narration || null, flag: timing.flag, words: timing.words });
    start += duration;
  });
  writeFileSync(join(out, 'src', 'index.jsx'), indexSource(items), 'utf-8');
  writeJson(join(out, 'assets', 'manifest.json'), manifest);
  const meta = {
    mode, replica: toPosixRel(out, ctx.dir), canvas: template.canvas, fps, total: round3(start),
    scenes: items.map(({ words, ...rest }) => rest), warnings,
  };
  writeJson(join(out, 'project.json'), meta);
  return { dir: out, ...meta };
}

// Bundle a generated project into its index.html (esbuild from the shared runtime).
export function buildProject(dir) {
  if (!existsSync(join(dir, 'node_modules'))) throw new Error(`runtime missing: run node scripts/ensure-runtime.mjs first`);
  return run(process.execPath, ['build.mjs'], { cwd: dir }).trim();
}

// A one-scene project that renders a single sketch in a box of its slot's aspect, centred on
// the canvas — what `frames.mjs --sketch` captures for the sketch self-check.
export function generateSketchProject(replicaDirArg, sketchFile, { duration, aspect, out: outArg } = {}) {
  const ctx = loadReplica(replicaDirArg);
  const out = outArg || join(ctx.dir, 'review', '.sketch-project');
  const { canvas } = ctx.template;
  copySkeleton(out, canvas);
  copyTemplateParts(ctx, out);
  mkdirSync(join(out, 'src', 'sketches'), { recursive: true });
  copyFileSync(sketchFile, join(out, 'src', 'sketches', basename(sketchFile)));
  const [aw, ah] = String(aspect || `${canvas.width}:${canvas.height}`).split(':').map(Number);
  const k = Math.min(canvas.width / aw, canvas.height / ah);
  const box = { width: Math.round(aw * k), height: Math.round(ah * k) };
  const src = [
    "import React from 'react';",
    "import { Design } from '../system/design.js';",
    `import * as mod from '../sketches/${basename(sketchFile)}';`,
    "const Sketch = mod.default || Object.values(mod).find((v) => typeof v === 'function');",
    '',
    `export const duration = ${duration};`,
    'export default function Scene({ t }) {',
    `  return (<div style={{ position: 'absolute', inset: 0, background: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>`,
    `    <div style={{ position: 'relative', width: ${box.width}, height: ${box.height}, overflow: 'hidden', containerType: 'size' }}><Sketch t={t} duration={duration} Design={Design} /></div>`,
    '  </div>);',
    '}',
    '',
  ].join('\n');
  writeFileSync(join(out, 'src', 'scenes', 'sketch.jsx'), src, 'utf-8');
  writeFileSync(join(out, 'src', 'index.jsx'), indexSource([{ key: 'sketch', duration }]), 'utf-8');
  writeJson(join(out, 'assets', 'manifest.json'), {});
  return { dir: out, canvas, fps: ctx.template.fps || 30, duration };
}
