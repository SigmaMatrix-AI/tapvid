# Sketches

For the sketch sub-agents of step 5 (one per board). A sketch is the animated storyboard of one media slot:
the user judges from it what the shot will look like, and for `code` slots it **is** the final picture. It is
not "a gradient and a line of text".

## 1. Which slots get one

| Slot | Sketch |
|---|---|
| `ai` with a reference clip | none — the review page plays the reference clip with the replacement notes |
| `ai` without a reference (`mode: text`) | yes: what the prompt will produce |
| `code` | yes: the final picture |
| `user` | none — the user's file is shown |

File: `replicas/<slug>/sketches/<Board>.<path>.jsx` (path as in `media`, e.g. `Demo03.steps.2.screen`); set the
slot's `sketch` to it.

## 2. Contract

- Default export `({ t, duration, Design })`; imports only `react`. It fills its box (`position: absolute;
  inset: 0`, root `containerType: "size"`, geometry in `cqw` / `cqh` of the slot).
- A pure function of `t`: no `Math.random` (hash a seed), no `Date.now`, no CSS animation or transition, no
  effects with timers. SVG, CSS gradients, filters and an inline `<canvas>` drawn from `t` are all fine.
- `duration` = the slot's duration; the motion spans it exactly.
- About 250 lines at most.

## 3. Quality bar

- **The subject is recognisable.** Draw the prompt's subject and its key details: a product's outline,
  material and highlight; a person's pose and facing; an interface's layout. No grey blocks standing in for
  things. When a replacement picture exists (`assets/user/…` or a generated one), put the picture itself into
  the composition (`<image href>` in SVG or `<img>`), cut out with a mask or clip-path where the shot needs it.
- **Space and light.** At least three layers — background, midground, foreground — with depth cues (the far
  layer blurred or lower in contrast). Light from the prompt's direction: shading, a rim light on the subject's
  lit edge, a contact shadow under it.
- **Colour.** The prompt's colours first, then `Design.palette`; it must sit inside its board without clashing.
- **Motion.** The camera follows the prompt or the field's `media.motion`: dolly-in = scale up around the
  subject, pan = translate, orbit = layers moving at different speeds. The subject acts in keyframes (raises a
  hand, turns, steam rises, particles drift). Easing on every move; nothing linear unless it is a drift.
- **Interface slots** (`role: screen`): draw the interface from `product.md` — sidebar or tab bar, real-looking
  data (names, amounts, dates), the element the line talks about clearly visible, maybe highlighted at its cue.
  Usually good enough to stay as the final picture.
- **No captions or labels** in the sketch ("AI video", the prompt): the review page overlays its own badges.

## 4. Self-check

```bash
node "$SKILL_ROOT/scripts/frames.mjs" "$REPLICA" --sketch "$REPLICA/sketches/<file>.jsx" --duration <s>
```

It renders the sketch at 25 %, 50 % and 85 % of its duration. Look at the three frames: rewrite when the
subject is not recognisable, it is only colour fields, the three frames hardly differ, or the motion does not
match the prompt. At most two rounds; then return what is there and name its weak point.

## 5. Worked example

Prompt: "A matte-black smart speaker on a walnut desk by a window, warm late-afternoon light from the right;
the camera slowly pushes in while dust motes drift through the sunbeam." 16:9, 4 s.

