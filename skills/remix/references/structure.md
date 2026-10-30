# Narrative structure and the swap test

For the main agent, steps 3.7–3.8. The narrative structure is what a replica writer reads first: what each
part of the film has to achieve, written so that any topic in the template's range can be poured in.

## 1. `template/skill/SKILL.md`

Agent Skills format: YAML frontmatter, then a short body.

```markdown
---
name: saas-launch-explainer
description: A feature launch told as pain → turn → proof → ask, for a busy professional audience; 45–60 s, confident and plain-spoken.
metadata:
  schema_version: 1
  sections:
    - beat: Hook
      node: hook
      brief: Put the viewer's recurring cost in one question they would answer "too much" to.
      scenes: [{ durationS: 2.1, narration: "How many hours does your team lose to meetings each week?" }]
    - beat: Features
      node: features
      brief: Two to four capabilities, each one action and its visible result, in the order a user meets them.
      scenes:
        - { durationS: 4.0, narration: "Record a clip instead of calling a meeting." }
        - { durationS: 3.6, narration: "Cut the filler, keep the point." }
      scenes_min: 2
      scenes_max: 4
    - beat: Ask
      node: ask
      brief: One action and where to take it; no new claim.
      scenes: [{ durationS: 2.5, narration: "Try it free today." }]
---

Speaks to team leads who already feel the problem; no hype, short sentences, numbers over adjectives.
The hook asks, the features answer it one by one, the ask closes without a new promise.

Other topics in range: an expense tool's approval flow, a scheduling app's booking page, a CRM's follow-up reminders.
```

- `name`: the template id (also the clone directory's `<id>`).
- `description`: what the structure does, for whom, register and length — at structure level
  (`references/analysis.md` §4), never this video's product.
- A **section** is one narrative node: `beat` (Hook, Problem, Features, Proof, Ask …), `brief` (what the node
  must achieve), optional `node` (lowercase, ≤ 32 chars; pairs the section with the boards carrying it — the
  board json's `node`).
- `scenes[]`: the original's scenes inside that node, each with `durationS` (from `timeline.json`) and the
  original's `narration` (empty for a segmented board, whose lines live in its data).
- `scenes_min` / `scenes_max`: how many scenes a replica may play for the section (three features in the
  original, two to four for a replica). Absent = fixed at the listed count. A ranged section's `node` has
  exactly one board, so a repeated scene is the same board.
- The body: who it talks to, register, how the parts hand over; the last paragraph names two or three other
  topics in range. It says nothing about boards.

## 2. `template/template.json`

Written together with the skill: `id`, `title` (a name in the user's language), `canvas`, `fps`, `category`
(`avatar` when any board has a `presenter` field, else `no_avatar`), `audio` (`source_mode` from the brief,
`captions` = the caption style matching the original's burned-in captions or `null`, `bpm`), `source`
(`file: "../source/source.mp4"`, `duration_s`, `url` when downloaded), `boards` (default scene order — the
original's order, one entry per scene, a repeated board listed once per scene) and `transitions`
(`references/transitions.md`).

## 3. Swap test

Before acceptance, prove the template is a structure and not a copy.

1. **A second topic.** Pick a topic in range that differs from the original's (a different product, a
   different occasion). Re-read the skill's `description`, every `brief`, every field `desc`, `useWhen`,
   `dontUseWhen` and `displays` with it substituted. Each sentence must still be true and still tell the writer
   what to do. A sentence that only works for the original — a named object, place, person, season or number
   outside an "e.g." — is rewritten at structure level.
2. **No leftover copy.** `grep` the boards for literal strings from `example_data`; every hit is a fallback to
   remove.
3. **No decomposed product.** With the second topic in mind, a field only the original product would have (its
   button label, its reaction set, a viewer's initial) means a product surface was split up — fold it back
   into the surface's media field.
4. **Counts.** For every list, render the board with `minItems` items and with `maxItems` items (write the
   picks as `variants` in `analysis/boards.json` and run `build-boards.mjs --only <Name>` /
   `compare.mjs --only <Name>`; the variant frames show the layout). Through the board's whole length: nothing
   overflows the canvas, overlaps, or leaves a gap the layout does not close.
5. **Text.** Fill every text field once in Chinese and once in English about 1.5× the original's length (a
   temporary `example_data` copy, rebuilt with `build-boards.mjs --only <Name> --skip-audio`, then restored).
   No title wraps while the region beside it is free, no line holds a lone glyph, nothing runs into a
   presenter, panel or badge, no literal `\n` on screen.
6. Write the second topic used and every fix into `report.md`.

A board that only works at the original's count, or only with the original's words, is fixed in the board —
its layout or timing was written per item instead of from the source table and the re-flow rule.
