import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quick } from '../../skills/remix/scripts/quick.mjs';
import { quickTemplate, sceneWindows } from '../../skills/remix/scripts/lib/quick.mjs';
import { validateTemplate } from '../../skills/remix/scripts/lib/validate-template.mjs';
import { check } from '../../skills/remix/scripts/lib/schema.mjs';

const shot = (index, start, end, out = 'cut') => ({ index, start, end, transition_out: { type: out, start: out === 'soft' ? end - 0.3 : end, end } });
const TIMELINE = {
  fps: 30, duration_s: 9, frames: 270,
  shots: [shot(0, 0, 2), shot(1, 2, 4.5, 'soft'), shot(2, 4.5, 9)],
  words: [{ text: 'Here', start: 0.2, end: 0.5 }, { text: 'we', start: 0.5, end: 0.7 }, { text: 'go', start: 0.7, end: 1 }, { text: 'Try', start: 5, end: 5.4 }, { text: 'it', start: 5.4, end: 5.6 }],
  beats: { bpm: null, times: [] },
};
const SHOTS = {
  palette: { accent: '#F2C14E' },
  captions: { centerY: 78, size: 2.6, plate: false },
  scenes: [
    { name: 'Hook', role: 'Hook: a promise in one line', shots: [0, 1],
      layers: [{ key: 'presenter', fill: 'avatar', box: [0, 0, 1, 1], describe: 'A woman talks to camera, handheld',
        subjects: [{ id: 'host', kind: 'person', box: [0.2, 0.1, 0.6, 0.8] }] }],
      texts: [{ text: 'DAY IN\nTHE LIFE', box: [0.3, 0.2, 0.4, 0.3], in: 0.2, out: 2, enter: 'pop', color: 'accent' }] },
    { name: 'Demo', role: 'Shows the app on a phone', shots: [2],
      layers: [{ key: 'footage', fill: 'pixel', box: [0, 0, 1, 1], describe: 'Hands hold a phone showing the app',
        subjects: [{ id: 'phone', kind: 'product', box: [0.3, 0.3, 0.4, 0.5], t: 6 }] }], texts: [] },
  ],
};

function project() {
  const dir = join(mkdtempSync(join(tmpdir(), 'tapvid-quick-')), 'clone-day-reel');
  mkdirSync(join(dir, 'source'), { recursive: true });
  mkdirSync(join(dir, 'analysis'), { recursive: true });
  writeFileSync(join(dir, 'source', 'timeline.json'), JSON.stringify(TIMELINE));
  writeFileSync(join(dir, 'source', 'source.json'), JSON.stringify({ streams: [{ codec_type: 'video', width: 720, height: 1280, avg_frame_rate: '30/1' }], format: { duration: '9' } }));
  writeFileSync(join(dir, 'analysis', 'shots.json'), JSON.stringify(SHOTS));
  return dir;
}

test('shots.json schema accepts the documented shape', () => {
  assert.deepEqual(check('shots', SHOTS), []);
  assert.ok(check('shots', { scenes: [{ name: 'hook', role: 'r', shots: [0], layers: [{ key: 'presenter', fill: 'talk', box: [0, 0, 1, 1] }] }] }).length >= 2);
});

