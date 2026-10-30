// ElevenLabs (spec §5.6): speech with word timings, voices, Scribe transcription and music.
// All calls are synchronous. Docs: elevenlabs.io/docs/api-reference/{text-to-speech/
// convert-with-timestamps, voices/search, speech-to-text/convert, music/compose, user/subscription/get}.
import { basename } from 'node:path';
import { MediaError } from '../lib/media/errors.mjs';
import { estimateFromMeta } from '../lib/media/adapt.mjs';

const BASE = 'https://api.elevenlabs.io';

// A pause longer than this between words starts a new transcript segment.
const SEGMENT_GAP_S = 1;

// Prices from elevenlabs.io/pricing/api, 2026-10-27: v4 $0.08 / 1k chars, Scribe v2 $0.22 / hour,
// Eleven Music $0.15 / minute.
export const meta = {
  name: 'elevenlabs',
  displayName: 'ElevenLabs',
  docs: 'https://elevenlabs.io/docs',
  secrets: ['ELEVENLABS_API_KEY'],
  concurrency: 4,
  capabilities: {
    'speech.synthesize': { models: [{ id: 'eleven_v4', default: true, maxChars: 10000, price: { usdPer1kChars: 0.08 } }] },
    'speech.voices': { models: [] },
    'speech.transcribe': { models: [{ id: 'scribe_v2', default: true, price: { usdPerSecond: 0.22 / 3600 } }] },
    'music.generate': { models: [{ id: 'music_v2_5', default: true, duration: { min: 3, max: 600 }, price: { usdPerSecond: 0.15 / 60 } }] },
  },
};

const auth = (ctx) => ({ 'xi-api-key': ctx.secret('ELEVENLABS_API_KEY') });

export async function verify(ctx) {
  await ctx.json(`${BASE}/v1/user`, { headers: auth(ctx) });
}

// ElevenLabs bills in characters / credits of the subscription period.
export async function account(ctx) {
  const sub = await ctx.json(`${BASE}/v1/user/subscription`, { headers: auth(ctx) });
  return { credits: Math.max(0, (sub.character_limit || 0) - (sub.character_count || 0)) };
}

export async function estimate(capability, req) {
  return estimateFromMeta(capability, req, meta.capabilities[capability]?.models.find((m) => m.id === req.model));
}

const CJK = /[㐀-鿿぀-ヿ가-힯]/;

// Character alignment → word timings: runs of non-space characters form a word; each CJK
// character is a word of its own since those scripts put no spaces between words.
export function wordsFromAlignment(al) {
  const chars = al?.characters || [];
  const starts = al?.character_start_times_seconds || [];
  const ends = al?.character_end_times_seconds || [];
  const words = [];
  let cur = null;
  const flush = () => { if (cur) words.push(cur); cur = null; };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (/\s/.test(ch)) { flush(); continue; }
    if (CJK.test(ch)) { flush(); words.push({ text: ch, start: starts[i], end: ends[i] }); continue; }
    if (!cur) cur = { text: ch, start: starts[i], end: ends[i] };
    else cur = { ...cur, text: cur.text + ch, end: ends[i] };
  }
  flush();
  return words;
}

// Segments from word timings: split after sentence punctuation or at a pause.
export function segmentsFromWords(words) {
  const segments = [];
  let first = 0;
  words.forEach((w, i) => {
    const next = words[i + 1];
    if (next && !/[.!?。！？]$/.test(w.text) && next.start - w.end <= SEGMENT_GAP_S) return;
    const part = words.slice(first, i + 1);
    // Words of spaceless scripts join without spaces.
    const text = part.map((x) => x.text).join(' ').replace(/ (?=[㐀-鿿぀-ヿ가-힯])|(?<=[㐀-鿿぀-ヿ가-힯]) /g, '');
    segments.push({ start: part[0].start, end: w.end, text });
    first = i + 1;
  });
  return segments;
}

