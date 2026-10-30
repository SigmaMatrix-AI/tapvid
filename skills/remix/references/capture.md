# Capturing the user's product

For the main agent, steps 4–5, whenever a slot shows the user's own product interface (`role: screen`, a
screenshot pop-up, a screen recording in the original). Recording the product is the recommended way — the
user logs in once, you do the rest — but it is the user's choice. Output: footage and stills in
`$REPLICA/assets/capture/`, set on the slots as `source: "user"`.

## 1. Which source

| Situation | Do |
|---|---|
| A web product the user can open in a browser | record it (§2–§5) |
| The user already has a demo recording or screenshots | `capture.mjs index` on their file (§4), then cut from it (§5) — no recording needed |
| A desktop or mobile app | ask the user to record it with the system recorder (macOS: ⇧⌘5; Windows: Win+Alt+R / Snipping Tool; iOS Simulator: `xcrun simctl io booted recordVideo --codec h264 out.mp4`; Android: `adb shell screenrecord /sdcard/out.mp4`, 180 s per take), then index it |
| No access at all (an invented product, a product not launched yet) | code-drawn interface (`references/replica.md` §5, `references/sketches.md`) |

Ask once, in the step-4 message, with the recommendation first (this pattern, in the user's language):

> The original shows product screens (screenshots and screen recordings). Three ways to do them:
> 1. I record your product (recommended): a browser window opens, you log in, I do the rest; you see the
>    result on the review page.
> 2. You give me demo recordings or screenshots you already have.
> 3. They are drawn as animation: nothing for you to do, but not your real interface.

- Nothing opens before the user agrees to option 1.
- A "no" to recording is final for this replica: use their files (option 2, through §4–§5) or animation
  (option 3); do not ask again. Files the user volunteers always win over recording.
- They may mix: record the web app, their own recording for the mobile app.
- Auto mode asks nothing: record public pages and products with a saved session (`login --check`); every other
  product screen is drawn as animation, and the delivery report says so.

## 2. Log in once

```bash
node "$SKILL_ROOT/scripts/capture.mjs" login <product url>
```

A browser window opens on the product; the user logs in there (password and 2FA are typed by them, never by
you) and closes the window. The session is saved on this machine only (`~/.tapvid-video/auth/<host>.json`,
outside the project). `capture.mjs login --check <url>` tells whether a session exists. Public pages need no
login (`"auth": false`).

## 3. Walk the flow, write the storyboard

First walk the product yourself with the browser tool the client offers (Playwright MCP, Claude in Chrome,
the Codex browser) — on the saved session or a public page — to learn the real labels, roles and waits. Then
write `$REPLICA/capture/<name>.json`, one storyboard per flow, following the replica's narration: each line
that shows the product gets the steps that make it true on screen.

```json
{ "name": "make-a-video", "url": "https://app.example.com", "auth": true,
  "viewport": { "width": 1920, "height": 1080 },
  "fake": [ { "find": "Jane Cooper", "replace": "Alex Kim" }, { "find": "/[\\w.]+@[\\w.]+/", "replace": "alex@example.com" } ],
  "mask": [ ".billing-card" ],
  "steps": [
    { "id": "home", "do": "goto", "url": "https://app.example.com/home", "hold": 1.0, "note": "step one: open the app" },
    { "id": "prompt", "do": "type", "target": { "role": "textbox", "name": "Describe your video" }, "text": "A 30-second launch video for Ledgerline", "cps": 14 },
    { "id": "generate", "do": "click", "target": { "text": "Generate" } },
    { "id": "result", "do": "wait_for", "target": { "testId": "result-player" }, "timeout": 180 },
    { "id": "download", "do": "hover", "target": { "role": "button", "name": "Download" }, "hold": 1.5 }
  ] }
```

- Steps: `goto`, `click`, `type` (`cps` characters per second, default 12), `press` (`key`, target optional),
  `hover`, `scroll` (`to` `{ y }` scrolls the page; a target scrolls its nearest scrolling container until the
  target is centred; eased over `duration`), `wait_for` (a target appears; `timeout` seconds, default 30),
  `hold` (lasts its own `hold`). Every step may hold after itself (`hold`, default 0.6 s) and carry a `note`
  (which line it serves). A click / type / hover target not visible within 15 s fails the step; one off screen
  is scrolled in smoothly first.
- A target must match exactly one element (strict): add the role or a closer label when a run reports several,
  or pick one with `"nth": <0-based index>` (e.g. the player's Play button among thumbnail ones).
- Targets by meaning, in this order: `{ role, name }`, `{ label }`, `{ placeholder }`, `{ text }`, `{ testId }`,
  `{ selector }` last.
- **Real content for the new film**: type what the replica's copy says ("Describe your video" gets the
  example the narration mentions), not test strings.
- **Privacy**: `fake` swaps every name, email, amount and account detail that would show for neutral ones (plain
  text or `/regex/`; text nodes and input values — not `title` / `placeholder` attributes, not the focused
  input); `mask` blurs what cannot be swapped. Passwords are never typed in a storyboard (`record` refuses).
- Actions that cost the user money or change their account for real (pay, publish, delete, invite, spend
  credits on a generation): ask before including them, say what it costs. A generation the flow needs can
  often be shown by opening one the user already made.

## 4. Record and index

```bash
node "$SKILL_ROOT/scripts/capture.mjs" record "$REPLICA" "$REPLICA/capture/<name>.json"
node "$SKILL_ROOT/scripts/capture.mjs" index "$REPLICA" "$REPLICA/assets/capture/<name>"
```

`record` performs the steps while recording `recording.mp4` (1080p, with a drawn cursor gliding to each target
and a ripple on every click; 60 fps), writes `log.json` (each step's action from `start` to `end` on the
video's timeline — within a frame — then its hold until the next step, and the box of the element it acted on)
and a sharp 2× screenshot per step in `shots/`, taken at the end of the hold (the drawn cursor is in it). A failing step stops the run with an
error screenshot: read it, fix the storyboard, rerun. `login needed` → §2.

`index` turns the recording (or a file the user gave, which has no log) into `index.json` — segments marked
`typing`, `click`, `scroll`, `wait`, `result`, `motion`, `still`, with times and boxes — and a contact sheet.
Look at the sheet and the shots before cutting: right page, right data, nothing private left, no spinner stuck,
no error toast. Rerecord rather than use a bad take.

## 5. Cut the material for each slot

```bash
# a moving slot: the span the line talks about, cropped to its region, fitted to the slot's length
node "$SKILL_ROOT/scripts/capture.mjs" clip "$REPLICA" --from <name> --start 12.4 --end 19.0 \
  --box 0.05,0.10,0.60,0.55 --aspect 16:9 --duration 3.2 --out assets/capture/03-Steps02.steps.1.screen.mp4
# a still slot: the step's 2× screenshot, cropped
node "$SKILL_ROOT/scripts/capture.mjs" clip "$REPLICA" --from <name> --still 15.0 --box 0.05,0.10,0.60,0.55 \
  --out assets/capture/03-Steps02.steps.1.screen.png
```

| The original's slot | Take |
|---|---|
| a moving screen (`video` field, `role: screen`) | the segment the line describes; `--duration` = the slot's on-screen time, so waits are compressed and typing keeps its pace; crop to the part the line talks about |
| a still screenshot pop-up (`image` field) | `--still` at that step: the 2× shot, cropped to the element's box (from `log.json`) with some margin |
| a still slot whose board plays a motion list (`references/boards.md` §6) | the still, plus beats from `log.json`: `focus` / `ring` on the step's box, `click` at its centre, `type` with the typed text |

- Crop to what the line says: the narration names one control or result, the frame shows it big. The original's
  slot aspect (`media.aspect`) decides `--aspect`.
- Compress waiting (a progress bar, a generation running) with `--duration`; never speed typing or cursor
  moves above about 1.5× — the eye reads it as fast-forward.
- Set each slot: `{ "kind": "<image|video>", "source": "user", "file": "assets/capture/<…>", "visual": "<one line in the user's language>" }`.
- Missing a moment (the flow skipped it, the product looks different): add steps and record again — recording
  is free.

## 6. Checks before stop 2

- Every product slot has footage or a still from the capture (or a code-drawn fallback with the reason).
- Look at each clip's first, middle and last frame: the right screen, readable at the slot's size, the cursor
  where the line says, no private data, no errors or empty states.
- The review page's Replica preview shows them in place; the Assets tab lists them.
