# Acceptance

For the main agent, step 3.10–3.11, and for board sub-agents (§3). The template is accepted when it rebuilds
the original shot by shot within the bar below, every static check passes and the element checklist (§7) is
clear. This happens before stop 1: the user confirms a finished clone, they do not find its faults. A sample
may stay under the bar only for a cause no template change can reach (§7 lists the accepted ones), recorded in
`report.md` as a known limit.

## 1. Build

```bash
node "$SKILL_ROOT/scripts/build-boards.mjs" "$PROJECT"                 # all boards; --only Name while iterating
node "$SKILL_ROOT/scripts/build-boards.mjs" "$PROJECT" --only Hook01 --skip-audio --skip-png
```

It cuts each board's example audio from the original into `boards/<Name>.mp3` and measures
`example_duration_ms`, bundles the board with its `example_data` into the single-file `boards/<Name>.html`,
screenshots `preview_t` into `boards/<Name>.png`, and grabs `template/cover.png` at `cover_t`. The canvas is
the template's (`1920×1080` or `1080×1920`), never the source resolution.

## 2. Clock check

The screenshots and the compare load every page fresh, so they cannot see a hidden clock — a CSS
transition, a timer in an effect, a video left playing on its own.

```bash
node "$SKILL_ROOT/scripts/clock.mjs" "$PROJECT"          # all built boards; --only Name for some
```

For each `boards/<Name>.html` it plays into the entrance and pauses, seeks back near the start, plays on,
seeks near the end and back, and compares every stop with a fresh page seeked straight to the same `t` (a video
in a slot may land a frame either way). A board that differs prints the stop and its SSIM, and the script
exits 1: look for a CSS transition or animation, a timer, or state kept outside `t`. Record the result in
`report.md`.

## 3. Shot-by-shot compare

```bash
node "$SKILL_ROOT/scripts/compare.mjs" "$PROJECT" --fail-under 0.95          # all; --only Name for one board
```

Boards are measured in parallel, and a board whose page, reference clips, timeline and transitions are unchanged
since the last run reuses that run's rows (`compare/cache.json`), so rerunning the whole template after fixing
one board costs only that board. `--fresh` measures everything again.

Each board is rendered with its media slots filled from the original's own reference clips
(`template/refs/`, from `analysis/boards.json` crops — run `refs.mjs` first) and screenshotted at 25 % / 60 % /
85 % of each shot, against the original at the same instants:

- a segmented board is sampled at 25 / 60 / 85 % of **each segment**, so every line is checked;
- every `variants` entry re-picks the original's own items in that order, lays their segment windows back to
  back and compares against the mapped source time. The camera's first ~1.4 s after a re-picked boundary may
  differ; the 25 % sample of an item normally clears it;
- two scores per frame: full-resolution `ssim`, and `struct` (SSIM at 480×270). The bar applies to `struct`:
  layout, motion and timing, not codec noise or font hinting.

It writes `compare/<Name>…_<pct>.png` rows (source | board | diff). **Read the rows and fix by element; do not
chase the number.** Typical causes and fixes:

| Row shows | Fix |
|---|---|
| Flat areas differ, geometry right | measure the background per scene; lifted black is not `#000` |
| Everything offset by a constant | the board's window is off — re-read the shot's frames in `timeline.json` |
| Element late / early | its timing was eyeballed — take it from the motion peak or the word start |
| Text wider / narrower | substitute font tracking: one `scaleX` from a measured line; size from cap height |
| Camera move drifts | the easing was guessed — build the per-axis progress table from frames |
| Slot content misplaced | the slot's `crop` in `analysis/boards.json` is wrong, or the board crops with the wrong `objectFit` |
| Frame-rendered source scores low on motion | set `"source_frame_time": "start"` in `analysis/boards.json` |

Organic textures, particles and hand-held shake are judged by eye (density, brightness, motion), not by SSIM;
name them as the cause when they keep a shot under the bar.

Sub-agents run this for their own board (`--only <Name>`), at most 5 rounds, and return per-shot scores with
causes.

## 4. Timing alignment

```bash
node "$SKILL_ROOT/scripts/compare.mjs" "$PROJECT" --timing
```

