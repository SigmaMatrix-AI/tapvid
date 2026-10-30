import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSITION_TYPES, transitionStyles } from '../../skills/remix/assets/template/src/system/transitions.js';

const SPEC_TYPES = ['crossfade', 'push', 'wipe', 'zoom-through', 'whip-pan', 'page-flip', 'canvas-pan', 'slide-stack'];
const PARAMS = {
  push: { direction: 'up' },
  wipe: { shape: 'circle', direction: 'left', softness: 0.3 },
  'zoom-through': { origin: [0.3, 0.6], scale: 2 },
  'whip-pan': { direction: 'right', blur: 30 },
  'page-flip': { direction: 'left', curl: 0.35 },
  'canvas-pan': { vector: [1, 0], zoom: [1, 0.85, 1], easing: 'inOutCubic' },
  'slide-stack': { direction: 'left', depth: 0.5 },
};

test('every spec transition type is in the library', () => {
  for (const t of SPEC_TYPES) assert.ok(TRANSITION_TYPES.includes(t), t);
});

test('transitions are pure functions of progress and params', () => {
  for (const type of TRANSITION_TYPES) {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const a = transitionStyles(type, p, PARAMS[type]);
      assert.deepEqual(a, transitionStyles(type, p, PARAMS[type]), `${type}@${p}`);
      assert.deepEqual(JSON.parse(JSON.stringify(a)), a, `${type}@${p} serialisable`);
      assert.equal(typeof a.incomingOnTop, 'boolean');
    }
    assert.notDeepEqual(transitionStyles(type, 0, PARAMS[type]), transitionStyles(type, 1, PARAMS[type]), `${type} moves`);
    assert.deepEqual(transitionStyles(type, -1, PARAMS[type]), transitionStyles(type, 0, PARAMS[type]), `${type} clamps low`);
    assert.deepEqual(transitionStyles(type, 2, PARAMS[type]), transitionStyles(type, 1, PARAMS[type]), `${type} clamps high`);
  }
});

test('end states show the incoming board in place', () => {
  assert.equal(transitionStyles('crossfade', 1).incoming.opacity, 1);
  assert.match(transitionStyles('push', 1, { direction: 'left' }).incoming.transform, /translate\(0\.000%, 0\.000%\)|translate\(-?0\.000%, -?0\.000%\)/);
  assert.match(transitionStyles('canvas-pan', 1, PARAMS['canvas-pan']).incoming.transform, /scale\(1\.0000\) translate\(0\.000%, 0\.000%\)/);
  assert.match(transitionStyles('page-flip', 1, PARAMS['page-flip']).outgoing.transform, /rotateY\(-180\.00deg\)/);
  assert.match(transitionStyles('canvas-pan', 0.5, PARAMS['canvas-pan']).incoming.transform, /scale\(0\.8500\)/);
  assert.match(transitionStyles('wipe', 0.5, { shape: 'diamond' }).incoming.clipPath, /^polygon\(/);
  assert.match(transitionStyles('wipe', 0.5, { shape: 'line', softness: 0.5 }).incoming.maskImage, /linear-gradient/);
});

test('unknown types cut', () => {
  assert.deepEqual(transitionStyles('nope', 0.5), { outgoing: {}, incoming: {}, incomingOnTop: true });
});
