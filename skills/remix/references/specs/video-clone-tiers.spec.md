# video-clone fidelity tiers

`remix` runs at one of two tiers. `high` is the full 1:1 clone described in
`video-clone.spec.md`; `low` trades layout fidelity for speed; `high` is the default.

## 1. Why two tiers

A `high` run takes about 80 minutes, most of it in step 3: one hand-written React board per layout,
an element inventory with measured boxes, font matching, and comparison rounds until every sample
scores 0.95. Many users only need the film's rhythm and structure on their own topic: the same shots
in the same order, at the same pace, with their own people, products and copy. `low` keeps that and
drops per-element design, targeting about 25 minutes from link to finished film.

Both tiers build every frame from the same three sources, and the core of the analysis is deciding which
source fills which part of the frame:

- **avatar**: a digital human, for a person talking to camera;
- **pixel**: generated picture (AI video following the original clip, or an AI image), for live action,
  products and anything filmed;
- **code**: drawn by the board itself — text, panels, charts, lists, UI cards.

A screen region is the fourth case at the boundary: the user's own recording or screenshot when they have
one, otherwise pixel. One scene often combines several sources: a screen recording over a talking head,
two pictures side by side, a presenter in a corner over a chart, a cut-out presenter in front of a
backdrop.

| | `high` (default) | `low` |
|---|---|---|
| Analysis | shots, script, every element measured | shots, script, the position and timing of on-screen text |
| Template | one hand-written board per layout system, 1:1 | one generated board per scene: the scene's layers (avatar / pixel / screen / code regions in the original's boxes) under a generic text overlay |
| Talking-to-camera regions | digital human | digital human |
| Filmed regions (live action, products) | rebuilt per slot (reference, keyframe, capture, GIF) | AI video that follows the original region's camera and timing (reference-to-video, MiniMax H3 on TapVid), with the user's people and products from images |
| Screen regions | capture, user recording or code | the user's recording or screenshot, else AI video as above |
| Code regions | per-board code | one element per region, written per replica |
| On-screen text | per-board code replaying measured boxes, fonts and motion | the generic overlay: the original's boxes and timing, one font, fade or pop entrances |
| Transitions | measured, full transition library | soft cuts become crossfades of the measured length; everything else is a hard cut |
| Captions | measured style | measured style (same `Design.captions` tokens) |
| Sound effects | detected and replayed per element | none |
| Stops (plan mode) | 2: the clone, then the replica with its cost | 1: the replica with its cost |
| Acceptance | `compare.mjs --fail-under 0.95`, timing check, element checklist | `validate.mjs template`, a contact-sheet look at every scene |

## 2. Invocation

```
remix <video | url | keywords | clone dir> [topic] [low | high] [auto]
```

- The tier is the keyword `low` or `high` anywhere in the arguments; without one the run is `low`.
- A user who asks for an exact, faithful or 1:1 copy (in any language) gets `high`; one who asks for a
  quick or rough version gets `low`.
- A reused clone directory keeps the tier its template was built at; `high` on a `low` template
  rebuilds step 3 at `high`.
- `auto` is independent of the tier.

The tier is recorded in `analysis/brief.json` as `"tier": "low" | "high"`.

## 3. `low` flow

Steps 0–2 are unchanged (`intake.mjs` is already fast). Step 3 is replaced by the quick template;
steps 4–9 run as in `high` with the differences listed in §3.3.

### 3.1 `analysis/shots.json`

Written by the agent from the shot strips, the overview sheet and the transcript (validated by
`assets/schemas/shots.json`). It groups shots into scenes and records only what the generated boards need:

