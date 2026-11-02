# Writing the replica

For the main agent, step 4 (and the checks of step 7). The replica is `replicas/<slug>/replica.json`, the one
source of truth for the new film: copy, list counts, replacements, and where every picture comes from.

## 1. Skeleton

```bash
node "$SKILL_ROOT/scripts/replica-init.mjs" "$PROJECT" <slug> --topic "<topic>" --language zh
```

Scenes in the template's default order, each with its board's `example_data`, and one `media` entry per
`image` / `video` slot carrying its `ref` (the `refs.json` key) and the subjects seen there. Read
`template/skill/SKILL.md` and every `template/boards/<Name>.json` before writing anything else.

## 2. Replacement table (`replace`)

One entry per subject the new film changes, keyed by the subject `id` from `template/refs/refs.json`:

```json
"replace": [
  { "subject": "presenter", "with": { "file": "assets/user/me.png" }, "note": "the presenter becomes the user" },
  { "subject": "laptop", "with": { "generate": "A slim silver laptop showing a finance dashboard, three-quarter view" }, "file": null }
]
```

- `with.file`: the user's picture, copied into `assets/user/`.
- `with.generate`: an English description. The plan generates one image for it (full view, centred, neutral
  background, even light), its result fills `file`, and every slot that uses the subject takes the same image.
  This keeps one person or product consistent across the film.
- `with.generate` + `with.from`: rework the user's picture instead of inventing the subject — a portrait reframed
  so the board's layout fits (more headroom above a presenter whose overlays sit above the head), a product
  restaged. `generate` is then the whole shot in English (no studio-cutout suffix is added), `from` the user's
  file; `aspect` (default `3:4`) and `model` are optional. Check the result against the original picture
  (same face, clothes, product) before anything uses it.
- **Presenter headroom.** The template's pop-ups sit around the original host (`media.headTop` on the
  presenter field). Look at the portrait: when its head top is more than 5 % of the height away from
  `headTop`, reframe it for free before anything else —
  `node "$SKILL_ROOT/scripts/reframe.mjs" <portrait> "$REPLICA/assets/user/<name>-reframed.png" --head-top <now %> --target <headTop>`
  (shifts the picture and fills the gap with a blurred extension, seam feathered) — and use the result as
  `with.file`. Look at it once; an AI reframe (`with.from`) only when the blur shows.
- Subjects the user named come from the user. A subject of the original the user has not mentioned: ask now
  ("The original also shows a laptop — what should replace it? Keeping it is fine too."). Pick yourself only when the user handed the choice over.
- A subject kept as it is gets no entry; slots showing it still use the original's reference for composition
  only — the original's pixels never appear in the film.

## 3. Invented product

Only when the user agrees that the product is fictional (or asks you to make one up). Write `product.md`
before any copy:

```markdown
# Ledgerline
One line: month-end reconciliation that matches bank lines to invoices automatically.
Users: finance teams of 20–200-person companies.
Colours: brand #2F6BFF, neutral #0F172A. UI: light.
Screens:
1. Dashboard — unmatched lines count, a progress ring, last sync time.
2. Match review — bank line left, suggested invoice right, Accept button.
3. Report — month summary with three totals and a download button.
```

Every screen prompt and every line follows this sheet. Choose a name no real company uses.

## 4. Copy and data

Rewrite each scene's `narration` and `data` for the topic:

- Same structure: the scene count and each scene's board stay as `replica-init` wrote them, except a ranged
  section (`scenes_min` / `scenes_max`) may add or drop scenes of its board.
- Every field within `maxChars` / `minItems` / `maxItems`; write in the field's register (`desc`).
- Lists take as many items as the topic needs, inside the range — not the example's count. When a list grows
  or shrinks, add or remove that item's `media` entries (`features.3.shot`); a new item has no reference
  (`mode: "text"`, `ref: null`).
- Segmented boards speak their own `narration` fields; the scene's `narration` stays empty.
- `music-only` / `silent`: narration fields are on-screen copy only; nothing is voiced.
- **Copy budget** (narration mode): a scene's narration should not need more syllables than the original
  spoke in that window (original pace in syllables per second × window, +8 %). Translate the meaning, not the
  word count — an English replica of a fast English original keeps its short words; a Chinese replica of an
  English one counts one syllable per character. `validate.mjs replica` warns per scene with both numbers;
  shorten until it is quiet. Too-long copy is what makes a replica slow and long; a tempo can only make up a
  little of it (`references/audio.md` §Pace).
