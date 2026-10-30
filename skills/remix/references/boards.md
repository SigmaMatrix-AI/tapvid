# Boards

For the main agent (split, `design.js`, fonts, the sub-agent brief) and for each board sub-agent (the rest).
A board is a single-file React component that redraws one layout system of the original from parameters.

## 1. How many boards

**One board per layout system, not per shot.** The count follows the film's structure — one, or dozens.

| The original | Split |
|---|---|
| One continuous take, an infinite canvas, one shared world the camera travels over | **One segmented board** for the whole film: one segment per content node; elements, copy, media and the camera path are all parameters (lists) |
| Consecutive shots with the same layout and different content (three features, five reviews) | One board with a list field, or one board repeated as several scenes |
| A layout that returns after another one (A, B, A) | One board per window, the later ones copies of the first under their own names (`references/analysis.md` §8); written together, by one sub-agent when there are sub-agents |
| Sections with different layouts, hard cuts between them | One board each |
| Sections with different layouts and a designed transition between them (page flip, zoom-through, mask wipe, whip pan, canvas pan) | One board each; the transition goes into the transition table (`references/transitions.md`) |
| A transition that depends on content moving continuously across it (an element flying from its place in A to its place in B, one object running through both sections) | **Merge into one segmented board**: a transition between boards moves whole frames and cannot carry element-level continuity |

The test: any instant of the original can be rebuilt from "the board it falls in + its parameters + the
transition". Write the split and one reason per boundary into `report.md`.

Naming: `<Function><NN>` in scene order (`Hook01`, `Problem02`, `Demo03`). The name is the file name and the
exported function. Record each board's layering tier in `report.md`:

| Tier | When | Shape |
|---|---|---|
| All code | rendered graphics only | everything drawn, no media field |
| Code + slot | a live region (presenter, screen recording, photo) or a product surface inside a drawn frame | the drawn part in code, the live region one `image` / `video` field |
| Full-frame media | the whole board is footage with no recoverable skeleton | one canvas-filling `video` field, `media.role: broll`, its `desc` precise enough to generate the footage from |

## 2. Hard rules (`validate.mjs template` checks each)

- One file, `import React from "react"` and nothing else. Easing helpers and sub-components are inlined per
  board; there is no shared module in the template.
- Exactly one export, named like the file: `export function Hook01({ t, duration, segments, Design, ...props })`.
- `t` is scene time in seconds and the frame is a pure function of it: no `Math.random` (use a seeded hash),
  no `Date.now`, no CSS transitions or animations, no timers, no own clock. Seeking to `t` always gives the
  same frame.
- Unsegmented board: every time is a fraction of `duration`. Segmented board: elements are timed in seconds
  from their segment's `start`, found by key (`segments.find(s => s.key === "points.1.say")`); `duration` still
  spans the whole scene. Never seconds from the scene's start.
- Geometry in `cqw` / `cqh` only, on a root with `containerType: "size"`. Measure in source pixels, divide by
  the source width / height.
- Colours and fonts only from `Design` (`const { palette, font, fontHead } = Design`); no hex in a board.
- Arrays set the element count: any count from `minItems` to `maxItems` neither overflows, overlaps nor leaves
  a hole (`references/analysis.md` §6 for the source table and the re-flow rule).
- `image` / `video` fields arrive as ready `<img>` / `<video>` elements: the board positions and crops them
  (`React.cloneElement(cover, { style: { width: "100%", height: "100%", objectFit: "cover" } })`) and never
  builds its own. `element` fields arrive as a React element and are rendered as given.
- A missing prop draws nothing — never a fallback copied from the source.
- **Boundaries.** Where the transition table declares a transition, the board does no entrance or exit on
  that side: the frame at `t = 0` (incoming side) or `t = duration` (outgoing side) is complete and still, and
  the transition does the handoff. At a hard-cut boundary the board carries its own entrance and exit, as the
  original does.