```json
{
  "palette": { "fg": "#FFFFFF", "accent": "#F2C14E", "plate": "rgba(0,0,0,0.55)" },
  "font": "Inter",
  "captions": { "centerY": 78, "size": 2.6, "weight": 600, "plate": false, "maxChars": 16 },
  "scenes": [
    {
      "name": "Hook",
      "role": "Hook: a fast day-in-the-life montage that promises a shortcut",
      "shots": [0, 1],
      "layers": [
        { "key": "app", "fill": "screen", "box": [0, 0, 1, 0.5],
          "describe": "A phone app scrolls through a recipe feed",
          "subjects": [{ "id": "app", "kind": "other", "box": [0, 0, 1, 1] }] },
        { "key": "presenter", "fill": "avatar", "box": [0, 0.5, 1, 0.5],
          "describe": "A young woman talks to camera in a bright living room, handheld",
          "subjects": [{ "id": "host", "kind": "person", "box": [0.25, 0.1, 0.5, 0.9], "t": 1.0 }] }
      ],
      "texts": [
        { "text": "DAY IN THE LIFE", "box": [0.3, 0.2, 0.4, 0.3], "in": 0.2, "out": 2.0, "enter": "pop", "color": "accent" }
      ]
    }
  ]
}
```

- `shots` are consecutive indices into `source/timeline.json`; the scene's window runs from the first
  shot's start to the last shot's end, and scenes tile the film in order. `start` / `end` (source seconds)
  cut a shot, so one long shot can be split across consecutive scenes that both list it; a scene that
  ends inside its shot hands over with a hard cut.
- `layers`: the scene's layout, back to front. Each layer is one region of the frame for the whole scene:
  - `fill`: `avatar` (a person talking to camera; a digital human in narration mode), `pixel` (filmed
    picture: live action, products, b-roll), `screen` (a phone or desktop screen) or `code` (a region the
    board draws: a coloured panel, a chart, a list, a UI card — anything that is graphics, not footage);
  - `box`: the region in 0–1 of the frame; the board crops its content to cover it, and `refs.mjs`
    cuts the reference clip to the same box, so a reference video model sees only that region;
  - `key`: the board field for it — `presenter` for the avatar layer (at most one per scene), any other
    camelCase name otherwise (not `texts` or `say`);
  - `shape`: `rect` (default), `round` (rounded corners) or `circle` (a picture-in-picture bubble);
  - `cutout: true` (avatar or pixel only): only the layer's people are drawn, over the layers before it
    that it overlaps — a presenter keyed out in front of a backdrop, chart or screen. Those layers are
    recorded as behind it, and the clip is matted with `matte.mjs`;
  - `describe`: what the region shows, in the register of a generation prompt (code: what it draws);
  - `subjects`: the people, products and screens the replica may replace, boxes in 0–1 of the layer,
    `t` in source seconds. One subject keeps its `id` across scenes; a screen layer lists its screen
    (`app`) so the user's screenshot can replace it.

  Typical layouts: one full-frame layer; a split screen (two layers stacked or side by side); a
  picture-in-picture (a full-frame layer, then a small `circle` or `round` avatar); a keyed presenter
  (a backdrop layer, then a full-frame avatar with `cutout`); a text card (one full-frame `code` layer
  and `background`).
- `background`: the palette key behind the layers (`bg` by default), visible wherever no layer covers.
- A scene with a `pixel` or `screen` layer lasts at most 15 s, the longest clip a reference-to-video
  model makes; a longer one is split. Avatar and code layers have no limit.
- `texts`: designed on-screen text only — titles, labels, numbers, stickers with words. Burned-in
  captions of the narration are not texts; their look goes into `captions`. `box` is 0–1 of the frame,
  `in` / `out` are source seconds inside the scene, `enter` is `pop` / `fade` / `cut`, `color` names a
  palette key (`fg` by default), `plate: true` draws the palette's `plate` behind the words.
- `font` is one open family (installed with `fonts.mjs`); without it the overlay uses `sans-serif`.
- `captions` holds the `Design.captions` tokens (`references/captions.md`), or `null` when the original
  has no captions.

### 3.2 `quick.mjs`

