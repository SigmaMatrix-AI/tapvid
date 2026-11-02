// Static checks of replicas/<slug>/replica.json against its template (spec §4 step 4).
// Returns { errors, warnings }; errors block the review page and media planning.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fromPosixRel, readJson } from './common.mjs';
import { refShowsPerson, templateTier } from './identity.mjs';
import { check } from './schema.mjs';
import { PACE_TOLERANCE, speechRate, textSyllables } from './pace.mjs';
import { loadReplica, mediaPaths, narrationLines, occurrences, sourceWindow } from './replica.mjs';

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// Data against the board's field schema: required, types, maxChars, minItems / maxItems.
export function checkData(fields, data, where) {
  const errors = [];
  const keys = new Set(fields.map((f) => f.key));
  for (const k of Object.keys(data || {})) if (!keys.has(k)) errors.push(`${where}.${k}: not a field of the board`);
  for (const f of fields) {
    const v = data?.[f.key];
    const at = `${where}.${f.key}`;
    if (v === undefined || v === null) {
      if (f.required && !['image', 'video', 'element'].includes(f.type)) errors.push(`${at}: required`);
      continue;
    }
    const tooLong = (s, label) => {
      if (typeof s !== 'string') errors.push(`${label}: expected string, got ${typeName(s)}`);
      else if (f.maxChars && [...s].length > f.maxChars) errors.push(`${label}: ${[...s].length} chars, max ${f.maxChars}`);
    };
    const count = (arr) => {
      if (f.minItems !== undefined && arr.length < f.minItems) errors.push(`${at}: ${arr.length} items, min ${f.minItems}`);
      if (f.maxItems !== undefined && arr.length > f.maxItems) errors.push(`${at}: ${arr.length} items, max ${f.maxItems}`);
    };
    if (f.type === 'string' || f.type === 'narration') tooLong(v, at);
    else if (f.type === 'number' && typeof v !== 'number') errors.push(`${at}: expected number`);
    else if (f.type === 'string[]' || f.type === 'number[]' || f.type === 'object[]') {
      if (!Array.isArray(v)) { errors.push(`${at}: expected a list`); continue; }
      count(v);
      if (f.type === 'string[]') v.forEach((s, i) => tooLong(s, `${at}.${i}`));
      if (f.type === 'object[]') v.forEach((item, i) => errors.push(...checkData(f.fields || [], item, `${at}.${i}`)));
    } else if (f.type === 'object') errors.push(...checkData(f.fields || [], v, at));
  }
  return errors;
}

function checkMedia(ctx, scene, key, fields, errors, warnings) {
  const { replica, refs } = ctx;
  const narration = replica.audio?.mode === 'narration';
  const expected = new Map(mediaPaths(fields, scene.data).map((p) => [p.path, p]));
  for (const path of expected.keys()) if (!scene.media?.[path]) errors.push(`${key}.media.${path}: missing (the board has this media field)`);
  for (const [path, m] of Object.entries(scene.media || {})) {
    const at = `${key}.media.${path}`;
    const field = expected.get(path);
    if (!field) { errors.push(`${at}: no such media field path in the data (list counts changed?)`); continue; }
    if (field.type === 'element' && (m.kind !== 'element' || m.source !== 'code')) errors.push(`${at}: element fields are kind element, source code`);
    if (m.kind === 'element' && field.type !== 'element') errors.push(`${at}: kind element on a ${field.type} field`);
    if (m.kind === 'image' && field.type !== 'image') errors.push(`${at}: kind image on a ${field.type} field`);
    if ((m.kind === 'video' || m.kind === 'avatar') && field.type !== 'video') errors.push(`${at}: kind ${m.kind} on a ${field.type} field`);
    if (m.kind === 'avatar' && !narration) errors.push(`${at}: avatar slots need narration mode`);
    if (m.kind === 'avatar' && m.source === 'code') errors.push(`${at}: an avatar cannot be source code`);
    if (m.mode && m.source !== 'ai') errors.push(`${at}: mode only applies to source ai`);
    const ref = m.ref ? refs[m.ref] : null;
    if (m.ref && !ref) errors.push(`${at}: ref ${m.ref} is not in refs.json`);
    const hasClip = Boolean(ref?.clip);
    if (m.source === 'ai' && m.mode === 'reference' && refShowsPerson(ref) && !m.reference_ok && templateTier(ctx) === 'high') {
      errors.push(`${at}: its reference clip shows a person, and a reference clip can carry that person into the film: use mode keyframe, or say in reference_ok why no one is recognisable (a silhouette)`);
    }
    if (m.source === 'ai' && m.mode === 'reference' && !hasClip) errors.push(`${at}: mode reference needs a ref with a clip`);
    if (m.source === 'ai' && m.mode === 'keyframe' && !ref?.frame) errors.push(`${at}: mode keyframe needs a ref with a frame`);
    const needsSketch = m.source === 'code' && m.kind !== 'element'
      || (m.source === 'ai' && ['image', 'video'].includes(m.kind) && !(m.mode === 'reference' && hasClip));
    if (needsSketch) {
      if (!m.sketch) errors.push(`${at}: needs a sketch (sketches/${scene.board}.${path}.jsx)`);
      else if (!existsSync(fromPosixRel(ctx.dir, m.sketch))) errors.push(`${at}: sketch ${m.sketch} does not exist`);
    }
    if (m.source === 'user' && (!m.file || !existsSync(fromPosixRel(ctx.dir, m.file)))) errors.push(`${at}: user file ${m.file} does not exist`);
    for (const s of m.replace || []) {
      if (!(replica.replace || []).some((r) => r.subject === s)) warnings.push(`${at}: lists ${s}, which has no entry in replace[] (kept as in the source)`);
    }
  }
}

