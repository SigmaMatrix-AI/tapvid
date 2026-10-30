// Pure motion helpers — shared by every composable scene module (project mode).
//
// These have NO React and NO player dependency, so an authored scene module can
// `import { mix, easeOut } from '../system/motion.js'` and stay a pure function of
// its `t` prop. Keeping easing in one shipped file makes motion feel consistent
// across scenes without the LLM re-deriving it per scene.

// Linear interpolation.
export const mix = (a, b, p) => a + (b - a) * p;

// Ease-out cubic — clamps p to [0, 1] first.
export const easeOut = (p) => 1 - Math.pow(1 - Math.max(0, Math.min(1, p)), 3);

// Ease-in-out cubic — the other curve scenes reach for constantly.
export const easeInOut = (p) => {
  const c = Math.max(0, Math.min(1, p));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
};

// Clamp a value into [lo, hi].
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Ease-out back — overshoots past 1 then settles; the bouncy-pop entrance curve.
// Keep overshoot <= ~2 — past that it reads as a cartoon wobble, not an arrival.
export const easeBackOut = (p, overshoot = 1.6) => {
  const q = Math.max(0, Math.min(1, p)) - 1;
  return 1 + (overshoot + 1) * q * q * q + overshoot * q * q;
};
