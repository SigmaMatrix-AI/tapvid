// replica.json → plan.json (spec §4 step 4.6): one media request per AI slot, replacement
// subject and narration line, in dependency order, with the generation mode settled against
// what the configured providers can actually do (a reference video falls back to keyframe).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fromPosixRel, readJson, toPosixRel } from '../common.mjs';

const MAX_ID = 64;
// Generated media never needs to be sharper than a 4K short edge.
const MAX_SHORT_EDGE = 2160;
// An image drawn under half the canvas width (minWidthPx is the drawn width ×1.5), or seen for
// under 3 s, shows no difference between a premium and an economy model.
const SMALL_WIDTH_SHARE = 0.5;
const SHORT_VISIBLE_S = 3;

export function requestId(...parts) {
  const id = parts.join('-').replace(/[^A-Za-z0-9._-]+/g, '_');
  if (id.length <= MAX_ID) return id;
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `${id.slice(0, MAX_ID - 9)}-${hash}`;
}

export const sceneKey = (index, board) => `${String(index + 1).padStart(2, '0')}-${board}`;
export const slotRequestId = (slug, index, board, path) => requestId(slug, sceneKey(index, board), path);
export const speechRequestId = (slug, index, board, key = 'narration') => requestId(slug, sceneKey(index, board), 'speech', key);
export const replaceRequestId = (slug, subject) => requestId(slug, 'replace', subject);

