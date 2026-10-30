// Static checks on a template directory (spec §6): schemas, the board .jsx rules of §6.2, the
// board json's timing model and example data, the transition table, and the project's element
// inventory (analysis/elements.json, against analysis/motion.json when measured).
//   validateTemplate(templateDir) -> { errors: string[], warnings: string[] }
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ASSETS_DIR, PLUGIN, readJson } from './common.mjs';
import { check } from './schema.mjs';
import { boardSegments, fieldAt, isSegmented } from './board-fields.mjs';

// The first transition library (spec §6.3), used until the render runtime's list is importable.
const SPEC_TRANSITIONS = ['crossfade', 'push', 'wipe', 'zoom-through', 'whip-pan', 'page-flip', 'canvas-pan', 'slide-stack'];
// How far example_segments may drift from tiling the example audio (seconds); ms rounding plus
// a frame of slack.
const SEGMENT_TOLERANCE_S = 0.05;
const FORBIDDEN_CALLS = [
  [/\bMath\.random\s*\(/, 'Math.random'], [/\bDate\.now\s*\(/, 'Date.now'], [/\bnew\s+Date\s*\(/, 'new Date'],
  [/\bperformance\.now\s*\(/, 'performance.now'], [/\bsetTimeout\s*\(/, 'setTimeout'], [/\bsetInterval\s*\(/, 'setInterval'],
  [/\brequestAnimationFrame\s*\(/, 'requestAnimationFrame'],
];

// Content that moves inside its slot, so the slot must be a video field.
const MOVING_CONTENT = ['loop', 'recording', 'footage'];
// Kinds whose stop-motion "boil" a board replays from poses_per_s.
const BOIL_KINDS = ['sticker', 'title', 'badge'];
// CSS generic families: every render host resolves them, fonts.json need not ship them.
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'emoji', 'math']);

const STRING = /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

export function checkJsx(name, src) {
  const errors = [];
  const code = stripComments(src);
  const bare = code.replace(STRING, '""');
  const strings = code.match(STRING) || [];
  const imports = [...code.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)];
  const sideEffectImports = [...code.matchAll(/^\s*import\s+['"][^'"]+['"]/gm)];
  if (imports.length !== 1 || sideEffectImports.length || imports[0][2] !== 'react' || imports[0][1].trim() !== 'React') {
    errors.push(`board ${name}: must have exactly one import, \`import React from "react"\``);
  }
  if (/\brequire\s*\(|\bimport\s*\(/.test(bare)) errors.push(`board ${name}: dynamic import / require not allowed`);
  const exported = [...bare.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  for (const m of bare.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) exported.push(...m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  if (/^\s*export\s+default\s+(?!function|class)/m.test(bare)) exported.push('default');
  if (exported.length !== 1 || exported[0] !== name) errors.push(`board ${name}: must export exactly one function named ${name}, found [${exported.join(', ')}]`);
  else if (!new RegExp(`\\bfunction\\s+${name}\\s*\\(\\s*\\{`).test(bare)) errors.push(`board ${name}: \`function ${name}({ t, duration, Design, ...props })\` signature not found`);
  for (const [re, label] of FORBIDDEN_CALLS) if (re.test(bare)) errors.push(`board ${name}: ${label} is not allowed (render must be a pure function of t)`);
  if (/\b(transition|animation)[A-Za-z]*\s*:/.test(bare) || strings.some((s) => /\b(transition|animation)[a-z-]*\s*:|@keyframes/.test(s))) {
    errors.push(`board ${name}: CSS transition / animation / @keyframes not allowed (drive motion from t)`);
  }
  const px = strings.find((s) => /\d(?:\.\d+)?px\b/.test(s));
  if (px) errors.push(`board ${name}: px unit in ${px.slice(0, 40)} (use cqw / cqh)`);
  const hex = strings.find((s) => /#[0-9a-fA-F]{3,8}\b/.test(s));
  if (hex) errors.push(`board ${name}: hex colour in ${hex.slice(0, 40)} (take colours from Design)`);
  if (!/cq[wh]\b/.test(code)) errors.push(`board ${name}: no cqw / cqh geometry found`);
  return errors;
}

// example_data against the field limits: required values present, maxChars, minItems / maxItems.
export function checkExample(name, fields, data, prefix = '') {
  const errors = [];
  const where = (f) => `board ${name}: example_data.${prefix}${f.key}`;
  for (const f of fields || []) {
    const v = data?.[f.key];
    const media = ['image', 'video', 'element'].includes(f.type);
    if (v === undefined || v === null) {
      if (f.required && !media) errors.push(`${where(f)} is required`);
      continue;
    }
    if (media) { errors.push(`${where(f)}: example_data must not carry media (slots stay empty)`); continue; }
    if (Array.isArray(v)) {
      if (f.minItems !== undefined && v.length < f.minItems) errors.push(`${where(f)} has ${v.length} items (min ${f.minItems})`);
      if (f.maxItems !== undefined && v.length > f.maxItems) errors.push(`${where(f)} has ${v.length} items (max ${f.maxItems})`);
    }
    if (['string', 'narration'].includes(f.type)) {
      if (typeof v !== 'string') errors.push(`${where(f)} is not a string`);
      else if (f.maxChars && v.length > f.maxChars) errors.push(`${where(f)} has ${v.length} chars (max ${f.maxChars})`);
    } else if (f.type === 'number' && typeof v !== 'number') errors.push(`${where(f)} is not a number`);
    else if (['string[]', 'number[]'].includes(f.type)) {
      const kind = f.type === 'string[]' ? 'string' : 'number';
      if (!Array.isArray(v) || v.some((x) => typeof x !== kind)) errors.push(`${where(f)} is not a list of ${kind}s`);
      else if (f.maxChars) for (const x of v) if (x.length > f.maxChars) errors.push(`${where(f)} item "${x}" has ${x.length} chars (max ${f.maxChars})`);
    } else if (f.type === 'object') {
      if (typeof v !== 'object' || Array.isArray(v)) errors.push(`${where(f)} is not an object`);
      else errors.push(...checkExample(name, f.fields, v, `${prefix}${f.key}.`));
    } else if (f.type === 'object[]') {
      if (!Array.isArray(v)) errors.push(`${where(f)} is not a list`);
      else v.forEach((item, i) => errors.push(...checkExample(name, f.fields, item, `${prefix}${f.key}.${i}.`)));
    }
  }
  return errors;
}

// durationModel "segments" exactly when the schema has narration fields; then example_segments
// lists every narration line in speaking order and tiles the example audio from 0.
export function checkSegments(name, meta) {
  const fields = meta.schema?.fields;
  const segmented = isSegmented(fields);
  if (segmented !== (meta.meta?.durationModel === 'segments')) {
    return [`board ${name}: meta.durationModel must be "segments" exactly when the schema has narration fields`];
  }
  if (!segmented) return [];
  const keys = boardSegments(fields, meta.example_data).map(([k]) => k);
  const segs = meta.example_segments || [];
  if (segs.map((s) => s.key).join('|') !== keys.join('|')) {
    return [`board ${name}: example_segments must list one {key, start, end} per narration line, in order: ${keys.join(', ')}`];
  }
  let at = 0;
  for (const s of segs) {
    if (Math.abs(s.start - at) > SEGMENT_TOLERANCE_S || !(s.end > s.start)) return [`board ${name}: example_segments must tile the example from 0 (at ${s.key})`];
    at = s.end;
  }
  const total = (meta.example_duration_ms || 0) / 1000;
  if (total && Math.abs(at - total) > SEGMENT_TOLERANCE_S) return [`board ${name}: example_segments end at ${at}s, the example is ${total}s`];
  return [];
}

// Media keys that only make sense on some fields: `loop` on a video, `headTop` on a presenter.
export function checkMediaKeys(name, fields, prefix = '') {
  const errors = [];
  for (const f of fields || []) {
    const at = `board ${name}: ${prefix}${f.key}.media`;
    if (f.media?.loop !== undefined && f.type !== 'video') errors.push(`${at}.loop is only for video fields`);
    if (f.media?.headTop !== undefined && f.media.role !== 'presenter') errors.push(`${at}.headTop is only for role presenter fields`);
    if (f.media?.cutout && f.type !== 'video') errors.push(`${at}.cutout is only for video fields`);
    if (f.fields) errors.push(...checkMediaKeys(name, f.fields, `${prefix}${f.key}.`));
  }
  return errors;
}

// Narration field paths of a board, list levels dropped (`steps.say`): what meta.captions.off names.
function narrationPaths(fields, prefix = '') {
  return (fields || []).flatMap((f) => {
    const key = `${prefix}${f.key}`;
    if (f.type === 'narration') return [key];
    return f.fields ? narrationPaths(f.fields, `${key}.`) : [];
  });
}

// meta.captions is decided when the board is built (does the original show captions over this layout,
// and where): required once the template has captions; `off` names the board's narration fields.
export function checkBoardCaptions(name, meta, templateCaptions) {
  const rule = meta.meta?.captions;
  if (rule === undefined) {
    return templateCaptions ? [`board ${name}: meta.captions missing — say whether the original shows captions over this board (true / false / { off, centerY … })`] : [];
  }
  const lines = narrationPaths(meta.schema.fields);
  return (rule?.off || []).filter((k) => !lines.includes(k))
    .map((k) => `board ${name}: meta.captions.off "${k}" is not a narration field (${lines.join(', ') || 'none'})`);
}

// A media.cutout field `host` reaches the board as a second prop `hostCutout` (the same clip with only the
// people opaque), which the board draws over the elements behind the person.
export function checkCutoutDrawn(name, fields, source) {
  return mediaPaths(fields).filter((p) => fieldAt(fields, p.replaceAll('*', '0'))?.media?.cutout).map((p) => `${p.split('.').pop()}Cutout`)
    .filter((prop) => !source.includes(prop)).map((prop) => `board ${name}: media.cutout field — the board never draws ${prop}`);
}

// Media field paths of a board, list indices as "*" (`steps.*.screen`).
function mediaPaths(fields, prefix = '') {
  return (fields || []).flatMap((f) => {
    const key = `${prefix}${f.key}`;
    if (f.type === 'image' || f.type === 'video') return [key];
    if (f.type === 'object') return mediaPaths(f.fields, `${key}.`);
    if (f.type === 'object[]') return mediaPaths(f.fields, `${key}.*.`);
    return [];
  });
}
const wildIndex = (path) => path.split('.').map((p) => (/^\d+$/.test(p) ? '*' : p)).join('.');
const firstFamily = (stack) => String(stack).split(',')[0].trim().replace(/^['"]+|['"]+$/g, '').trim();

/**
 * The element inventory against the template: schema, boards and field paths, every media field
 * covered, moving content in video fields, the motion measurements, and font roles fonts.json ships.
 * @param {object} o
 * @param {object} o.inventory   analysis/elements.json
 * @param {object} [o.motion]    analysis/motion.json, when measured
 * @param {object} o.boardFields { <Board>: schema.fields } of the template's valid boards
 * @param {object} [o.design]    design.js's Design (null when it could not be loaded)
 * @param {Array}  [o.faces]     fonts.json faces
 */
export function checkElements({ inventory, motion, boardFields, design, faces = [] }) {
  const schemaErrors = check('elements', inventory);
  if (schemaErrors.length) return schemaErrors.map((e) => `analysis/elements.json ${e}`);
  const errors = [];
  const seen = new Set();
  const covered = new Set();
  const behind = new Set();
  const measured = motion?.elements || {};
  for (const el of inventory.elements) {
    const { id } = el;
    if (seen.has(id)) errors.push(`${id}: duplicate element id`);
    seen.add(id);
    if (!(el.out > el.in)) errors.push(`${id}: out (${el.out}) must be after in (${el.in})`);
    const fields = boardFields[el.board];
    if (!fields) { errors.push(`${id}: board ${el.board} is not in the template`); continue; }
    const content = el.content || 'still';
    const idle = el.idle?.type || 'none';
    if (el.path) {
      const field = fieldAt(fields, el.path);
      if (!field) errors.push(`${id}: ${el.board}.${el.path} is not a field of the board`);
      else if (MOVING_CONTENT.includes(content) && field.type === 'image') {
        errors.push(`${id} moves in the original (content ${content}) but ${el.board}.${el.path} is an image — make it a video field (media.loop: true for a GIF-like loop)`);
      }
      covered.add(`${el.board}.${wildIndex(el.path)}`);
    }
    if (el.behind) {
      const cover = fieldAt(fields, el.behind);
      if (!cover?.media?.cutout || cover.type !== 'video') errors.push(`${id}: behind ${el.board}.${el.behind} needs a video field with media.cutout: true`);
      else behind.add(`${el.board}.${wildIndex(el.behind)}`);
    }
    if (idle === 'boil' && BOIL_KINDS.includes(el.kind) && el.idle.poses_per_s === undefined) {
      errors.push(`${id}: idle boil needs poses_per_s (measure.mjs motion)`);
    }
    const m = measured[id];
    if (m?.class === 'moving' && content === 'still' && idle === 'none') {
      errors.push(`${id}: measured moving in analysis/motion.json (mean ${m.mean}${m.loop_s ? `, loop ${m.loop_s}s` : ''}) but declared still — set content (loop / recording / footage) or idle`);
    }
    if (m?.class === 'boil' && idle !== 'boil') {
      errors.push(`${id}: measured boil in analysis/motion.json (${m.poses_per_s} poses/s) but idle.type is ${idle}`);
    }
    if (el.font) {
      const stack = design?.[el.font];
      if (!design) errors.push(`${id}: design.js could not be loaded to check font role "${el.font}"`);
      else if (typeof stack !== 'string') errors.push(`${id}: font role "${el.font}" is not a font in design.js`);
      else {
        const family = firstFamily(stack);
        if (!GENERIC_FAMILIES.has(family.toLowerCase()) && !faces.some((f) => f.family === family)) {
          errors.push(`${id}: font role "${el.font}" is ${family}, which fonts.json does not ship (fonts.mjs)`);
        }
      }
    }
  }
  for (const [board, fields] of Object.entries(boardFields)) {
    for (const path of mediaPaths(fields)) {
      if (!covered.has(`${board}.${path}`)) errors.push(`${board}.${path}: no element in analysis/elements.json has this path`);
      // Matting costs minutes per clip: only for a subject that really covers an element in the original.
      if (fieldAt(fields, path.replaceAll('*', '0'))?.media?.cutout && !behind.has(`${board}.${path}`)) {
        errors.push(`${board}.${path}: media.cutout but no element in analysis/elements.json is behind it`);
      }
    }
  }
  return errors;
}

// Import a copy of a plain ES module file (the template's files have no .mjs extension); null
// when it does not load.
async function importCopy(file) {
  const dir = mkdtempSync(join(tmpdir(), 'tapvid-validate-'));
  try {
    const copy = join(dir, 'mod.mjs');
    copyFileSync(file, copy);
    return await import(pathToFileURL(copy).href);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function importKeys(file, exportName) {
  const v = (await importCopy(file))?.[exportName];
  return Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v) : null;
}

// Known transition types: the render runtime's TRANSITION_TYPES (else the spec's list), plus the
// keys of `extraTransitions` in the template's own transitions.js extension.
export async function transitionTypes(templateDir) {
  const types = new Set(SPEC_TRANSITIONS);
  const builtin = join(ASSETS_DIR, 'template', 'src', 'system', 'transitions.js');
  if (existsSync(builtin)) {
    try {
      const mod = await import(pathToFileURL(builtin).href);
      for (const t of mod.TRANSITION_TYPES || []) types.add(t);
    } catch { /* runtime not loadable here; the spec's list stands */ }
  }
  const ext = join(templateDir, 'transitions.js');
  if (existsSync(ext)) {
    const keys = await importKeys(ext, 'extraTransitions')
      ?? [...readFileSync(ext, 'utf-8').matchAll(/['"]([a-z][a-z0-9-]*)['"]\s*:\s*(?:\(|function)/g)].map((m) => m[1]);
    for (const k of keys) types.add(k);
  }
  return types;
}

export async function validateTemplate(templateDir) {
  const errors = [];
  const warnings = [];
  const templatePath = join(templateDir, 'template.json');
  if (!existsSync(templatePath)) return { errors: ['template.json missing'], warnings };
  const template = readJson(templatePath);
  errors.push(...check('template', template).map((e) => `template.json ${e}`));
  if (!existsSync(join(templateDir, 'design.js'))) errors.push('design.js missing');

  const boardsDir = join(templateDir, 'boards');
  const listed = Array.isArray(template.boards) ? template.boards : [];
  const boardFields = {};
  const onDisk = existsSync(boardsDir) ? readdirSync(boardsDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
  for (const extra of onDisk.filter((n) => !listed.includes(n))) warnings.push(`boards/${extra}.json is not in template.json boards`);
  for (const name of new Set([...listed, ...onDisk])) {
    const jsonPath = join(boardsDir, `${name}.json`);
    const jsxPath = join(boardsDir, `${name}.jsx`);
    if (!existsSync(jsonPath)) { errors.push(`boards/${name}.json missing`); continue; }
    if (!existsSync(jsxPath)) errors.push(`boards/${name}.jsx missing`);
    else errors.push(...checkJsx(name, readFileSync(jsxPath, 'utf-8')));
    let meta;
    try { meta = readJson(jsonPath); } catch (e) { errors.push(`boards/${name}.json: ${e.message}`); continue; }
    const schemaErrors = check('board', meta);
    errors.push(...schemaErrors.map((e) => `boards/${name}.json ${e}`));
    if (schemaErrors.length) continue;
    errors.push(...checkSegments(name, meta), ...checkExample(name, meta.schema.fields, meta.example_data),
      ...checkMediaKeys(name, meta.schema.fields), ...checkBoardCaptions(name, meta, template.audio?.captions));
    if (existsSync(jsxPath)) errors.push(...checkCutoutDrawn(name, meta.schema.fields, readFileSync(jsxPath, 'utf-8')));
    if (listed.includes(name)) boardFields[name] = meta.schema.fields;
  }

  const analysisDir = join(dirname(templateDir), 'analysis');
  const inventoryPath = join(analysisDir, 'elements.json');
  if (!existsSync(inventoryPath)) errors.push('analysis/elements.json missing — inventory every element (references/analysis.md)');
  else {
    let inventory;
    try { inventory = readJson(inventoryPath); } catch (e) { errors.push(`analysis/elements.json: ${e.message}`); }
    if (inventory) {
      const designPath = join(templateDir, 'design.js');
      const design = existsSync(designPath) ? (await importCopy(designPath))?.Design ?? null : null;
      errors.push(...checkElements({ inventory, boardFields, design,
        motion: readJson(join(analysisDir, 'motion.json'), null),
        faces: readJson(join(templateDir, 'fonts.json'), { faces: [] }).faces || [] }));
    }
  }

  const refsPath = join(templateDir, 'refs', 'refs.json');
  if (existsSync(refsPath)) {
    const refs = readJson(refsPath);
    errors.push(...check('refs', refs).map((e) => `refs/refs.json ${e}`));
    for (const key of Object.keys(refs)) if (!listed.includes(key.split('.')[0])) warnings.push(`refs/refs.json: ${key} names no board of the template`);
  }

  const types = await transitionTypes(templateDir);
  for (const [i, tr] of (template.transitions || []).entries()) {
    const at = `template.json transitions[${i}]`;
    if (!listed.includes(tr.from)) errors.push(`${at}: from "${tr.from}" is not a board`);
    if (!listed.includes(tr.to)) errors.push(`${at}: to "${tr.to}" is not a board`);
    const fi = listed.indexOf(tr.from);
    if (fi >= 0 && listed[fi + 1] !== tr.to) warnings.push(`${at}: ${tr.from} → ${tr.to} is not adjacent in the default order`);
    if (!types.has(tr.type)) errors.push(`${at}: unknown transition type "${tr.type}" (known: ${[...types].join(', ')})`);
  }
  return { errors, warnings };
}
