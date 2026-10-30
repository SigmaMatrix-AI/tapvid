// Sound effects in the source (spec §4 step 2): transient non-speech audio events — pops,
// whooshes, dings on element entrances — found as onset peaks of the soundtrack that do not
// belong to a spoken word. Each event gets a time, a length, a level, a spectral centroid and a
// rough kind, plus a short clip and one spectrogram strip so the cloner can hear / see it.
// Written to source/sfx.json; the template reproduces them with the built-in library (sfx.mjs).
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './common.mjs';
import { onsetStrength } from './tempo.mjs';
import { decodePcm, ffmpeg, hasFilter } from './video.mjs';

// 22.05 kHz keeps the spectrum up to 11 kHz, where clicks and swooshes put their energy.
export const DETECT_RATE = 22050;
// onsetStrength's hop (tempo.mjs): 256 samples = 11.6 ms at DETECT_RATE.
const HOP = 256;
// Peaks are picked on the energy rise over the last 8 hops (93 ms: the summed onset strength),
// so a whoosh that swells for a few hundred ms counts as well as a click that rises in one hop.
const RISE_HOPS = 8;
// A peak must rise at least a doubling of energy (log rise 0.69, see tempo.mjs) in that span.
const MIN_ONSET = 0.69;
// Peaks inside a transcript word (padded by 40 ms for the word timing's slack) are speech...
const WORD_PAD_S = 0.04;
// ...unless the peak is at least twice the median onset of the other peaks within ±0.5 s.
// Consecutive syllable attacks in one voice sit within about a doubling of each other (stressed
// vs. unstressed); an effect mixed loud enough to be heard over the voice clears that.
const SPEECH_WINDOW_S = 0.5;
const OVER_SPEECH = 2;
// Peaks closer than this are one event (an effect's attack often has two or three ripples).
const MERGE_S = 0.08;
// An event lasts until its 5 ms RMS envelope falls 20 dB under its peak, at most 1.5 s.
const ENV_S = 0.005;
const DECAY_DB = 20;
const MAX_DUR_S = 1.5;
const MAX_ATTACK_S = 0.5;
// 5 ms windows of band-passed noise (a whoosh) wobble by a few dB; a rise of more than 6 dB
// walking back from a peak is another sound, not the ripple of this one.
const RIPPLE_DB = 6;
const STRUCK_PEAK_S = 0.02;
// With background music every beat is an onset: keep the strongest 60 (a minute of one
// effect per second is more than any short video carries) and mark the list dense.
const MAX_EVENTS = 60;
// Clips start 50 ms before the onset so the attack is audible.
const PRE_ROLL_S = 0.05;
// Spectrogram strip: one clip after another with 0.1 s of silence between them.
const SHEET_GAP_S = 0.1;
const SHEET_PX_PER_S = 400;
const SHEET_MAX_W = 8000;
const SHEET_H = 256;

const round3 = (v) => Number(v.toFixed(3));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Kind rules, in order (from the duration, attack and spectral centroid of the event):
//   click  — over within 30 ms;
//   whoosh — the envelope peaks ≥ 80 ms after the onset (a swell; struck sounds peak at once);
//   impact — centroid under 500 Hz and ringing ≥ 150 ms (a thump; a pop glides low but is short);
//   ding   — rings ≥ 300 ms after a sharp attack (a bell or chime);
//   pop    — shorter than 200 ms;
//   other  — anything else.
export function guessKind({ dur, attack, centroidHz }) {
  if (dur < 0.03) return 'click';
  if (attack >= 0.08) return 'whoosh';
  if (centroidHz < 500 && dur >= 0.15) return 'impact';
  if (dur >= 0.3) return 'ding';
  if (dur < 0.2) return 'pop';
  return 'other';
}

// Magnitude spectrum of a power-of-two frame (iterative radix-2 FFT).
function magnitudes(frame) {
  const n = frame.length;
  const re = Float64Array.from(frame);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const [wr, wi] = [Math.cos(ang * k), Math.sin(ang * k)];
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        [re[b], im[b]] = [re[a] - tr, im[a] - ti];
        [re[a], im[a]] = [re[a] + tr, im[a] + ti];
      }
    }
  }
  return Float64Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]));
}