- Keep the original's verbal devices only when they survive the swap: a repeated product name ("Claude Code,
  Claude Code") reads as buzz; a repeated common phrase reads as a stutter.
- A field with `tiedTo` (focus box, tap point) is re-derived from the new picture once it exists (step 7),
  following its `desc`; left out when the picture has no sensible region.
- No real brands, celebrities or copyrighted characters in copy or prompts unless they are the user's own.

## 5. Where each picture comes from

| `source` | `mode` | When | Request the plan writes |
|---|---|---|---|
| `ai` | `reference` | the slot has a reference clip (default) | `video.generate` with `ref_videos: [{ file: <ref clip>, role: "motion" }]` and the replacement images as `refs` (`role: "subject"`); an image slot: `image.generate` with the reference frame (`role: "composition"`) and the replacements |
| `ai` | `keyframe` | no provider takes a reference video for this slot (the plan switches automatically and warns), or a reference video was refused | `image.generate` of the new first frame from the reference frame + replacements, then `video.generate` from that first frame with the original's camera motion (`refs.json` `describe`) |
| `ai` | `text` | no reference (an extra list item, a new scene) | prompt only, with one reference frame as a style reference |
| `user` | — | the user's own picture or clip, or a licensed stock clip (Pexels, Pixabay) found with `video.search` | none; the file goes on screen as is. Stock: write `license` / `attribution` on the entry |
| `code` | — | interfaces, charts, type, anything a sketch draws convincingly; also every slot when no generation provider exists | none; the sketch is the final picture (free) |
| `user` (GIF) | — | the original's slot is a reaction GIF / loop (`media.loop`) and GIPHY is ready | none; `gif.mjs` finds and downloads it (below) |
| `ai` | `keyframe` / `text` on a loop slot | a moving original picture without a GIF source: the still generated, then brought to life as a short clip | `video.generate` (shortest duration); the player loops it |

- `element` fields are always code: write `elements/<Board>.<key>.jsx` (default export
  `({ t, duration, Design })`, imports only `react`, deterministic in `t`, colours from `Design.palette`) and
  set `file` to it.
- A `presenter` slot is a digital human (`kind: "avatar"`), only in `narration` mode; its portrait is the
  `presenter` replacement. Without an avatar provider it becomes the portrait image with gentle motion — tell
  the user. The digital human should look like the original's presenter footage — same framing, nothing in
  the picture the original's footage does not have. An avatar takes no prompt (only the script and the
  portrait), so this is checked on each clip as it finishes (SKILL step 7).
- Interfaces of a real product come from a capture of the product (`references/capture.md`): the user logs in
  once, you record the flow and cut each slot from it — or from a demo recording the user already has. Draw a
  real product's interface as code only when it cannot be captured; an invented product's screens are
  generated (§7).
- Recommend `code` for interface and chart slots; a convincing sketch is free and sharp.
- **Moving originals stay moving.** A slot whose original content moves (`media.loop`, or a `video` field of
  role `screen`) never gets a still: a GIF, an AI clip, the user's screen recording, or a code animation
  (scroll, cursor, typing over the user's screenshot — `references/sketches.md`).
- **GIFs** (meme-style originals; GIPHY key, free at https://developers.giphy.com/dashboard/ →
  `set-key.mjs giphy`):

  ```bash
  node "$SKILL_ROOT/scripts/gif.mjs" search "$REPLICA" --slot <NN>-<Board>.<path> --query "<what the line says, in English>"
  node "$SKILL_ROOT/scripts/gif.mjs" pick "$REPLICA" --slot <NN>-<Board>.<path> --n <i>
  ```

  `search` writes a contact sheet of 8 candidates; look at it and pick the one that says the line best (not the
  very GIF the original used). `pick` downloads it and sets the slot (`source: user`, `loop: true`, `credit`).
  Credits go into the delivery report.

Each media entry:

```json
"cover": {
  "kind": "video", "source": "ai", "mode": "reference", "ref": "Hook01.cover",
  "replace": ["presenter", "laptop"],
  "prompt": "Use video 1 as the reference for camera motion, composition and timing. Replace the woman with the person in image 1 and the laptop with the laptop in image 2. She reviews a finance dashboard at a bright desk, morning light from the left; no on-screen text, no logos.",
  "visual": "The original's push-in on shot 1, with your photo as the person and the new product as the laptop",
  "aspect": "16:9", "duration_s": 2.133, "provider": null, "sketch": null, "file": null
}
```

**A slot with a person starts as `keyframe` at `high`** (`replica-init.mjs` writes it so, and `validate.mjs replica`
rejects `reference` there). A reference video carries the original's person, and a model can copy that person
however the prompt and the replacement image read. Showing a real person's likeness in the film is a fault no
quality can offset, so `reference` stays for slots with no recognisable person: objects, places, and with a stated
`reference_ok` ("a silhouette, no one recognisable") a person who cannot be told apart. For a keyframe, point `frame_t` of the slot in `analysis/boards.json` at the window's start (its
default is the middle, which may be another moment of a moving shot) and run `refs.mjs --only <Board>`; `validate.mjs
replica` then asks for the slot's sketch (`references/sketches.md`), its fallback if generation fails. The
trade-off is that the camera move then follows the description, not the reference clip: say so in the delivery report.

