import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJson, writeJson } from '../../skills/remix/scripts/lib/common.mjs';
import { slotRequestId } from '../../skills/remix/scripts/lib/media/plan.mjs';
import { loadReplica } from '../../skills/remix/scripts/lib/replica.mjs';
import {
  LINE_GAP_S, POST_PAD_S, PRE_PAD_S, alignLines, resolveTiming, scaleSourceSegments, snapToBeats, transcribeRequests, wordsRequestId,
} from '../../skills/remix/scripts/lib/timing.mjs';
import { fakeTasks, makeClone, makeReplica, probe } from './render-helpers.mjs';

const near = (a, b, eps = 1 / 30) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('narration mode: durations from the takes, segments from joined per-line takes', () => {
  const dir = makeReplica(makeClone());
  fakeTasks(dir, { cover: 0 });
  const { resolved, problems } = resolveTiming(loadReplica(dir));
  assert.deepEqual(problems, []);
  const take = (n) => probe(join(dir, 'assets', 'audio', `${n}.mp3`));
  const t1 = resolved['01-Title01'];
  assert.equal(t1.start, 0);
  assert.equal(t1.audioOffset, PRE_PAD_S);
  near(t1.duration, PRE_PAD_S + take('01-Title01.narration') + POST_PAD_S);
  assert.equal(t1.audio, 'assets/audio/01-Title01.narration.mp3');
  assert.ok(t1.words.length >= 5 && t1.words[0].start >= PRE_PAD_S);

  const t2 = resolved['02-Points02'];
  assert.deepEqual(t2.transitionIn, { type: 'page-flip', duration: 0.5, params: { direction: 'left', curl: 0.35 } });
  assert.equal(t2.audioOffset, 0.5, 'voice starts once the page flip has landed');
  assert.equal(t2.start, t1.duration);
  const [d0, d1] = [take('02-Points02.points.0.say'), take('02-Points02.points.1.say')];
  near(t2.duration, 0.5 + d0 + LINE_GAP_S + d1 + POST_PAD_S);
  assert.deepEqual(t2.segments.map((s) => s.key), ['points.0.say', 'points.1.say']);
  assert.equal(t2.segments[0].start, 0);
  near(t2.segments[1].start, 0.5 + d0 + LINE_GAP_S);
  assert.equal(t2.segments[1].end, t2.duration);
  assert.equal(t2.audio, 'assets/audio/02-Points02.mp3');
  assert.ok(existsSync(join(dir, 'assets', 'audio', '02-Points02.mp3')));
  near(probe(join(dir, 'assets', 'audio', '02-Points02.mp3')), d0 + LINE_GAP_S + d1, 0.1);
});

test('narration longer than the board maximum is an error naming the scene', () => {
  const dir = makeReplica(makeClone());
  fakeTasks(dir, { cover: 0, takes: { '01-Title01.narration': 6, '02-Points02.points.0.say': 0.5, '02-Points02.points.1.say': 0.5 } });
  const { resolved, problems } = resolveTiming(loadReplica(dir));
  assert.equal(resolved, null);
  assert.match(problems.join('\n'), /01-Title01: narration needs .* Title01 allows at most 6 s/);
});

test('missing takes are reported', () => {
  const dir = makeReplica(makeClone());
  const { problems } = resolveTiming(loadReplica(dir));
  assert.match(problems[0], /narration take demo-01-Title01-speech-narration is not in tasks.json/);
});

test('music-only: source windows, list items at the source rhythm, beat snapping', () => {
  const dir = makeReplica(makeClone(), {
    mode: 'music-only',
    edit: (r) => { r.scenes[1].data.points.push({ label: 'Learns your tone', say: 'It learns your tone.' }); },
  });
  let { resolved, problems } = resolveTiming(loadReplica(dir));
  assert.deepEqual(problems, []);
  assert.equal(resolved['01-Title01'].duration, 2.5);
  assert.equal(resolved['02-Points02'].duration, 3.767, '3.75 s rounded to whole frames');
  assert.deepEqual(resolved['02-Points02'].segments.map((s) => [s.key, s.start, s.end]),
    [['points.0.say', 0, 1.2], ['points.1.say', 1.2, 2.5], ['points.2.say', 2.5, 3.767]]);
  assert.equal(resolved['02-Points02'].audio, null);

  const ctx = loadReplica(dir);
  writeJson(join(dir, 'assets', 'audio', 'bgm.beats.json'), { bpm: 100, beats: [0, 0.6, 1.2, 1.8, 2.4, 3.0, 3.6, 4.2, 4.8, 5.4, 6.0, 6.6] });
  writeJson(ctx.path, { ...ctx.replica, audio: { ...ctx.replica.audio, bgm: { ...ctx.replica.audio.bgm, beats: 'assets/audio/bgm.beats.json' } } });
  ({ resolved } = resolveTiming(loadReplica(dir)));
  assert.equal(resolved['01-Title01'].duration, 2.4, 'the 2.5 s boundary snaps to the 2.4 s beat');
  assert.equal(resolved['02-Points02'].start, 2.4);
});

