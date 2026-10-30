// Root timeline player (project mode) — the whole video as ONE compiled page.
//
// A generated `src/index.jsx` imports every composable scene module in order and
// calls mountProject([{ id, Scene, duration }, ...]). This registers
// window.scenePlayer with the TOTAL duration; seekTo(globalSec) selects the active
// scene and renders it at LOCAL time (globalSec - sceneStart). Only the active
// scene mounts, so an N-scene project renders a single scene's tree at a time.
//
// Render is a pure function of the global time, so the renderer's existing
// getDuration()/seekTo()/screenshot contract drives the entire timeline unchanged.
//
// An entry may carry `transition: { type, duration, params }` (template.json transitions).
// The first `transition.duration` seconds of that scene overlap the previous one: both stay
// mounted (the previous one past its own duration, holding its final state) and
// transitions.js styles the two wrappers. Without `transition` the cut is hard.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useClock } from './player.js';
import { transitionStyles } from './transitions.js';
import { preloadFonts } from './fonts.js';

// One scene's render crash must not unmount the whole project tree — without a
// boundary React tears down the root and every later scene shows nothing. The
// boundary confines the damage to the crashing scene's time slot and logs a
// tagged console.error so the renderer's console capture still sees the failure.
class SceneErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.error(`[scene-error] ${this.props.sceneId}: ${String(error)}`);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// Only the active scene mounts, so a scene's <video> is created — and starts
// FETCHING — at the moment of its cut, which shows a blank video band for the
// fetch+decode latency (seconds on a cold cache) and then joins behind the clock.
// Warm every source video up front instead: the bundle is inline in the page, and
// asset URLs are literals in it, so scrape it for video URLs and hold detached
// preloading elements. Detached elements do fetch, but are invisible to the
// video-sync engine's document.querySelectorAll, so they are never play()ed.
// Best-effort by construction: a URL the scrape misses just loads at its cut,
// exactly as before.
const prewarmed = [];
function prewarmSourceVideos() {
  if (prewarmed.length) return;
  const seen = {};
  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    // tapvid: asset paths are relative (build.mjs resolves __ASSET aliases to them).
    const found = (s.textContent || '').match(/["'`]([^"'`\s\\]+\.(?:mp4|webm|mov))["'`]/g) || [];
    for (const quoted of found) {
      const url = quoted.slice(1, -1);
      if (seen[url]) continue;
      seen[url] = true;
      const v = document.createElement('video');
      v.preload = 'auto';
      v.muted = true;
      v.src = url;
      prewarmed.push(v);
    }
  }
}

export function mountProject(scenes) {
  prewarmSourceVideos();
  preloadFonts();
  // Cumulative start offset for each scene; total = sum of durations.
  const starts = [];
  let acc = 0;
  for (const s of scenes) {
    starts.push(acc);
    acc += s.duration || 0;
  }
  const total = acc;

  // Videos in the DOM belong to the one mounted (active) scene, so the video-sync
  // engine needs that scene's LOCAL time, not the global timeline time.
  function localTimeAt(t) {
    let i = 0;
    for (let k = 0; k < scenes.length; k++) {
      if (t >= starts[k]) i = k;
      else break;
    }
    const s = scenes[i];
    return Math.max(0, Math.min(s ? s.duration || 0 : 0, t - (starts[i] || 0)));
  }

  function Project() {
    const t = useClock(total, { localTime: localTimeAt });
    // Active scene = the last one whose start offset is <= t (scenes are ordered).
    let i = 0;
    for (let k = 0; k < scenes.length; k++) {
      if (t >= starts[k]) i = k;
      else break;
    }
    const active = scenes[i];
    if (!active) return null;
    const local = Math.max(0, Math.min(active.duration || 0, t - starts[i]));
    const tr = active.transition;
    const overlap = i > 0 && tr && tr.duration > 0 && local < tr.duration;
    // Each scene sits in a full-canvas wrapper keyed by its id, so the incoming scene
    // keeps its subtree (and its <video>) when the overlap ends. `key` per scene id
    // still gives every scene a fresh subtree and error boundary at its cut.
    const layer = (scene, sceneLocal, offset, style) => React.createElement(
      'div',
      { key: scene.id, 'data-time-offset': offset, style: { position: 'absolute', inset: 0, ...style } },
      React.createElement(
        SceneErrorBoundary,
        { sceneId: scene.id },
        React.createElement(scene.Scene, { t: sceneLocal }),
      ),
    );
    const stage = { position: 'relative', width: '100%', height: '100%', overflow: 'hidden' };
    if (!overlap) return React.createElement('div', { style: stage }, [layer(active, local, 0, null)]);
    const prev = scenes[i - 1];
    const lead = starts[i] - starts[i - 1];
    const s = transitionStyles(tr.type, local / tr.duration, tr.params);
    // Children keep timeline order (no DOM moves, which would interrupt a <video>);
    // stacking comes from zIndex.
    const out = layer(prev, local + lead, lead, { ...s.outgoing, zIndex: s.incomingOnTop ? 1 : 2 });
    const inc = layer(active, local, 0, { ...s.incoming, zIndex: s.incomingOnTop ? 2 : 1 });
    return React.createElement('div', { style: stage }, [out, inc]);
  }

  createRoot(document.getElementById('root')).render(React.createElement(Project));
}