async function speech(req, ctx) {
  const p = req.params;
  if (p.style) ctx.log('style hint ignored: ElevenLabs takes tone from the voice and audio tags in the text');
  const body = { text: p.text, model_id: req.resolved_params.model };
  if (p.language) body.language_code = p.language.slice(0, 2).toLowerCase();
  if (p.speed !== undefined) body.voice_settings = { speed: p.speed };
  const res = await ctx.json(`${BASE}/v1/text-to-speech/${encodeURIComponent(p.voice)}/with-timestamps?output_format=mp3_44100_128`,
    { headers: auth(ctx), body, timeoutMs: 300_000 });
  if (!res.audio_base64) throw new MediaError('transient', 'elevenlabs returned no audio');
  const file = { path: ctx.writeOut(req.out, Buffer.from(res.audio_base64, 'base64'), 'mp3'), mime: 'audio/mpeg' };
  const words = wordsFromAlignment(res.alignment || res.normalized_alignment);
  if (words.length) {
    file.words = words;
    file.duration_s = words.at(-1).end;
  }
  return { files: [file] };
}

async function voices(params, ctx) {
  const res = await ctx.json(`${BASE}/v2/voices?page_size=100`, { headers: auth(ctx) });
  const lang = params.language.slice(0, 2).toLowerCase();
  const speaks = (v) => (v.verified_languages || []).some((l) => String(l.language || '').toLowerCase().startsWith(lang))
    || String(v.labels?.language || '').toLowerCase().startsWith(lang);
  return (res.voices || [])
    .filter((v) => !params.gender || v.labels?.gender === params.gender)
    .map((v) => ({
      id: v.voice_id, name: v.name || v.voice_id, gender: v.labels?.gender ?? null,
      language: v.labels?.language || v.verified_languages?.[0]?.language || null,
      sample_url: v.preview_url ?? null, recommended: speaks(v),
    }))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended));
}

async function transcribe(req, ctx) {
  const form = new FormData();
  form.append('model_id', req.resolved_params.model);
  form.append('file', ctx.blob(req.params.file), basename(req.params.file));
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  if (req.params.language) form.append('language_code', req.params.language);
  const res = await ctx.json(`${BASE}/v1/speech-to-text`, { headers: auth(ctx), form, timeoutMs: 900_000 });
  const words = (res.words || []).filter((w) => w.type === 'word' && w.start !== null && w.start !== undefined)
    .map((w) => ({ text: w.text, start: w.start, end: w.end }));
  const transcript = { language: res.language_code || req.params.language || null, text: res.text || '', segments: segmentsFromWords(words), words };
  return { files: [{ path: ctx.writeOut(req.out, Buffer.from(JSON.stringify(transcript, null, 2)), 'json'), mime: 'application/json' }] };
}

async function music(req, ctx) {
  const r = req.resolved_params;
  const body = { prompt: req.params.prompt, music_length_ms: Math.round(r.duration * 1000), model_id: r.model, force_instrumental: req.params.instrumental ?? true };
  const { buffer, contentType } = await ctx.bytes(`${BASE}/v1/music`, { headers: auth(ctx), body, timeoutMs: 600_000 });
  const ext = contentType.includes('wav') ? 'wav' : 'mp3';
  return { files: [{ path: ctx.writeOut(req.out, buffer, ext), mime: ext === 'wav' ? 'audio/wav' : 'audio/mpeg', duration_s: r.duration, bpm: null }] };
}

export async function submit(capability, req, ctx) {
  if (capability === 'speech.synthesize') return { result: await speech(req, ctx) };
  if (capability === 'speech.voices') return { result: { items: await voices(req.params, ctx) } };
  if (capability === 'speech.transcribe') return { result: await transcribe(req, ctx) };
  if (capability === 'music.generate') return { result: await music(req, ctx) };
  throw new MediaError('unsupported', `elevenlabs has no ${capability}`);
}
