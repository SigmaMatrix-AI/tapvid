#!/usr/bin/env node
// The review page (spec §7.1), at the two confirmations of the flow.
//   node review.mjs <project> [--no-open]          clone review: $PROJECT/review/ (clone comparison only)
//   node review.mjs <project> <slug> [--no-open]   replica review: $REPLICA/review/
// Builds review/compare-project (template with example data + reference clips, source timing)
// and, for a replica, review/preview-project (the replica preview); places source.mp4, the BGM
// candidates, the sound effects the boards trigger and — once rendered — the final cuts and every
// generated asset next to them, writes review/data.json and review/index.html, prints the page path.
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_DIR, PLUGIN, cloneDir, fail, fromPosixRel, parseArgs, readJson, replicaDir, run, writeJson } from './lib/common.mjs';
import { platform } from './lib/platform.mjs';
import { replaceRequestId, requestId, slotRequestId, speechRequestId } from './lib/media/plan.mjs';
import { loadRegistry } from './lib/media/registry.mjs';
import { spendFromTasks } from './lib/media/runner.mjs';
import { buildProject, generateProject } from './lib/project.mjs';
import { boardFields, loadReplica, loadTemplate, narrationLines } from './lib/replica.mjs';
import { resolveSfx } from './lib/sfx.mjs';
import { validateReplica } from './lib/validate-replica.mjs';

// Shots scoring below this are flagged (spec §4 step 3.9).
const COMPARE_THRESHOLD = 0.95;

// The page gets codes and formats them in the viewer's language (review.html's dictionary).
const KINDS = new Set(['image', 'video', 'avatar']);
const MODES = new Set(['reference', 'keyframe', 'text']);
const CAPABILITY = { 'image.generate': 'image', 'video.generate': 'video', 'avatar.generate': 'avatar', 'speech.synthesize': 'speech', 'music.generate': 'music' };
const aiKind = (kind) => (KINDS.has(kind) ? kind : 'ai');
const note = (code, detail) => ({ code, detail });

function place(src, dest) {
  mkdirSync(join(dest, '..'), { recursive: true });
  rmSync(dest, { force: true });
  try { linkSync(src, dest); } catch { copyFileSync(src, dest); }
}

function sourceLabel(m) {
  if (m.kind === 'element' || m.source === 'code') return { kind: 'code', mode: null };
  if (m.source === 'user') return { kind: 'user', mode: null };
  return { kind: aiKind(m.kind), mode: MODES.has(m.mode) ? m.mode : null };
}

// media.mjs estimate output, or null when there is no plan yet.
function estimate(dir, notes) {
  if (!existsSync(join(dir, 'plan.json'))) return null;
  try {
    return JSON.parse(run(process.execPath, [join(PLUGIN, 'scripts', 'media.mjs'), 'estimate', join(dir, 'plan.json'), '--json'], { cwd: dir }));
  } catch (e) {
    notes.push(note('estimate', (e.stderr || e.message).toString().trim().split('\n')[0]));
    return null;
  }
}

const costText = (r) => (r?.credits ? `${r.credits} credits` : r?.usd != null ? `$${r.usd.toFixed(2)}` : null);
const money = (v, currency) => (currency === 'credits' ? `${v} credits` : `$${v.toFixed(2)}`);
const priceTotals = (totals, vendor) => Object.entries(totals || {}).map(([provider, t]) => ({ provider: vendor(provider), text: costText(t) || '0' }));

// estimate().byModel / spendFromTasks().byModel → rows the page formats: capability and unit as
// codes (unit null when there is no unit price), prices as money strings.
function modelRows(byModel, vendor) {
  return (byModel || []).map((m) => {
    const priced = m.unitPrice !== null && m.unitPrice !== undefined;
    return {
      vendor: vendor(m.provider), model: m.model || '—', capability: CAPABILITY[m.capability] || m.capability || '',
      price: priced ? (m.currency === 'credits' ? `${m.unitPrice} credits` : `$${Number(m.unitPrice.toFixed(4))}`) : null,
      unit: priced ? m.unit : null, resolution: priced ? m.resolution || null : null,
      count: m.count, subtotal: money(m.subtotal, m.currency), estimated: Boolean(m.estimated),
    };
  });
}

