// Reading a replica directory and the template it points at: one context object shared by
// project.mjs, timing.mjs, review.mjs, render.mjs and the validators.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fromPosixRel, readJson, run } from './common.mjs';
import { fieldPaths, getPath, sceneKey } from './media/plan.mjs';

export { sceneKey };

// Preview speech-rate estimates (spec §7.1): Mandarin about 4.5 characters a second, English
// about 15 characters (≈ 2.7 words) a second, both measured on typical explainer voice-overs.
export const CHARS_PER_SECOND = { zh: 4.5, en: 15 };

export const isZh = (language) => /^zh/i.test(language || '');

export function loadReplica(dirArg) {
  let dir = resolve(dirArg || '.');
  if (dir.endsWith('replica.json')) dir = dirname(dir);
  const path = join(dir, 'replica.json');
  if (!existsSync(path)) throw new Error(`${dir} has no replica.json`);
  const replica = readJson(path);
  return { dir, path, replica, ...loadTemplate(fromPosixRel(dir, replica.template)), tasks: readJson(join(dir, 'tasks.json'), { tasks: {} }) };
}

// Template dir → template.json, boards, refs, plus the clone project's analysis windows.
export function loadTemplate(templateDir) {
  const template = readJson(join(templateDir, 'template.json'));
  const boardsDir = join(templateDir, 'boards');
  const boards = new Map();
  for (const f of existsSync(boardsDir) ? readdirSync(boardsDir) : []) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    boards.set(name, { name, json: readJson(join(boardsDir, f)), jsx: join(boardsDir, `${name}.jsx`) });
  }
  const refsDir = join(templateDir, 'refs');
  const cloneRoot = dirname(templateDir);
  return {
    templateDir, template, boards, refsDir,
    refs: readJson(join(refsDir, 'refs.json'), {}),
    cloneRoot,
    analysis: readJson(join(cloneRoot, 'analysis', 'boards.json'), null),
    sourceVideo: template.source?.file ? fromPosixRel(templateDir, template.source.file) : join(cloneRoot, 'source', 'source.mp4'),
  };
}

export const boardFields = (ctx, name) => ctx.boards.get(name)?.json.schema?.fields || [];

// Narration lines of a scene: one per narration field on a segmented board, else the scene line.
export function narrationLines(fields, scene) {
  const lines = fieldPaths(fields, scene.data, 'narration').map(({ path }) => ({ key: path, text: getPath(scene.data, path) }));
  if (!lines.length && scene.narration) lines.push({ key: 'narration', text: scene.narration });
  return lines.filter((l) => l.text);
}

// Every media field path in a board's data: image / video (and avatar) / element.
export function mediaPaths(fields, data) {
  return ['image', 'video', 'element'].flatMap((type) => fieldPaths(fields, data, type).map((p) => ({ ...p, type })));
}

// The template transition into scene `index` (the boundary from the previous scene's board).
export function incomingTransition(template, boardsInOrder, index) {
  if (index === 0) return null;
  const tr = (template.transitions || []).find((x) => x.from === boardsInOrder[index - 1] && x.to === boardsInOrder[index]);
  return tr && tr.duration > 0 ? { type: tr.type, duration: tr.duration, params: tr.params || {} } : null;
}

// Han characters at the Mandarin rate, everything else at the English rate, so a Chinese line
// with an English product name (or the reverse) is still estimated sensibly.
export function estimateSpeechSeconds(text) {
  const str = String(text || '');
  const han = (str.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const rest = str.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, '').replace(/\s+/g, ' ').trim().length;
  return han / CHARS_PER_SECOND.zh + rest / CHARS_PER_SECOND.en;
}

// Word timings spread over [start, end] by character count, for captions without timestamps.
export function weightedWords(text, start, end, language) {
  const tokens = isZh(language)
    ? String(text).match(/[　-鿿＀-￯][，。！？、；：,.!?;:]*|[A-Za-z0-9'%.-]+[，。！？、；：,.!?;:]*/g) || []
    : String(text).split(/\s+/).filter(Boolean);
  const total = tokens.reduce((s, w) => s + w.length, 0) || 1;
  let at = start;
  return tokens.map((w) => {
    const d = ((end - start) * w.length) / total;
    const word = { text: w, start: round3(at), end: round3(at + d) };
    at += d;
    return word;
  });
}

export const round3 = (x) => Number(x.toFixed(3));

// The completed output files of a media request in tasks.json.
export function taskFiles(tasks, id) {
  const rec = tasks?.tasks?.[id];
  return rec?.status === 'completed' ? rec.result?.files || [] : [];
}

export function probeDuration(file) {
  return Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim());
}

// The source window of the n-th occurrence of a board in analysis/boards.json.
export function sourceWindow(analysis, board, occurrence) {
  const all = (analysis?.boards || []).filter((b) => b.name === board);
  return all[Math.min(occurrence, all.length - 1)] || null;
}

// Occurrence index of each scene's board among the scenes before it (for sourceWindow).
export function occurrences(boards) {
  const seen = {};
  return boards.map((b) => { seen[b] = (seen[b] ?? -1) + 1; return seen[b]; });
}