test('silent mode follows the source timeline', () => {
  const dir = makeReplica(makeClone(), { mode: 'silent' });
  const { resolved } = resolveTiming(loadReplica(dir));
  assert.deepEqual(Object.values(resolved).map((r) => r.duration), [2.5, 2.5]);
});

test('helpers: segment scaling drops items, beat snapping keeps far boundaries', () => {
  const win = { start: 0, end: 3, segments: [{ key: 'a.0.x', start: 0, end: 1 }, { key: 'a.1.x', start: 1, end: 2 }, { key: 'a.2.x', start: 2, end: 2.6 }] };
  assert.deepEqual(scaleSourceSegments(win, { a: [1, 2] }), { duration: 2.4, segments: [{ key: 'a.0.x', start: 0, end: 1 }, { key: 'a.1.x', start: 1, end: 2 }] });
  const round = (xs) => xs.map((x) => Number(x.toFixed(6)));
  assert.deepEqual(round(snapToBeats([2, 2], [0, 0.5, 1, 1.5, 2.2, 3])), [2.2, 1.8]);
  assert.deepEqual(round(snapToBeats([1.25, 1], [0, 0.5, 1.0, 2.0])), [1.0, 1.25]);
});

// A talking clip: picture and a tone track, as a self-voiced avatar delivers it.
function talkingClip(file, seconds) {
  mkdirSync(dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=360x640:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
}

// Words starting at `from`, 0.25 s each with 0.05 s gaps.
const spoken = (text, from) => text.split(' ').map((w, i) => ({ text: w, start: Number((from + i * 0.3).toFixed(3)), end: Number((from + i * 0.3 + 0.25).toFixed(3)) }));

// Scene 1 (Title01) is a self-voiced avatar on the cover slot; scene 2 keeps its voice-over takes.
function avatarReplica({ heard = 'Meet Nova, the notes app that rides back.', words = true, edit } = {}) {
  const dir = makeReplica(makeClone(), {
    edit: (r) => {
      r.scenes[0].media.cover = { ...r.scenes[0].media.cover, kind: 'avatar', sketch: null };
      edit?.(r);
    },
  });
  fakeTasks(dir, { cover: 0, takes: { '02-Points02.points.0.say': 0.8, '02-Points02.points.1.say': 1.0 } });
  const id = slotRequestId('demo', 0, 'Title01', 'cover');
  writeJson(join(dir, 'plan.json'), { version: 1, replica: 'replica.json', requests: [{ id, capability: 'avatar.generate', params: { mode: 'tts', script: 'x', voice: 'v1' }, out: 'assets/gen/01-Title01.cover' }] });
  talkingClip(join(dir, 'assets', 'gen', '01-Title01.cover.mp4'), 3);
  const ledger = readJson(join(dir, 'tasks.json'));
  ledger.tasks[id] = { id, status: 'completed', result: { files: [{ path: 'assets/gen/01-Title01.cover.mp4', mime: 'video/mp4' }] } };
  if (words) {
    const wid = wordsRequestId('demo', 0, 'Title01', 'cover');
    writeJson(join(dir, 'assets', 'audio', '01-Title01.cover.words.json'), { text: heard, words: spoken(heard, 0.4) });
    ledger.tasks[wid] = { id: wid, status: 'completed', result: { files: [{ path: 'assets/audio/01-Title01.cover.words.json', mime: 'application/json' }] } };
  }
  writeJson(join(dir, 'tasks.json'), ledger);
  return dir;
}

test('self-voiced avatar: the clip is the scene audio, its transcript places the line', () => {
  const dir = avatarReplica();
  const { resolved, problems, tempo } = resolveTiming(loadReplica(dir));
  assert.deepEqual(problems, []);
  assert.equal(tempo, null, 'no source transcript, no tempo decision');
  const t1 = resolved['01-Title01'];
  near(t1.duration, probe(join(dir, 'assets', 'gen', '01-Title01.cover.mp4')));
  assert.equal(t1.audioOffset, 0, 'picture and voice are one clip from the scene start');
  assert.equal(t1.audio, 'assets/audio/01-Title01.mp3');
  near(probe(join(dir, 'assets', 'audio', '01-Title01.mp3')), 3, 0.1);
  assert.equal(t1.wordMatch, 0.875, '7 of the 8 script words were heard');
  assert.deepEqual(t1.words.slice(0, 2), [{ text: 'Meet', start: 0.4, end: 0.65 }, { text: 'Nova,', start: 0.7, end: 0.95 }]);
  assert.equal(resolved['02-Points02'].audioOffset, 0.5, 'the voice-over scene is unchanged');
});

test('self-voiced avatar: a clip that does not say the script, or has no words yet, is a problem', () => {
  let { problems } = resolveTiming(loadReplica(avatarReplica({ heard: 'Completely different words spoken here today ok' })));
  assert.match(problems.join('\n'), /01-Title01: only \d+% of the script's words are in the avatar clip's transcript/);
  ({ problems } = resolveTiming(loadReplica(avatarReplica({ words: false }))));
  assert.match(problems.join('\n'), /01-Title01: the avatar clip has no word timings/);
});

test('transcribeRequests asks for the words of self-voiced avatar clips without them', () => {
  assert.deepEqual(transcribeRequests(loadReplica(avatarReplica({ words: false }))), [{
    id: 'demo-01-Title01-cover-words', capability: 'speech.transcribe',
    params: { file: 'assets/gen/01-Title01.cover.mp4', language: 'en' }, out: 'assets/audio/01-Title01.cover.words',
  }]);
  assert.deepEqual(transcribeRequests(loadReplica(avatarReplica())), []);
});

test('alignLines splits lines on the heard words, interpolating unmatched ones', () => {
  const words = spoken('so first we plan then we ship it 3 times', 1);
  const { lines, ratio } = alignLines([{ key: 'a', text: 'First, we plan.' }, { key: 'b', text: 'Then we ship it three times!' }, { key: 'c', text: 'Done.' }], words);
  assert.equal(ratio, 9 / 10);
  assert.deepEqual(lines[0], { key: 'a', start: 1.3, end: 2.15 }, '"so" before the script is skipped');
  assert.deepEqual(lines[1], { key: 'b', start: 2.2, end: 3.95 }, '"3" matches "three"');
  assert.deepEqual(lines[2], { key: 'c', start: 3.95, end: 3.95 }, 'an unheard last line sits after the last match');
});

test('uniform tempo: slow voice-over takes are sped by one capped factor', () => {
  const clone = makeClone();
  const dir = makeReplica(clone);
  fakeTasks(dir, { cover: 0 });
  // 9 syllables in 1 s of speech: faster than the takes' 20 syllables in 3 s by more than the cap.
  writeJson(join(clone, 'source', 'timeline.json'), { fps: 30, duration_s: 5, frames: 150, shots: [], words: [{ text: 'one two three four five six seven eight', start: 0, end: 1 }] });
  const { resolved, problems, tempo } = resolveTiming(loadReplica(dir));
  assert.deepEqual(problems, []);
  const { takeSylPerS, ...rest } = tempo;
  assert.deepEqual(rest, { factor: 1.3, sourceSylPerS: 9, kind: 'voiceover' });
  assert.ok(takeSylPerS > 6 && takeSylPerS < 6.8, `20 syllables over ~3 s of takes: ${takeSylPerS}`);
  const t1 = resolved['01-Title01'];
  assert.equal(t1.audio, 'assets/audio/01-Title01.narration.tempo-1.3.mp3');
  const take = probe(join(dir, 'assets', 'audio', '01-Title01.narration.mp3'));
  near(probe(join(dir, 'assets', 'audio', '01-Title01.narration.tempo-1.3.mp3')), take / 1.3, 0.08);
  near(t1.duration, PRE_PAD_S + (take + POST_PAD_S) / 1.3);
  assert.equal(t1.audioOffset, PRE_PAD_S, 'the voice still waits for the pre-pad');
  assert.ok(t1.words[0].start >= PRE_PAD_S);
  assert.equal(resolved['02-Points02'].audio, 'assets/audio/02-Points02.tempo-1.3.mp3');
  assert.equal(resolved['02-Points02'].segments.at(-1).end, resolved['02-Points02'].duration);

  const ctx = loadReplica(dir);
  writeJson(ctx.path, { ...ctx.replica, audio: { ...ctx.replica.audio, tempo: { fixed: 1 } } });
  const off = resolveTiming(loadReplica(dir));
  assert.equal(off.tempo.factor, 1);
  assert.equal(off.tempo.fixed, 1);
  assert.equal(off.resolved['01-Title01'].audio, 'assets/audio/01-Title01.narration.mp3');
});

test('uniform tempo: a self-voiced avatar is capped at the presenter limit and sped as one clip', () => {
  const dir = avatarReplica();
  writeJson(join(dirname(dirname(dir)), 'source', 'timeline.json'), { fps: 30, duration_s: 5, frames: 150, shots: [], words: [{ text: 'one two three four five six seven eight', start: 0, end: 1 }] });
  const { resolved, problems, tempo } = resolveTiming(loadReplica(dir));
  assert.deepEqual(problems, []);
  assert.equal(tempo.kind, 'presenter');
  assert.equal(tempo.factor, 1.12);
  const t1 = resolved['01-Title01'];
  assert.deepEqual(t1.media, { cover: 'assets/gen/01-Title01.cover.tempo-1.12.mp4' });
  near(probe(join(dir, 'assets', 'gen', '01-Title01.cover.tempo-1.12.mp4')), 3 / 1.12, 0.1);
  near(t1.duration, 3 / 1.12);
  assert.equal(t1.words[0].start, Number((0.4 / 1.12).toFixed(3)));
  assert.ok(existsSync(join(dir, 'assets', 'gen', '01-Title01.cover.mp4')), 'the original clip stays');
});
