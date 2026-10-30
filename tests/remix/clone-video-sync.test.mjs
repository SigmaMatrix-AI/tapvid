import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVideoSync } from '../../skills/remix/assets/template/src/system/videoSync.js';

// A stand-in for an HTMLVideoElement: just the properties and methods videoSync touches.
function fakeVideo({ duration = 2, currentTime = 0, loop = false } = {}) {
  const attrs = loop ? { 'data-loop': '1' } : {};
  const listeners = [];
  return {
    duration, currentTime, paused: true, seeking: false, readyState: 4, playbackRate: 1, preload: '', listeners,
    getAttribute: (k) => attrs[k] ?? null,
    closest: () => null,
    addEventListener: (type) => listeners.push(type),
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    load() {},
  };
}

function mount(videos) {
  globalThis.document = { querySelectorAll: () => videos };
}

afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
});

test('a paused looping video shows scene time modulo its duration', () => {
  const v = fakeVideo({ loop: true });
  mount([v]);
  createVideoSync(() => 5.3).seek();
  assert.ok(Math.abs(v.currentTime - 1.3) < 1e-9, String(v.currentTime));
  assert.equal(v.loop, true);
  assert.equal(v.paused, true);
});

test('frame-accurate rendering keeps its nudge on a looping video', () => {
  globalThis.window = { __tapvidFrameAccurate: true };
  const v = fakeVideo({ loop: true });
  mount([v]);
  createVideoSync(() => 4.5).seek();
  assert.ok(Math.abs(v.currentTime - 0.504) < 1e-9, String(v.currentTime));
});

test('a non-looping video still parks on its last frame', () => {
  const v = fakeVideo();
  mount([v]);
  createVideoSync(() => 5.3).seek();
  assert.equal(v.currentTime, 2);
  assert.equal(v.loop, false);
});

test('before the duration is known a looping video waits for its metadata', () => {
  const v = fakeVideo({ loop: true, duration: NaN, currentTime: 0 });
  mount([v]);
  createVideoSync(() => 5.3).seek();
  assert.equal(v.currentTime, 0);
  assert.ok(v.listeners.includes('loadedmetadata'));
});

test('playing across the loop point is not drift; a real drift seeks inside the loop', () => {
  const wrap = fakeVideo({ loop: true, currentTime: 1.99 });
  mount([wrap]);
  createVideoSync(() => 2.02).play();
  assert.equal(wrap.currentTime, 1.99);
  assert.equal(wrap.paused, false);
  assert.equal(wrap.playbackRate, 1);

  const behind = fakeVideo({ loop: true, currentTime: 0.2 });
  mount([behind]);
  createVideoSync(() => 3.0).play();
  assert.ok(Math.abs(behind.currentTime - 1.0) < 1e-9, String(behind.currentTime));
});