`node quick.mjs <project>` turns `shots.json` into a complete template, deterministically:

- `analysis/boards.json`: one board per scene, named `<Name><NN>` (`Hook01`), with the scene window,
  its shots and one media slot per non-code layer (crop = the layer's box, its subjects);
- `analysis/elements.json`: one element per layer (`presenter` / `footage` / `screen` / `picture`, a
  layer under a cutout marked `behind` it) and one `title` element per text, so `validate.mjs template`
  runs unchanged;
- `template/boards/<Name>.jsx`: the generic board — the layers in order, each covering its box with its
  shape, a cutout layer drawing its `<key>Cutout`, then each text in its measured box, sized to fit the
  box, entering and leaving at its measured fractions of the scene;
- `template/boards/<Name>.json`: one field per layer — `video` for avatar / pixel / screen (role
  `presenter` / `broll` / `screen`, the aspect nearest the region's drawn shape, a short edge of the
  region's size up to 720 px, `cutout` when cut out), `element` for code (its `desc` names the region) —
  then `texts` (`string[]`, exactly as many items as the original shows, `maxChars` 1.5× the longest
  original text) and, when the scene has spoken words, `say` (`narration`, `maxChars` 1.3× the
  original line); the original's words and texts as example data; `meta.captions` on when the scene
  is narrated;
- `template/template.json`: canvas from the source orientation, `category` `avatar` when any scene has
  an avatar layer, audio mode `narration` when the transcript has words (else `music-only`), and a
  `crossfade` for every scene boundary that falls on a soft transition in `timeline.json`, with its
  measured length;
- `template/design.js`: the palette, the font and the caption tokens;
- `template/skill/SKILL.md`: one section per scene, from `role`.

It then runs `refs.mjs` and `build-boards.mjs` for the whole template, copying each layer's `describe`
into `refs.json`. The agent runs `validate.mjs template` and looks at the built boards against the
original. Code regions are empty in the template previews: their content is written per replica.

### 3.3 Steps 4–9 at `low`

- **No stop 1.** The questions of step 4 come right after the quick template; plan mode has one stop,
  the replica with its cost (step 6).
- **Avatar layers** are digital humans (narration mode), one clip per scene at the layer's aspect.
- **Screen layers** take the user's recording or screenshot (`source: user`) when the screen must be
  readable; otherwise they are generated like pixel layers.
- **Pixel layers** are `source: ai`, `mode: reference`, pinned to `provider: tapvid`, `model: minimax-h3` when TapVid is
  ready (otherwise unpinned, so routing picks any model that takes a reference video, and keyframe is
  the fallback). The prompt follows `references/replica.md` §Low tier: what the new shot shows, the
  replacements as image 1…n, and that only camera movement, framing and pacing are taken from the
  reference video — never its people, screen content, text or setting — with no captions or text.
- **Code layers** are elements: the agent writes `elements/<Board>.<key>.jsx` per replica for the new
  topic (`references/boards.md` §3), in the region the field's `desc` names, with the palette from
  `Design`.
- **No sketches, GIF search or product capture.** Copy, voice, music and captions are as in `high`.
- **Checks** in step 7 are unchanged: `inspect.mjs` on every clip, one regeneration for a failing one.

## 4. Plugin fixes that came with this work

- **Stale uploads.** `ctx.upload` caches a provider's reference for a file by its hash. When TapVid
  refuses a request with "please upload it again" (a video uploaded before the backend measured its
  length), the provider uploads every file of that request again, replacing the cached references, and
  resubmits once.
- **Output names.** `out` is a prefix to which the runner adds the file extension; an `out` that
  already ends with that extension is used as the file name, never doubled (`clip.mp4.mp4`).
- **Pinned video models.** A `provider` / `model` on a video slot now pins its video request, as it
  already did for images. When a reference slot falls back to keyframe, the keyframe and the video
  are routed afresh: the pinned model was chosen for its reference-video support.
