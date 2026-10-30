# Reading the original

For the main agent, steps 2 and 3.1–3.2. Input: what `intake.mjs` wrote under `source/`. Output:
`analysis/brief.json`, then `analysis/boards.json`, and the analysis sections of `report.md`.

## 1. What intake gives you

| File | Use |
|---|---|
| `source/timeline.json` | The clock. Shots with frame-exact `start` / `end`, soft transition windows (`transition_in` / `transition_out` with `type: "soft"` and start / end), `motion_peaks` (camera moves starting / stopping, elements entering), `words`, `beats`. Every time you write anywhere comes from here, rounded to a frame |
| `source/frames/overview.jpg` | One frame per second: the whole film at a glance |
| `source/frames/shots/<n>/strip.jpg` | Dense, time-stamped frames of shot n (every 4th frame under 2 s, 4 fps for 2–6 s, 2 fps beyond), plus first / last frame, every motion peak and every transition's start / middle / end |
| `source/transcript.json` | Segments and word timings of the voice; empty when there is none |
| `source/understanding.json` | Present with `--understand`: a model's per-shot description (what is on screen, what happens, the camera). A cross-check, never the clock |
| `source/audio.wav` | The original's sound, for checking whether there is music, voice, or both |

Frame-level means: a fast film can change layout every second and bring an element in within a few frames,
so never infer timing from the overview or from a sparse grid. When you need a moment the strips do not
show, grab it frame-exactly: `ffmpeg -i source/source.mp4 -vf "select=eq(n\,<frame>)" -frames:v 1 out.png`
(select by frame number, not `-ss`, which drifts on variable-rate sources).

## 2. Read the whole film first

Before measuring anything, read `overview.jpg` and the full transcript, then every shot strip in order.
Decide what the video **is**: a frame alone shows an email client; the whole film shows a product launch
that shares through email. Every later decision (what a scene is for, which region gets swapped, how coarse
a slot is) is read off that.

Cross-check with `understanding.json` shot by shot. Where they disagree, look at the frames again: the
frames win for what is on screen, `timeline.json` wins for when.

## 3. `analysis/brief.json`

```json
{
  "genre": "product-demo",
  "product": "an async video messaging app for teams",
  "arc": "the pain of meetings → record → edit → share → the team reacts → call to action",
  "audio": { "voice": true, "music": true, "original_sound": false, "bpm": 104,
             "captions": { "burned_in": true, "style": "word-highlight", "notes": "white bold, yellow active word, lower third" } },
  "shots": [
    { "t": [0, 2.133], "shots": [0], "shows": "presenter", "what": "a woman at her desk sighs at a full calendar — the viewer's pain",
      "subjects": ["presenter", "laptop"], "camera": "slow dolly-in", "transition_in": null },
    { "t": [2.133, 6.4], "shots": [1, 2], "shows": "desktop", "what": "the product's recorder opens and starts capturing",
      "subjects": ["app-ui"], "camera": "push to the record button", "transition_in": "page-flip" }
  ]
}
```