`visual` is the one line the user reads in the table (their language); `prompt` is English for the provider;
`provider` / `model` pin a vendor the user chose (otherwise routing picks); `sketch` is set for `code` slots
and for `ai` slots without a reference.

## 6. Prompt patterns

Images are numbered in the order of `refs` (replacements in `replace` order), videos in `ref_videos` order.

**Text in the picture follows the original's footage.** The patterns end with "no text, no logos" because the
original's titles, captions and stickers are drawn by the boards, not baked into the footage. When the
original's footage itself shows text or a logo as part of the scene (a shop sign, a product label, a phone
screen), describe its new-topic version in the prompt instead and drop that clause.

**reference (video)**

> Use video 1 as the reference for camera motion, composition and timing. Replace the {original subject} with
> the {subject} in image 1{, and the … with the … in image 2}. {What happens in the new topic, one sentence}.
> {Light and setting}. Keep the framing and the move of the reference. No on-screen text, no logos.

**reference (image slot)**

> Keep the composition, camera angle and lighting of image 1. Replace the {original subject} with the {subject}
> in image 2. {New scene in one sentence}. No text, no logos.

**keyframe** — first the frame, then the move:

> First frame of the shot. Same composition as image 1: {framing}. The {subject} from image 2 {pose / action}.
> {Light}. No text, no logos.