- **Elements replay their measurements** (`analysis/elements.json`): an instance with its own box gets its own
  box (a `SOURCE` table of measured boxes per instance in the board, keyed by list index, with a rule for indices
  past the source's count); images keep their own aspect inside it.
- **Idle motion is a function of `t` too.** Boil: `pose = Math.floor(t * posesPerS)`, every offset, angle and
  scrap shape from a seeded hash of `(pose, part)` — still between poses, as measured. Drift / sway / pulse:
  smooth functions of `t` with the measured amplitude and period.
- **Sound effects ride on elements.** The element whose entrance makes the sound carries
  `data-sfx="<kind>"` (optional `data-sfx-gain`, linear, default 1). The cue fires on the first frame it is
  visible, in the preview and the render, so it follows any re-timing; never author cue times.
- Code-drawn components carry `data-part="<short English noun>"` (`Title card`, `Sticker`, `Badge`, `Icon`,
  `Heading`, `Step number`, `Screen card`, `Call to action`) so the review page frames and labels them; the
  page translates the common names when the viewer switches it to Chinese.

## 3. Fields: `boards/<Name>.json`

- `schema.fields[]`: `key`, `type` (`string` / `number` / `string[]` / `image` / `video` / `object` /
  `object[]` / `narration` / `element`), `required`, `maxChars` / `minItems` / `maxItems`, a mandatory `desc`,
  optional `tiedTo`. A good `desc` says what the field is on screen, how to write it, and the hard limits — not
  "Small line above the headline" but "One short line above the headline framing the demo's audience; neutral
  tone, no product name, ≤40 chars". Every field maps to one region role (`references/analysis.md` §5).
- `tiedTo: "<media key>"` on an optional field whose value only describes that one picture (a focus box, the
  point a cursor taps), in 0–1 fractions of the image, origin top-left. The board draws something sensible
  without it.
- `media` on every `image` / `video` field: `role` (`presenter` / `broll` / `screen`), `aspect`, `minWidthPx`
  (the widest the board ever draws it on the 1920 canvas, pushes included, × 1.5, capped at 2880); for video
  also `motion` (the camera and subject motion in words), `firstFrame` when the first frame matters, and
  `loop: true` for a GIF-like loop (the player repeats it for as long as the slot shows). A presenter field
  also records `headTop`: the host's head top in % of the height at rest, so a replacement portrait can be
  reframed to it. `cutout: true` when an element sits behind the person in this clip (§8). A picture that
  moves in the original (`elements.json` `content` other than `still`) is a
  `video` field. The
  `desc` of a media field describes only the picture — subject, framing, light, what stays stable, what must
  not appear — in the register a generation prompt wants.
- A presenter is a top-level `video` field keyed `presenter`, `role: presenter`, only on the boards where one
  appears; those boards have `maxDuration` ≤ 30.
- `element` only for content whose form changes with the topic (a chart in one video, a process flow in the
  next). Anything describable exactly is a plain field the board draws: an icon is a `string` naming one of a
  fixed icon set the board carries, a chart of known form is `number[]` / `object[]` data. An `element` is
  top-level, has no `media` and no `example_data` value; its `desc` says where it sits, how big, what suits the
  place, the palette and areas to keep clear.
- `meta`: `displays`, `useWhen[]` / `dontUseWhen[]` (English; `dontUseWhen` names the most similar board),
  `minDuration` / `maxDuration`, `durationModel` (`"segments"` exactly when the schema has `narration` fields),
  optional `motion` (§6), and `captions` when the template has captions (below).
- `meta.captions` is part of the layout, decided while building the board from what the original shows over
  it: `true` (the template's captions, `Design.captions`), `false` (none — e.g. a hook whose kinetic title
  is the spoken line), or an object: `off` lists the narration fields during which no captions show (a title
  card that says its own line: `["say"]`, `["steps.title"]`), and any `Design.captions` token (`centerY`,
  `size`, `maxChars` …) restyles captions on this board only (a full-frame layout whose captions sit lower than
  on the split layout). Preview and final cut both follow it; never patch the generated project instead.
- Examples: `example_data` (the source's own content, valid against the schema), `example_narration`,
  `example_segments` (segmented boards), `example_duration_ms` and `preview_t` (a fraction 0–1 of the board: the moment the entrance is done
  and the exit not started — set per board from its motion; 1.0 is usually mid-exit). `build-boards.mjs`
  writes `example_duration_ms` and the `.mp3` / `.html` / `.png`.

## 4. Text boxes are sized by the space

Measure the source's text for font size, line pitch and anchor — never for the box width. Chinese runs about
twice as wide per character as English at the same size, so a box fitted to the source's English breaks a
short Chinese title while half the canvas is empty.

- **Width is the free region**: from the anchor to the nearest thing the text must not cover (a presenter, a
  card edge, a badge, another block) or to the source's outer margin. Comment where each width comes from.
- **Fill the region, keep the source's line count**; wrap only when the whole region is used. Small fields
  too: a card's title spans the card's inner width.
- **Breaking**: sentences start on their own line after `.!?` and `。！？`; multi-line titles get
  `textWrap: "balance"`; `lineBreak: "strict"` so CJK punctuation never starts a line. An explicit break is a
  `string[]` item, never `\n`.
- **Overflow**: step the size down (floor ~75 % of the source's) before the box grows, derived from the value's
  length so the frame stays a pure function of the props; per-character widths come from the template's own
  fonts.
- When the source breaks a line where the wider box would not, `example_data` carries the break as separate
  items.

## 5. `template/design.js` and fonts

One palette and font set for the whole template, measured from the original:

```js
export const Design = {
  palette: { bg: '#0F1115', surface: '#1A1D24', fg: '#F2F4F8', muted: '#8A93A6', primary: '#4F7CFF', accent: '#FFB547' },
  font: "'Inter', system-ui, sans-serif",
  fontHead: "'Inter', system-ui, sans-serif",
  space: 8,
  radius: 12,
};
export default Design;
```

No imports, a literal only. Measure the background per scene before choosing `bg` (lifted blacks are common).
Name keys by use (`bg`, `surface`, `fg`, `primary`, `accent`, `paper`, `ink`), not by colour.

A family name is not a font: the render machine has none of the author's fonts. Fetch every family and every
weight the boards use (`grep -ho 'fontWeight: *[0-9]*' template/boards/*.jsx` lists them):

```bash
node "$SKILL_ROOT/scripts/fonts.mjs" "$PROJECT" --family "Inter" --weights 400,700
node "$SKILL_ROOT/scripts/fonts.mjs" "$PROJECT" --family "Proxima Nova" --weights 400,700 --substitute
```

Only OFL / Apache families are downloaded (`template/fonts/<Family>-<weight>.woff2`, recorded in
`fonts.json`). `--substitute` picks the nearest open family for a licensed face and prints the swap — point
`design.js` at the shipped family and write the swap into `report.md`. Identify the source font from measured
proportions (width per height at a known size), not by eye; when a substitute tracks wider, correct with one
`scaleX` factor measured on a rendered line.

## 6. Segmented boards and motion lists

A scene whose elements appear as the voice reaches them (points, steps, a feature walk-through, a one-take
film) is segmented; a title or mood scene that follows the scene as a whole is not.

- Each line is a `narration` field next to the visual it introduces: a top-level line for the opener
  (`titleSay`), a line inside each `object[]` item for a variable number of points (`points[].say`).
- `example_segments` = `[{key, start, end}]` in seconds over the board's mp3, one per line in schema order.
  The starts come from `timeline.json` words (or `ffmpeg -af silencedetect=n=-35dB:d=0.15` on the mp3).
- Lines must be speakable as written: no brackets or symbols a voice drops.

For the one-board film, the camera path is data too: each segment item carries its node's position on the
shared canvas and the camera's framing (`{ x, y, zoom }` in canvas fractions); the board interpolates between
consecutive nodes with the measured easing, so a different item count still travels a coherent path.

**Motion lists** (a board touring screenshots): keep only the motion style in code — the window, camera and
easing, veil, ring, cursor, caret, timing rules — and play a plan from data: a list of screens
`{ image, beats?, at? }`, each with beats. Declare it in `meta.motion`:

```json
"motion": { "lists": [ { "screens": "features[].screens", "line": "features[].say" } ],
            "beats": ["focus", "ring", "click", "type", "scroll", "hold"],
            "min_screen_sec": 1.2, "min_beat_sec": 0.8, "fallback": "hold" }
```

| Beat | Data (0–1 of the screenshot) | Drawn |
|---|---|---|
| `focus` | `box` | camera pushes in, the rest dims |
| `ring` | `box` | accent ring around one control |
| `click` | `point` | cursor glides in and clicks |
| `type` | `box`, `lines` | text appears line by line with a caret |
| `scroll` | `from`, `to` | camera pans between regions |
| `hold` | — | slow drift (the fallback) |

Beats may carry `label` (≤ 40 chars), `cue` (one word of the line) and `cueAt` (seconds from the line's
start; the board reads `cueAt`). A screen gets at most `floor(span / min_beat_sec)` beats; extra ones drop in
the order `hold`, `scroll`, `type`, `ring`, `click`, `focus`. A ring or click waits for the camera move it lands
in to settle and ends when the camera next moves. `beats: []` means hold. A plan too busy for its line plays
plainer, never broken.

## 7. Sub-agent brief (one per layout, step 3.6)

Used when the template has 4 or more layouts (SKILL.md §Sub-agents); with fewer the main agent writes the
boards itself by the same task list. The main agent fixes `design.js`, fonts, the transition table and every board's window first, then sends each
sub-agent (fast tier, SKILL.md §Sub-agents) the boards of one layout:

- the board names, their windows and shots, its `analysis/boards.json` entry, its brief shots and regions / roles,
  its elements from `analysis/elements.json` and `analysis/motion.json`, the fonts per role;
- the transitions on its two edges (type and duration) — no own entrance / exit on a transition edge;
- the paths: `$SKILL_ROOT`, `$PROJECT`, and the sections to read: this file §2–§6 and §8, `references/acceptance.md`
  §3 and §7 — nothing else;
- the task: write `template/boards/<Name>.jsx` and `.json` for each of its boards (a returning layout's later
  boards are copies of the first under their own names); run
  `node "$SKILL_ROOT/scripts/refs.mjs" "$PROJECT" --only <Names>`,
  `node "$SKILL_ROOT/scripts/build-boards.mjs" "$PROJECT" --only <Names>`,
  `node "$SKILL_ROOT/scripts/compare.mjs" "$PROJECT" --only <Names>`; read the score table, open the compare image
  (source | board | diff) only of a row under 0.95, and fix by element against its `analysis/elements.json`
  entries (box, font, idle motion, sound) and `references/acceptance.md` §7; 2 rounds (the strong tier that
  takes over a failing layout gets 3 more); write nothing outside its own board files;
- the return, as short text: per-board min / mean struct scores, the measured cause of any score under 0.95,
  fields added, anything the main agent must decide (a board that should merge with its neighbour).

## 8. Elements behind the person

Some originals put an element behind the presenter: a sunburst turning behind the head, a title the head
overlaps, logos floating behind the shoulders. The board then draws three layers: the clip, the element, and
the clip's **cutout** on top — the same clip with only the people opaque (VP9 with alpha), matted locally by
`matte.mjs` (Robust Video Matting; free, the engine installs itself on first use).

Use it only when all three hold:

1. In the original the element is visibly covered by the person — hair, a shoulder or a hand passes in front
   of it (frame grabs around `in`, `measure.mjs grid --box`). An element beside the person, or always in front,
   is an ordinary layer.
2. What covers it is footage in a `video` field (presenter or b-roll), not something the board draws — a
   drawn layer is simply ordered in the JSX.
3. That footage moves or is replaced in a replica, so its outline cannot be fixed in advance. Never hand-draw
   the original person's silhouette as a mask: a new presenter will not fit it.

Then: `behind: "<video field path>"` on the element in `analysis/elements.json`, `media.cutout: true` on that
field, and the board draws the field's second prop `<key>Cutout` above the element:

```jsx
<div style={{ position: 'absolute', inset: 0 }}>{presenter}</div>
<Sunburst t={t} style={{ position: 'absolute', left: '22cqw', top: '8cqh' }} />
<div style={{ position: 'absolute', inset: 0 }}>{presenterCutout}</div>
```

Both props are `<video>` elements of the same clip, kept in sync by the player; place them identically.
`project.mjs` mats every clip such a field plays — the reference clip in the clone comparison, then the
generated or user clip — once per clip (about 20 frames a second at 720p; the cutout is reused until the clip
changes). `validate.mjs template` checks that the element, the field and the board agree.
