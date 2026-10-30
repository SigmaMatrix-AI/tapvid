// Entry of a board's single-file page (board-page.mjs fills the __PLACEHOLDERS__). The page
// renders the board as a pure function of `t`, driven by window.scenePlayer like a scene page.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Design } from './design.js';
import { __NAME__ } from './boards/__NAME__.jsx';

const DURATION = __DURATION__;
const PROPS = __PROPS__;
const MEDIA = __MEDIA__;

const clampT = (v) => Math.max(0, Math.min(DURATION, v));
const initialT = () => {
  const q = parseFloat(new URLSearchParams(window.location.search).get('t'));
  return Number.isFinite(q) ? clampT(q * DURATION) : 0;
};

function seekVideos(t) {
  for (const v of document.querySelectorAll('#root video')) {
    const want = Math.max(0, t + (parseFloat(v.dataset.offset) || 0));
    if (Math.abs(v.currentTime - want) > 0.001) v.currentTime = want;
  }
}

function useClock() {
  const [t, setT] = React.useState(initialT);
  const tRef = React.useRef(t);
  React.useEffect(() => {
    let playing = false;
    let raf = 0;
    let last = 0;
    const set = (v) => { tRef.current = clampT(v); setT(tRef.current); };
    const videos = () => Array.from(document.querySelectorAll('#root video'));
    const loop = (now) => {
      if (!playing) return;
      if (last) set(tRef.current + (now - last) / 1000);
      last = now;
      if (tRef.current >= DURATION) { playing = false; videos().forEach((v) => v.pause()); return; }
      raf = requestAnimationFrame(loop);
    };
    window.scenePlayer = {
      play() { playing = true; last = 0; raf = requestAnimationFrame(loop); videos().forEach((v) => v.play().catch(() => {})); },
      pause() { playing = false; cancelAnimationFrame(raf); videos().forEach((v) => v.pause()); seekVideos(tRef.current); },
      seekTo(sec) { set(sec); seekVideos(tRef.current); },
      getDuration() { return DURATION; },
      getCurrentTime() { return tRef.current; },
    };
    seekVideos(tRef.current);
    return () => cancelAnimationFrame(raf);
  }, []);
  return t;
}

const FILL = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' };

function mediaElement(key, m) {
  if (m.kind === 'image') return <img data-field={key} src={m.src} alt="" style={FILL} />;
  return <video data-field={key} src={m.src} muted playsInline preload="auto" data-offset={m.offset || 0} style={FILL} />;
}

// A media key is a path into the props: `cover`, or `steps.1.screen` inside list item 1. A path
// whose list item the props do not have is skipped, so a slot never invents an item.
function setIn(obj, [head, ...rest], value) {
  if (Array.isArray(obj)) {
    const i = Number(head);
    if (!/^(0|[1-9][0-9]*)$/.test(head) || i >= obj.length) return obj;
    const copy = obj.slice();
    copy[i] = rest.length ? setIn(obj[i], rest, value) : value;
    return copy;
  }
  if (!obj || typeof obj !== 'object' || (rest.length && !(head in obj))) return obj;
  return { ...obj, [head]: rest.length ? setIn(obj[head], rest, value) : value };
}

const FILLED = Object.entries(MEDIA).reduce((props, [key, m]) => setIn(props, key.split('.'), mediaElement(key, m)), PROPS);

function Page() {
  const t = useClock();
  React.useEffect(() => seekVideos(t), [t]);
  return <__NAME__ {...FILLED} t={t} duration={DURATION} Design={Design} />;
}

createRoot(document.getElementById('root')).render(<Page />);
