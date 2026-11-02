# Captions

For the main agent, step 8 and step 9 checks. Captions exist only in `narration` mode; `music-only` and
`silent` have `audio.captions: null`.

## 1. Style

`replica.audio.captions` names one style for the whole film. Recommend the one closest to the original's
burned-in captions (`template.json` `audio.captions`, described in `analysis/brief.json`); if the original had
none, recommend none unless the film is for muted social feeds.

| Style | Looks | Use for |
|---|---|---|
| `word-highlight` | a phrase on a dark rounded plate, the word being spoken lit in `Design.palette.accent` | social, talking head, anything the original captioned word by word |
| `plate` | the same plate, plain phrase, no per-word state | explainers, brand films, calm register |
| `creator` | no plate: a few white semibold words with a soft shadow, each word fading in as it is spoken (defaults: ≤ 16 chars at 77.8 % of the height) | talking-head creator videos whose original shows small plate-less words |
| `null` | no captions | the original had none and the user does not want them |

**Measure the original's captions in step 3** and write them to `Design.captions` in `design.js`; every style
reads them, so the template's captions match the original from the first build. Unset keys keep the style's
default:

| Key | `plate` / `word-highlight` default | `creator` default | Meaning |
|---|---|---|---|
| `maxChars` | 28 | 16 | most characters in one phrase |
| `centerY` | none (bottom 7 % above the edge) | 77.8 | the line's centre, % of the height |
| `size` | 4.2 | 2.65 | type height, % of the height |
| `weight` | 700 | 600 | font weight |
| `plate` | true | false | dark rounded plate behind the phrase |
| `uppercase` | false | false | all caps |
| `wordIn` | `none` | `fade` | each word fades in on its start, or the phrase appears whole |
| `wordFadeS` | 0.08 | 0.08 | one word's fade, seconds |
| `style` | — | — | the style the measurements belong to (a record; `replica.audio.captions` picks the style) |

`centerY` comes from frames where the words are being spoken (`source/timeline.json` words), through
`measure.mjs grid`, on at least three lines of the film: a title or sticker on the same spot is not the caption.
The comparison cannot catch a wrong value, because it draws no template captions and the original's are burned
in. So write each measured value next to the crop it came from in `report.md`, and check the band (`centerY` ± `size`)
against every title and sticker box of each board that shows captions: where they collide in the original too,
the board's `meta.captions` moves or mutes them. `validate.mjs template` warns on such a collision.

The render project mounts one caption overlay above every scene (`src/components/Captions.jsx`), with
words in scene seconds. One look, one size, one position across the film: a caption that changes between cuts
reads as a bug. Boards never draw captions and keep the lower 20 % of the frame free of key content where
captions sit.

## 2. Word timing

`timing.mjs` writes `resolved.<scene>.words = [{ text, start, end }]`:

- **Word timestamps from the voice** (the take's `words[]`, from providers that return them): used as they are,
  offset by the line's start in the scene.
- **Otherwise a weighted split** over the take's spoken length: Chinese is tokenised into single Han characters
  with trailing punctuation attached; other languages split on spaces. Each token's share of the take is its
  character count over the total.

Check the result on the frames of step 9: a phrase must appear when its words are heard. Where the weighted
split runs ahead or behind (long numbers, English inside Chinese), prefer a voice vendor that returns word
timestamps, or shorten the line.

## 3. Where captions sit

The overlay is centred horizontally, 10 % in from each side, its bottom 7 % above the frame's bottom edge;
type at 4.2 % of the frame height, bold, in `Design.font`, on a 55 % black plate. Plan board layouts around
that band:

| Canvas | Caption band (canvas px) | Keep clear in boards |
|---|---|---|
| 16:9, 1920×1080 | x 192–1728, roughly y 900–1004 (one line) / 850–1004 (two) | key text, faces and product details below y ≈ 840 |
| 9:16, 1080×1920 | x 108–972, roughly y 1600–1786 (one line) / 1510–1786 (two) | the same band; 9:16 platforms also overlay their own UI below it |

Each board carries its own rule, set when the board is built (`meta.captions`, `references/boards.md` §3):
`false` where the original shows no captions over that layout, `off` for the lines a title card already says
on screen, and token overrides (`centerY`, `size` …) where the original's captions sit elsewhere on that
layout. Never two texts saying the same line at once.

## 4. Grouping

The overlay shows one phrase at a time: words are grouped in order up to 28 characters per phrase, a phrase
shows from its first word's start to its last word's end with a 0.12 s fade at each side. To keep phrases
readable:

- write narration in short clauses; a clause longer than 28 characters splits mid-clause;
- end sentences with `。！？.!?` — the voice pauses there and the phrase boundary reads naturally;
- avoid symbols the voice drops or spells out (`/`, `&`, brackets, emoji).

## 5. Checks (step 9)

On the frames from `frames.mjs`:

- the caption never covers a face, the product, or a board's text, and no two texts overlap, at line boundaries
  too (`frames.mjs` saves the frames around them and scans the film, exit 1 per overlapping pair);
- a phrase leaves when its words end: it never waits on screen through a muted line;
- no phrase overruns the plate on two lines;
- CJK punctuation never starts a line; no lone glyph on a line;
- the caption at a transition belongs to the scene whose voice is playing.

A board whose important content sits where the caption is gets the caption question solved in the board's
layout, not by moving the caption for one scene.

## 6. A style closer to the original

When the original's caption look matters (a signature karaoke pill, kinetic words) and the two built-in styles
are not close enough, add it after `project.mjs --final` in `$REPLICA/project/src/components/Captions.jsx`
as a new `variant` branch: a pure function of `t`, colours from `Design.palette`, font from `Design.font`,
geometry in `cqw` / `cqh`, every value deterministic. Set `audio.captions` to its name, rebuild and recheck
the frames. `project.mjs` regenerates the project, so re-apply the branch after any later `project.mjs` run and
note it in the replica's report.
