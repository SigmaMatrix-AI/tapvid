// The identity gate (references/replica.md §9): a generated clip showing a person reaches the film
// only after someone looked at it frame by frame and saw the replacement, not the original's person.
// No script can tell who a face is, so the gate enforces the looking: `inspect.mjs --identity` must
// have read this very clip before a verdict is taken, a regenerated clip voids its verdict, and
// render.mjs refuses a film with an open slot. Records live in <replica>/identity.json.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromPosixRel, readJson, writeJson } from './common.mjs';
import { slotRequestId } from './media/plan.mjs';
import { taskFiles } from './replica.mjs';

const recordsFile = (dir) => join(dir, 'identity.json');
const readRecords = (dir) => readJson(recordsFile(dir), { clips: {} });
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export const templateTier = (ctx) => readJson(join(ctx.cloneRoot, 'analysis', 'brief.json'), {})?.tier;

const personSubjects = (refs) => new Set(Object.values(refs || {})
  .flatMap((r) => r.subjects || []).filter((s) => s.kind === 'person').map((s) => s.id));

// A reference clip with a person in it carries that person into the model's input.
export const refShowsPerson = (ref) => (ref?.subjects || []).some((s) => s.kind === 'person');

export function slotShowsPerson(ctx, m) {
  if (m.kind === 'avatar' || refShowsPerson(ctx.refs?.[m.ref])) return true;
  const people = personSubjects(ctx.refs);
  return (m.replace || []).some((id) => people.has(id));
}

// The generated clips the gate covers. The user's own files are theirs; a request that did not
// complete has no clip, and its slot falls back to the sketch.
export function identitySlots(ctx) {
  const { replica } = ctx;
  return replica.scenes.flatMap((scene, index) => Object.entries(scene.media || {}).flatMap(([path, m]) => {
    if (m.source !== 'ai' || !['video', 'avatar'].includes(m.kind) || !slotShowsPerson(ctx, m)) return [];
    const id = slotRequestId(replica.slug, index, scene.board, path);
    const file = taskFiles(ctx.tasks, id)[0];
    return file ? [{ id, mode: m.mode, clip: fromPosixRel(ctx.dir, file.path) }] : [];
  }));
}

// inspect.mjs --identity has read this clip: the verdict may now be given.
export function recordInspection(dir, id, clip) {
  const records = readRecords(dir);
  writeJson(recordsFile(dir), { clips: { ...records.clips, [id]: { sha256: sha256(clip), inspected: true, verdict: null } } });
}

export function signOff(ctx, id, verdict, { saw } = {}) {
  const slot = identitySlots(ctx).find((s) => s.id === id);
  if (!slot) throw new Error(`${id}: not a generated clip of a person in this replica`);
  const records = readRecords(ctx.dir);
  const record = records.clips[id];
  if (!record?.inspected || record.sha256 !== sha256(slot.clip)) {
    throw new Error(`${id}: run inspect.mjs ${ctx.dir} ${id} --identity and look at every frame first`);
  }
  if (!saw) throw new Error(`${id}: --saw is required: say whose face you saw and where in the clip`);
  const clips = { ...records.clips, [id]: { ...record, verdict, saw } };
  // One leak says reference mode is copying people on this source: its other clips are read again.
  if (verdict === 'fail') {
    for (const other of identitySlots(ctx)) {
      if (other.id !== id && other.mode === 'reference') delete clips[other.id];
    }
  }
  writeJson(recordsFile(ctx.dir), { clips });
}

// What still stops the render; empty when every clip of a person passed.
export function identityProblems(ctx) {
  const { clips } = readRecords(ctx.dir);
  return identitySlots(ctx).flatMap((slot) => {
    const record = clips[slot.id];
    if (!record?.verdict) return [`${slot.id}: no identity check (inspect.mjs --identity, then identity.mjs pass or fail)`];
    if (record.sha256 !== sha256(slot.clip)) return [`${slot.id}: the clip changed since its identity check; check it again`];
    if (record.verdict !== 'pass') return [`${slot.id}: failed the identity check (${record.saw}); regenerate it as keyframe`];
    return [];
  });
}