// Spectral centroid (Hz) of `seconds` of audio from sample `start`, Hann-windowed.
function centroid(pcm, sampleRate, start, seconds) {
  let n = 256;
  while (n < seconds * sampleRate && n < 2048) n <<= 1;
  const frame = Float64Array.from({ length: n }, (_, i) => (pcm[start + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));
  const mag = magnitudes(frame);
  let num = 0;
  let den = 0;
  for (let k = 1; k < mag.length; k++) { num += k * mag[k]; den += mag[k]; }
  return den ? (num / den) * (sampleRate / n) : 0;
}

/**
 * Sound-effect events in mono PCM.
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @param {Array<{start:number,end:number}>} [words] transcript words (seconds)
 * @returns {{ events: Array<{t,dur,peakDb,centroidHz,kindGuess}>, dense: boolean }}
 */
export function detectSfx(pcm, sampleRate, words = []) {
  const onset = onsetStrength(pcm);
  const rise = onset.map((_, i) => onset.slice(Math.max(0, i - RISE_HOPS + 1), i + 1).reduce((a, b) => a + b, 0));
  const hopS = HOP / sampleRate;
  const peaks = [];
  for (let i = 1; i < rise.length; i++) {
    const v = rise[i];
    if (v < MIN_ONSET) continue;
    let top = true;
    for (let k = Math.max(0, i - 2); k <= Math.min(rise.length - 1, i + 2); k++) if (rise[k] > v || (rise[k] === v && k < i)) top = false;
    // The event starts where its rise does: the first rising hop of the span.
    let start = Math.max(1, i - RISE_HOPS + 1);
    while (start < i && onset[start] <= 0) start++;
    if (top) peaks.push({ t: start * hopS, strength: v });
  }
  const inWord = (t) => words.some((w) => t >= w.start - WORD_PAD_S && t <= w.end + WORD_PAD_S);
  const kept = peaks.filter((p) => {
    if (!inWord(p.t)) return true;
    const near = peaks.filter((q) => q !== p && Math.abs(q.t - p.t) <= SPEECH_WINDOW_S).map((q) => q.strength);
    return near.length > 0 && p.strength >= OVER_SPEECH * median(near);
  });
  const merged = kept.reduce((acc, p) => {
    const last = acc[acc.length - 1];
    if (last && p.t - last.t < MERGE_S) return p.strength > last.strength ? [...acc.slice(0, -1), p] : acc;
    return [...acc, p];
  }, []);
  const dense = merged.length > MAX_EVENTS;
  const chosen = dense ? [...merged].sort((a, b) => b.strength - a.strength).slice(0, MAX_EVENTS).sort((a, b) => a.t - b.t) : merged;

  const win = Math.max(1, Math.round(ENV_S * sampleRate));
  const env = Float64Array.from({ length: Math.ceil(pcm.length / win) }, (_, w) => {
    let e = 0;
    const end = Math.min(pcm.length, (w + 1) * win);
    for (let k = w * win; k < end; k++) e += pcm[k] * pcm[k];
    return 10 * Math.log10(e / Math.max(1, end - w * win) + 1e-12);
  });
  const events = chosen.map(({ t }) => {
    const w0 = Math.floor(t / ENV_S);
    // The envelope peak: from just before the onset to the attack limit (a swell peaks late).
    let wp = w0;
    for (let w = Math.max(0, w0 - 2); w <= Math.min(env.length - 1, w0 + Math.round(MAX_ATTACK_S / ENV_S)); w++) {
      if (env[w] > env[wp]) wp = w;
      if (env[w] < env[wp] - DECAY_DB) break; // already decayed: the rest is another sound
    }
    // A struck sound peaks within 20 ms of its onset hop and starts there. A swell peaks later,
    // and its quiet head is below what the onset strength sees: walk back from its peak until the
    // envelope drops 20 dB under it or rises past its lowest point so far by more than the ripple
    // (an earlier sound under it).
    let ws = w0;
    if ((wp - w0) * ENV_S >= STRUCK_PEAK_S) {
      let low = env[wp];
      ws = wp;
      while (ws > 0 && env[ws - 1] >= env[wp] - DECAY_DB && env[ws - 1] <= low + RIPPLE_DB && (wp - ws) * ENV_S < MAX_ATTACK_S) {
        ws--;
        low = Math.min(low, env[ws]);
      }
    }
    let we = wp;
    while (we < env.length - 1 && env[we] >= env[wp] - DECAY_DB && (we - ws) * ENV_S < MAX_DUR_S) we++;
    const start = Math.min(t, ws * ENV_S);
    const dur = Math.min(MAX_DUR_S, Math.max(ENV_S, we * ENV_S - start));
    const attack = Math.max(0, wp * ENV_S - start);
    const s0 = Math.round(start * sampleRate);
    const s1 = Math.min(pcm.length, s0 + Math.round(dur * sampleRate));
    let peak = 0;
    for (let k = s0; k < s1; k++) peak = Math.max(peak, Math.abs(pcm[k]));
    const centroidHz = Math.round(centroid(pcm, sampleRate, s0, Math.min(dur, 0.1)));
    return { t: round3(start), dur: round3(dur), peakDb: Number((20 * Math.log10(peak + 1e-9)).toFixed(1)), centroidHz, kindGuess: guessKind({ dur, attack, centroidHz }) };
  });
  return { events, dense };
}

// Detect, cut each event to source/sfx/<nn>.wav, draw source/sfx/sheet.png, write source/sfx.json.
export async function writeSfx(sourceDir, wav, words = []) {
  const { events, dense } = detectSfx(await decodePcm(wav, DETECT_RATE), DETECT_RATE, words);
  const dir = join(sourceDir, 'sfx');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (const [k, e] of events.entries()) {
    const clip = `sfx/${String(k + 1).padStart(2, '0')}.wav`;
    const from = Math.max(0, e.t - PRE_ROLL_S);
    await ffmpeg(['-i', wav, '-af', `atrim=start=${from.toFixed(3)}:end=${(e.t + e.dur).toFixed(3)},asetpts=PTS-STARTPTS`, join(sourceDir, ...clip.split('/'))]);
    out.push({ ...e, clip });
  }
  let sheet = null;
  if (out.length && hasFilter('showspectrumpic')) {
    const total = out.reduce((s, e) => s + Math.min(e.t, PRE_ROLL_S) + e.dur + SHEET_GAP_S, 0);
    const width = Math.min(SHEET_MAX_W, Math.max(400, Math.round(total * SHEET_PX_PER_S)));
    const graph = out.map((_, k) => `[${k}:a]apad=pad_dur=${SHEET_GAP_S}[a${k}]`).join(';')
      + `;${out.map((_, k) => `[a${k}]`).join('')}concat=n=${out.length}:v=0:a=1,showspectrumpic=s=${width}x${SHEET_H}:legend=0`;
    sheet = 'sfx/sheet.png';
    await ffmpeg([...out.flatMap((e) => ['-i', join(sourceDir, ...e.clip.split('/'))]), '-filter_complex', graph, '-frames:v', '1', '-update', '1', join(dir, 'sheet.png')]);
  }
  const result = { dense, sheet, events: out };
  writeJson(join(sourceDir, 'sfx.json'), result);
  return result;
}
