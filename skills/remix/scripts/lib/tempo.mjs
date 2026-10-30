// Tempo and beat times from mono PCM: an energy-envelope onset strength, its autocorrelation
// for the beat period, then the phase that lines the most onset strength up on the grid.
// Deliberately simple; good enough to say "about 104 bpm, beats here" for music-only cuts.

// Envelope hop: 256 samples at 11025 Hz ≈ 23 ms, finer than any beat a cut lands on.
const HOP = 256;
// Tempo search range; outside it a period is a bar or a subdivision, not the beat.
const MIN_BPM = 60;
const MAX_BPM = 200;
// Autocorrelation at the best lag, relative to lag 0, below which the audio has no steady pulse.
// A 120 bpm click track scores 0.82, white noise 0.24.
const MIN_PERIODICITY = 0.4;
// Largest onset (log-energy rise per hop) below which nothing in the audio is a hit: a held
// tone through AAC peaks at 0.06, a click at 5.5, a doubling of energy is 0.69.
const MIN_ONSET = 0.3;
// A half-period lag keeping this share of the best autocorrelation is the real beat (the best
// lag of a steady pulse is often a multiple of it).
const HALF_LAG_SHARE = 0.8;

export function onsetStrength(pcm) {
  const n = Math.floor(pcm.length / HOP);
  const energy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let k = i * HOP; k < (i + 1) * HOP; k++) e += pcm[k] * pcm[k];
    energy[i] = Math.log1p(1000 * e / HOP);
  }
  const onset = new Float64Array(n);
  for (let i = 1; i < n; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1]);
  const mean = onset.reduce((a, b) => a + b, 0) / Math.max(1, n);
  return onset.map((v) => Math.max(0, v - mean));
}

export function detectBeats(pcm, sampleRate, duration = pcm.length / sampleRate) {
  const onset = onsetStrength(pcm);
  const frameRate = sampleRate / HOP;
  const minLag = Math.floor((60 / MAX_BPM) * frameRate);
  const maxLag = Math.ceil((60 / MIN_BPM) * frameRate);
  const ac = (lag) => {
    let s = 0;
    for (let i = lag; i < onset.length; i++) s += onset[i] * onset[i - lag];
    return s;
  };
  const zero = ac(0);
  if (!zero || onset.length < maxLag * 2 || Math.max(...onset) < MIN_ONSET) return { bpm: null, times: [] };
  let best = minLag;
  let bestVal = -Infinity;
  const vals = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    vals[lag] = ac(lag);
    if (vals[lag] > bestVal) { bestVal = vals[lag]; best = lag; }
  }
  if (bestVal / zero < MIN_PERIODICITY) return { bpm: null, times: [] };
  // Compared as 3-lag sums: a period between two lags splits its peak over both.
  const near = (k) => (vals[k - 1] || 0) + (vals[k] || 0) + (vals[k + 1] || 0);
  for (;;) {
    const h = Math.round(best / 2);
    const half = [h - 1, h, h + 1].filter((k) => k >= minLag).sort((a, b) => vals[b] - vals[a])[0];
    if (half === undefined || near(half) < HALF_LAG_SHARE * near(best)) break;
    best = half;
    bestVal = vals[half];
  }
  // Parabolic interpolation around the peak for a sub-hop period.
  const [l, c, r] = [vals[best - 1] ?? bestVal, bestVal, vals[best + 1] ?? bestVal];
  const shift = l - 2 * c + r ? (0.5 * (l - r)) / (l - 2 * c + r) : 0;
  const period = (best + shift) / frameRate;
  let phase = 0;
  let phaseVal = -Infinity;
  for (let p = 0; p < best; p++) {
    let s = 0;
    for (let t = p; t < onset.length; t += period * frameRate) s += onset[Math.round(t)] || 0;
    if (s > phaseVal) { phaseVal = s; phase = p; }
  }
  const times = [];
  // The grid runs back to the start too: the first hit has no energy before it to rise from.
  let first = phase / frameRate;
  while (first - period > -1 / frameRate) first -= period;
  for (let t = first; t < duration; t += period) times.push(Number(Math.max(0, t).toFixed(3)));
  return { bpm: Number((60 / period).toFixed(1)), times };
}
