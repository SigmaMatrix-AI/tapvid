// Shared setup for the render-side tests: a scratch copy of the sample clone, a replica built
// from it, and tiny ffmpeg-generated media.
import { cpSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runtimePath, writeJson } from '../../skills/remix/scripts/lib/common.mjs';
import { buildReplica } from '../../skills/remix/scripts/replica-init.mjs';
import { slotRequestId, speechRequestId } from '../../skills/remix/scripts/lib/media/plan.mjs';

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-clone');
export const runtimeReady = existsSync(runtimePath('esbuild')) && existsSync(runtimePath('playwright'));

export function makeClone() {
  const dir = join(mkdtempSync(join(tmpdir(), 'tapvid-render-')), 'clone');
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

export const SKETCH = `import React from 'react';
export default function Sketch({ t, duration, Design }) {
  const p = Math.min(1, t / duration);
  return <div style={{ position: 'absolute', inset: 0, background: Design.palette.primary, transform: \`scale(\${1 + 0.1 * p})\` }} />;
}
`;

// A replica of the sample template that validates: the example title line is cut to the
// board's 18-char limit and the AI cover slot gets a sketch.
export function makeReplica(clone, { slug = 'demo', mode, edit } = {}) {
  const replica = buildReplica(clone, slug, { topic: 'Nova launch', language: 'en' });
  replica.scenes[0].data.title = ['Meet Nova', 'Notes that reply'];
  replica.scenes[0].media.cover.sketch = 'sketches/Title01.cover.jsx';
  if (mode) {
    replica.audio = { mode, voice: null, captions: null, bgm: mode === 'silent' ? null : { brief: '', candidates: [], selected: 0, path: null, beats: null } };
  } else {
    replica.audio.voice = { provider: 'fake', id: 'v1', name: 'Fake' };
  }
  edit?.(replica);
  const dir = join(clone, 'replicas', slug);
  mkdirSync(join(dir, 'sketches'), { recursive: true });
  writeFileSync(join(dir, 'sketches', 'Title01.cover.jsx'), SKETCH, 'utf-8');
  writeJson(join(dir, 'replica.json'), replica);
  return dir;
}

export function tone(file, seconds) {
  mkdirSync(dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '64k', file]);
}

export function clip(file, seconds, size = '540x960') {
  mkdirSync(dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
}

export function probe(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf-8' }));
}

// tasks.json with completed narration takes for both scenes and the generated cover clip.
export function fakeTasks(dir, { takes = { '01-Title01.narration': 1.2, '02-Points02.points.0.say': 0.8, '02-Points02.points.1.say': 1.0 }, cover = 2 } = {}) {
  const tasks = {};
  const add = (id, path, mime) => { tasks[id] = { id, status: 'completed', result: { files: [{ path, mime }] } }; };
  for (const [name, s] of Object.entries(takes)) {
    const rel = `assets/audio/${name}.mp3`;
    tone(join(dir, ...rel.split('/')), s);
    const [scene, ...key] = name.split('.');
    const index = Number(scene.slice(0, 2)) - 1;
    const board = scene.slice(3);
    add(speechRequestId('demo', index, board, key.join('.')), rel, 'audio/mpeg');
  }
  if (cover) {
    clip(join(dir, 'assets', 'gen', '01-Title01.cover.mp4'), cover);
    add(slotRequestId('demo', 0, 'Title01', 'cover'), 'assets/gen/01-Title01.cover.mp4', 'video/mp4');
  }
  writeJson(join(dir, 'tasks.json'), { version: 1, tasks });
}