// Copy budget: a scene's narration should fit the syllables the original speaks in the same
// window (at the original's pace, plus the tolerance); longer copy makes the scene run long or
// forces a fast voice. The source rate falls back to the whole film's when the window is silent.
function checkCopyBudget(ctx, warnings) {
  const { replica } = ctx;
  const timeline = readJson(join(ctx.cloneRoot, 'source', 'timeline.json'), null);
  const words = timeline?.words || [];
  if (!words.length) return;
  const language = timeline.language || replica.language;
  const film = speechRate(words, { language }).sylPerS;
  const occ = occurrences(replica.scenes.map((s) => s.board));
  replica.scenes.forEach((scene, i) => {
    const win = sourceWindow(ctx.analysis, scene.board, occ[i]);
    if (!win || !ctx.boards.has(scene.board)) return;
    const local = speechRate(words, { language, from: win.start, to: win.end }).sylPerS;
    const original = (win.end - win.start) * (local || film);
    const fields = ctx.boards.get(scene.board).json.schema?.fields || [];
    const said = narrationLines(fields, scene).reduce((a, l) => a + textSyllables(l.text, replica.language), 0);
    if (original > 0 && said > original * (1 + PACE_TOLERANCE)) {
      warnings.push(`scenes[${i}] ${scene.board}: narration is ~${said} syllables, the original says ~${Math.round(original)} in this window — shorten it or the scene runs long/fast`);
    }
  });
}

export function validateReplica(dirArg) {
  const errors = [];
  const warnings = [];
  let ctx;
  try {
    ctx = loadReplica(dirArg);
  } catch (e) {
    return { errors: [e.message], warnings };
  }
  const { replica, refs } = ctx;
  errors.push(...check('replica', replica).map((e) => `schema ${e}`));
  if (!Array.isArray(replica.scenes)) return { errors, warnings };

  const refSubjects = new Set(Object.values(refs).flatMap((r) => (r.subjects || []).map((s) => s.id)));
  for (const r of replica.replace || []) {
    if (!refSubjects.has(r.subject) && !r.with?.generate) errors.push(`replace ${r.subject}: not a subject in refs.json and not generated`);
    if (!r.with?.file && !r.with?.generate) errors.push(`replace ${r.subject}: needs with.file or with.generate`);
    if (r.with?.file && !existsSync(fromPosixRel(ctx.dir, r.with.file))) errors.push(`replace ${r.subject}: ${r.with.file} does not exist`);
    if (r.with?.from && !r.with?.generate) errors.push(`replace ${r.subject}: with.from needs with.generate (what to make of the picture)`);
    if (r.with?.from && !existsSync(fromPosixRel(ctx.dir, r.with.from))) errors.push(`replace ${r.subject}: ${r.with.from} does not exist`);
  }
  const mode = replica.audio?.mode;
  if (mode !== 'narration' && (replica.audio?.voice || replica.audio?.captions)) errors.push(`audio: ${mode} mode has no voice or captions`);
  if (mode === 'silent' && replica.audio?.bgm) errors.push('audio: silent mode has no bgm');
  if (mode === 'narration' && !replica.audio?.voice) warnings.push('audio: narration mode without a voice yet');

  replica.scenes.forEach((scene, i) => {
    const key = `scenes[${i}] ${scene.board}`;
    const board = ctx.boards.get(scene.board);
    if (!board || !existsSync(board.jsx)) { errors.push(`${key}: board ${scene.board} is not in the template`); return; }
    const fields = board.json.schema?.fields || [];
    errors.push(...checkData(fields, scene.data, `${key}.data`));
    checkMedia(ctx, scene, key, fields, errors, warnings);
  });
  if (mode === 'narration') checkCopyBudget(ctx, warnings);
  return { errors, warnings };
}