> {What happens in the shot}. Camera: {the original's move from `describe` — slow dolly-in, pan left, orbit}.
> {Subject motion}. Duration {n} s. No text, no logos.

**text** — `describe` of the nearest slot of the same board gives the camera and framing:

> {Subject and action}. {Framing and camera move}. {Light, palette matching the film}. Style as in image 1. No
> text, no logos.

Models generate at least 5 s on most vendors, whatever the shot needs. A generated clip longer than its scene is
sped up by `project.mjs` to fit, at most 2.5×, and past that the end is cut: write one quick action for a shot
under 2 s, because only its first 2.5 × shot seconds show. A reference clip under 2 s is slowed to 2 s when it is uploaded.

Rules: one action per shot; at most two hands in frame and say what each holds; the product's shape and colour
in words even when an image is given; describe what to show, never "do not show the old product"; keep areas
the board covers with text empty ("leave the left third clear").

**Low tier**: the reference clip is the layer's region of the original
frame (the whole frame for a full-frame layer), with its people, burned-in captions and stickers, so the prompt
describes the full new picture for that region and takes only the motion from the video. Pin `provider: "tapvid"`, `model: "minimax-h3"` when TapVid is ready; images are the
replacements (the user's photo, a product shot, a screenshot of their app):

> {Framing} of {the new subject from image 1, doing what} in {setting, light}. {The second subject from image 2,
> where it sits in the frame}. {Camera move in words}. Take only the camera movement, framing and pacing from
> the reference video; never its people, {phone / screen} content, text or setting. No captions, no subtitles,
> no text overlays.

MiniMax H3 copies the reference's handheld move and framing. It can keep the person in image 1 recognisable, and
it can also keep the reference's person instead, so every such clip passes the identity gate (§9); a
screen in the shot comes out as a likeness of the screenshot whose small text is not readable. When the screen
must be readable, make that slot `user` (a capture or the user's screenshot) instead. A layer with `cutout`
needs only its people to read well: ask for a plain, evenly lit background behind them.

## 7. Generated screens (invented product)

Each screen slot is an image prompt built from `product.md`: its colours and light / dark mode, the slot's
`shows` (desktop window, phone, tablet) and aspect. Realistic UI — a sidebar or tab bar, real-looking data
(names, amounts, dates), and the one thing the scene's line talks about clearly visible. Few, plain words on
screen (fewer words, less garbled text). Ask for the app edge to edge: "no window frame, no title bar, no
floating card on a background" (the board draws the frame). One shared base prompt; only the content changes.
Generate the first screen alone (`media.mjs run plan.json --only <id>`) and check it. Then, in `plan.json`,
add `{ "file": "@<first screen's request id>", "role": "style" }` to the `refs` of every other screen request
and start their prompts with "Same app, same sidebar, logo and styling as the last image." The runner resolves `@id`
to that result and waits for it. `media.mjs plan` rewrites `plan.json`, so add these refs again after any
re-plan.

## 8. Plan and estimate

```bash
node "$SKILL_ROOT/scripts/validate.mjs" replica "$REPLICA/replica.json"
node "$SKILL_ROOT/scripts/media.mjs" plan "$REPLICA/replica.json"
node "$SKILL_ROOT/scripts/media.mjs" estimate "$REPLICA/plan.json" --json
```

`plan` writes one request per AI slot, replacement image and narration line, in dependency order, with the
vendor and model routing picked and the parameters fitted to the model (resolution not below the slot's
`minWidthPx`, the shortest supported duration not under the slot's, the nearest aspect). Read every warning:

| Warning | Means | Tell the user |
|---|---|---|
| `falling back to keyframe` | no ready vendor takes a reference video | that shot is rebuilt from a new first frame, not copied move for move |
| `using the subjects only` | no image vendor takes the reference frame | the composition follows the prompt only |
| `avatar … needs narration mode and a voice` | a presenter slot without a voice | switch to narration or make the slot an image |

`estimate` gives a row per request, a table per model (unit price, count, subtotal) and totals per vendor
(TapVid in credits, others in dollars); rows marked low-resolution go into the table as "not sharp enough" (in the user's language). The model
table goes into the stop-2 message — the user sees where the money goes. Small, short-lived pictures (a pop-up
under half the canvas width or on screen under 3 s) carry the economy tier and take the cheapest model that
fits; hero shots keep the vendor's best. Rerun `plan` and `estimate` after every change to the replica.

A presenter that is a digital human speaking the script itself gets no narration requests for its scenes — its
own voice is the take (`references/audio.md` §2).

## 9. Checks during generation (step 7)

- **Replacement images first.** Open each generated one: right subject, whole, plain background. Regenerate
  once with a sharper description before anything uses it.
- **Keyframes.** Subject correctly swapped, hand count and fingers, the product's outline and colour, the
  composition matches the reference frame. A bad one is regenerated once before its video is submitted.
- **First invented screen** as in §7.
- **Every clip** with `inspect.mjs`, frame by frame at full size: extra or missing hands, wrong fingers, a
  morphing product, garbled text, clipping through objects, the subject drifting back to the original or into
  someone else. A clean span that covers the slot is trimmed and used; otherwise state the cost and regenerate
  once with the prompt fixed (fewer hands, one action, a keyframe).
- **Identity gate, every clip that shows a person.** Beside the replacement image and the original's subject
  frame, read `inspect.mjs "$REPLICA" <id> --identity` (the first second at 8 fps, the rest at 2 fps, at full width,
  because a person can be a few dozen pixels in a wide or overhead shot; zoom a crop when the face still cannot be
  told apart). Record what you saw: `identity.mjs pass|fail "$REPLICA" <id> --saw "<whose face, where>"`. Wrong person, or a
  person you cannot identify, is a failure: state nothing as swapped until you have seen the face. Do not trim
  around it: regenerate as `keyframe`. A fail takes the verdict off all the film's `reference` clips, since one leak says
  that mode is copying people on this source; a regenerated clip loses its own. `render.mjs` refuses while
  `identity.mjs status "$REPLICA"` lists anything, with no flag to skip it. A digital human and any slot whose
  reference or `replace` names a `person` subject is covered, so give every person a subject in `analysis/boards.json`.
- A slot that still fails becomes its sketch (`source: "code"`) and is listed in the delivery report.
