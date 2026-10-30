// Built-in sound-effect library: every kind is synthesized here in plain Node (seeded noise,
// one-pole / biquad filters, envelopes) into a 44.1 kHz mono 16-bit WAV, so a replica can
// reproduce the original's pops and whooshes without a paid service or the source audio.
// ensureSfx(kind) renders a kind once into ~/.tapvid-video/sfx/; a template may ship its own
// template/sfx/<kind>.wav, which resolveSfx prefers.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './common.mjs';

export const SFX_RATE = 44100;
// Peak level of every rendered kind: −3 dBFS leaves headroom for the mix's resampling.
const PEAK = 10 ** (-3 / 20);
// Edge fades: 2 ms in, 5 ms out, short enough to keep a click's attack, long enough that no kind
// starts or ends on a non-zero sample (an audible tick of its own).
const FADE_IN_S = 0.002;
const FADE_OUT_S = 0.005;

// mulberry32: a tiny seeded PRNG, so every render of a kind is byte-identical.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buffer = (seconds) => new Float64Array(Math.round(seconds * SFX_RATE));
const noise = (n, seed) => {
  const r = rng(seed);
  return Float64Array.from({ length: n }, () => r() * 2 - 1);
};

// RBJ cookbook biquad; `freq(i)` may vary per sample (coefficients are refreshed every 32 samples,
// fine enough for a sweep and ~30× cheaper than per sample).
function biquad(input, type, freq, q) {
  const f = typeof freq === 'function' ? freq : () => freq;
  const out = new Float64Array(input.length);
  let b0 = 0; let b1 = 0; let b2 = 0; let a1 = 0; let a2 = 0;
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    if (i % 32 === 0) {
      const w = (2 * Math.PI * Math.min(f(i), SFX_RATE * 0.45)) / SFX_RATE;
      const alpha = Math.sin(w) / (2 * q);
      const cos = Math.cos(w);
      const a0 = 1 + alpha;
      if (type === 'lowpass') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; }
      else if (type === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; }
      else { b0 = alpha; b1 = 0; b2 = -alpha; } // band-pass, 0 dB peak gain
      [b0, b1, b2, a1, a2] = [b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
    }
    const x = input[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    [x2, x1, y2, y1] = [x1, x, y1, y];
    out[i] = y;
  }
  return out;
}

// One-pole low-pass (gentle 6 dB/oct darkening).
function onePole(input, cutoff) {
  const k = 1 - Math.exp((-2 * Math.PI * cutoff) / SFX_RATE);
  const out = new Float64Array(input.length);
  let y = 0;
  for (let i = 0; i < input.length; i++) { y += k * (input[i] - y); out[i] = y; }
  return out;
}

// Sine with a per-sample frequency (phase-accumulated, so glides stay continuous).
function sweep(n, freq) {
  const out = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) { out[i] = Math.sin(ph); ph += (2 * Math.PI * freq(i / SFX_RATE)) / SFX_RATE; }
  return out;
}

const decay = (t, tau) => Math.exp(-t / tau);
const glide = (from, to, seconds) => (t) => from * (to / from) ** Math.min(1, t / seconds);
const mul = (a, env) => a.map((v, i) => v * env(i / SFX_RATE));
const add = (...xs) => xs[0].map((_, i) => xs.reduce((s, x) => s + (x[i] || 0), 0));
const at = (a, n, offset) => Float64Array.from({ length: n }, (_, i) => (i >= offset && i - offset < a.length ? a[i - offset] : 0));
// Swell: rises to the peak at `peakAt` (share of the length) and falls back, sin²-shaped.
const swell = (len, peakAt) => (t) => {
  const p = t / len;
  return Math.sin((Math.PI / 2) * (p < peakAt ? p / peakAt : 1 - (p - peakAt) / (1 - peakAt))) ** 2;
};