Every shot boundary, transition start / end, element entrance (motion peak) and sound effect (`source/sfx.json`
against the template's `data-sfx` cues) in the template preview is compared with `source/timeline.json`. Every offset must be ≤ 1 frame. An offset is fixed where it comes from:
a board window (`analysis/boards.json`), a segment start (`example_segments`), a transition duration
(`template.json`), or an element's timing inside the board.

## 5. Static checks

```bash
node "$SKILL_ROOT/scripts/validate.mjs" template "$PROJECT/template"
```

It reports, among others: the only-React import, one same-named export, no randomness or clocks, `cqw` / `cqh` geometry, no hex colours in
boards, `design.js` literal, every family in `design.js` shipped in `fonts.json`, schema / meta completeness, a
`desc` on every field, `media` keys per field type, `example_data` valid against its schema, `durationModel`
matching narration fields, numbered sibling keys (`item1`, `item2` → a list), refs present for every slot,
transition types known (built-in or in `template/transitions.js`). Fix every error.

## 6. `report.md`

```markdown
# <template title>

## What it is
Genre, product (structure level), arc. Structure vs topic, and the topic range.

## Boards
| Board | Window | Tier | Regions and roles | Why a separate board (or why merged) |

## Transitions
| From → To | Type | Duration | Params | How measured |

## Fidelity
| Board | Shot / segment / variant | struct | ssim | Cause when < 0.95 |
Timing: largest offset per board (frames); every offset > 1 frame with its cause.

## Fonts
Family, weights, licence; substitutions (source font → shipped font, scaleX); candidates compared per role.

## Known limits
What still differs from the original after §7, each with its cause (one line each).

## Swap test
Second topic; counts tried; text tried; fixes made.

## Status
| Check | Status | Evidence |
|---|---|---|
| reference match | passed / failed / not-run | compare table; boards under 0.95 named |
| timing | | largest offset |
| player clock | | boards checked |
| swap test | | second topic |
| static checks | | validate result |
```

Each status row is `passed`, `failed` or `not-run` with its evidence; a built preview or a clean validate does
not stand in for a row that did not run, and a `failed` row keeps its measured reason. Stop 1 quotes this
table's fidelity line and the known limits to the user in plain words.

## 7. Element checklist (before stop 1)

Walk `analysis/elements.json` with the compare rows and the clone review open. Each line must hold, or be
fixed:

| Check | Fails like | Fix |
|---|---|---|
| Every instance sits in its own measured box | all pop-ups in one fixed zone; a picture squeezed to the zone's aspect | replay the per-instance `box` table; draw images at their own aspect |
| Every text role matches by letterform | a rounded face where the original has a soft serif | `measure.mjs fonts` with more candidates of that class |
| Sizes and line breaks match | a one-line sticker wraps to two | wrap width and size from the measured box and cap height |
| Composite parts match | a sticker drawn as one plate where the original tears a scrap per letter | rebuild the part from a zoomed grab (`measure.mjs grid --box`) |
| Idle motion matches | a sticker that boils in the original stands still | the measured `poses_per_s`, which parts move and by how much |
| Moving content is a video slot | a GIF or a screen recording kept as a still | field type `video`, the reference clip from `refs.mjs` |
| Captions match | a dark plate where the original has plate-less words | `Design.captions` from the measurements |
| Captions stand where the original's stand | `centerY` copied from a title, so the captions land on the headline | measure on a frame with spoken words (`references/captions.md` §1) |
| Lines keep their titles inside them | a title timed in the original's seconds, landing in the next line once the copy is shorter | times as fractions of the segment (`references/boards.md` §2) |
| Captions show where the original shows them | captions under a kinetic title that already says the line; full-frame captions at the split-screen height | the board's `meta.captions` (`false`, `off`, a `centerY`) |
| Elements behind the person stay behind | a sunburst drawn over the presenter's hair, or cut by a hand-drawn mask | `behind` + `media.cutout` + `<key>Cutout` (`references/boards.md` §8) |
| Sound effects are cued | an entrance that pops in the original is silent | `data-sfx` on the element; `compare.mjs --timing` lists missing cues |
| Nothing of the original's copy is left in the boards | a source phrase hard-coded in the .jsx | move it to `example_data` |

Accepted known limits: a font with no open look-alike (the closest one named), moving content inside a slot
(the reference clip differs frame by frame from any regenerated picture by nature), a host's gestures and jump
cuts inside a presenter slot. Anything else under the bar is a fault to fix.