```jsx
import React from "react";

// Deterministic helpers.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (p) => { const x = clamp(p, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

// Dust motes: fixed seeds, positions are functions of t only.
const MOTES = Array.from({ length: 28 }, (_, i) => ({
  x: 55 + hash(i) * 40, y: 10 + hash(i + 50) * 70, r: 0.15 + hash(i + 99) * 0.35,
  speed: 0.6 + hash(i + 7) * 1.4, phase: hash(i + 13) * Math.PI * 2,
}));

export default function SpeakerSketch({ t, duration, Design }) {
  const { palette } = Design;
  const p = ease(t / duration);
  const push = 1 + 0.12 * p;                       // camera dolly-in
  const parallax = (k) => `translate(${-k * p}cqw, ${-k * 0.4 * p}cqh)`;
  const glow = 0.85 + 0.15 * Math.sin((t / duration) * Math.PI); // light breathes once

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", containerType: "size", background: "#1b1410" }}>
      <div style={{ position: "absolute", inset: 0, transform: `scale(${push})`, transformOrigin: "58% 62%" }}>
        {/* Background: wall and window, soft and low contrast */}
        <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice"
             style={{ position: "absolute", inset: 0, width: "100%", height: "100%", filter: "blur(0.35cqw)", transform: parallax(0.6) }}>
          <defs>
            <linearGradient id="wall" x1="0" x2="1">
              <stop offset="0" stopColor="#3a2a20" />
              <stop offset="1" stopColor="#7a5a40" />
            </linearGradient>
            <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffd9a0" />
              <stop offset="1" stopColor="#f3a868" />
            </linearGradient>
          </defs>
          <rect width="160" height="90" fill="url(#wall)" />
          <rect x="112" y="6" width="40" height="52" rx="1" fill="url(#sky)" opacity={0.9 * glow} />
          <path d="M132 6 V58 M112 32 H152" stroke="#4a3426" strokeWidth="1.4" />
          {/* Sunbeam falling across the room */}
          <polygon points="112,10 152,10 96,90 40,90" fill="#ffd7a0" opacity={0.16 * glow} />
        </svg>

        {/* Midground: desk with grain and the speaker */}
        <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice"
             style={{ position: "absolute", inset: 0, width: "100%", height: "100%", transform: parallax(1.4) }}>
          <defs>
            <linearGradient id="desk" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#8a5a36" />
              <stop offset="1" stopColor="#4a2e1a" />
            </linearGradient>
            <linearGradient id="body" x1="0" x2="1">
              <stop offset="0" stopColor="#0d0d0f" />
              <stop offset="0.7" stopColor="#1e1e22" />
              <stop offset="1" stopColor="#3a3a40" />
            </linearGradient>
            <radialGradient id="shadow" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0" stopColor="#000" stopOpacity="0.55" />
              <stop offset="1" stopColor="#000" stopOpacity="0" />
            </radialGradient>
            <pattern id="mesh" width="1.2" height="1.2" patternUnits="userSpaceOnUse">
              <circle cx="0.6" cy="0.6" r="0.28" fill="#000" opacity="0.55" />
            </pattern>
          </defs>
          <rect y="60" width="160" height="30" fill="url(#desk)" />
          {[64, 69, 75, 82].map((y, i) => (
            <path key={i} d={`M0 ${y} C40 ${y - 1.2} 90 ${y + 1.4} 160 ${y - 0.6}`} stroke="#5a3a22" strokeWidth="0.3" fill="none" opacity="0.6" />
          ))}
          {/* Contact shadow, cast to the left away from the light */}
          <ellipse cx="88" cy="69.5" rx="15" ry="2.6" fill="url(#shadow)" />
          {/* Speaker: cylinder body, fabric mesh, top cap, rim light on the right */}
          <rect x="80" y="36" width="18" height="33" rx="8" fill="url(#body)" />
          <rect x="80" y="40" width="18" height="26" rx="7" fill="url(#mesh)" />
          <ellipse cx="89" cy="37" rx="9" ry="2.4" fill="#2b2b30" />
          <ellipse cx="89" cy="37" rx="3" ry="0.8" fill={palette.accent} opacity={0.5 + 0.5 * p} />
          <path d="M97.6 39 Q99 52 97.6 66" stroke="#ffcf96" strokeWidth="0.7" fill="none" opacity={0.8 * glow} />
        </svg>

        {/* Foreground: out-of-focus plant leaf on the left edge, moves fastest */}
        <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice"
             style={{ position: "absolute", inset: 0, width: "100%", height: "100%", filter: "blur(0.8cqw)", transform: parallax(3) }}>
          <path d="M-6 90 C10 60 24 48 30 30 C34 52 26 72 8 90 Z" fill="#1f3a22" opacity="0.9" />
          <path d="M-4 90 C4 74 10 66 18 58" stroke="#2f5532" strokeWidth="1.2" fill="none" />
        </svg>

        {/* Dust motes drifting through the beam */}
        <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice"
             style={{ position: "absolute", inset: 0, width: "100%", height: "100%", mixBlendMode: "screen" }}>
          {MOTES.map((m, i) => {
            const y = m.y + ((t * m.speed * 3) % 20) - 10;
            const x = m.x + Math.sin(t * m.speed + m.phase) * 1.5 - (y - m.y) * 0.4;
            return <circle key={i} cx={x} cy={y} r={m.r} fill="#ffe6c0" opacity={0.35 * glow} />;
          })}
        </svg>
      </div>

      {/* Lens vignette */}
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 60% 55%, transparent 55%, rgba(0,0,0,0.55) 100%)" }} />
    </div>
  );
}
```

What makes it pass: the speaker reads as a speaker (cylinder, mesh, cap, status light), the light comes from the
window on the right (rim light, beam, shadow to the left), four depths move at different speeds under one
dolly-in, the motes give the shot life, and every value is a function of `t`.