| Key | Values |
|---|---|
| `genre` | `product-demo` (the product's interface carries the story) · `explainer` (a concept told with generic scenes and graphics) · `testimonial` · `brand` (mood and identity, no interface) · `greeting` (an occasion) · `other` + a word on what it is |
| `product` | what is shown, one line at structure level; `null` when nothing is sold |
| `arc` | the narrative arc in one line — the seed of the narrative structure |
| `audio` | what the soundtrack is made of; `bpm` from `timeline.json`; whether captions are burned in and what they look like |
| `shots[]` | one entry per semantic scene, `t` its window from `timeline.json`, `shots` the timeline shot indices it covers. A continuous walk-through is one entry however many cuts it has |
| `shows` | `desktop` · `phone` · `tablet` · `text` (type and graphics only) · `brand` · `footage` · `presenter` |
| `subjects` | ids of the people, products and logos visible; one id per subject across the whole film (`presenter` stays `presenter` in every shot). These become the replacement table's keys |
| `camera` | the camera move in plain words, located by the motion peaks |
| `transition_in` | how this scene is entered: `null` (hard cut) or the transition seen |

The recommended audio mode in step 1 follows `audio`: voice → `narration`, music only → `music-only`.

## 4. Separate the structure from the topic

A template is a **narrative structure** other topics are poured into, not a copy of this video. Write both
halves into `report.md`:

- the **structure**: what each part of the arc does, in what order, register and rhythm (for a festival
  greeting: name the occasion → its roots → the people it brings together → the wider community → a closing
  blessing). This is what the template fixes;
- the **topic**: what this video is about, and the range of topics the structure serves (festivals, seasonal
  days, anniversaries). This is what each replica swaps. Wide enough that a second topic fits every scene,
  narrow enough that the scenes still say something.

Everything a writer reads to fill the template is written at structure level: the narrative skill, every
`beat` / `brief`, every field `desc`, every `useWhen` / `dontUseWhen` / `displays`. The source's topic lives
in exactly three places — `example_data`, `example_narration` / `scenes[].narration`, and the "e.g." inside a
`desc`, which then gives a second example from another topic in range.

| Topic-bound (wrong) | Structure-level (right) |
|---|---|
| "a still life of the festival's food" | "a still life of the one object that stands for the occasion — a food, a craft, a keepsake" |
| "The festival's name, e.g. Mid-Autumn" | "The occasion's name, e.g. Mid-Autumn or an anniversary" |

A board never falls back to the source's words: `{title ?? "Mid-Autumn"}` puts the original's copy into every
replica whose field is empty. A missing prop draws nothing.

## 5. Regions and roles, top-down

Per board, split the frame into a few regions and give each one role by one question: **when the topic
changes, is this region replaced as a whole, or kept with only its words changed?**

- In a `product-demo`, every interface inside the demo is a product surface — the product's own screens and
  the third-party apps it is shown working in.
- The scenes framing the demo (the hook showing the viewer's pain, the payoff showing their day after) are the
  viewer's world: an interface there is a story prop.
- In any other genre an interface is a story prop.

| Role | Test | Becomes |
|---|---|---|
| Product surface | another product would look entirely different here | **one** `image` / `video` field (`media.role: screen`) inside a neutral frame the board draws; nothing inside it is a field |
| Story prop | a generic place the story happens (team chat, email, calendar, lock screen) | code; only the 1–3 strings that carry the plot are fields |
| Brand | logo mark, wordmark | `image` field |
| Footage / presenter | filmed or generated people and places | `video` field (`role: broll` or `presenter`) |
| Text | words that track the narration — headline, caption, callout, pills | `string` / `string[]` / `narration` fields |
| Decoration and camera | pointer paths, rings, arrows, confetti, pushes and pulls, avatars that only fill a seat | code, never a field |

A product surface is never decomposed: its labels, icons and panels are the source product's. A board with
many fields that are all labels from one area is a decomposed surface — merge it back into one slot. Record
regions and roles per board in `report.md`.

## 6. Repeated units become lists

Two or more siblings drawn the same way (same layout, styling, entrance) that differ only in content — a
timeline's nodes, step lists, card grids, comparison columns, stat tiles, pills, logo strips, the steps of a
walk-through — are **one `object[]` field**, never numbered keys (`action1…action4`). Each item carries every
attribute one unit shows, nested lists included.

- `minItems` / `maxItems` from what the layout holds legibly, with the source's count inside the range.
- The highlighted unit (current step, featured plan) stays in the list; the board marks it by a rule from the
  source (the last item, the middle one), not by a separate field.
- Measure every per-item variation (position, size, entrance delay, motion, each step's camera move and focus
  point) into a table in the board, `const SOURCE = [{ x, y, delay, move }, …]`. With the source's count the
  board replays it entry by entry; other counts derive from it:

| Count n vs. the source's s | Board does |
|---|---|
| n = s | each item uses its own entry |
| n < s | first and last items keep the opening and closing entries; middle items take the middle entries in order |
| n > s | opening and closing as above; middle items cycle through the middle entries |

Layout re-flows for n from the source's container, spacing and alignment (a grid re-rows, a timeline
re-spaces); the stagger continues the source's interval.

## 7. Code or pixels, per region

| Evidence | Verdict |
|---|---|
| zero temporal difference across static frames; few unique colours; long sharp edges | rendered graphic → code |
| photographic or generated texture | media slot |
| undecidable | media slot (cheap to be wrong that way) |
| a procedural texture that is always occluded | code, judged by eye |
| the whole frame is footage with no recoverable skeleton | one full-frame `video` slot (`role: broll`) — a legitimate outcome |

Measure, never assume: sample the background per scene (lifted black `#060408` rendered as `#000` scores
about 0.1 with perfect geometry), measure element boxes on frame-exact grabs, and track a moving container per
frame — per-axis progress tables are the easing; do not eyeball curves.

## 8. `analysis/boards.json`

Written once the board split is decided (`references/boards.md` §1). All times come from `timeline.json`.

```json
{
  "fps": 30,
  "canvas": { "width": 1920, "height": 1080 },
  "cover_t": 1.0,
  "source_frame_time": "middle",
  "boards": [
    { "name": "Hook01", "start": 0, "end": 2.133, "shots": [0],
      "media": {
        "cover": { "crop": [0.52, 0.12, 0.42, 0.76],
                   "subjects": [ { "id": "presenter", "kind": "person", "box": [0.3, 0.1, 0.4, 0.8], "t": 1.0 },
                                 { "id": "laptop", "kind": "product", "box": [0.05, 0.55, 0.5, 0.4], "t": 1.6 } ] } } },
    { "name": "Points02", "start": 2.133, "end": 6.4, "shots": [1, 2],
      "segments": [ { "key": "points.0.say", "start": 0, "end": 1.8 }, { "key": "points.1.say", "start": 1.8, "end": 4.267 } ],
      "media": { "points.0.shot": { "crop": [0.1, 0.2, 0.5, 0.6], "window": { "start": 2.3, "end": 4.0 }, "subjects": [] } },
      "variants": [ { "id": "n3", "pick": { "points": [0, 1, 1] } } ] }
  ]
}
```

- `boards`: one entry per board name, in source order. A layout that comes back later in the film (separated
  by another layout) is a new board with its own name and window — `refs.mjs`, `compare.mjs` and the reference
  clips key on the name, so one name never has two windows here. Its JSX is a copy of the first one's with the
  new name (boards share no module), written by the same sub-agent (`references/boards.md` §7).
- `canvas`: 1920×1080 for 16:9, 1080×1920 for 9:16, whatever the source resolution.
- `start` / `end`: the board's window in source seconds. `segments`: one per narration field, seconds from the
  board's start (the first starts at 0, each ends where the next starts).
- `media`: one entry per `image` / `video` slot, keyed by media path (`cover`, `hero.logo`, `points.1.shot`).
  `crop` = `[x, y, w, h]` as 0–1 fractions of the source frame — for a product surface the whole product
  region, chrome included, so board + crop rebuilds the source frame. `window` = `{ "start", "end" }`, the
  source seconds the slot is on screen when shorter than the board (default: the board's window). The slot's
  `<video>` then plays its reference clip from `window.start`: at board time `t` it shows source second
  `board.start + t` (the player keeps it there through play, pause and seek; the board never touches it). `subjects[]`: `id` (same ids as `brief.json`), `kind` (`person` /
  `product` / `logo` / `other`), `box` (0–1 fractions of the crop) and `t` (source second where the subject is
  clearest). `refs.mjs` turns these into reference clips, frames and subject cut-outs.
- `variants`: other list counts to compare (`references/acceptance.md` §3).
- `cover_t`: the source second for the template cover. `source_frame_time`: `"middle"` for a filmed or
  encoded source; `"start"` for a source rendered frame by frame (motion graphics, After Effects), where frame
  n is exactly n / fps.

## 9. `analysis/elements.json` — every element, measured

The boards replay what is listed here, so the first template is already one to one. One entry per element
**instance** on screen (every pop-up, sticker, title, caption block, icon, badge, screen card, the presenter):

```json
{ "elements": [
  { "id": "Hook01.pops.0", "board": "Hook01", "kind": "picture", "path": "pops.0.image",
    "in": 3.2, "out": 4.9, "box": [0.315, 0.18, 0.37, 0.175],
    "enter": "pop", "exit": "cut", "idle": { "type": "none" }, "content": "loop", "sfx": "pop" },
  { "id": "Hook01.stickers.1", "board": "Hook01", "kind": "sticker", "path": "stickers.1.text",
    "in": 5.0, "out": 6.4, "box": [0.22, 0.144, 0.56, 0.06],
    "enter": "pop", "exit": "cut", "idle": { "type": "boil", "poses_per_s": 4 }, "content": "still",
    "font": "sticker", "sfx": null }
] }
```

| Field | How to get it |
|---|---|
| `id` / `board` | `<Board>.<name>` and the board it belongs to (a board of `template.json`) |
| `kind` | one of `picture`, `screen`, `sticker`, `title`, `caption`, `icon`, `badge`, `presenter`, `footage`, `shape` (a drawn frame, highlight box, arrow, divider) |
| `path` | the board field that fills it (`stickers.1.text`, `presenter`); leave it out for something the board draws with no field of its own (a fixed shape, a decoration) — a `path` must name a field of the board's schema |
| `box` | `[x, y, w, h]`, 0–1 of the canvas, **per instance** — originals rarely reuse one box. Read it off `node "$SKILL_ROOT/scripts/measure.mjs" grid "$PROJECT" --at <t>[,<t>…] [--box x,y,w,h]` (a 2 % labelled grid on the frame-exact grab, `--box` zooms in). Automatic rectangle detection is unreliable on footage; read the grid |
| `in` / `out` | the motion peak or word start in `timeline.json`, to the frame |
| `enter` / `exit` | from the strips at 4 fps around the moment, frame grabs for anything faster |
| `idle` | what the element does while it stays: `none`, `boil` (stop-motion jitter: a new pose every few frames, still between), `drift`, `pulse`, `sway`, `shake`. `measure.mjs motion` measures it; a `boil` on a sticker, title or badge carries `poses_per_s`, and `validate.mjs template` holds `idle` and `content` to what `analysis/motion.json` measured |
| `content` | what the picture inside does: `still`, `loop` (a GIF-like repeat), `recording` (a screen recording: scrolls, a cursor, typing), `footage`. `measure.mjs motion` measures it |
| `font` | the `design.js` key of a font stack (`font`, `fontHead` …), whose first family `fonts.json` ships (`fonts.mjs`); every role is matched with `measure.mjs fonts` (below) |
| `behind` | only for an element the person in a footage slot covers in the original (hair or a hand in front of it): the path of that `video` field. It turns on matting for that field (`references/boards.md` §8) — leave it out when nothing covers the element |
| `sfx` | the sound its entrance makes, from `source/sfx.json` (an event within 2 frames of `in`): `pop`, `click`, `whoosh`, `swoosh`, `ding`, `paper`, `typewriter`, `impact`, `riser`, `shutter`, or `null` |

Then:

```bash
node "$SKILL_ROOT/scripts/measure.mjs" motion "$PROJECT"          # analysis/motion.json: still / boil / moving per element
node "$SKILL_ROOT/scripts/measure.mjs" fonts "$PROJECT" --at <t> --box x,y,w,h --text "<exact text>" \
  --candidates "Source Serif 4:900,Bree Serif:400,Fraunces:700,…"
```

- `motion` skips `presenter` and `footage` elements (their jump cuts read as motion) and measures the rest.
- `motion` decides field types: an element whose content moves is a `video` field (`media.loop: true` for a
  GIF-like loop), never an image with a still reference — otherwise the replica gets stills where the original
  moves. A `boil` element gets the measured poses per second in its board.
- `fonts` renders each candidate beside the original's crop. Try 6–12 open families of the same class (soft
  serif, black slab, hand-written, condensed sans …), pick by letterforms (the `a`, `g`, `R`, terminals,
  contrast), then set size from the measured cap height.
- Captions are elements too: measure their position, size, words per phrase, plate or none, case and how words
  appear, and write them to `Design.captions` (`references/captions.md`). Note per board whether the original
  shows captions over it at all, and during which lines: that becomes the board's `meta.captions`
  (`references/boards.md` §3).
- Sound: listen through `source/sfx.json` (`kindGuess`, the spectrogram sheet) and give each event to the
  element whose entrance it marks.

`validate.mjs template` checks the inventory against the boards: every media field covered, a moving element
never an image field, measured motion matching what is declared.
