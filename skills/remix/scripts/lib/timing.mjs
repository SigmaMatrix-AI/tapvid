// Scene timing (spec §4 step 8). Narration mode: durations follow the voice takes. Music-only
// and silent: durations follow the source timeline (analysis/boards.json), optionally snapped
// to the BGM beat grid. The layout helpers are shared with the preview estimate in project.mjs.
// A self-voiced avatar (avatar.generate mode tts) is its own narration: its clip's transcript
// places the lines. One uniform tempo then brings the film's speech rate to the original's.
import { existsSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fromPosixRel, readJson, run, toFrame, toPosixRel } from './common.mjs';
import { getPath, requestId, slotRequestId, speechRequestId } from './media/plan.mjs';
import { speechRate, tempoFactor, wordTokens } from './pace.mjs';
import {
  boardFields, incomingTransition, narrationLines, occurrences, probeDuration, round3, sceneKey,
  sourceWindow, taskFiles, weightedWords,
} from './replica.mjs';

// Silence before the first word and after the last: enough for a cut to land before the voice
// and for the line to breathe before the next scene (tuned by ear on 2–4 s explainer scenes).
export const PRE_PAD_S = 0.3;
export const POST_PAD_S = 0.4;
// Pause between the per-line takes of a segmented board, about a comma's worth.
export const LINE_GAP_S = 0.15;
// Share of the script's words found in an avatar clip's transcript below which the clip does
// not say the script (a transcription slip costs a few words; a wrong clip most of them).
export const MIN_WORD_MATCH = 0.8;

// Request id of the word timings of a self-voiced avatar clip (speech.transcribe of the clip).
export const wordsRequestId = (slug, index, board, path) => requestId(slotRequestId(slug, index, board, path), 'words');

// Lay out narration lines in a scene: voice starts after the incoming transition has landed
// (or the pre-pad, whichever is longer), lines follow each other with a gap; segments tile the
// scene so a segmented board can time each item from its segment start.
export function layoutNarration(lines, { transitionIn, min, max }) {
  const audioOffset = Math.max(PRE_PAD_S, transitionIn?.duration || 0);
  let at = audioOffset;
  const placed = lines.map((l, i) => {
    const start = at;
    at += l.duration + (i < lines.length - 1 ? LINE_GAP_S : 0);
    return { ...l, start, end: start + l.duration };
  });
  const natural = at + POST_PAD_S;
  const duration = Math.max(min ?? 0, natural);
  const segments = placed.map((l, i) => ({
    key: l.key, start: round3(i === 0 ? 0 : l.start), end: round3(i === placed.length - 1 ? duration : placed[i + 1].start),
  }));
  return { duration, audioOffset, placed, segments, over: max !== undefined && natural > max, natural };
}

// Segments of a source window, with list items added or dropped at the source's per-item
// rhythm when the replica's list is longer or shorter than the source's.
export function scaleSourceSegments(window, data) {
  const duration = window.end - window.start;
  const src = window.segments || [];
  const lead = src[0]?.start ?? 0;
  const tail = src.length ? duration - src[src.length - 1].end : 0;
  const parse = (key) => key.match(/^(.+?)\.(\d+)\.(.+)$/);
  let segs = src.map((s) => ({ key: s.key, len: s.end - s.start }));
  for (const list of new Set(segs.map((s) => parse(s.key)?.[1]).filter(Boolean))) {
    const idx = (s) => { const m = parse(s.key); return m && m[1] === list ? Number(m[2]) : null; };
    const count = (getPath(data, list) || []).length;
    const items = segs.filter((s) => idx(s) !== null);
    const srcCount = new Set(items.map(idx)).size;
    if (!count || count === srcCount) continue;
    const perItem = items.reduce((a, s) => a + s.len, 0) / srcCount;
    const lastIdx = Math.max(...items.map(idx));
    const last = items.filter((s) => idx(s) === lastIdx);
    const lastLen = last.reduce((a, s) => a + s.len, 0) || 1;
    const extra = [];
    for (let i = srcCount; i < count; i++) {
      for (const s of last) extra.push({ key: s.key.replace(`${list}.${lastIdx}.`, `${list}.${i}.`), len: (s.len / lastLen) * perItem });
    }
    const end = segs.findLastIndex((s) => idx(s) !== null);
    segs = [...segs.slice(0, end + 1), ...extra, ...segs.slice(end + 1)].filter((s) => idx(s) === null || idx(s) < count);
  }
  let at = lead;
  const segments = segs.map((s) => { const r = { key: s.key, start: at, end: at + s.len }; at += s.len; return r; });
  return { duration: segs.length ? at + Math.max(0, tail) : duration, segments };
}

