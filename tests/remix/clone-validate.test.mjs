import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkJsx, validateTemplate } from '../../skills/remix/scripts/lib/validate-template.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample-clone/template', import.meta.url));
const ANALYSIS = fileURLToPath(new URL('./fixtures/sample-clone/analysis', import.meta.url));

// A copy of the fixture template and its analysis/, which pass every rule; tests break the copy.
function cleanCopy() {
  const root = mkdtempSync(join(tmpdir(), 'tapvid-validate-'));
  const dir = join(root, 'template');
  cpSync(FIXTURE, dir, { recursive: true });
  cpSync(ANALYSIS, join(root, 'analysis'), { recursive: true });
  return dir;
}

function edit(dir, rel, fn) {
  const path = join(dir, ...rel.split('/'));
  if (rel.endsWith('.json')) {
    const j = JSON.parse(readFileSync(path, 'utf-8'));
    fn(j);
    writeFileSync(path, JSON.stringify(j));
  } else writeFileSync(path, fn(readFileSync(path, 'utf-8')));
}

const hasError = (res, re) => res.errors.some((e) => re.test(e));

test('the sample template is clean', async () => {
  const res = await validateTemplate(cleanCopy());
  assert.deepEqual(res, { errors: [], warnings: [] });
});

test('board jsx rules', () => {
  const ok = readFileSync(join(FIXTURE, 'boards', 'Title01.jsx'), 'utf-8');
  assert.deepEqual(checkJsx('Title01', ok), []);
  const cases = [
    [ok.replace('import React from "react";', 'import React from "react";\nimport { motion } from "framer-motion";'), /exactly one import/],
    [ok.replace('import React from "react";', 'import * as React from "react";'), /exactly one import/],
    [ok.replace('export function Title01', 'export function Title02'), /exactly one function named Title01/],
    [`${ok}\nexport const extra = 1;`, /exactly one function named Title01/],
    [ok.replace('const p = ease', 'const jitter = Math.random();\n  const p = ease'), /Math\.random/],
    [ok.replace('const p = ease', 'const now = Date.now();\n  const p = ease'), /Date\.now/],
    [ok.replace('const p = ease', 'React.useEffect(() => { setTimeout(() => {}, 10); });\n  const p = ease'), /setTimeout/],
    [ok.replace('const p = ease', 'React.useEffect(() => { requestAnimationFrame(() => {}); });\n  const p = ease'), /requestAnimationFrame/],
    [ok.replace('overflow: "hidden" }', 'overflow: "hidden", transition: "opacity 0.3s" }'), /transition/],
    [ok.replace('overflow: "hidden" }', 'overflow: "hidden", animation: "spin 1s" }'), /transition/],
    [ok.replace('left: "52cqw"', 'left: "998px"'), /px unit/],
    [ok.replace('background: palette.bg', 'background: "#101010"'), /hex colour/],
    [ok.replaceAll(/cq[wh]/g, '%'), /cqw \/ cqh/],
  ];
  for (const [src, re] of cases) {
    const errors = checkJsx('Title01', src);
    assert.ok(errors.some((e) => re.test(e)), `${re} not reported; got ${JSON.stringify(errors)}`);
  }
});

test('board json rules: timing model, segments and example limits', async () => {
  const variants = [
    [(j) => { j.meta.durationModel = 'scene'; }, 'Points02', /durationModel must be "segments"/],
    [(j) => { j.example_segments[1].start = 1.5; }, 'Points02', /tile the example/],
    [(j) => { j.example_segments.pop(); }, 'Points02', /one \{key, start, end\} per narration line/],
    [(j) => { j.example_data.points.push({ label: 'a', say: 'b' }, { label: 'c', say: 'd' }, { label: 'e', say: 'f' }); }, 'Points02', /items \(max 4\)/],
    [(j) => { delete j.example_data.heading; }, 'Points02', /heading is required/],
    [(j) => { j.example_data.points[0].label = 'x'.repeat(41); }, 'Points02', /points\.0\.label has 41 chars/],
    [(j) => { j.meta.durationModel = 'segments'; }, 'Title01', /durationModel must be "segments"/],
    [(j) => { delete j.meta.minDuration; }, 'Title01', /missing required "minDuration"/],
  ];
  for (const [fn, board, re] of variants) {
    const dir = cleanCopy();
    edit(dir, `boards/${board}.json`, fn);
    const res = await validateTemplate(dir);
    assert.ok(hasError(res, re), `${re} not reported; got ${JSON.stringify(res.errors)}`);
  }
});

