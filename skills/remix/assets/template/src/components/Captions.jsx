// Caption overlay for narration mode (spec §8). project.mjs mounts it above the board when
// replica.audio.captions is set, with words timed in scene seconds: real word timestamps from
// the speech provider, or a character-weighted split of the line (timing.mjs / preview).
// `variant` is the caption style name; "word-highlight" lights the spoken word, "creator" is the
// plate-less talking-head style (a few white words fading in as spoken), anything else shows the
// phrase plainly. Pure function of t.
// Every style reads the original's measured look from the optional `Design.captions` tokens
// (design.js): maxChars (phrase length), centerY (% of the height the line is centred on; unset =
// the plate styles' bottom band), size (% of the height), weight, plate (dark rounded plate behind
// the words), uppercase, wordIn ('fade' = each word fades in on its start, 'none' = the phrase shows
// whole) and wordFadeS. A token left out keeps the style's default below, so a design.js without
// `captions` renders as before. `style` in the tokens is the recommended style name; the drawn
// style is always `variant` (replica.audio.captions).
import React from 'react';

// Plate styles: a phrase holds at most 28 characters, two short lines at 4.2 % of the height, bold,
// on the plate, its bottom 7 % above the frame's bottom edge.
const PLATE = { maxChars: 28, centerY: null, size: 4.2, weight: 700, plate: true, uppercase: false, wordIn: 'none', wordFadeS: 0.08 };
const FADE_S = 0.12;
// "creator": measured on talking-head originals — 2–3 words (≤ 16 chars) at 77.8 % of the height,
// 2.65 % tall white semibold type with a soft shadow, each word fading in over 0.08 s on its start.
const CREATOR = { maxChars: 16, centerY: 77.8, size: 2.65, weight: 600, plate: false, uppercase: false, wordIn: 'fade', wordFadeS: 0.08 };
const PLATE_STYLE = { background: 'rgba(0,0,0,0.55)', borderRadius: '1.2cqh', padding: '1cqh 2cqw' };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function phrases(words, maxChars) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const w of words) {
    if (cur.length && len + w.text.length > maxChars) { out.push(cur); cur = []; len = 0; }
    cur.push(w);
    len += w.text.length;
  }
  if (cur.length) out.push(cur);
  return out.map((ws) => ({ words: ws, start: ws[0].start, end: ws[ws.length - 1].end }));
}

export function Captions({ t, words, variant, Design }) {
  if (!words || !words.length) return null;
  if (variant === 'creator') return <CreatorCaptions t={t} words={words} Design={Design} />;
  const c = { ...PLATE, ...Design.captions };
  const group = phrases(words, c.maxChars).find((g) => t >= g.start - FADE_S && t < g.end + FADE_S);
  if (!group) return null;
  const a = Math.min(clamp((t - (group.start - FADE_S)) / FADE_S, 0, 1), clamp((group.end + FADE_S - t) / FADE_S, 0, 1));
  const { palette, font } = Design;
  const spaced = !/[　-鿿]/.test(group.words.map((w) => w.text).join(''));
  const at = c.centerY == null ? { bottom: '7cqh' } : { top: `${c.centerY}cqh`, transform: 'translateY(-50%)' };
  return (
    <div style={{ position: 'absolute', left: '10cqw', right: '10cqw', ...at, display: 'flex', justifyContent: 'center', pointerEvents: 'none', opacity: a }}>
      <div data-part="Captions" style={{ ...(c.plate ? PLATE_STYLE : {}), fontFamily: font, fontSize: `${c.size}cqh`, fontWeight: c.weight, lineHeight: 1.3, textAlign: 'center',
        textTransform: c.uppercase ? 'uppercase' : undefined, color: palette.fg || '#fff' }}>
        {group.words.map((w, i) => {
          const lit = variant === 'word-highlight' && t >= w.start;
          return (
            <span key={i} style={{ color: lit ? palette.accent || palette.primary : undefined, opacity: wordOpacity(c, t, w) }}>
              {w.text}{spaced && i < group.words.length - 1 ? ' ' : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// Per-word entrance: 'fade' ramps each word in over wordFadeS from its start; 'none' leaves it to the phrase.
function wordOpacity(c, t, w) {
  return c.wordIn === 'fade' ? clamp((t - w.start) / c.wordFadeS, 0, 1) : undefined;
}

function CreatorCaptions({ t, words, Design }) {
  const c = { ...CREATOR, ...Design.captions };
  const group = phrases(words, c.maxChars).find((g) => t >= g.start && t < g.end + FADE_S);
  if (!group) return null;
  const out = clamp((group.end + FADE_S - t) / FADE_S, 0, 1);
  const spaced = !/[　-鿿]/.test(group.words.map((w) => w.text).join(''));
  return (
    <div style={{ position: 'absolute', left: '8cqw', right: '8cqw', top: `${c.centerY ?? CREATOR.centerY}cqh`, transform: 'translateY(-50%)',
      display: 'flex', justifyContent: 'center', pointerEvents: 'none', opacity: out }}>
      <div data-part="Captions" style={{ ...(c.plate ? PLATE_STYLE : {}), fontFamily: Design.font, fontSize: `${c.size}cqh`, fontWeight: c.weight, lineHeight: 1.25, textAlign: 'center',
        textTransform: c.uppercase ? 'uppercase' : undefined, color: Design.palette.fg || '#fff', textShadow: `0 0.15cqh 0.6cqh ${Design.palette.shadow || 'rgba(0,0,0,0.5)'}` }}>
        {group.words.map((w, i) => (
          <span key={i} style={{ opacity: wordOpacity(c, t, w) }}>
            {w.text}{spaced && i < group.words.length - 1 ? ' ' : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

export default Captions;