test('scenes must tile the timeline shots in order, and texts stay inside their scene', () => {
  assert.throws(() => sceneWindows({ scenes: [{ ...SHOTS.scenes[0], shots: [0] }, SHOTS.scenes[1]] }, TIMELINE), /continue from shot 1/);
  assert.throws(() => sceneWindows({ scenes: [SHOTS.scenes[0]] }, TIMELINE), /the film runs to 9s/);
  assert.throws(() => sceneWindows({ scenes: [{ ...SHOTS.scenes[0], texts: [{ text: 'x', box: [0, 0, 1, 1], in: 3, out: 6 }] }, SHOTS.scenes[1]] }, TIMELINE), /outside the scene/);
  const long = { ...TIMELINE, duration_s: 30, shots: [shot(0, 0, 2), shot(1, 2, 4.5), shot(2, 4.5, 30)] };
  const demoScene = SHOTS.scenes[1];
  assert.throws(() => sceneWindows(SHOTS, long), /with a pixel layer — split it into scenes of at most 15s/);
  const split = sceneWindows({ scenes: [SHOTS.scenes[0], { ...demoScene, end: 16 }, { ...demoScene, name: 'More', start: 16 }] }, long);
  assert.deepEqual(split.map((x) => [x.board, x.start, x.end]), [['Hook01', 0, 4.5], ['Demo02', 4.5, 16], ['More03', 16, 30]]);
  assert.equal(split[1].outShot, null);
  assert.throws(() => sceneWindows({ scenes: [SHOTS.scenes[0], { ...demoScene, end: 16 }, { ...demoScene, name: 'More', start: 17 }] }, long), /previous scene ends at 16s/);
  const [hook, demo] = sceneWindows(SHOTS, TIMELINE);
  assert.deepEqual([hook.board, hook.start, hook.end, hook.say], ['Hook01', 0, 4.5, 'Here we go']);
  assert.deepEqual([demo.board, demo.say], ['Demo02', 'Try it']);
});