test('transitions reference boards and known types; a template extension adds types', async () => {
  let dir = cleanCopy();
  edit(dir, 'template.json', (j) => { j.transitions[0].type = 'ripple'; j.transitions.push({ from: 'Points02', to: 'Nope03', type: 'crossfade', duration: 0.3 }); });
  let res = await validateTemplate(dir);
  assert.ok(hasError(res, /unknown transition type "ripple"/));
  assert.ok(hasError(res, /to "Nope03" is not a board/));

  dir = cleanCopy();
  edit(dir, 'template.json', (j) => { j.transitions[0].type = 'ripple'; });
  writeFileSync(join(dir, 'transitions.js'), "export const extraTransitions = {\n  'ripple': (p) => ({ outgoing: {}, incoming: { opacity: p }, incomingOnTop: true }),\n};\n");
  res = await validateTemplate(dir);
  assert.deepEqual(res.errors, []);
});

test('schema errors in template.json and refs.json are reported', async () => {
  const dir = cleanCopy();
  edit(dir, 'template.json', (j) => { j.canvas.width = 1280; });
  edit(dir, 'refs/refs.json', (j) => { j['Title01.cover'].crop = [0, 0, 2, 1]; });
  const res = await validateTemplate(dir);
  assert.ok(hasError(res, /^template\.json \$\.canvas\.width/));
  assert.ok(hasError(res, /^refs\/refs\.json .*crop\[2\]: above 1/));
});

test('media keys: loop only on video fields, headTop only on presenter fields', async () => {
  const dir = cleanCopy();
  edit(dir, 'boards/Title01.json', (j) => { j.schema.fields[2].media.headTop = 12; });
  edit(dir, 'boards/Points02.json', (j) => { j.schema.fields.push({ key: 'logo', type: 'image', desc: 'The brand mark', media: { loop: true } }); });
  edit(dir, '../analysis/elements.json', (j) => { j.elements.push({ id: 'Points02.logo', board: 'Points02', kind: 'icon', path: 'logo', in: 2.5, out: 5, box: [0.8, 0.05, 0.1, 0.1] }); });
  const res = await validateTemplate(dir);
  assert.ok(hasError(res, /Points02: logo\.media\.loop is only for video fields/), JSON.stringify(res.errors));
  assert.ok(hasError(res, /Title01: cover\.media\.headTop is only for role presenter fields/));
  edit(dir, 'boards/Title01.json', (j) => { j.schema.fields[2].media.role = 'presenter'; j.schema.fields[2].media.loop = true; });
  edit(dir, 'boards/Points02.json', (j) => { j.schema.fields.pop(); });
  edit(dir, '../analysis/elements.json', (j) => { j.elements.pop(); });
  assert.deepEqual((await validateTemplate(dir)).errors, []);
});

test('element inventory: required, schema-valid, boards, paths and media coverage', async () => {
  let dir = cleanCopy();
  rmSync(join(dirname(dir), 'analysis', 'elements.json'));
  assert.ok(hasError(await validateTemplate(dir), /analysis\/elements\.json missing — inventory every element/));

  dir = cleanCopy();
  edit(dir, '../analysis/elements.json', (j) => { j.elements[0].box = [52, 12, 42, 76]; j.elements[1].kind = 'blob'; });
  let res = await validateTemplate(dir);
  assert.ok(hasError(res, /^analysis\/elements\.json .*box\[0\]: above 1/), JSON.stringify(res.errors));
  assert.ok(hasError(res, /kind: must be one of/));

  dir = cleanCopy();
  edit(dir, '../analysis/elements.json', (j) => {
    j.elements.shift();
    j.elements[0].board = 'Ghost09';
    j.elements[1].path = 'subtitle';
    j.elements[2].out = j.elements[2].in;
  });
  res = await validateTemplate(dir);
  assert.ok(hasError(res, /^Title01\.cover: no element in analysis\/elements\.json has this path/), JSON.stringify(res.errors));
  assert.ok(hasError(res, /Title01\.kicker: board Ghost09 is not in the template/));
  assert.ok(hasError(res, /Title01\.title: Title01\.subtitle is not a field of the board/));
  assert.ok(hasError(res, /Points02\.heading: out \(2\.5\) must be after in \(2\.5\)/));
});

