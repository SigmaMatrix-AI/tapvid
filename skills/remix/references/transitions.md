# Transitions

For the main agent, step 3.3: measure every board boundary of the original and write the transition table
into `template/template.json`. Boards do not draw transitions; the render project's
`src/system/transitions.js` does.

## 1. The table

```json
"transitions": [
  { "from": "Hook01", "to": "Problem02", "type": "page-flip", "duration": 0.533,
    "params": { "direction": "left", "curl": 0.35 } },
  { "from": "Problem02", "to": "Demo03", "type": "canvas-pan", "duration": 0.8,
    "params": { "vector": [1, 0], "zoom": [1, 0.85, 1], "easing": "inOutCubic" } }
]
```

- One entry per boundary that has a transition; a boundary not listed is a hard cut.
- `duration` = the soft window's length in `source/timeline.json` (`transition_out.end − transition_out.start`
  of the outgoing shot), rounded to whole frames (`round(d × fps) / fps`).
- A replica keeps the template's table; when a replica changes a list count so that a board repeats, the
  entry between two instances of the same board is the one the original used between its repeats, else a cut.

## 2. How it runs

- During the overlap both boards are mounted, each in a full-canvas wrapper, and
  `transitionStyles(type, progress, params)` returns `{ outgoing, incoming, incomingOnTop }` — CSS for the two
  wrappers and the stacking order — for `progress ∈ [0, 1]`.
- The overlap is the first `duration` seconds of the incoming scene; the outgoing scene keeps rendering past
  its own end, holding its final state. Total length does not grow.
- It is a pure function of `progress`; no timers, no CSS transitions. Videos in the outgoing wrapper stay in
  sync; a clip that ends holds its last frame, so a video slot on an outgoing edge must cover its scene plus
  the overlap.
- Board rule: on a transition edge the board's frame is complete and still at `t = 0` / `t = duration`
  (`references/boards.md` §2). Narration never runs inside the overlap — the incoming line starts after it,
  the outgoing line ends before it.

## 3. The library

| `type` | Effect | Params (defaults) |
|---|---|---|
| `crossfade` | dissolve | — |
| `push` | the incoming frame pushes the outgoing one off | `direction`: `left` / `right` / `up` / `down` — the way the content travels (`left`) |
| `wipe` | a mask edge reveals the incoming frame over the still outgoing one | `shape`: `line` / `circle` / `diamond` (`line`); `direction` for `line` (`left`); `softness` 0–1, the feathered edge's width (0); `origin` `[x, y]` in 0–1 for `circle` / `diamond` (`[0.5, 0.5]`) |
| `zoom-through` | the outgoing frame grows from a point and fades, the incoming one settles from small | `origin` `[x, y]` (`[0.5, 0.5]`); `scale` peak scale of the outgoing frame (1.6) |
| `whip-pan` | fast push with motion blur peaking mid-way | `direction` (`left`); `blur` peak blur in px (24) |
| `page-flip` | the outgoing page turns about its hinge edge in 3-D and uncovers the incoming one beneath | `direction`: `left` (hinge on the left edge) / `right`; `curl` 0–1, how much the page lifts, darkens and casts shadow mid-turn (0.35) |
| `canvas-pan` | both boards sit side by side on one plane; the camera travels from one to the other, optionally pulling out mid-way | `vector` `[dx, dy]` in frame widths / heights (`[1, 0]` = B is to the right of A); `zoom` `[start, mid, end]` (`[1, 1, 1]`); `easing`: `linear` / `inCubic` / `outCubic` / `inOutCubic` / `inOutSine` (`inOutCubic`) |
| `slide-stack` | the incoming card slides in on top, the outgoing one sinks back (shrinks up to 12 % and darkens) | `direction` the incoming card travels (`left`); `depth` 0–1 (0.5) |

Every type except `canvas-pan` runs on an in-out cubic; a different curve means a new type (§5).

## 4. Measuring a boundary

Start from `timeline.json`: a shot whose `transition_out` is `soft` gives the window; a hard cut has none.
Then read the window's frames (the strip contains its start, middle and end; grab more frame-exactly with
`select=eq(n\,N)`) and decide by what moves:

| What the frames show | Type | How to read the params |
|---|---|---|
| Both images visible, partly transparent, neither moves | `crossfade` | — |
| Both images move together in one direction, edge to edge, no gap | `push` | `direction` from the edge's travel |
| One image stays still, a hard or feathered edge uncovers the other | `wipe` | `shape` from the edge's form at mid-window; `softness` ≈ feather width / (0.4 × frame width) for a line, / (0.3 × frame diagonal) for a circle; for circle / diamond, `origin` = the shape's centre at its smallest |
| The outgoing image grows past the frame from one point, then the incoming one settles from slightly small | `zoom-through` | `origin` = the fixed point of the growth (where two frames' features line up); `scale` = outgoing scale at the frame where the incoming one first shows |
| A horizontal / vertical smear over a few frames | `whip-pan` | `direction` from the smear; `blur` from the smear length at mid-window (px at canvas size) |
| A page bends with perspective and a shading gradient along a fold | `page-flip` | `direction` from the hinge edge; `curl` from the fold's bend at mid-window (flat page 0, half-rolled 0.5) |
| Both boards visible at once side by side, the camera travelling across, often smaller mid-way | `canvas-pan` | `vector` from the travel direction and distance in frame sizes; `zoom` from the frame scale at start / middle / end (measure a known element's width); `easing` from the per-frame position table |
| The incoming card covers the outgoing one, which shrinks or darkens behind | `slide-stack` | `direction` of the incoming card; `depth` = (1 − outgoing scale at the end) / 0.12 |

For any moving edge or element, track its position per frame across the window and compare the normalised
progress with the in-out cubic (or, for `canvas-pan`, the easings above); when none fits, write the measured
curve into a new type (§5). The midpoint of the progress must
land on the same frame as in the original — `compare.mjs --timing` checks it to one frame.

When both sides' content moves continuously across the boundary (an element travels from its place in A to its
place in B), it is not a transition: merge the two boards (`references/boards.md` §1).

## 5. A type the library does not have

Write it in the template, so the template keeps working when reused: `template/transitions.js`, exporting
`extraTransitions`. Building a render project copies it over `src/system/transitions.extra.js`; its types are
merged over the built-in ones (same name = yours wins), so a modified built-in also goes here.

```js
// template/transitions.js — extension types for this template. Pure functions of progress.
const clamp = (v) => Math.min(1, Math.max(0, v));
const inOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

export const extraTransitions = {
  // Venetian blinds: the incoming frame appears through `slats` horizontal bands that open in turn.
  blinds: (progress, { slats = 8, stagger = 0.4 } = {}) => {
    // One mask layer per slat; each opens downward, the next starting `stagger / slats` later.
    const layers = Array.from({ length: slats }, (_, i) => {
      const local = clamp((progress - (i / slats) * stagger) / (1 - stagger));
      const a = (100 / slats) * i;
      const b = a + (100 / slats) * inOutCubic(local);
      return `linear-gradient(to bottom, transparent ${a}%, #000 ${a}%, #000 ${b}%, transparent ${b}%)`;
    }).join(',');
    return { outgoing: {}, incoming: { WebkitMaskImage: layers, maskImage: layers }, incomingOnTop: true };
  },
};
```

Rules for a new type:

- Signature `(progress, params) => ({ outgoing, incoming, incomingOnTop })`; `progress` arrives clamped to
  `[0, 1]`; return plain CSS objects (transform, opacity, filter, clip-path, mask) for the two wrappers.
- At `progress = 0` the outgoing wrapper looks untouched and the incoming one is invisible or off-frame; at
  `progress = 1` the reverse. No DOM changes, no timers, no randomness.
- Percent translations are relative to the full canvas. 3-D effects set `perspective` on the wrapper's own
  transform (`perspective(1600px) rotateY(…)`), and `backfaceVisibility: 'hidden'`.
- Name it in kebab-case, document its params in a comment, use it in the table like a built-in type, and
  confirm it on both boards' compare rows (`compare.mjs --only <Name>` for each side) and with `--timing`.

## 6. Choosing when the original is ambiguous

- Prefer the simplest type that scores: a crossfade that matches beats a page flip that almost does.
- A transition that recurs in the original keeps the same type and params everywhere; do not vary it.
- Keep `duration` ≤ 25 % of the shorter of the two scenes after a replica re-times them; when a narrated
  scene gets shorter than four times its overlap, lengthen its line rather than shorten the transition.
