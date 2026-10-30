// Board-to-board transitions (spec §6.3).
//
// projectPlayer keeps the outgoing and incoming scenes in two full-canvas wrappers during an
// overlap and applies the styles returned here. `progress` runs 0 -> 1 over the incoming
// scene's transition duration. Pure functions of progress and params: no timers, no CSS
// transitions, so every frame renders deterministically.
//
// A template whose source used a transition the library lacks ships template/transitions.js
// exporting `extraTransitions = { '<type>': (progress, params) => styles }`; the project build
// copies it over transitions.extra.js, and its types win over the built-in ones.
import { clamp, easeInOut, easeOut, mix } from './motion.js';
import { extraTransitions } from './transitions.extra.js';

const SAME = { outgoing: {}, incoming: {}, incomingOnTop: true };

// Unit vector a direction name moves content along ("left" = content travels to the left).
const DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const dirOf = (d, fallback = 'left') => DIRS[d] || DIRS[fallback];

const EASINGS = {
  linear: (p) => clamp(p, 0, 1),
  inOutCubic: easeInOut,
  outCubic: easeOut,
  inCubic: (p) => Math.pow(clamp(p, 0, 1), 3),
  inOutSine: (p) => 0.5 - Math.cos(Math.PI * clamp(p, 0, 1)) / 2,
};

// Defaults: what the motion reads as at a typical 0.4–0.8 s transition length.
const ZOOM_THROUGH_SCALE = 1.6;
const WHIP_BLUR_PX = 24;
const PAGE_PERSPECTIVE_PX = 2400;
const SLIDE_STACK_SHRINK = 0.12; // outgoing card shrink at depth 1

// Mask that reveals the incoming scene: a gradient edge travelling across the frame.
function lineMask(dir, e, softness) {
  const angle = { left: 270, right: 90, up: 0, down: 180 }[dir] ?? 270;
  const soft = clamp(softness, 0, 1) * 40; // percent of the frame the soft edge spans
  const edge = mix(-soft, 100 + soft, e);
  const g = `linear-gradient(${angle}deg, #000 ${(edge - soft / 2).toFixed(2)}%, transparent ${(edge + soft / 2).toFixed(2)}%)`;
  return { maskImage: g, WebkitMaskImage: g };
}

function circleMask(e, softness, origin) {
  const soft = clamp(softness, 0, 1) * 30;
  const r = mix(0, 100 + soft, e); // 100 % = the farthest corner, so the end state covers the frame
  const at = `${origin[0] * 100}% ${origin[1] * 100}%`;
  const g = `radial-gradient(circle farthest-corner at ${at}, #000 ${Math.max(0, r - soft).toFixed(2)}%, transparent ${r.toFixed(2)}%)`;
  return { maskImage: g, WebkitMaskImage: g };
}

function diamondClip(e, origin) {
  const r = mix(0, 150, e); // half-diagonal in percent large enough to cover every corner
  const [x, y] = origin.map((v) => v * 100);
  const pts = [[x, y - r], [x + r, y], [x, y + r], [x - r, y]].map(([a, b]) => `${a.toFixed(2)}% ${b.toFixed(2)}%`);
  return { clipPath: `polygon(${pts.join(', ')})` };
}

const originOf = (o) => (Array.isArray(o) ? o : [0.5, 0.5]);

// Zoom through three keyframes (start, middle, end) on a quadratic through them.
function zoomAt(zoom, p) {
  const [a, b, c] = Array.isArray(zoom) && zoom.length === 3 ? zoom : [1, 1, 1];
  return p < 0.5 ? mix(a, b, easeInOut(p * 2)) : mix(b, c, easeInOut((p - 0.5) * 2));
}