test('element inventory: moving content needs a video field', async () => {
  const dir = cleanCopy();
  edit(dir, 'boards/Title01.json', (j) => { j.schema.fields[2].type = 'image'; delete j.schema.fields[2].media.motion; });
  edit(dir, '../analysis/elements.json', (j) => { j.elements[0].content = 'loop'; });
  const res = await validateTemplate(dir);
  assert.ok(hasError(res, /^Title01\.cover moves in the original \(content loop\) but Title01\.cover is an image — make it a video field \(media\.loop: true/), JSON.stringify(res.errors));
});

test('element inventory against analysis/motion.json', async () => {
  const dir = cleanCopy();
  writeFileSync(join(dirname(dir), 'analysis', 'motion.json'), JSON.stringify({ elements: {
    'Title01.kicker': { class: 'moving', mean: 6.2, loop_s: 1.2, confidence: 0.9 },
    'Title01.title': { class: 'boil', period_s: 0.25, poses_per_s: 4, mean: 1.1, confidence: 0.8 },
    'Points02.heading': { class: 'still', mean: 0.1, confidence: 1 },
  } }));
  let res = await validateTemplate(dir);
  assert.ok(hasError(res, /Title01\.kicker: measured moving in analysis\/motion\.json \(mean 6\.2, loop 1\.2s\) but declared still/), JSON.stringify(res.errors));
  assert.ok(hasError(res, /Title01\.title: measured boil in analysis\/motion\.json \(4 poses\/s\) but idle\.type is none/));
  assert.equal(res.errors.length, 2);
  edit(dir, '../analysis/elements.json', (j) => { j.elements[1].content = 'loop'; j.elements[2].idle = { type: 'boil' }; });
  res = await validateTemplate(dir);
  assert.deepEqual(res.errors, ['Title01.title: idle boil needs poses_per_s (measure.mjs motion)']);
  edit(dir, '../analysis/elements.json', (j) => { j.elements[2].idle.poses_per_s = 4; });
  assert.deepEqual((await validateTemplate(dir)).errors, []);
});

test('element font roles name design.js fonts that fonts.json ships', async () => {
  const dir = cleanCopy();
  edit(dir, '../analysis/elements.json', (j) => { j.elements[1].font = 'fontHead'; j.elements[2].font = 'palette'; });
  let res = await validateTemplate(dir);
  assert.ok(hasError(res, /Title01\.kicker: font role "fontHead" is Inter, which fonts\.json does not ship/), JSON.stringify(res.errors));
  assert.ok(hasError(res, /Title01\.title: font role "palette" is not a font in design\.js/));
  edit(dir, 'fonts.json', (j) => { j.faces.push({ family: 'Inter', weight: 700, style: 'normal', file: 'fonts/Inter-700.woff2', license: 'OFL-1.1' }); });
  edit(dir, '../analysis/elements.json', (j) => { j.elements[2].font = 'font'; });
  assert.deepEqual((await validateTemplate(dir)).errors, []);
});

test('behind the subject: an element behind a clip needs media.cutout there, and a cutout needs an element behind it', async () => {
  const dir = cleanCopy();
  edit(dir, '../analysis/elements.json', (j) => { j.elements[1].behind = 'cover'; });
  let res = await validateTemplate(dir);
  assert.deepEqual(res.errors, ['Title01.kicker: behind Title01.cover needs a video field with media.cutout: true']);
  edit(dir, 'boards/Title01.json', (j) => { j.schema.fields[2].media.cutout = true; });
  res = await validateTemplate(dir);
  assert.deepEqual(res.errors, ['board Title01: media.cutout field — the board never draws coverCutout']);
  edit(dir, 'boards/Title01.jsx', (src) => `${src}\n// draws coverCutout over the kicker\n`);
  assert.deepEqual((await validateTemplate(dir)).errors, []);
  edit(dir, '../analysis/elements.json', (j) => { delete j.elements[1].behind; });
  res = await validateTemplate(dir);
  assert.deepEqual(res.errors, ['Title01.cover: media.cutout but no element in analysis/elements.json is behind it']);
  edit(dir, 'boards/Points02.json', (j) => { j.schema.fields[0].media = { cutout: true }; });
  assert.ok(hasError(await validateTemplate(dir), /board Points02: heading\.media\.cutout is only for video fields/));
});
