import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from '../../skills/remix/scripts/lib/common.mjs';
import { loadReplica } from '../../skills/remix/scripts/lib/replica.mjs';
import { boardCaptions, buildProject, generateProject } from '../../skills/remix/scripts/lib/project.mjs';
import { checkBoardCaptions, checkCutoutDrawn } from '../../skills/remix/scripts/lib/validate-template.mjs';
import { resolveTiming } from '../../skills/remix/scripts/lib/timing.mjs';
import { lintDeterminism, validateProject } from '../../skills/remix/scripts/lib/validate-project.mjs';
import { clip, fakeTasks, makeClone, makeReplica, runtimeReady } from './render-helpers.mjs';

const read = (dir, ...p) => readFileSync(join(dir, ...p), 'utf-8');

test('preview: AI slot without a reference clip shows its sketch with review overlay data', () => {
  const dir = makeReplica(makeClone());
  const meta = generateProject(dir, { mode: 'preview' });
  const scene = read(meta.dir, 'src', 'scenes', '01-Title01.jsx');
  assert.match(scene, /^import \{ Title01 \} from '\.\.\/boards\/Title01\.jsx';$/m);
  assert.match(scene, /^import \* as Sketch_01_Title01_cover_mod from '\.\.\/sketches\/Title01\.cover\.jsx';$/m);
  assert.match(scene, /"cover": <div style=\{\{ position: 'relative', width: '100%', height: '100%' \}\} data-slot=\{"01-Title01\.cover"\} data-badge=\{"sketch:video"\}><Sketch_01_Title01_cover t=\{t\} duration=\{2\.5\} Design=\{Design\} \/><\/div>/);
  assert.match(scene, /<Title01 t=\{t\} duration=\{duration\} segments=\{segments\} Design=\{Design\} \{\.\.\.data\} \/>/);
  assert.match(scene, /"title": \[\n\s+"Meet Nova",\n\s+"Notes that reply"\n\s+\]/);
  const index = read(meta.dir, 'src', 'index.jsx');
  assert.match(index, /^import Scene_01_Title01 from '\.\/scenes\/01-Title01\.jsx';$/m);
  assert.match(index, /\{ id: '02-Points02', Scene: Scene_02_Points02, duration: [\d.]+, transition: \{"type":"page-flip","duration":0\.5,"params":\{"direction":"left","curl":0\.35\}\} \},/);
  // English narration at 15 chars/s, plus the pads, inside Title01's 1.5–6 s range.
  assert.ok(meta.scenes[0].duration > 3 && meta.scenes[0].duration < 4, String(meta.scenes[0].duration));
  assert.deepEqual(meta.scenes[1].segments.map((s) => s.key), ['points.0.say', 'points.1.say']);
  assert.ok(existsSync(join(meta.dir, 'src', 'boards', 'Points02.jsx')) && !existsSync(join(meta.dir, 'src', 'boards', 'Points02.json')));
  assert.ok(existsSync(join(meta.dir, 'src', 'system', 'design.js')));
  assert.match(read(meta.dir, 'template.html'), /#root\{width:1920px;height:1080px/);
});

test('preview: AI slot with a reference clip plays it with the ref badge and replacement chips as codes', () => {
  const clone = makeClone();
  clip(join(clone, 'template', 'refs', 'Title01.cover.mp4'), 1);
  const refsPath = join(clone, 'template', 'refs', 'refs.json');
  const refs = readJson(refsPath);
  refs['Title01.cover'] = { ...refs['Title01.cover'], clip: 'Title01.cover.mp4', subjects: [{ id: 'presenter', kind: 'person', image: 'subjects/presenter.png' }] };
  writeJson(refsPath, refs);
  const dir = makeReplica(clone, {
    edit: (r) => {
      r.replace = [{ subject: 'presenter', with: { file: 'assets/user/me.png' } }];
      Object.assign(r.scenes[0].media.cover, { mode: 'reference', replace: ['presenter'], prompt: 'Use video 1 as reference.', sketch: null });
    },
  });
  const meta = generateProject(dir, { mode: 'preview' });
  const scene = read(meta.dir, 'src', 'scenes', '01-Title01.jsx');
  assert.match(scene, /"cover": <video src="__ASSET:01-Title01-cover__" muted playsInline data-offset="0" data-slot=\{"01-Title01\.cover"\} data-badge=\{"ref"\} data-replace=\{"\[\{\\"subject\\":\\"person\\",\\"target\\":\\"photo\\"\}\]"\} data-prompt=\{"Use video 1 as reference\."\} \/>/);
  assert.deepEqual(readJson(join(meta.dir, 'assets', 'manifest.json')), { '01-Title01-cover': 'assets/media/01-Title01-cover.mp4' });
  assert.ok(existsSync(join(meta.dir, 'assets', 'media', '01-Title01-cover.mp4')));
});

test('final: media from tasks.json, durations from resolved, captions overlaid', () => {
  const dir = makeReplica(makeClone(), { edit: (r) => { r.audio.captions = 'word-highlight'; } });
  fakeTasks(dir);
  const ctx = loadReplica(dir);
  const { resolved } = resolveTiming(ctx);
  writeJson(ctx.path, { ...ctx.replica, resolved });
  assert.throws(() => generateProject(makeReplica(makeClone()), { mode: 'final' }), /resolved is missing — run timing\.mjs/);
  const meta = generateProject(dir, { mode: 'final' });
  const scene = read(meta.dir, 'src', 'scenes', '01-Title01.jsx');
  assert.match(scene, /"cover": <video src="__ASSET:01-Title01-cover__" muted playsInline data-offset="0" \/>/);
  assert.match(scene, /^export const duration = [\d.]+;$/m);
  assert.match(scene, /<Captions t=\{t\} words=\{words\} variant="word-highlight" Design=\{Design\} \/>/);
  const points = read(meta.dir, 'src', 'scenes', '02-Points02.jsx');
  assert.match(points, new RegExp(`^const segments = ${JSON.stringify(resolved['02-Points02'].segments).replace(/[[\]{}.]/g, '\\$&')};$`, 'm'));
  const index = read(meta.dir, 'src', 'index.jsx');
  for (const [k, r] of Object.entries(resolved)) assert.match(index, new RegExp(`id: '${k}', Scene: \\w+, duration: ${r.duration}[,\\s]`));
  assert.deepEqual(validateProject(meta.dir).errors, []);
});

test('boardCaptions: false drops a board\'s captions, off mutes its lines, other keys restyle it', () => {
  const words = [{ text: 'Top', start: 0.1, end: 0.4 }, { text: 'five', start: 0.5, end: 0.9 }, { text: 'Detail', start: 1.5, end: 2 }];
  const segments = [{ key: 'items.0.title', start: 0, end: 1.2 }, { key: 'items.0.detail', start: 1.2, end: 3 }];
  assert.equal(boardCaptions(false, words, segments), null);
  assert.deepEqual(boardCaptions(undefined, words, segments), { words, style: {} });
  assert.deepEqual(boardCaptions(true, words, segments), { words, style: {} });
  assert.deepEqual(boardCaptions({ off: ['items.title'], centerY: 80 }, words, segments), { words: [words[2]], style: { centerY: 80 } });
});

test('checkBoardCaptions: the rule is required once the template has captions; off names narration fields', () => {
  const meta = readJson(join(makeClone(), 'template', 'boards', 'Points02.json'));
  assert.deepEqual(checkBoardCaptions('Points02', meta, null), []);
  assert.match(checkBoardCaptions('Points02', meta, 'creator')[0], /meta\.captions missing/);
  assert.deepEqual(checkBoardCaptions('Points02', { ...meta, meta: { ...meta.meta, captions: { off: ['points.say'] } } }, 'creator'), []);
  assert.match(checkBoardCaptions('Points02', { ...meta, meta: { ...meta.meta, captions: { off: ['heading'] } } }, 'creator')[0], /"heading" is not a narration field \(points\.say\)/);
});

test('final: a board without captions renders none; a restyled board passes its tokens', () => {
  const clone = makeClone();
  const board = (name, captions) => {
    const p = join(clone, 'template', 'boards', `${name}.json`);
    const j = readJson(p);
    writeJson(p, { ...j, meta: { ...j.meta, captions } });
  };
  board('Title01', false);
  board('Points02', { centerY: 80 });
  const dir = makeReplica(clone, { edit: (r) => { r.audio.captions = 'creator'; } });
  fakeTasks(dir);
  const ctx = loadReplica(dir);
  writeJson(ctx.path, { ...ctx.replica, resolved: resolveTiming(ctx).resolved });
  const meta = generateProject(dir, { mode: 'final' });
  assert.doesNotMatch(read(meta.dir, 'src', 'scenes', '01-Title01.jsx'), /Captions/);
  assert.match(read(meta.dir, 'src', 'scenes', '02-Points02.jsx'), /Design=\{\{ \.\.\.Design, captions: \{ \.\.\.Design\.captions, \.\.\.\{"centerY":80\} \} \}\} \/>/);
});

test('final: a media.cutout field passes its clip\'s cutout as <key>Cutout; the board must draw it', () => {
  const clone = makeClone();
  const p = join(clone, 'template', 'boards', 'Title01.json');
  const j = readJson(p);
  const fields = j.schema.fields.map((f) => (f.key === 'cover' ? { ...f, media: { ...f.media, cutout: true } } : f));
  writeJson(p, { ...j, schema: { ...j.schema, fields } });
  assert.deepEqual(checkCutoutDrawn('Title01', fields, 'return <div>{cover}</div>'), ['board Title01: media.cutout field — the board never draws coverCutout']);
  assert.deepEqual(checkCutoutDrawn('Title01', fields, 'return <div>{cover}{coverCutout}</div>'), []);
  const dir = makeReplica(clone);
  fakeTasks(dir);
  // A cutout newer than its clip is reused; matting itself is covered by matte.test.mjs.
  writeFileSync(join(dir, 'assets', 'gen', '01-Title01.cover.cutout.webm'), 'cutout');
  const ctx = loadReplica(dir);
  writeJson(ctx.path, { ...ctx.replica, resolved: resolveTiming(ctx).resolved });
  const meta = generateProject(dir, { mode: 'final' });
  const scene = read(meta.dir, 'src', 'scenes', '01-Title01.jsx');
  assert.match(scene, /"coverCutout": <video src="__ASSET:01-Title01-coverCutout__" muted playsInline data-offset="0" \/>/);
  assert.equal(read(meta.dir, 'assets', 'media', '01-Title01-coverCutout.webm'), 'cutout');
});

test('compare: example data, reference clips and source windows', () => {
  const dir = makeReplica(makeClone());
  const meta = generateProject(dir, { mode: 'compare' });
  assert.equal(meta.dir, join(dir, 'review', 'compare-project'));
  assert.deepEqual(meta.scenes.map((s) => [s.key, s.start, s.duration]), [['01-Title01', 0, 2.5], ['02-Points02', 2.5, 2.5]]);
  const points = read(meta.dir, 'src', 'scenes', '02-Points02.jsx');
  assert.match(points, /^const segments = \[\{"key":"points\.0\.say","start":0,"end":1\.2\},\{"key":"points\.1\.say","start":1\.2,"end":2\.5\}\];$/m);
  assert.match(read(meta.dir, 'src', 'scenes', '01-Title01.jsx'), /"title": \[\n\s+"Meet Nova",\n\s+"Notes that reply"\n\s+\]/);
});

test('template transition extension is copied over the extension slot', () => {
  const clone = makeClone();
  writeFileSync(join(clone, 'template', 'transitions.js'), "export const extraTransitions = { iris: (p) => ({ outgoing: {}, incoming: { opacity: p }, incomingOnTop: true }) };\n");
  const meta = generateProject(makeReplica(clone), { mode: 'compare' });
  assert.match(read(meta.dir, 'src', 'system', 'transitions.extra.js'), /iris/);
});

test('validate-project: determinism lint and alias resolution', () => {
  assert.deepEqual(lintDeterminism("import React from 'react';\nconst a = (t) => t * 2; // Math.random in a comment"), []);
  const bad = lintDeterminism("import React from 'react';\nimport x from './x.js';\nconst j = Math.random(); const s = { transition: 'all 1s' };");
  assert.equal(bad.length, 3);
  const dir = makeReplica(makeClone());
  writeFileSync(join(dir, 'sketches', 'Title01.cover.jsx'), "import React from 'react';\nexport default function S() { return <div>{Date.now()}</div>; }\n");
  const meta = generateProject(dir, { mode: 'preview' });
  const scene = join(meta.dir, 'src', 'scenes', '01-Title01.jsx');
  writeFileSync(scene, readFileSync(scene, 'utf-8') + '\nconst x = "__ASSET:nope__";\n');
  const { errors } = validateProject(meta.dir);
  assert.ok(errors.some((e) => /nope: alias not in assets\/manifest\.json/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /sketches[\\/]Title01\.cover\.jsx: wall-clock time/.test(e)), errors.join('\n'));
});

test('generated preview project builds into one index.html', { skip: !runtimeReady && 'runtime not installed' }, () => {
  const dir = makeReplica(makeClone());
  const meta = generateProject(dir, { mode: 'preview' });
  buildProject(meta.dir);
  const html = read(meta.dir, 'index.html');
  assert.ok(!html.includes('__ASSET:') && !html.includes('/*__BUNDLE__*/') && html.includes('scenePlayer'));
});

test('final: within-line cues land on the resolved words, the replica stays as it is', () => {
  const dir = makeReplica(makeClone(), {
    edit: (r) => {
      r.scenes[1].data.points[0].beats = [{ type: 'ring', cue: 'seconds' }, { type: 'hold', cue: 'never said', cueAt: 0.4 }];
      r.scenes[1].data.points[1].cue = 'your voice';
    },
  });
  fakeTasks(dir);
  const ctx = loadReplica(dir);
  const { resolved } = resolveTiming(ctx);
  writeJson(ctx.path, { ...ctx.replica, resolved });
  const meta = generateProject(dir, { mode: 'final' });
  const points = read(meta.dir, 'src', 'scenes', '02-Points02.jsx');
  const r = resolved['02-Points02'];
  const at = (line, word) => Number((r.words.find((w) => w.text === word && w.start >= r.segments.find((s) => s.key === line).start).start - r.segments.find((s) => s.key === line).start).toFixed(3));
  assert.match(points, new RegExp(`"cue": "seconds",\\n\\s+"cueAt": ${at('points.0.say', 'seconds.')}\\n`));
  assert.match(points, new RegExp(`"cue": "your voice",\\n\\s+"cueAt": ${at('points.1.say', 'your')}\\n`));
  assert.match(points, /"cue": "never said",\n\s+"cueAt": 0\.4\n/, 'an unheard cue keeps its cueAt');
  assert.ok(meta.warnings.some((w) => /02-Points02: cue "never said" at points\.0\.beats\.1 is not in its line's words/.test(w)), meta.warnings.join('\n'));
  assert.equal(readJson(join(dir, 'replica.json')).scenes[1].data.points[1].cueAt, undefined);
});

test('final: a sped avatar clip from resolved media plays, looping fields carry data-loop', () => {
  const clone = makeClone();
  const boardPath = join(clone, 'template', 'boards', 'Title01.json');
  const board = readJson(boardPath);
  board.schema.fields[2].media.loop = true;
  writeJson(boardPath, board);
  const dir = makeReplica(clone);
  fakeTasks(dir);
  clip(join(dir, 'assets', 'gen', '01-Title01.cover.tempo-1.1.mp4'), 1);
  const ctx = loadReplica(dir);
  const { resolved } = resolveTiming(ctx);
  resolved['01-Title01'] = { ...resolved['01-Title01'], media: { cover: 'assets/gen/01-Title01.cover.tempo-1.1.mp4' } };
  writeJson(ctx.path, { ...ctx.replica, resolved });
  const meta = generateProject(dir, { mode: 'final' });
  const scene = read(meta.dir, 'src', 'scenes', '01-Title01.jsx');
  assert.match(scene, /"cover": <video src="__ASSET:01-Title01-cover__" muted playsInline data-offset="0" data-loop="1" \/>/);
  assert.equal(statSync(join(meta.dir, 'assets', 'media', '01-Title01-cover.mp4')).size, statSync(join(dir, 'assets', 'gen', '01-Title01.cover.tempo-1.1.mp4')).size);
});