function storyboard(ctx, preview, est, notes, vendor) {
  const byId = new Map((est?.rows || []).map((r) => [r.id, r]));
  const rows = ctx.replica.scenes.map((scene, i) => {
    const board = ctx.boards.get(scene.board)?.json || {};
    const slots = Object.entries(scene.media || {}).map(([path, m]) => {
      const r = m.source === 'ai' ? byId.get(slotRequestId(ctx.replica.slug, i, scene.board, path)) : null;
      if (r?.note) notes.push(note('warning', `${scene.board}.${path}: ${r.note}`));
      return { path, ...sourceLabel(m), visual: m.visual || '', provider: r?.provider || m.provider || null, model: r?.model || m.model || null, usd: r?.usd ?? null, credits: r?.credits ?? null };
    });
    const lines = narrationLines(boardFields(ctx, scene.board), scene);
    const speech = lines.map((l) => byId.get(speechRequestId(ctx.replica.slug, i, scene.board, l.key))).filter(Boolean);
    const costed = [...slots, ...speech];
    const usd = costed.reduce((a, s) => a + (s.usd || 0), 0);
    const credits = costed.reduce((a, s) => a + (s.credits || 0), 0);
    return {
      n: i + 1, key: preview.scenes[i].key, beat: scene.beat || board.meta?.displays || scene.board,
      visual: slots.map((s) => s.visual).filter(Boolean).join('；') || board.meta?.displays || '',
      narration: lines.map((l) => l.text).join(' ') || '—',
      slots: slots.length ? slots : [{ kind: 'code', mode: null, provider: null, model: null }],
      duration: preview.scenes[i].duration,
      cost: [credits ? `${credits} credits` : null, usd ? `$${usd.toFixed(2)}` : null].filter(Boolean).join(' + ') || null,
    };
  });
  const all = [...notes, ...(est?.warnings || []).map((w) => note('warning', w))];
  const unique = [...new Map(all.map((n) => [`${n.code}|${n.detail}`, n])).values()];
  return { rows, models: modelRows(est?.byModel, vendor), totals: priceTotals(est?.totals, vendor), notes: unique };
}

// compare/report.json from compare.mjs: one row per sample (board, window, pct, source_t, struct).
// Samples of one window collapse into one shot cell scored by its worst sample; the reasons a
// low score is accepted come from compare/reasons.json ({ "<board>": "…" }), written with report.md.
function compareReport(ctx) {
  const dir = join(ctx.cloneRoot, 'compare');
  const report = readJson(join(dir, 'report.json'), { rows: [], timing: [] });
  const reasons = readJson(join(dir, 'reasons.json'), {});
  const cells = new Map();
  for (const row of (report.rows || []).filter((x) => !x.variant)) {
    const key = `${row.board}|${row.window}`;
    const c = cells.get(key) || { board: row.board, start: row.source_t, end: row.source_t, score: row.struct };
    cells.set(key, { ...c, start: Math.min(c.start, row.source_t), end: Math.max(c.end, row.source_t), score: Math.min(c.score, row.struct) });
  }
  const shots = [...cells.values()].sort((a, b) => a.start - b.start)
    .map((c) => ({ ...c, reason: c.score < COMPARE_THRESHOLD ? reasons[c.board] || null : null }));
  const timing = (report.timing || []).map((x) => ({
    label: `${x.board} ${x.kind}`, at: x.source_t ?? 0, deltaFrames: x.frames ?? null,
    flagged: x.frames === null || x.frames === undefined || Math.abs(x.frames) > 1, note: x.note || null,
  }));
  return { shots, timing };
}

// Fidelity in numbers from compare/report.json: min / mean struct and samples at the threshold.
export function fidelity(cloneRoot) {
  const scores = (readJson(join(cloneRoot, 'compare', 'report.json'), { rows: [] }).rows || [])
    .filter((r) => !r.variant && typeof r.struct === 'number').map((r) => r.struct);
  if (!scores.length) return null;
  return { min: Math.min(...scores), mean: scores.reduce((a, b) => a + b, 0) / scores.length, passed: scores.filter((x) => x >= COMPARE_THRESHOLD).length, samples: scores.length };
}

