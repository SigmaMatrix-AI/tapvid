// Shared deterministic clock — the single source of the renderer contract.
//
// The renderer calls window.scenePlayer.getDuration() then seekTo(sec) then
// screenshots. `useClock(duration)` returns the current time and registers
// window.scenePlayer so that contract is IDENTICAL whether it drives one
// standalone scene (eval) or a whole-project timeline (final index.html). The
// caller renders as a PURE FUNCTION of the returned value — no wall-clock — so
// seek-to-frame is deterministic. play()/pause() drive an rAF loop for live
// preview only. Not authored by the LLM: one canonical copy guarantees every
// build gets the correct player contract.
//
// Any <video> a scene renders (source-video enhancement) is driven from the same
// bridge by the engineered videoSync engine: play/pause/seekTo keep the element on
// the host clock, and setRate lets the host declare 0.5x/2x instead of scrubbing.
// `opts.localTime` maps the clock's (global) time to the mounted scene's local
// time — identity for a standalone scene, timeline-offset for the whole project —
// because the videos in the DOM always belong to the currently mounted scene.
import React from 'react';
import { createVideoSync } from './videoSync.js';

export function useClock(duration, opts) {
  const [t, setT] = React.useState(0);
  const tRef = React.useRef(0);
  const rafRef = React.useRef(0);
  const playing = React.useRef(false);
  const localTime = (opts && opts.localTime) || null;

  React.useEffect(() => {
    const toLocal = localTime || ((x) => x);
    const sync = createVideoSync(() => toLocal(tRef.current));
    const set = (v) => {
      const clamped = Math.max(0, Math.min(duration, v));
      tRef.current = clamped;
      setT(clamped);
    };
    // `playing` is the host's INTENT (play() was called, pause() wasn't);
    // `running` is whether the rAF loop is scheduled. They part ways at the end
    // of the timeline: the loop stops itself there but the intent stands, so a
    // later seek back into range resumes without a fresh play() call.
    let last = 0;
    let running = false;
    const loop = (now) => {
      if (!playing.current) { running = false; return; }
      if (last) set(tRef.current + (now - last) / 1000);
      last = now;
      sync.tick();
      if (tRef.current >= duration) { running = false; sync.pause(); return; }
      rafRef.current = requestAnimationFrame(loop);
    };
    const ensureLoop = () => {
      if (running) return;
      running = true;
      last = 0;
      rafRef.current = requestAnimationFrame(loop);
    };
    window.scenePlayer = {
      play() {
        playing.current = true;
        ensureLoop();
        sync.play();
      },
      pause() {
        playing.current = false;
        running = false;
        cancelAnimationFrame(rafRef.current);
        sync.pause();
      },
      // Seek preserves the play state. The renderer and the recorder only seek
      // while stopped, but the live preview seeks DURING playback (progress-bar
      // click) and never re-issues play() — its post-seek kick deliberately
      // skips a clock parked at non-zero time. Stopping here therefore froze
      // the clock after every mid-playback seek: the scene held one frame
      // while the videoSync engine, still told the host was playing, ran the
      // <video> ahead and yanked it back on every correction.
      seekTo(sec) {
        set(sec);
        sync.seek();
        if (playing.current && tRef.current < duration) {
          const wasRunning = running;
          ensureLoop();
          // The loop had parked at the timeline end and sync.pause()d the
          // videos — re-arm them along with the clock.
          if (!wasRunning) sync.play();
        }
      },
      setRate(r) { sync.setRate(r); },
      getDuration() { return duration; },
      getCurrentTime() { return tRef.current; },
    };
    sync.start();
    return () => { cancelAnimationFrame(rafRef.current); sync.dispose(); };
  }, [duration]);

  return t;
}
