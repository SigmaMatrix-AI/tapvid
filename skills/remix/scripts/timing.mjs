#!/usr/bin/env node
// Step 8 (spec §4): write replica.json "resolved" — each scene's start / duration, segments,
// incoming transition, narration audio and offset, word timings.
//   node timing.mjs <replica-dir>
// Narration mode needs the voice takes in tasks.json; music-only / silent use the source
// windows in analysis/boards.json (snapped to the BGM beat grid in music-only mode). A
// self-voiced avatar clip is transcribed first (speech.transcribe, cached in tasks.json), and
// the uniform tempo decision goes to replica.audio.tempo.
import { fail, parseArgs, writeJson } from './lib/common.mjs';
import { loadReplica } from './lib/replica.mjs';
import { resolveTiming, transcribeRequests } from './lib/timing.mjs';

// Word timings of the self-voiced avatar clips, through the media runner into tasks.json.
async function transcribe(ctx) {
  const requests = transcribeRequests(ctx);
  if (!requests.length) return ctx;
  const [{ loadRegistry }, { createSecrets }, { loadConfig }, { createRunner }] = await Promise.all([
    import('./lib/media/registry.mjs'), import('./lib/media/secrets.mjs'), import('./lib/media/router.mjs'), import('./lib/media/runner.mjs'),
  ]);
  const runner = createRunner({ registry: await loadRegistry(), secrets: createSecrets(), config: loadConfig(), log: (m) => console.error(m) });
  console.error(`transcribing ${requests.length} avatar clip(s)…`);
  const results = await runner.runPlan(requests, { planDir: ctx.dir });
  for (const r of results) if (r.status !== 'completed') console.error(`warning: ${r.id}: ${r.error?.message || 'transcription failed'}`);
  return loadReplica(ctx.dir);
}

const args = parseArgs();
if (!args._[0]) fail('usage: timing.mjs <replica-dir>', 2);
const ctx = await transcribe(loadReplica(args._[0]));
const { resolved, problems, tempo } = resolveTiming(ctx);
if (problems.length) fail(problems.join('\n'));
const audio = tempo ? { ...ctx.replica.audio, tempo } : ctx.replica.audio;
writeJson(ctx.path, { ...ctx.replica, audio, resolved });
if (tempo) console.error(`pace: source ${tempo.sourceSylPerS ?? '—'} syl/s, take ${tempo.takeSylPerS} syl/s → tempo ×${tempo.factor} (${tempo.kind}${tempo.fixed !== undefined ? ', fixed' : ''})`);
for (const [k, r] of Object.entries(resolved)) if (r.wordMatch !== undefined) console.error(`${k}: ${Math.round(r.wordMatch * 100)}% of the script matched the avatar's words`);
const total = Object.values(resolved).reduce((a, r) => a + r.duration, 0);
console.log(JSON.stringify({ scenes: Object.fromEntries(Object.entries(resolved).map(([k, r]) => [k, r.duration])), total: Number(total.toFixed(3)) }));