test('quickTemplate maps scenes to boards, fields, transitions and captions', () => {
  const out = quickTemplate({ shots: SHOTS, timeline: TIMELINE, size: { width: 720, height: 1280 }, id: 'day-reel' });
  assert.deepEqual(out.template.canvas, { width: 1080, height: 1920 });
  assert.equal(out.template.category, 'avatar');
  assert.deepEqual(out.template.audio, { source_mode: 'narration', captions: 'creator', bpm: null });
  assert.deepEqual(out.template.transitions, [{ from: 'Hook01', to: 'Demo02', type: 'crossfade', duration: 0.3 }]);
  const hook = out.boards.Hook01.json;
  assert.deepEqual(hook.schema.fields.map((f) => f.key), ['presenter', 'texts', 'say']);
  assert.equal(hook.schema.fields[0].media.role, 'presenter');
  assert.equal(hook.schema.fields[0].media.minWidthPx, 720);
  assert.equal(hook.schema.fields[1].maxItems, 1);
  assert.equal(hook.meta.captions, true);
  assert.equal(hook.preview_t, 0.244);
  assert.equal(out.boards.Demo02.json.preview_t, 0.5);
  assert.equal(out.boards.Demo02.json.schema.fields[0].media.role, 'broll');
  assert.match(out.boards.Hook01.jsx, /export function Hook01\(/);
  assert.match(out.boards.Hook01.jsx, /const LAYOUT = \{"background":"bg","layers":\[\{"key":"presenter","box":\[0,0,100,100\],"shape":"rect"\}\],"texts":\[\{"box":\[30,20,40,30\],"in":0.044,"out":0.444,"enter":"pop","color":"accent","plate":false,"lines":2\}\]\};/);
  assert.doesNotMatch(out.boards.Hook01.jsx, /__[A-Z]+__/);
  assert.equal(out.analysis.boards[1].media.footage.subjects[0].t, 6);
  assert.equal(out.analysis.boards[0].media.presenter.subjects[0].t, 2.25);
  assert.equal(out.describe['Demo02.footage'], 'Hands hold a phone showing the app');
  assert.match(out.design, /"accent": "#F2C14E"/);
});

test('layers rebuild split, picture-in-picture and code regions as fields, crops and elements', () => {
  const split = { name: 'Walk', role: 'Walks through the app', shots: [2], layers: [
    { key: 'app', fill: 'screen', box: [0, 0, 1, 0.5], describe: 'The app scrolls a feed' },
    { key: 'presenter', fill: 'avatar', box: [0, 0.5, 1, 0.5], shape: 'round' },
  ] };
  const pip = { ...split, layers: [
    { key: 'chart', fill: 'code', box: [0, 0, 1, 1], describe: 'A bar chart of weekly signups' },
    { key: 'presenter', fill: 'avatar', box: [0.55, 0.6, 0.4, 0.4], cutout: true },
  ] };
  const at = (scene) => quickTemplate({ shots: { scenes: [SHOTS.scenes[0], scene] }, timeline: TIMELINE, size: { width: 1080, height: 1920 }, id: 'x' });

  const a = at(split);
  const [app, host] = a.boards.Walk02.json.schema.fields;
  assert.deepEqual([app.media.role, app.media.aspect, app.media.minWidthPx], ['screen', '5:4', 900]);
  assert.deepEqual([host.media.role, host.media.aspect], ['presenter', '5:4']);
  assert.deepEqual(a.analysis.boards[1].media.app.crop, [0, 0, 1, 0.5]);
  assert.match(a.boards.Walk02.jsx, /"key":"presenter","box":\[0,50,100,50\],"shape":"round"/);
  assert.equal(a.describe['Walk02.app'], 'The app scrolls a feed');

  const b = at(pip);
  const [chart, cut] = b.boards.Walk02.json.schema.fields;
  assert.equal(chart.type, 'element');
  assert.equal(chart.media, undefined);
  assert.equal(cut.media.cutout, true);
  assert.equal(b.analysis.boards[1].media.chart, undefined);
  assert.match(b.boards.Walk02.jsx, /"code":true/);
  assert.match(b.boards.Walk02.jsx, /"cut":"presenterCutout"/);
  const els = Object.fromEntries(b.elements.elements.map((e) => [e.id, e]));
  assert.equal(els['Walk02.chart'].behind, 'presenter');
  assert.equal(els['Walk02.presenter'].behind, undefined);

  assert.throws(() => at({ ...split, layers: [{ key: 'host', fill: 'avatar', box: [0, 0, 1, 1] }] }), /keyed "presenter"/);
  assert.throws(() => at({ ...split, layers: [{ key: 'texts', fill: 'pixel', box: [0, 0, 1, 1] }] }), /reserved or repeated/);
  assert.throws(() => at({ ...split, layers: [{ key: 'presenter', fill: 'avatar', box: [0, 0, 1, 1], cutout: true }] }), /covers no layer before it/);
});

test('a code-only scene has no 15 s limit and no reference media', () => {
  const long = { ...TIMELINE, duration_s: 30, shots: [shot(0, 0, 2), shot(1, 2, 4.5), shot(2, 4.5, 30)] };
  const card = { name: 'Card', role: 'A list of tips', shots: [2], layers: [{ key: 'list', fill: 'code', box: [0, 0, 1, 1] }] };
  const [, scene] = sceneWindows({ scenes: [SHOTS.scenes[0], card] }, long);
  assert.equal(scene.duration, 25.5);
});

test('without spoken words the template is music-only, with no narration fields or captions', () => {
  const out = quickTemplate({ shots: SHOTS, timeline: { ...TIMELINE, words: [] }, size: { width: 1920, height: 1080 }, id: 'x' });
  assert.equal(out.template.audio.source_mode, 'music-only');
  assert.equal(out.template.audio.captions, null);
  assert.equal(out.boards.Hook01.json.meta.captions, undefined);
  assert.ok(!out.boards.Hook01.json.schema.fields.some((f) => f.type === 'narration'));
  assert.equal(out.boards.Hook01.json.schema.fields[0].media.minWidthPx, 1280);
});

test('quick.mjs writes a template that passes validate.mjs template, and never overwrites one', async () => {
  const dir = project();
  await quick(dir, { skipBuild: true, log: () => {} });
  const { errors } = await validateTemplate(join(dir, 'template'));
  assert.deepEqual(errors, []);
  assert.match(readFileSync(join(dir, 'template', 'skill', 'SKILL.md'), 'utf-8'), /brief: "Shows the app on a phone"/);
  await assert.rejects(() => quick(dir, { skipBuild: true, log: () => {} }), /already has a template/);
  writeFileSync(join(dir, 'template', 'boards', 'Old09.json'), '{}');
  await quick(dir, { skipBuild: true, force: true, log: () => {} });
  assert.equal(existsSync(join(dir, 'template', 'boards', 'Old09.json')), false);
});