// Walk a board schema for fields of a type, yielding dotted paths into data
// ("points.0.say" for a narration field inside an object[] item).
export function fieldPaths(fields, data, type, prefix = '') {
  const out = [];
  for (const f of fields || []) {
    const path = prefix ? `${prefix}.${f.key}` : f.key;
    if (f.type === type) out.push({ path, field: f });
    if (f.type === 'object' && f.fields) out.push(...fieldPaths(f.fields, data?.[f.key] || {}, type, path));
    if (f.type === 'object[]' && f.fields) {
      (data?.[f.key] || []).forEach((item, i) => out.push(...fieldPaths(f.fields, item, type, `${path}.${i}`)));
    }
  }
  return out;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// Board field schema for a media path key ("features.2.shot" → features[].shot).
export function fieldForPath(fields, path) {
  const parts = path.split('.').filter((p) => !/^\d+$/.test(p));
  let list = fields;
  let found = null;
  for (const p of parts) {
    found = (list || []).find((f) => f.key === p);
    if (!found) return null;
    list = found.fields;
  }
  return found;
}

function shortEdge(field, aspect) {
  const w = field?.media?.minWidthPx;
  if (!w) return undefined;
  const [aw, ah] = String(aspect || field.media.aspect || '16:9').split(':').map(Number);
  return Math.min(MAX_SHORT_EDGE, Math.round(Math.min(w, (w * ah) / aw)));
}

export function buildPlan(replicaPath, { route }) {
  const dir = dirname(replicaPath);
  const replica = readJson(replicaPath);
  const templateDir = fromPosixRel(dir, replica.template);
  const tpl = readJson(join(templateDir, 'template.json'));
  const refs = readJson(join(templateDir, 'refs', 'refs.json'), {});
  const refsDir = join(templateDir, 'refs');
  const rel = (abs) => toPosixRel(dir, abs);
  const requests = [];
  const warnings = [];
  const canvasAspect = tpl.canvas.width > tpl.canvas.height ? '16:9' : '9:16';
  const supports = (req) => route(req).candidates.length > 0;

  // Replacement subjects: user files are used as they are; descriptions are generated once.
  const subjectFile = {};
  for (const r of replica.replace || []) {
    if (r.with?.file) subjectFile[r.subject] = r.with.file;
    else if (r.file) subjectFile[r.subject] = r.file;
    else if (r.with?.generate) {
      const id = replaceRequestId(replica.slug, r.subject);
      // `with.from`: rework the user's own picture (reframe, restage) instead of inventing the subject;
      // the prompt then describes the whole shot, so no studio-cutout suffix.
      const from = r.with.from ? { refs: [{ file: r.with.from, role: 'subject' }] } : {};
      const prompt = r.with.from ? r.with.generate : `${r.with.generate}. Full view, centred, plain neutral background, even studio light, no text.`;
      requests.push({ id, capability: 'image.generate', ...(r.with.model ? { model: r.with.model } : {}),
        params: { prompt, aspect: r.with.aspect || '3:4', min_short_edge: 1024, ...from }, out: `assets/gen/replace.${r.subject}` });
      subjectFile[r.subject] = `@${id}`;
    }
  }

  const voice = replica.audio?.voice;
  const narrated = replica.audio?.mode === 'narration';

  replica.scenes.forEach((scene, index) => {
    const boardPath = join(templateDir, 'boards', `${scene.board}.json`);
    const board = existsSync(boardPath) ? readJson(boardPath) : { schema: { fields: [] } };
    const fields = board.schema?.fields || [];

    const lines = fieldPaths(fields, scene.data, 'narration').map(({ path }) => ({ key: path, text: getPath(scene.data, path) }));
    if (!lines.length && scene.narration) lines.push({ key: 'narration', text: scene.narration });
    const spoken = lines.filter((l) => l.text);
    const firstSpeech = spoken.length ? speechRequestId(replica.slug, index, scene.board, spoken[0].key) : null;
    // Lip-sync to a separate take; without a provider for that the avatar voices the script itself.
    const avatarAudio = (path, m) => ({ id: slotRequestId(replica.slug, index, scene.board, path), capability: 'avatar.generate',
      params: { mode: 'audio', audio: firstSpeech ? `@${firstSpeech}` : undefined, portrait: subjectFile[(m.replace || [])[0]], aspect: m.aspect || fieldForPath(fields, path)?.media?.aspect || canvasAspect },
      out: `assets/gen/${sceneKey(index, scene.board)}.${path}` });
    const selfVoiced = narrated && voice && Object.entries(scene.media || {})
      .some(([path, m]) => m.source === 'ai' && m.kind === 'avatar' && !(firstSpeech && supports(avatarAudio(path, m))));

    // Narration: one take per scene, or one per narration field on a segmented board — none when
    // a self-voiced avatar speaks the scene (its own voice is the narration).
    const speechIds = [];
    if (narrated && voice && !selfVoiced) {
      for (const line of spoken) {
        const id = speechRequestId(replica.slug, index, scene.board, line.key);
        requests.push({ id, capability: 'speech.synthesize', provider: voice.provider, params: { text: line.text, voice: voice.id, language: replica.language }, out: `assets/audio/${sceneKey(index, scene.board)}.${line.key}` });
        speechIds.push(id);
      }
    }

    for (const [path, m] of Object.entries(scene.media || {})) {
      if (m.source !== 'ai') continue;
      const id = slotRequestId(replica.slug, index, scene.board, path);
      const field = fieldForPath(fields, path);
      const aspect = m.aspect || field?.media?.aspect || canvasAspect;
      const ref = m.ref ? refs[m.ref] : null;
      const refClip = ref?.clip ? rel(join(refsDir, ref.clip)) : null;
      const refFrame = ref?.frame ? rel(join(refsDir, ref.frame)) : null;
      const subjects = (m.replace || []).map((s) => subjectFile[s]).filter(Boolean).map((file) => ({ file, role: 'subject' }));
      const out = `assets/gen/${sceneKey(index, scene.board)}.${path}`;
      const base = { prompt: m.prompt, aspect, min_short_edge: shortEdge(field, aspect) };
      // A vendor / model the user chose for this slot (replica.md §5) pins the route.
      const pin = { ...(m.provider ? { provider: m.provider } : {}), ...(m.model ? { model: m.model } : {}) };
      if (!base.min_short_edge) delete base.min_short_edge;
      // Settled scene length (narration is voiced and timed before video), else the slot's estimate.
      const settled = replica.resolved?.[sceneKey(index, scene.board)]?.duration;

      if (m.kind === 'avatar') {
        const portrait = subjectFile[(m.replace || [])[0]];
        if (speechIds.length) requests.push(avatarAudio(path, m));
        else if (voice) {
          requests.push({ id, capability: 'avatar.generate', provider: voice.provider, params: { mode: 'tts', script: spoken.map((l) => l.text).join(' '), voice: voice.id, portrait, aspect, language: replica.language }, out });
          warnings.push(`${id}: the avatar voices the script itself; this scene's timing comes from the avatar's own voice`);
        } else warnings.push(`${id}: avatar slot needs narration mode and a voice`);
        continue;
      }

      if (m.kind === 'image') {
        const imgRefs = [...(refFrame && m.mode !== 'text' ? [{ file: refFrame, role: 'composition' }] : refFrame ? [{ file: refFrame, role: 'style' }] : []), ...subjects];
        const visible = m.duration_s ?? settled;
        const small = (field?.media?.minWidthPx && field.media.minWidthPx < SMALL_WIDTH_SHARE * tpl.canvas.width * 1.5)
          || (visible !== undefined && visible < SHORT_VISIBLE_S);
        let req = { id, capability: 'image.generate', ...pin, ...(small ? { tier: 'economy' } : {}), params: { ...base, refs: imgRefs }, out };
        if (!supports(req) && imgRefs.length) {
          req = { ...req, params: { ...base, refs: subjects } };
          warnings.push(`${id}: no image provider takes the reference frame; using the subjects only`);
        }
        requests.push(req);
        continue;
      }

      // Video.
      // The outgoing scene keeps playing through the next boundary's transition, so its clip covers it.
      const next = replica.scenes[index + 1];
      const overlap = (tpl.transitions || []).find((t) => t.from === scene.board && t.to === next?.board)?.duration || 0;
      const duration = (settled ? settled + overlap : 0) || m.duration_s || (board.example_duration_ms ? board.example_duration_ms / 1000 : 5);
      const vbase = { ...base, duration_s: Math.max(1, Math.ceil(duration * 10) / 10), audio: false };
      let mode = m.mode || (refClip ? 'reference' : 'text');
      let fellBack = false;
      if (mode === 'reference') {
        const req = { id, capability: 'video.generate', ...pin, params: { ...vbase, refs: subjects, ref_videos: refClip ? [{ file: refClip, role: 'motion' }] : [] }, out };
        if (refClip && supports(req)) { requests.push(req); continue; }
        warnings.push(`${id}: no video provider takes a reference video; falling back to keyframe`);
        mode = 'keyframe';
        // The pin chose a reference-video model; the fallback is routed afresh.
        fellBack = true;
      }
      if (mode === 'keyframe' && refFrame) {
        const kfId = requestId(id, 'keyframe');
        const describe = ref?.describe ? ` Camera and motion as in the original: ${ref.describe}.` : '';
        requests.push({ id: kfId, capability: 'image.generate', params: { prompt: `First frame of the shot. ${m.prompt}`, aspect, min_short_edge: base.min_short_edge || 1080, refs: [{ file: refFrame, role: 'composition' }, ...subjects] }, out: `${out}.keyframe` });
        requests.push({ id, capability: 'video.generate', ...(fellBack ? {} : pin), params: { ...vbase, prompt: `${m.prompt}${describe}`, first_frame: `@${kfId}` }, out });
        continue;
      }
      const textReq = { id, capability: 'video.generate', ...(fellBack ? {} : pin), params: { ...vbase, refs: refFrame ? [{ file: refFrame, role: 'style' }, ...subjects] : subjects }, out };
      requests.push(supports(textReq) ? textReq : { ...textReq, params: { ...vbase } });
    }
  });

  // Drop undefined values so the plan validates.
  const clean = JSON.parse(JSON.stringify(requests));
  return { version: 1, replica: 'replica.json', requests: clean, warnings };
}