const KINDS = {
  // Short pitch-dropping sine blip with a soft noise tick on the attack.
  pop: () => {
    const n = buffer(0.12).length;
    const tone = mul(sweep(n, glide(900, 240, 0.06)), (t) => decay(t, 0.025));
    const tick = mul(onePole(noise(n, 1), 4000), (t) => decay(t, 0.002) * 0.3);
    return add(tone, tick);
  },
  // 5 ms band-passed noise tick.
  click: () => mul(biquad(noise(buffer(0.02).length, 2), 'bandpass', 3200, 1.2), (t) => (t < 0.005 ? decay(t, 0.0015) : 0)),
  // Band-passed noise whose centre sweeps up and back with a swell: air moving past.
  whoosh: () => {
    const len = 0.45;
    const n = buffer(len).length;
    const centre = (i) => { const p = i / n; return 350 + 2300 * Math.sin(Math.PI * Math.min(1, p / 0.8)); };
    return mul(biquad(noise(n, 3), 'bandpass', centre, 1.4), swell(len, 0.6));
  },
  // Shorter, brighter, one-way sweep.
  swoosh: () => {
    const len = 0.25;
    const n = buffer(len).length;
    return mul(biquad(noise(n, 4), 'bandpass', (i) => 1500 * 4 ** (i / n), 2), swell(len, 0.4));
  },
  // Bell: inharmonic partials (classic bell ratios), higher ones dying faster.
  ding: () => {
    const n = buffer(0.9).length;
    const partials = [[1, 1, 0.35], [2.76, 0.5, 0.2], [5.4, 0.25, 0.1], [8.93, 0.12, 0.06]];
    return add(...partials.map(([ratio, amp, tau]) => mul(sweep(n, () => 1320 * ratio), (t) => amp * decay(t, tau))));
  },
  // Paper crinkle: sparse high-passed noise grains of random length and level.
  paper: () => {
    const len = 0.3;
    const n = buffer(len).length;
    const r = rng(6);
    const grains = new Float64Array(n);
    // ~120 grains/s: dense enough to read as one crinkle, sparse enough to stay grainy.
    for (let g = 0; g < 120 * len; g++) {
      const start = Math.floor(r() * n * 0.9);
      const glen = Math.floor((0.002 + r() * 0.004) * SFX_RATE);
      const amp = 0.3 + r() * 0.7;
      const grain = biquad(noise(glen, 100 + g), 'highpass', 2000 + r() * 4000, 0.9);
      for (let k = 0; k < glen && start + k < n; k++) grains[start + k] += amp * grain[k] * Math.sin((Math.PI * k) / glen);
    }
    return mul(grains, swell(len, 0.3));
  },
  // Typewriter key: noise snap + metallic clack + low thunk of the key bed.
  typewriter: () => {
    const n = buffer(0.08).length;
    return add(
      mul(biquad(noise(n, 7), 'bandpass', 2500, 1.5), (t) => decay(t, 0.003)),
      mul(sweep(n, () => 1800), (t) => 0.4 * decay(t, 0.015)),
      mul(sweep(n, () => 180), (t) => 0.6 * decay(t, 0.02)),
    );
  },
  // Low sine thump falling in pitch plus a dark noise burst.
  impact: () => {
    const n = buffer(0.6).length;
    return add(
      mul(sweep(n, glide(110, 45, 0.25)), (t) => decay(t, 0.12)),
      mul(biquad(noise(n, 8), 'lowpass', 900, 0.7), (t) => 0.5 * decay(t, 0.04)),
    );
  },
  // Rising noise sweep plus a gliding tone, growing to the end.
  riser: () => {
    const len = 1;
    const n = buffer(len).length;
    const grow = (t) => (t / len) ** 2;
    return add(
      mul(biquad(noise(n, 9), 'bandpass', (i) => 300 * (5000 / 300) ** (i / n), 1.2), grow),
      mul(sweep(n, glide(200, 800, len)), (t) => 0.3 * grow(t)),
    );
  },
  // Camera shutter: two bright mechanical clicks (open, close) 70 ms apart.
  shutter: () => {
    const n = buffer(0.15).length;
    const blade = (seed) => {
      const m = buffer(0.04).length;
      return add(mul(biquad(noise(m, seed), 'bandpass', 4000, 1.5), (t) => decay(t, 0.008)), mul(sweep(m, () => 600), (t) => 0.4 * decay(t, 0.01)));
    };
    return add(at(blade(10), n, 0), at(mul(blade(11), () => 0.8), n, Math.round(0.07 * SFX_RATE)));
  },
};

export const SFX_KINDS = Object.keys(KINDS);

// Mono float samples of `kind`, edge-faded and peak-normalized to −3 dBFS.
export function synthSfx(kind) {
  if (!KINDS[kind]) throw new Error(`unknown sfx kind: ${kind} (known: ${SFX_KINDS.join(', ')})`);
  const raw = KINDS[kind]();
  const fi = Math.round(FADE_IN_S * SFX_RATE);
  const fo = Math.round(FADE_OUT_S * SFX_RATE);
  const faded = raw.map((v, i) => v * Math.min(1, i / fi, (raw.length - 1 - i) / fo));
  const peak = faded.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  return Float32Array.from(faded, (v) => (v * PEAK) / peak);
}

// 16-bit PCM WAV bytes of mono float samples.
export function wavBytes(samples, rate = SFX_RATE) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return buf;
}

export function renderSfx(kind, out) {
  writeFileSync(out, wavBytes(synthSfx(kind)));
  return out;
}

// Absolute path of the library WAV for `kind`, rendered on first use.
// Bump SYNTH_VERSION when a synth changes, so cached renders of the old sound are not reused.
const SYNTH_VERSION = 1;
export function ensureSfx(kind) {
  const dir = join(HOME, 'sfx', `v${SYNTH_VERSION}`);
  const out = join(dir, `${kind}.wav`);
  if (existsSync(out)) return out;
  const samples = synthSfx(kind); // throws on an unknown kind before anything is written
  mkdirSync(dir, { recursive: true });
  writeFileSync(out, wavBytes(samples));
  return out;
}

// The template's own template/sfx/<kind>.wav when it ships one, else the library's.
export function resolveSfx(templateDir, kind) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(kind)) throw new Error(`invalid sfx kind: ${kind}`);
  const own = templateDir && join(templateDir, 'sfx', `${kind}.wav`);
  return own && existsSync(own) ? own : ensureSfx(kind);
}