// The "known limits" section of the template report ($PROJECT/report.md): its list items, or its
// paragraphs when it has no list.
export function knownLimits(project) {
  const path = join(project, 'report.md');
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && /known limit|limitation/i.test(l));
  if (at < 0) return [];
  const level = lines[at].match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l) && l.match(/^#+/)[0].length <= level);
  const body = lines.slice(at + 1, end < 0 ? undefined : end);
  const items = body.filter((l) => /^\s*([-*+]|\d+\.)\s+/.test(l)).map((l) => l.replace(/^\s*([-*+]|\d+\.)\s+/, '').trim());
  return items.length ? items : body.map((l) => l.trim()).filter(Boolean);
}

// Sound-effect kinds the template's boards trigger (data-sfx="<kind>" in the board source).
export function sfxKinds(templateDir) {
  const dir = join(templateDir, 'boards');
  const kinds = new Set();
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.jsx')) : []) {
    for (const m of readFileSync(join(dir, f), 'utf-8').matchAll(/data-sfx=["']([A-Za-z0-9_-]+)["']/g)) kinds.add(m[1]);
  }
  return [...kinds].sort();
}

// review/sfx/<kind>.wav for each kind → { kind: path } for the page.
export function placeSfx(templateDir, review, notes, resolveKind = resolveSfx) {
  rmSync(join(review, 'sfx'), { recursive: true, force: true });
  return Object.fromEntries(sfxKinds(templateDir).flatMap((kind) => {
    try {
      place(resolveKind(templateDir, kind), join(review, 'sfx', `${kind}.wav`));
      return [[kind, `sfx/${kind}.wav`]];
    } catch (e) {
      notes.push(note('sfx', `${kind}: ${e.message}`));
      return [];
    }
  }));
}

// Every rendered cut in $REPLICA/out, tapvid.mp4 (the current one) first; null before the render.
export function finalCuts(dir, review) {
  const out = join(dir, 'out');
  rmSync(join(review, 'final'), { recursive: true, force: true });
  if (!existsSync(join(out, 'tapvid.mp4'))) return null;
  const files = readdirSync(out).filter((f) => /\.mp4$/i.test(f))
    .sort((a, b) => (a === 'tapvid.mp4' ? -1 : b === 'tapvid.mp4' ? 1 : a.localeCompare(b)));
  return {
    versions: files.map((f) => {
      place(join(out, f), join(review, 'final', f));
      return { label: f.replace(/\.mp4$/i, ''), path: `final/${f}`, current: f === 'tapvid.mp4' };
    }),
  };
}

// Request id → what it is: scene number (0 = shared, e.g. a replacement subject), role code
// (image / video / avatar / ai / speech / replace / user), the subject replaced and whether it is a
// video's first frame.
export function assetLabels(ctx) {
  const slug = ctx.replica.slug;
  const labels = new Map();
  for (const r of ctx.replica.replace || []) labels.set(replaceRequestId(slug, r.subject), { scene: 0, role: 'replace', subject: r.subject, visual: r.with?.generate || '' });
  ctx.replica.scenes.forEach((scene, i) => {
    for (const [path, m] of Object.entries(scene.media || {})) {
      const id = slotRequestId(slug, i, scene.board, path);
      const role = aiKind(m.kind);
      labels.set(id, { scene: i + 1, role, visual: m.visual || '' });
      labels.set(requestId(id, 'keyframe'), { scene: i + 1, role, keyframe: true, visual: m.visual || '' });
    }
    for (const l of narrationLines(boardFields(ctx, scene.board), scene)) {
      labels.set(speechRequestId(slug, i, scene.board, l.key), { scene: i + 1, role: 'speech', visual: l.text });
    }
  });
  return labels;
}

const mediaKind = (file) => ({ '.mp4': 'video', '.mov': 'video', '.webm': 'video', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image',
  '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.ogg': 'audio' })[extname(file).toLowerCase()] || null;

// Every generated asset in tasks.json plus the user files the replica uses, placed under
// review/assets/ and grouped by scene: [{ scene, cards: [{ label: { scene, role, subject?, keyframe? }, visual, vendor, model, cost, kind, path, id }] }].
export function assetGroups(ctx, review, vendor) {
  rmSync(join(review, 'assets'), { recursive: true, force: true });
  const labels = assetLabels(ctx);
  const cards = [];
  const add = (src, name, card) => {
    const kind = mediaKind(src);
    if (!kind || !existsSync(src)) return;
    place(src, join(review, 'assets', name));
    cards.push({ ...card, kind, path: `assets/${name}` });
  };
  for (const t of Object.values(ctx.tasks.tasks || {})) {
    const files = t.status === 'completed' ? t.result?.files || [] : [];
    const l = labels.get(t.id) || { scene: null, role: CAPABILITY[t.capability] || 'ai', visual: '' };
    const provider = t.provider ?? t.result?.provider;
    const cost = t.cost ?? t.result?.cost;
    files.forEach((f, k) => {
      const src = fromPosixRel(ctx.dir, f.path);
      add(src, `${t.id}${files.length > 1 ? `-${k + 1}` : ''}${extname(src)}`, {
        scene: l.scene, label: { scene: l.scene, role: l.role, ...(l.subject ? { subject: l.subject } : {}), ...(l.keyframe ? { keyframe: true } : {}) }, visual: l.visual, vendor: provider ? vendor(provider) : null, model: t.model ?? t.result?.model ?? null,
        cost: costText(cost), estimated: Boolean(cost?.estimated), id: t.id,
      });
    });
  }
  const user = (scene, subject, file, visual) => {
    const src = fromPosixRel(ctx.dir, file);
    add(src, `user-${scene}-${cards.length}${extname(src)}`, { scene, label: { scene, role: 'user', ...(subject ? { subject } : {}) }, visual, user: true, vendor: null, model: null, cost: null, estimated: false, id: file });
  };
  for (const r of ctx.replica.replace || []) {
    const file = r.with?.file || r.file;
    if (file) user(0, r.subject, file, '');
  }
  ctx.replica.scenes.forEach((scene, i) => {
    for (const m of Object.values(scene.media || {})) if (m.source === 'user' && m.file) user(i + 1, null, m.file, m.visual || '');
  });
  const order = (s) => (s === null || s === undefined ? Infinity : s);
  const rank = { video: 0, image: 1, audio: 2 };
  const scenes = [...new Set(cards.map((c) => c.scene ?? null))].sort((a, b) => order(a) - order(b));
  return scenes.map((scene) => ({
    scene,
    cards: cards.filter((c) => (c.scene ?? null) === scene).sort((a, b) => rank[a.kind] - rank[b.kind]).map(({ scene: n, ...c }) => c),
  }));
}

function writePage(review, data) {
  writeJson(join(review, 'data.json'), data);
  const shell = readFileSync(join(ASSETS_DIR, 'template', 'review.html'), 'utf-8');
  const json = JSON.stringify(data).replace(/<\/(script)/gi, '<\\/$1');
  const page = join(review, 'index.html');
  writeFileSync(page, shell.replace('/*__DATA__*/', () => json), 'utf-8');
  return page;
}

// The clone review: the template beside the original only. generateProject reads a replica
// directory, so a throwaway one with no scenes stands in for it (compare mode uses none).
function cloneReview(project) {
  const tpl = loadTemplate(join(project, 'template'));
  const review = join(project, 'review');
  mkdirSync(review, { recursive: true });
  const stub = mkdtempSync(join(tmpdir(), 'tapvid-clone-review-'));
  let compareMeta;
  try {
    writeJson(join(stub, 'replica.json'), { version: 1, slug: 'clone', template: tpl.templateDir, scenes: [] });
    compareMeta = generateProject(stub, { mode: 'compare', out: join(review, 'compare-project') });
    buildProject(compareMeta.dir);
  } catch (e) {
    fail(e.stderr?.toString() || e.message);
  } finally {
    rmSync(stub, { recursive: true, force: true });
  }
  if (existsSync(tpl.sourceVideo)) place(tpl.sourceVideo, join(review, 'source.mp4'));
  const notes = compareMeta.warnings.map((w) => note('warning', w));
  const sfx = placeSfx(tpl.templateDir, review, notes);
  return writePage(review, {
    stage: 'clone', title: tpl.template.title, canvas: tpl.template.canvas, fps: compareMeta.fps,
    compare: { src: 'compare-project/index.html', source: 'source.mp4', total: compareMeta.total, scenes: compareMeta.scenes, threshold: COMPARE_THRESHOLD, ...compareReport(tpl) },
    clone: { boards: tpl.template.boards.length, fidelity: fidelity(tpl.cloneRoot), limits: knownLimits(project), notes },
    sfx,
  });
}

async function replicaReview(project, slug) {
  const dir = replicaDir(project, slug);
  const check = validateReplica(dir);
  for (const e of check.errors) console.error(`replica: ${e}`);
  const ctx = loadReplica(dir);
  const review = join(dir, 'review');
  mkdirSync(review, { recursive: true });

  let compareMeta;
  let previewMeta;
  try {
    compareMeta = generateProject(dir, { mode: 'compare', out: join(review, 'compare-project') });
    buildProject(compareMeta.dir);
    previewMeta = generateProject(dir, { mode: 'preview', out: join(review, 'preview-project') });
    buildProject(previewMeta.dir);
  } catch (e) {
    fail(e.stderr?.toString() || e.message);
  }

  if (existsSync(ctx.sourceVideo)) place(ctx.sourceVideo, join(review, 'source.mp4'));
  const bgm = (ctx.replica.audio?.bgm?.candidates || []).map((c, i) => {
    const src = c.path && fromPosixRel(dir, c.path);
    if (!src || !existsSync(src)) return null;
    const name = `bgm/${i + 1}${extname(src)}`;
    place(src, join(review, ...name.split('/')));
    return { title: c.title || { index: i + 1 }, source: c.source || null, path: name, index: i };
  }).filter(Boolean);

  // Real narration (avatar track or voice-over) once timing.mjs has resolved it; the page then plays
  // it instead of the browser's speech synthesis.
  const narration = (key) => {
    const r = ctx.replica.resolved?.[key];
    const src = r?.audio && fromPosixRel(dir, r.audio);
    if (!src || !existsSync(src)) return null;
    const name = `audio/${key}${extname(src)}`;
    place(src, join(review, ...name.split('/')));
    return { audio: name, audioOffset: r.audioOffset || 0 };
  };

  const registry = await loadRegistry();
  const vendor = (name) => registry.get(name)?.meta.displayName || name;
  const notes = previewMeta.warnings.map((w) => note('warning', w));
  const sfx = placeSfx(ctx.templateDir, review, notes);
  const est = estimate(dir, notes);
  const final = finalCuts(dir, review);
  const spend = spendFromTasks(ctx.tasks);
  return writePage(review, {
    stage: 'replica', title: ctx.template.title, slug, topic: ctx.replica.topic, language: ctx.replica.language, canvas: ctx.template.canvas, fps: compareMeta.fps,
    compare: { src: 'compare-project/index.html', source: 'source.mp4', total: compareMeta.total, scenes: compareMeta.scenes, threshold: COMPARE_THRESHOLD, ...compareReport(ctx) },
    preview: {
      src: 'preview-project/index.html', total: previewMeta.total, mode: ctx.replica.audio?.mode,
      scenes: previewMeta.scenes.map((s, i) => ({ ...s, narration: narrationLines(boardFields(ctx, s.board), ctx.replica.scenes[i]).map((l) => l.text).join(' '), ...narration(s.key) })),
      bgm, selected: Math.max(0, bgm.findIndex((b) => b.index === (ctx.replica.audio?.bgm?.selected || 0))),
    },
    storyboard: storyboard(ctx, previewMeta, est, notes, vendor),
    final,
    assets: final ? { groups: assetGroups(ctx, review, vendor), spend: { models: modelRows(spend.byModel, vendor), totals: priceTotals(spend.totals, vendor) } } : null,
    sfx,
    replicaErrors: check.errors,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  const [projectArg, slug] = args._;
  if (!projectArg) fail('usage: review.mjs <project> [<slug>] [--no-open]', 2);
  const project = cloneDir(projectArg);
  const page = slug ? await replicaReview(project, slug) : cloneReview(project);
  console.log(page);
  if (!args['no-open']) platform.openFile(page);
}