const BUILTIN = {
  crossfade: (p) => {
    const e = easeInOut(p);
    return { outgoing: { opacity: 1 - e }, incoming: { opacity: e }, incomingOnTop: true };
  },
  push: (p, { direction = 'left' } = {}) => {
    const e = easeInOut(p);
    const [dx, dy] = dirOf(direction);
    const t = (k) => `translate(${(dx * k).toFixed(3)}%, ${(dy * k).toFixed(3)}%)`;
    return { outgoing: { transform: t(mix(0, 100, e)) }, incoming: { transform: t(mix(-100, 0, e)) }, incomingOnTop: true };
  },
  wipe: (p, { shape = 'line', direction = 'left', softness = 0, origin } = {}) => {
    const e = easeInOut(p);
    const o = originOf(origin);
    const incoming = shape === 'circle' ? circleMask(e, softness, o) : shape === 'diamond' ? diamondClip(e, o) : lineMask(direction, e, softness);
    return { outgoing: {}, incoming, incomingOnTop: true };
  },
  'zoom-through': (p, { origin, scale = ZOOM_THROUGH_SCALE } = {}) => {
    const e = easeInOut(p);
    const o = originOf(origin);
    const at = `${o[0] * 100}% ${o[1] * 100}%`;
    return {
      outgoing: { transform: `scale(${mix(1, scale, e)})`, transformOrigin: at, opacity: clamp(1 - e * 1.6, 0, 1) },
      incoming: { transform: `scale(${mix(1 / scale, 1, e)})`, transformOrigin: at, opacity: clamp((e - 0.25) / 0.75, 0, 1) },
      incomingOnTop: true,
    };
  },
  'whip-pan': (p, { direction = 'left', blur = WHIP_BLUR_PX } = {}) => {
    const e = easeInOut(p);
    const [dx, dy] = dirOf(direction);
    const b = (blur * Math.sin(Math.PI * clamp(p, 0, 1))).toFixed(2);
    const t = (k) => `translate(${(dx * k).toFixed(3)}%, ${(dy * k).toFixed(3)}%)`;
    return {
      outgoing: { transform: t(mix(0, 100, e)), filter: `blur(${b}px)` },
      incoming: { transform: t(mix(-100, 0, e)), filter: `blur(${b}px)` },
      incomingOnTop: true,
    };
  },
  // The outgoing page turns about its hinge edge and uncovers the incoming one beneath.
  'page-flip': (p, { direction = 'left', curl = 0.35 } = {}) => {
    const e = easeInOut(p);
    const left = direction !== 'right';
    const angle = (left ? -1 : 1) * mix(0, 180, e);
    const lift = Math.sin(Math.PI * e);
    return {
      outgoing: {
        transform: `perspective(${PAGE_PERSPECTIVE_PX}px) rotateY(${angle.toFixed(2)}deg) scale(${(1 + 0.04 * curl * lift).toFixed(4)})`,
        transformOrigin: left ? 'left center' : 'right center',
        backfaceVisibility: 'hidden',
        filter: `brightness(${(1 - 0.35 * curl * lift).toFixed(3)})`,
        boxShadow: `0 0 ${(60 * lift).toFixed(1)}px rgba(0,0,0,${(0.45 * lift).toFixed(3)})`,
      },
      incoming: { filter: `brightness(${mix(0.6, 1, e).toFixed(3)})` },
      incomingOnTop: false,
    };
  },
  // Both boards sit on one plane, the incoming one `vector` frames away; the camera travels
  // there and may pull out on the way (zoom keyframes). Scale is about the frame centre.
  'canvas-pan': (p, { vector = [1, 0], zoom = [1, 1, 1], easing = 'inOutCubic' } = {}) => {
    const e = (EASINGS[easing] || easeInOut)(p);
    const z = zoomAt(zoom, clamp(p, 0, 1));
    const [vx, vy] = vector;
    const at = (ox, oy) => `scale(${z.toFixed(4)}) translate(${((ox - vx * e) * 100).toFixed(3)}%, ${((oy - vy * e) * 100).toFixed(3)}%)`;
    return {
      outgoing: { transform: at(0, 0), transformOrigin: '50% 50%' },
      incoming: { transform: at(vx, vy), transformOrigin: '50% 50%' },
      incomingOnTop: true,
    };
  },
  // The incoming card slides over the outgoing one, which sinks back into the stack.
  'slide-stack': (p, { direction = 'left', depth = 0.5 } = {}) => {
    const e = easeInOut(p);
    const [dx, dy] = dirOf(direction);
    const k = mix(100, 0, e);
    return {
      outgoing: { transform: `scale(${(1 - SLIDE_STACK_SHRINK * depth * e).toFixed(4)})`, filter: `brightness(${(1 - 0.4 * depth * e).toFixed(3)})` },
      incoming: { transform: `translate(${(-dx * k).toFixed(3)}%, ${(-dy * k).toFixed(3)}%)`, boxShadow: `0 0 80px rgba(0,0,0,${(0.5 * (1 - e)).toFixed(3)})` },
      incomingOnTop: true,
    };
  },
};

const TABLE = { ...BUILTIN, ...(extraTransitions || {}) };

export const TRANSITION_TYPES = Object.keys(TABLE);

export function transitionStyles(type, progress, params = {}) {
  const fn = TABLE[type];
  if (!fn) return SAME;
  return fn(clamp(Number(progress) || 0, 0, 1), params || {});
}
