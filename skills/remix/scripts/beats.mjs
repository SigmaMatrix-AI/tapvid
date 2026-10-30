#!/usr/bin/env node
// Beat grid for a finished track (BGM), with the same detector intake.mjs uses on the source
// (scripts/lib/tempo.mjs). With --bpm the tempo is given and only the phase is searched.
//   node beats.mjs <audio> [--bpm 96] [--beats-per-bar 4] [--out <file>]
// Writes { bpm, beatsPerBar, offset, beats, bars } to --out (default <audio>.beats.json); a track
// without a steady pulse gets bpm null and no beats, so nothing snaps to a fake grid.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, parseArgs, writeJson } from './lib/common.mjs';
import { detectBeats as detectTempo, onsetStrength } from './lib/tempo.mjs';
import { decodePcm } from './lib/video.mjs';

const SR = 11025;
const HOP = 256; // tempo.mjs's envelope hop

function gridFor(pcm, bpm, duration) {
  const onset = onsetStrength(pcm);
  const frameRate = SR / HOP;
  const period = 60 / bpm;
  let offset = 0;
  let best = -1;
  for (let o = 0; o < period; o += 0.005) {
    let s = 0;
    for (let t = o; t * frameRate < onset.length; t += period) s += onset[Math.round(t * frameRate)] || 0;
    if (s > best) { best = s; offset = o; }
  }
  const times = [];
  for (let t = offset; t < duration; t += period) times.push(Number(t.toFixed(3)));
  return times;
}

export async function detectBeats(audio, { bpm: fixedBpm, beatsPerBar = 4 } = {}) {
  const pcm = await decodePcm(audio, SR);
  const duration = pcm.length / SR;
  const bpm = Number(fixedBpm) || null;
  const { bpm: found, times } = bpm ? { bpm, times: gridFor(pcm, bpm, duration) } : detectTempo(pcm, SR, duration);
  return {
    bpm: found, beatsPerBar, offset: times[0] ?? null, beats: times,
    bars: times.filter((_, i) => i % beatsPerBar === 0),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs();
  if (!args._[0]) fail('usage: beats.mjs <audio> [--bpm N] [--beats-per-bar 4] [--out <file>]', 2);
  const audio = resolve(args._[0]);
  const result = await detectBeats(audio, { bpm: args.bpm, beatsPerBar: Number(args['beats-per-bar']) || 4 });
  const out = resolve(typeof args.out === 'string' ? args.out : `${audio.replace(/\.[^.]+$/, '')}.beats.json`);
  writeJson(out, result);
  console.log(JSON.stringify({ out, bpm: result.bpm, offset: result.offset, beats: result.beats.length }));
}