// Move each scene boundary to the nearest beat when it lies within half a beat of one.
export function snapToBeats(durations, beats) {
  if (!beats?.length) return durations;
  const period = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : Infinity;
  const out = [];
  let prev = 0;
  let acc = 0;
  for (let i = 0; i < durations.length; i++) {
    acc += durations[i];
    let edge = acc;
    if (i < durations.length - 1) {
      const near = beats.reduce((b, x) => (Math.abs(x - acc) < Math.abs(b - acc) ? x : b), beats[0]);
      if (Math.abs(near - acc) <= period / 2 && near > prev) edge = near;
    }
    out.push(edge - prev);
    prev = edge;
  }
  return out;
}

function concatTakes(files, outFile) {
  mkdirSync(join(outFile, '..'), { recursive: true });
  const inputs = files.flatMap((f) => ['-i', f]);
  const chains = files.map((_, i) => `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${i < files.length - 1 ? `,apad=pad_dur=${LINE_GAP_S}` : ''}[a${i}]`);
  const filter = `${chains.join(';')};${files.map((_, i) => `[a${i}]`).join('')}concat=n=${files.length}:v=0:a=1[out]`;
  run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '192k', outFile]);
}

function extractAudio(clip, outFile) {
  mkdirSync(join(outFile, '..'), { recursive: true });
  run('ffmpeg', ['-y', '-v', 'error', '-i', clip, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', outFile]);
}

const readPlan = (ctx) => readJson(join(ctx.dir, 'plan.json'), { requests: [] });

// The scene's avatar slot that voices the script itself: avatar.generate in mode tts in plan.json.
function selfVoicedSlot(ctx, plan, scene, index) {
  for (const [path, m] of Object.entries(scene.media || {})) {
    if (m.kind !== 'avatar' || m.source !== 'ai') continue;
    const id = slotRequestId(ctx.replica.slug, index, scene.board, path);
    const req = (plan.requests || []).find((r) => r.id === id);
    if (req?.capability === 'avatar.generate' && req.params?.mode === 'tts') return { path, id };
  }
  return null;
}

// Word timings of a completed transcription: on the result file, or inside its transcript json.
export function transcriptWords(ctx, id) {
  const file = taskFiles(ctx.tasks, id)[0];
  if (!file) return null;
  if (file.words?.length) return file.words;
  const abs = fromPosixRel(ctx.dir, file.path);
  return /\.json$/i.test(file.path) && existsSync(abs) ? readJson(abs).words || null : null;
}

// speech.transcribe requests for the self-voiced avatar clips that have no word timings yet
// (timing.mjs runs them before resolveTiming).
export function transcribeRequests(ctx) {
  if (ctx.replica.audio?.mode !== 'narration') return [];
  const plan = readPlan(ctx);
  return ctx.replica.scenes.flatMap((scene, index) => {
    const slot = selfVoicedSlot(ctx, plan, scene, index);
    const clip = slot && taskFiles(ctx.tasks, slot.id)[0];
    const id = slot && wordsRequestId(ctx.replica.slug, index, scene.board, slot.path);
    if (!clip || transcriptWords(ctx, id)) return [];
    return [{ id, capability: 'speech.transcribe', params: { file: clip.path, language: ctx.replica.language }, out: `assets/audio/${sceneKey(index, scene.board)}.${slot.path}.words` }];
  });
}

// Script lines on the words actually spoken: a longest-common-subsequence alignment of
// normalized tokens; a line spans its first to last token, unmatched tokens interpolated
// between their matched neighbours. Returns { lines: [{ key, start, end }], ratio }.
export function alignLines(lines, words) {
  const script = lines.flatMap((l, li) => wordTokens(l.text).map((tok) => ({ tok, li })));
  const heard = words.flatMap((w) => wordTokens(w.text).map((tok) => ({ tok, w })));
  const n = script.length;
  const m = heard.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = script[i].tok === heard[j].tok ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const at = new Array(n).fill(null);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (script[i].tok === heard[j].tok) { at[i] = heard[j].w; i++; j++; } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++; else j++;
  }
  const matched = at.flatMap((w, i) => (w ? [i] : []));
  const first = words[0]?.start ?? 0;
  const last = words[words.length - 1]?.end ?? first;
  const times = at.map((w, i) => {
    if (w) return { start: w.start, end: w.end };
    const lo = matched.findLast((k) => k < i) ?? -1;
    const hi = matched.find((k) => k > i) ?? n;
    const a = lo < 0 ? first : at[lo].end;
    const b = hi >= n ? last : at[hi].start;
    const gap = hi - lo - 1;
    return { start: a + ((b - a) * (i - lo - 1)) / gap, end: a + ((b - a) * (i - lo)) / gap };
  });
  const placed = lines.map((l, li) => {
    const idx = script.flatMap((s, i) => (s.li === li ? [i] : []));
    return { key: l.key, start: idx.length ? times[idx[0]].start : first, end: idx.length ? times[idx[idx.length - 1]].end : first };
  });
  return { lines: placed, ratio: n ? matched.length / n : 0 };
}

// A scene voiced by its avatar: the clip's audio is the scene audio, its transcript the words.
// The avatar's picture and voice are one clip starting at the scene start, so the audio offset
// is 0 (the clip's own lead-in plays under the incoming transition) and no gaps are inserted;
// each segment starts at its line's first word.
function avatarScene(ctx, scene, index, slot, texts, problems) {
  const board = ctx.boards.get(scene.board)?.json || {};
  const key = sceneKey(index, scene.board);
  const clip = taskFiles(ctx.tasks, slot.id)[0];
  if (!clip) { problems.push(`${key}: avatar clip ${slot.id} is not in tasks.json (run media.mjs run plan.json)`); return null; }
  const words = transcriptWords(ctx, wordsRequestId(ctx.replica.slug, index, scene.board, slot.path));
  if (!words?.length) { problems.push(`${key}: the avatar clip has no word timings (timing.mjs transcribes it — is a transcription provider ready?)`); return null; }
  const abs = fromPosixRel(ctx.dir, clip.path);
  const clipS = probeDuration(abs);
  const min = board.meta?.minDuration;
  const max = board.meta?.maxDuration;
  if (max !== undefined && clipS > max) {
    problems.push(`${key}: the avatar speaks for ${clipS.toFixed(2)} s but ${scene.board} allows at most ${max} s — shorten the line and regenerate the avatar`);
    return null;
  }
  const { lines, ratio } = alignLines(texts, words);
  if (ratio < MIN_WORD_MATCH) {
    problems.push(`${key}: only ${Math.round(ratio * 100)}% of the script's words are in the avatar clip's transcript — the clip does not say the script`);
    return null;
  }
  const audioFile = join(ctx.dir, 'assets', 'audio', `${key}.mp3`);
  extractAudio(abs, audioFile);
  const duration = Math.max(min ?? 0, clipS);
  const segments = lines.map((l, i) => ({
    key: l.key, start: round3(i === 0 ? 0 : l.start), end: round3(i === lines.length - 1 ? duration : lines[i + 1].start),
  }));
  const segmented = board.meta?.durationModel === 'segments' || lines.length > 1;
  return {
    duration, segments: segmented ? segments : [], audio: toPosixRel(ctx.dir, audioFile), audioOffset: 0,
    words: words.map((w) => ({ text: w.text, start: round3(w.start), end: round3(w.end) })),
    presenter: { path: slot.path, file: abs }, wordMatch: round3(ratio),
  };
}

function narrationScene(ctx, plan, scene, index, transitionIn, problems) {
  const { replica, dir } = ctx;
  const board = ctx.boards.get(scene.board)?.json || {};
  const fields = boardFields(ctx, scene.board);
  const key = sceneKey(index, scene.board);
  const texts = narrationLines(fields, scene);
  const slot = selfVoicedSlot(ctx, plan, scene, index);
  const hasTakes = texts.some((l) => taskFiles(ctx.tasks, speechRequestId(replica.slug, index, scene.board, l.key)).length);
  if (slot && texts.length && !hasTakes) return avatarScene(ctx, scene, index, slot, texts, problems);
  const lines = texts.map((l) => {
    const id = speechRequestId(replica.slug, index, scene.board, l.key);
    const file = taskFiles(ctx.tasks, id)[0];
    if (!file) { problems.push(`${key}: narration take ${id} is not in tasks.json (run media.mjs run plan.json)`); return null; }
    const abs = fromPosixRel(dir, file.path);
    return { ...l, file: abs, rel: file.path, words: file.words, duration: probeDuration(abs) };
  });
  if (lines.some((l) => !l)) return null;
  const min = board.meta?.minDuration;
  const max = board.meta?.maxDuration;
  if (!lines.length) {
    const d = Math.max(min ?? 0, (board.example_duration_ms || 0) / 1000 || min || 2);
    return { duration: d, segments: [], audio: null, audioOffset: 0, words: null };
  }
  const lay = layoutNarration(lines, { transitionIn, min, max });
  if (lay.over) {
    problems.push(`${key}: narration needs ${lay.natural.toFixed(2)} s but ${scene.board} allows at most ${max} s — shorten the line and re-voice`);
    return null;
  }
  let audio = lines[0].rel;
  if (lines.length > 1) {
    const joined = join(dir, 'assets', 'audio', `${key}.mp3`);
    concatTakes(lines.map((l) => l.file), joined);
    audio = toPosixRel(dir, joined);
  }
  const words = lay.placed.flatMap((l) => (l.words?.length
    ? l.words.map((w) => ({ text: w.text, start: round3(l.start + w.start), end: round3(l.start + w.end) }))
    : weightedWords(l.text, l.start, l.end, replica.language)));
  const segmented = board.meta?.durationModel === 'segments' || lines.length > 1;
  return { duration: lay.duration, segments: segmented ? lay.segments : [], audio, audioOffset: round3(lay.audioOffset), words };
}

function sourceScene(ctx, scene, occurrence, problems, key) {
  const win = sourceWindow(ctx.analysis, scene.board, occurrence);
  if (!win) {
    problems.push(`${key}: analysis/boards.json has no window for ${scene.board}`);
    return null;
  }
  const { duration, segments } = scaleSourceSegments(win, scene.data);
  return { duration, segments, audio: null, audioOffset: 0, words: null };
}

// One speed-up for the whole film when its takes speak slower than the original (syllables per
// second over speech spans). Voice-over takes get atempo; a self-voiced avatar clip is sped as
// picture and sound together into assets/gen/<name>.tempo-<f>.mp4 (the original stays). Times
// after the voice starts scale by 1/f, so a voice still waits for its incoming transition.
// `audio.tempo.fixed` forces the factor (1 = off). Returns { items, tempo } (tempo null when
// there is neither a source transcript nor a fixed factor).
function applyTempo(ctx, items) {
  const { replica, dir } = ctx;
  const fixed = typeof replica.audio?.tempo?.fixed === 'number' ? replica.audio.tempo.fixed : null;
  const timeline = readJson(join(ctx.cloneRoot, 'source', 'timeline.json'), null);
  const source = timeline?.words?.length ? speechRate(timeline.words, { language: timeline.language || replica.language }) : null;
  if (!source && fixed === null) return { items, tempo: null };
  const rates = items.map((it) => speechRate(it.words || [], { language: replica.language }));
  const speechS = rates.reduce((a, r) => a + r.speechS, 0);
  const takeRate = speechS > 0 ? rates.reduce((a, r) => a + r.syllables, 0) / speechS : 0;
  const kind = items.some((it) => it.presenter) ? 'presenter' : 'voiceover';
  const factor = fixed ?? tempoFactor(source.sylPerS, takeRate, kind);
  const round2 = (x) => Number(x.toFixed(2));
  const tempo = { factor, sourceSylPerS: source ? round2(source.sylPerS) : null, takeSylPerS: round2(takeRate), kind, ...(fixed !== null ? { fixed } : {}) };
  if (factor === 1 || !(factor > 0)) return { items, tempo };
  const tag = `tempo-${factor}`;
  const sped = items.map((it) => {
    if (!it.audio) return it;
    const anchor = it.audioOffset;
    const scale = (t) => (t <= anchor ? t : round3(anchor + (t - anchor) / factor));
    const audioIn = fromPosixRel(dir, it.audio);
    const audioOut = join(dir, 'assets', 'audio', `${basename(audioIn, extname(audioIn))}.${tag}.mp3`);
    run('ffmpeg', ['-y', '-v', 'error', '-i', audioIn, '-filter:a', `atempo=${factor}`, '-c:a', 'libmp3lame', '-b:a', '192k', audioOut]);
    let media;
    if (it.presenter) {
      const clipOut = join(dir, 'assets', 'gen', `${basename(it.presenter.file, extname(it.presenter.file))}.${tag}.mp4`);
      mkdirSync(join(clipOut, '..'), { recursive: true });
      run('ffmpeg', ['-y', '-v', 'error', '-i', it.presenter.file, '-filter_complex', `[0:v]setpts=PTS/${factor}[v];[0:a]atempo=${factor}[a]`,
        '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clipOut]);
      media = { [it.presenter.path]: toPosixRel(dir, clipOut) };
    }
    const duration = Math.max(ctx.boards.get(it.board)?.json.meta?.minDuration ?? 0, scale(it.duration));
    return {
      ...it, duration, audio: toPosixRel(dir, audioOut), media,
      segments: it.segments.map((s, i, all) => ({ ...s, start: scale(s.start), end: i === all.length - 1 ? duration : scale(s.end) })),
      words: it.words?.map((w) => ({ ...w, start: scale(w.start), end: scale(w.end) })),
    };
  });
  return { items: sped, tempo };
}

// Compute replica.resolved. Returns { resolved, problems, tempo }; problems are fatal; tempo is
// the uniform speed-up decision for replica.audio.tempo (narration mode, else null).
export function resolveTiming(ctx) {
  const { replica, template } = ctx;
  const fps = template.fps || 30;
  const order = replica.scenes.map((s) => s.board);
  const occ = occurrences(order);
  const narration = replica.audio?.mode === 'narration';
  const problems = [];
  const plan = narration ? readPlan(ctx) : null;
  const laid = replica.scenes.map((scene, i) => {
    const transitionIn = incomingTransition(template, order, i);
    const key = sceneKey(i, scene.board);
    const r = narration ? narrationScene(ctx, plan, scene, i, transitionIn, problems) : sourceScene(ctx, scene, occ[i], problems, key);
    return r && { key, board: scene.board, transitionIn, ...r };
  });
  if (problems.length) return { resolved: null, problems, tempo: null };
  const { items, tempo } = narration ? applyTempo(ctx, laid) : { items: laid, tempo: null };

  let durations = items.map((it) => it.duration);
  const beatsPath = replica.audio?.mode === 'music-only' && replica.audio?.bgm?.beats ? fromPosixRel(ctx.dir, replica.audio.bgm.beats) : null;
  if (beatsPath && existsSync(beatsPath)) {
    const grid = readJson(beatsPath);
    const snapped = snapToBeats(durations, grid.beats || grid.times);
    items.forEach((it, i) => {
      const k = snapped[i] / it.duration;
      it.segments = it.segments.map((s) => ({ ...s, start: s.start * k, end: s.end * k }));
    });
    durations = snapped;
  }

  const resolved = {};
  let start = 0;
  items.forEach((it, i) => {
    const duration = toFrame(durations[i], fps);
    resolved[it.key] = {
      start: toFrame(start, fps), duration,
      segments: it.segments.map((s) => ({ key: s.key, start: toFrame(s.start, fps), end: toFrame(Math.min(s.end, duration), fps) })),
      transitionIn: it.transitionIn, audio: it.audio, audioOffset: it.audioOffset, words: it.words,
      ...(it.media ? { media: it.media } : {}), ...(it.wordMatch !== undefined ? { wordMatch: it.wordMatch } : {}),
    };
    start += duration;
  });
  return { resolved, problems: [], tempo };
}
