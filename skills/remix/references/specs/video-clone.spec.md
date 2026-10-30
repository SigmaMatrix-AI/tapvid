# Remix skill design

## 1. Goals and scope

The user provides a reference video (a local mp4, a video link, or keywords the plugin uses to search for a popular video) and a new topic (optionally with replacement materials such as photos of people or product images). The plugin produces, on the user's machine:

1. **A reusable template**: the reference video's narrative structure, layouts, motion, transitions, colours and fonts, broken down into a set of React boards, a transition table and a narrative description, independent of any specific topic. The footage of every media slot in the original is also extracted and saved with the template as reference material for later generation;
2. **The replica film** `tapvid.mp4`: using this template, the copy is rewritten for the new topic; new footage is generated with the corresponding shots of the original as reference (following the reference video's camera motion, composition and pacing, with people and objects swapped for the ones the user specifies); then narration and music are added, and the film is rendered frame by frame.

The next time the user makes a video of the same kind, they take this template, change the topic, skip the breakdown, and start from writing the replica.

This document describes the `high` tier, the full 1:1 clone. This is the default tier. The `low` tier replaces step 3 with a generated template and makes the non-speaking shots by reference-to-video; see `video-clone-tiers.spec.md`.

The whole flow is **one skill, one continuous flow**: understand the original → build the template → clone comparison → write the replica → review page → generate → narration / music → render. The goal is **one-pass production**: every self-check of every stage is done by the skill; the user only confirms and never has to report problems item by item.

Two modes:

| Mode | Trigger | User involvement |
|---|---|---|
| **plan** (default) | auto not requested | Two confirmation points: after the template is built, confirm the 1:1 clone (stop 1); the replica with its per-model cost (stop 2, the only confirmation before any cost is incurred). Generation and rendering then run to delivery |
| **auto** | `auto` in the arguments, or the user says "fully automatic", "just make the video", "don't ask me" | Asked for the topic only when it is missing; replacements, copy, voice, music, GIFs and model tiers are all decided by the skill. A budget the user gives is a hard cap (first downgrade the model tier, then turn media slots into animation; if it still exceeds the budget, stop and explain); without a budget, generate at the economy tier defaults and state the estimated cost in one sentence when generation starts |

A stop is a confirmation, not a review: before a stop, every self-check of that stage must pass and every fix must be done. Differences the self-checks cannot resolve (a font with no open-source look-alike, a moving media slot of the original that must be regenerated) are written down as known limits with their reason, never raised to the user as questions.

**Respect the user's decisions**: the topic, the people and objects to replace, and the user's own materials all come from the user; the skill sets no defaults for them. Only when the user explicitly hands over the choice ("you decide", "just pick one") does the skill recommend 2–3 options for the user to choose from, or choose directly and state the reason. Production choices such as the audio mode, voice and BGM are recommended by the skill and confirmed by the user.

**Clone 1:1 first, then ask about the replica**: understanding the original and building the template (steps 1–3) is a 1:1 reconstruction of the original. It needs no content decisions from the user, so no questions are asked in advance; the questions about the replica are asked all at once after the template is built (at the start of step 4), when what the original actually contains can be shown to the user. Local, free infrastructure (ffmpeg, the runtime, whisper, yt-dlp) is installed directly with a one-sentence notice, without asking for consent.

Media capabilities (video, image, narration, music, digital human, search, download, transcription, video understanding) go through the plugin's unified **media capability layer**, which can be backed by any provider: the TapVid open API, vendors' official APIs, aggregators (fal, Replicate), and providers the skill writes on the spot for the user following the agreed pattern. A user with a TapVid key covers most capabilities with that one key; without one, each capability is routed according to whichever vendors' keys the user has. Every call is a script making a direct HTTP API request, with no dependency on any MCP server connected to the client.

Out of scope:

- Publishing the template to the TapVid platform; no dependency on Template Studio;
- No runtime dependency on another repository or plugin: this skill includes its analysis workflow and render runtime;
- The original's picture and sound never appear directly in the final film. The original has only three uses: analysis, comparison on the review page, and reference input to generation models.

## 2. Distribution

The plugin is self-contained: the SOP, reference documents, capability schemas, built-in providers, render project skeleton and scripts are all released with the plugin version. Runtime dependencies are installed into `~/.tapvid-video/runtime` (the plugin cache directory is a per-version snapshot and changes on every upgrade); user configuration, user-written providers, the upload cache and local models live in `~/.tapvid-video/` and are unaffected by plugin upgrades.

```text
tapvid/
├── README.md, LICENSE, THIRD_PARTY_NOTICES.md
├── skills/remix/
│   ├── SKILL.md
│   ├── references/          # workflow documents; specs/ contains this document
│   ├── scripts/
│   │   ├── *.mjs           # command-line entry points
│   │   ├── lib/            # runtime, project, media and platform helpers
│   │   ├── providers/      # built-ins, _template.mjs and __fixtures__
│   │   ├── runtime-package.json
│   │   └── runtime-package-lock.json
│   └── assets/
│       ├── schemas/        # capability and project JSON schemas
│       └── template/       # player, review shell, components and music
└── tests/remix/             # unit tests and synthetic sample clone
```

Source provenance and third-party dependencies are recorded in the repository’s `THIRD_PARTY_NOTICES.md`.

The runtime needs only **Node ≥ 20, ffmpeg and Chromium (Playwright)**; no Python or opencv. Downloading videos needs `yt-dlp` and local transcription needs `whisper.cpp` (command `whisper-cli`); these two are checked only when used.

### 2.1 Platform support

**macOS and Windows 10 / 11** (x64, arm64) are supported, from both Claude Code and Codex. Every script is a Node script; there are no bash or PowerShell entry points. The four OS-specific operations live in `scripts/lib/platform.mjs`; no other code checks the platform:

| Operation | macOS | Windows |
|---|---|---|
| Install system dependencies | Homebrew: `brew install node ffmpeg yt-dlp whisper.cpp` | winget: `OpenJS.NodeJS.LTS`, `Gyan.FFmpeg`, `yt-dlp.yt-dlp`; whisper.cpp has no winget package, so its prebuilt Windows package is downloaded from its GitHub release and unpacked into `~/.tapvid-video/bin/` |
| Prompt for a key in a dialog | `osascript` `display dialog … with hidden answer` | PowerShell WinForms password box (`UseSystemPasswordChar`) |
| Store and read a key | Keychain: write with `security add-generic-password -s tapvid-video -a <SECRET_NAME> -U`, read with `security find-generic-password -s tapvid-video -a <SECRET_NAME> -w` | DPAPI-encrypted file (current-user scope): PowerShell `ConvertFrom-SecureString` writes `~/.tapvid-video/secrets/<SECRET_NAME>.dpapi`, `ConvertTo-SecureString` reads it; only the same Windows user can decrypt it |
| Open a file | `open <path>` | `cmd /c start "" <path>` |

Other cross-platform conventions:

- The home directory is always `os.homedir()` + `path.join`; on Windows `~/.tapvid-video` is `%USERPROFILE%\.tapvid-video`. Paths written into json are always stored as POSIX-style relative paths and converted to native paths on read, so a project directory can be copied between the two systems;
- Child processes are always `spawn(command, args)` with an argument array, never a concatenated shell command string, which avoids the quoting differences between cmd.exe and bash. External commands resolve their executable per platform: on Windows `.exe` is appended; right after a winget install, when the current session's PATH has not refreshed yet, the default install directory is searched;
- File I/O is always UTF-8, never the system code page (Simplified Chinese Windows defaults to GBK); ffmpeg and Chromium output is handled as byte streams;
- Linux is not supported: on Linux `platform.mjs` only prints a notice to install the dependencies manually and supply keys through environment variables.

## 3. Project directory

Each reference video has one project directory, by default `./clone-<id>/`. `<id>` is named by content as `<topic>-<kind>`, such as `saas-launch-explainer`.

```
clone-<id>/
├── source/
│   ├── source.mp4            # the original (copied or downloaded)
│   ├── source.json           # ffprobe result; a download also has url, title, author
│   ├── timeline.json         # frame-level timeline: shots, transitions, motion peaks, words, beats (section 4, step 2)
│   ├── transcript.json       # transcription: segments and words (with timestamps)
│   ├── understanding.json    # shot-by-shot description from a video understanding model (when a provider is available)
│   ├── audio.wav             # the original's audio track
│   ├── sfx.json              # sound effect events of the original: time, duration, loudness, spectral centroid, type guess
│   ├── sfx/                  # clip and spectrogram sheet per sound effect event
│   └── frames/
│       ├── overview.jpg      # full-film contact sheet at 1 frame per second
│       └── shots/<n>/        # dense frames per shot and a timestamped strip
├── analysis/
│   ├── brief.json            # what this video is: kind, product, narrative arc, shot list, the original's audio makeup
│   ├── boards.json           # per board: window in the original and segments, cover time, comparison media, count variants
│   ├── elements.json         # element inventory: measured box, entrance/exit, idle motion, content motion, font, sound effect of each element instance
│   ├── motion.json           # measurements from measure.mjs motion
│   └── measure/              # grid images and font comparison images used for measuring
├── template/                 # the reusable template (section 6)
│   ├── template.json         # canvas, default scene order, transition table
│   ├── design.js
│   ├── fonts.json
│   ├── fonts/<Family>-<weight>.woff2
│   ├── skill/SKILL.md        # narrative structure
│   ├── boards/<Name>.{jsx,json,mp3,html,png}
│   ├── refs/                 # reference clips, reference frames, subject crops per media slot + refs.json
│   └── cover.png
├── compare/                  # comparison screenshots (generated)
├── review/                   # clone comparison page (stop 1)
├── report.md                 # template report: split reasons, layering, comparison scores, timeline offsets, font substitutions, topic-swap test topic
└── replicas/
    └── <slug>/               # one directory per replica; slug is a short English name for the topic
        ├── replica.json      # the replica (section 6.5), the single source of truth
        ├── product.md        # product card for an invented product (invented products only)
        ├── sketches/         # placeholder motion sketches <Board>.<path>.jsx
        ├── elements/         # code components for element fields <Board>.<key>.jsx
        ├── plan.json         # media task list (input to media.mjs)
        ├── tasks.json        # media task ledger (resume, no double charging)
        ├── capture/<name>.json   # product recording storyboard
        ├── assets/{user,gen,audio,gif,capture}/   # capture/<name>/: recording.mp4, log.json, shots/, index.json
        ├── review/           # review page index.html and the files it references
        ├── project/          # render project (copied from the plugin's template/ skeleton)
        ├── out/tapvid.mp4        # the current final film; other versions the user asks for are out/tapvid-<label>.mp4
        └── report.md         # delivery report: costs, fallbacks, provider of each asset
```

## 4. Main flow

The main SOP is written for non-technical users: the conversation never shows file names, field names, model codes or script output; picture sources are always called "AI video / AI image / GIF / animation / your material / digital human", providers are called by vendor name ("MiniMax", "fal", "TapVid", "GIPHY"), and models by product name ("Nano Banana"). While scripts and generation tasks run, each step gets one line of progress. The whole conversation uses the user's language: when the film is in another language, the copy is accompanied by its meaning in the user's language, and the conversation language does not change. The example messages, table headers and wording in the SKILL and reference documents are patterns written in English; the agent rewrites them in the user's language rather than pasting them verbatim: an English-speaking user sees no Chinese, and a Chinese-speaking user sees no English labels.

Everything the user needs to look at is on the review page: the original compared with the template, the replica preview, the costs, the final film compared with the original, every version of the final film, and every generated asset. After a change, the review page is rebuilt and the tab to look at is named; videos, audio and images are never opened separately in an external player.

### Step 0: Environment

Run on every invocation:

1. `node scripts/ensure-runtime.mjs`: checks `node >= 20`, `ffmpeg`, `ffprobe`. Anything missing is installed directly with this platform's package manager (Homebrew on macOS, winget on Windows, see section 2.1) without asking for consent; only when there is no package manager or a manual step is needed are the install instructions given to the user. Installs `esbuild`, `react`, `react-dom`, `tone`, `playwright` and Chromium into `~/.tapvid-video/runtime/`, skipped when the dependency manifest hash matches.
2. `node scripts/media.mjs providers --json`: learns which providers are currently available for each capability (key configured and verified), without disturbing the user. When no transcription provider is available, runs `node scripts/ensure-runtime.mjs --tool whisper-cli` to install local whisper directly. Keys and generation providers are brought up in step 4.

### Step 1: Input

**Reference video**:

| What the user gives | Handling |
|---|---|
| A local mp4 | Go straight to step 2 |
| A video link | Download into `source/` with `video.download` |
| Keywords (such as "find a SaaS launch video that has been popular recently") | Search with `video.search`, list the candidates in a table (title, duration, views, publish date, link), download the one the user picks |
| An existing project directory `clone-<id>` (or its `template/`) | Reuse the template, jump to step 4 |

When search or download fails (no provider available for the platform, the link needs a login, the download is refused), fall back in this order:

1. With the user's permission, the agent uses whatever browser automation the current client provides (Claude Code's Chrome browser control, or computer-use style tools) to work in the user's own browser: open the platform page, search, get the video page link or download the file. The user logs in themselves; paywalls, DRM and CAPTCHAs are never bypassed; only the video the user picked is handled;
2. Ask the user to download it themselves and provide the file path.

If the user has already given the topic, note it; apart from picking a video from the search results, this step asks no other questions. Before downloading a link, run `ensure-runtime.mjs --tool yt-dlp`.

### Step 2: Understand the original (frame level)

A fast-paced video can have a transition every few seconds and an element entrance every few frames. The replica has to align to the second or even the frame, so the analysis is built on the full frame rate, not on sparse frame sampling.

`node scripts/intake.mjs <project> <source>`:

1. Copy the original to `source/source.mp4` and write `source.json` with ffprobe.
2. **Frame-level cut detection**: compute a scene-change score for every frame with ffmpeg (the `scene` value of `scdet` / `select`) and write it into the timeline with its frame number.
   - A single-frame jump is a hard cut;
   - A score that stays above a lower threshold for several frames is a soft transition (dissolve, wipe, push, zoom); its start and end frames are recorded.
3. **Motion curve**: compute the inter-frame difference for every frame (`YDIF` from `signalstats` plus the scene score) and find the motion peaks, i.e. the start and end of camera pushes and pulls and the moments elements enter.
4. **Audio**:
   - Extract the audio track `audio.wav`;
   - Transcribe with `speech.transcribe` into `transcript.json` with word-level timestamps; empty when there is no voice;
   - Detect the music's bpm and beats with `beats.mjs`;
   - **Sound effect detection**: find peaks in the onset strength, drop peaks that fall inside a word (40 ms either side) and are not clearly louder than the surrounding speech envelope, and merge peaks within 80 ms of each other; for each event record time, duration, peak loudness, spectral centroid and a type guess (`click` / `pop` / `whoosh` / `ding` / `impact` / `other`), cut out its clip and build a spectrogram sheet, and write `source/sfx.json`. With BGM the onsets are dense, so only the 60 strongest are kept and `dense: true` is set.
5. **Frame extraction**:
   - A full-film contact sheet `overview.jpg` at 1 frame per second;
   - Dense, timestamped frames per shot, by shot length: 1 frame in 4 for shots shorter than 2 seconds, 4 frames per second for 2–6 seconds, 2 frames per second for longer shots;
   - Always taken: the first and last frame of each shot, the frame at each motion peak, and the start, middle and end of each transition;
   - Assembled into a shot strip `frames/shots/<n>/strip.jpg`.
6. Write `source/timeline.json`, in seconds rounded to frames, keeping the frame numbers as well:

```json
{
  "fps": 30, "duration_s": 48.2, "frames": 1446,
  "shots": [
    { "index": 0, "start": 0, "end": 2.133, "start_frame": 0, "end_frame": 64,
      "transition_in": null,
      "transition_out": { "type": "soft", "start": 1.933, "end": 2.133 } }
  ],
  "motion_peaks": [{ "t": 0.4, "frame": 12, "shot": 0, "strength": 0.82 }],
  "words": [{ "text": "Your", "start": 0.21, "end": 0.42 }],
  "beats": { "bpm": 104, "times": [0.0, 0.577, 1.154] }
}
```

7. When a `video.understand` provider is available, the original is handed to the video understanding model for a shot-by-shot description, `understanding.json` (what is in each shot, what happens, how the camera moves). It is used to cross-check the agent's understanding from reading frames; for timing, `timeline.json` is authoritative.

Following `references/analysis.md`, the main agent reads each shot's strip, the full-film contact sheet, the transcript and the shot-by-shot description, and writes `analysis/brief.json`. It contains:

- Kind: `product-demo` / `explainer` / `testimonial` / `brand` / `greeting` / `other`;
- The product and the narrative arc;
- The shot list: for each shot its time window, `shows` (`desktop` / `phone` / `tablet` / `text` / `brand` / `footage` / `presenter`), its role, the subjects in frame (people, products, logos), camera motion, and the transition from the previous shot;
- The original's audio makeup (narration / music / original sound), and whether the original has burned-in captions and their style.

### Step 3: Build the template

Follow `references/analysis.md`, `boards.md`, `transitions.md`, `structure.md`, `acceptance.md` in that order. Each step's output is written before moving on to the next:

1. **Split into boards**: decide the number and boundaries of boards by the principles of section 6.2. One board corresponds to one layout system, not to one shot:
   - When the whole film is one continuous take or moves across one infinite canvas, a single segmented board can suffice, with the content at every point in time expressed as parameters;
   - When layouts differ and are joined by designed transitions, split into several boards and write the transitions into the transition table.

   Write the split and its reasons into `report.md`.
2. **Breakdown**: separate structure from topic → region roles → turn repeated units into lists → layer each board (all code / code + media slot / full-frame media) → write `analysis/boards.json`: each board's window, shots and segments (taken directly from the frame-level times in `timeline.json`), and for each media slot its region `crop` in the original, an optional time window, and the subjects in it, `subjects` (`{id, kind, box, t}`), used by step 7 to extract reference material.
3. **Element inventory**: write every element instance (pop-up picture, sticker, title, caption, icon, number, screenshot card, presenter) into `analysis/elements.json` (section 6.6): measured box (`measure.mjs grid` overlays a 2 % grid on the frame and each box is read off it; the original rarely reuses the same box), entrance and exit times and styles, idle motion, content motion, font role, entrance sound effect. Then `measure.mjs motion` measures the inter-frame difference inside each element's box: still, boil (a held pose that jitters, with poses per second), or continuous motion (GIF loop, screen recording, live footage, with the loop period). A media slot whose content moves is a `video` field (a GIF loop adds `media.loop: true`), not an image field with a reference frame; otherwise the replica turns the GIF into a still.
4. **Transition table**: for each board boundary, measure the transition type, duration and parameters from the soft transition windows in `timeline.json` and the corresponding frames, and write them into `transitions` in `template.json` (section 6.3).
5. **Globals**: measure the palette from the original and write `design.js`; write the caption style as measured from the original into `Design.captions` (position, size, words per group, background plate or not, letter case, word-by-word reveal). For each text role, `measure.mjs fonts` renders 6–12 open-source candidate fonts of the same kind side by side with a crop of the original; pick by letterforms (`a`, `g`, `R`, terminals, stroke contrast), take the size from the measured cap height, then run `node scripts/fonts.mjs` to download the fonts. A font not licensed under OFL / Apache is replaced with the closest open-source font and recorded in the report.
6. **Boards**: once the main agent has fixed `design.js`, the fonts, the transition table and each board's window, the main agent writes the boards layout by layout; for a template with 4 or more layouts **one sub-agent per layout runs in parallel** instead (fast tier, writing every board of that layout; a layout still failing after 2 rounds goes to the strong tier for up to 3 more — SKILL.md §Sub-agents). Following that board's element inventory, its writer produces `boards/<Name>.jsx` and `.json`: every instance replays its measured box, images keep their own aspect ratio, idle motion is implemented with the measured parameters (boil takes a seeded hash per pose at the measured poses per second and holds still between poses), elements that make a sound carry `data-sfx`, and code components carry `data-part`. It then runs `refs.mjs --only <Name>` (extracts that board's reference clips, which fill the media slots in the comparison), `build-boards.mjs --only <Name>` and `compare.mjs --only <Name>`, reads the score table, opens the comparison image only of a row under 0.95, and fixes element by element against the element inventory and the acceptance checklist until it passes.
7. **Reference material**: `node scripts/refs.mjs <project>` extracts (or completes) reference material for every `image` / `video` media slot according to `boards.json` and writes `template/refs/refs.json` (section 6.4):
   - A reference clip from the corresponding window of the original, cropped to the media slot's region;
   - A reference frame;
   - Crops of the subjects in frame (people, products, logos).

   The main agent adds a one-sentence English description of the picture and its motion for each media slot.
8. **Narrative structure**: write `template/skill/SKILL.md` and `template/template.json`.
9. **Topic-swap test**: with a second topic within the same structure, reread every narrative and field description; set each list field to `minItems` and then `maxItems`; fill each text field with Chinese and then with English about 1.5 times as long. Check board by board: no overflow, no overlap, no holes.
10. **Acceptance**:
   - Full build with `build-boards.mjs`;
   - Clock check (`clock.mjs`): the frame after pausing, seeking back and jumping forward matches the frame from seeking directly to the same time (within a frame for a video in a slot);
   - `compare.mjs --fail-under 0.95`: shot-by-shot comparison at three moments per shot, 25 % / 60 % / 85 %; each segment of a segmented board is checked the same way. Boards run in parallel, and a board whose page, reference clips, timeline and transitions are unchanged reuses its last results (`compare/cache.json`, `--fresh` to measure all again);
   - `compare.mjs --timing`: every shot boundary, transition start and end, element entrance and sound effect cue in the template preview is within 1 frame (2 frames for sound effects) of `timeline.json` / `sfx.json`;
   - `validate.mjs template` reports no errors (including consistency between the element inventory and the boards: every media field has an element, no moving element is an image field, measured motion matches what is declared);
   - Check the element inventory item by item (`references/acceptance.md` §7): measured boxes, letterforms, font size and line breaks, composite pieces (such as one paper scrap per letter), idle motion, content motion, caption style, sound effects.

   A sample below 0.95 may remain only for a reason no template change can fix (a font with no open-source look-alike, the original content in a media slot itself moving, a presenter's gestures and jump cuts), written into `report.md` as a known limit; everything else is a problem to fix.
11. Write `report.md`: kind and product, narrative structure, board split and reasons, each board's layering and region roles, the transition table, comparison scores, timeline offsets, font substitutions and candidates, known limits, the topic-swap test topic.

**Stop 1: clone comparison** (plan mode; auto mode continues directly). `node scripts/review.mjs <project>` (without a slug) builds and opens `review/index.html`: the template plays in sync with the original, with component frames, the original's sound and the template's sound effects. In the conversation, a few lines state the fidelity (the number of samples ≥ 0.95, the timing offset), what was measured and rebuilt (fonts, element boxes, idle motion, captions, sound effects), and the known limits with their reasons, and ask the user to confirm.

This step costs only tokens and time; it incurs no generation cost.

### Step 4: Write the replica

Follow `references/replica.md`. First research the topic and the user's product on the web (official site, docs, press kit, app-store page) and write `<project>/research.md`: what it is, key features and numbers, audience, tone, brand colours, the official logo, links to real screenshots and demo videos, each with its source, and what could not be found. Research is tried first for gaps in the user's materials; what it cannot find or confirm (a product with no web presence, unreleased features, the user's own photos) is asked of the user. The questions propose concrete answers where research found them, and the copy is written from it. Then ask, in one message, everything about the replica the user needs to decide, starting from what the original actually contains (the structure in one sentence, e.g. "A presenter talks to camera; above their head a title, four step numbers, software screenshots and memes pop up in turn; word-by-word captions at the bottom"):

- **New topic**: if the user has not given one yet, ask them to say in one sentence what this video is about (product, event, occasion);
- **Replacements**: what each person, product, logo and sticker in the original becomes, or whether it is removed. Ask the user for photos and product images and copy them into `replicas/<slug>/assets/user/`; without materials, explain that AI can generate them from a description, or they can be drawn as animation;
- **Product UI**: for the product screenshots and screen recordings in the original, offer three approaches and recommend the first: the skill records the user's product (section 4.1; the user only logs in once in the window that pops up); the user provides existing recordings or screenshots; draw it as animation. The user chooses; no window is opened before they agree. If the user declines recording, use their materials or animation and do not ask again. In auto mode, only public pages and products already logged in on this machine are recorded; everything else is drawn as animation;
- **GIFs**: moving pictures in the original (meme GIFs, short looping clips) use real GIFs from GIPHY (free, needs a free GIPHY key), or have AI animate a generated image (charged per clip). Real GIFs are recommended for meme-style originals;
- **Repeated content**: the corresponding content under the new topic (such as the four steps), or whether the skill drafts it first;
- **Production choices** (the skill recommends, the user confirms): language; audio mode, recommended from the original's makeup (`narration` when the original has voice narration, `music-only` when it has only music); in `narration` mode, list recommended voices with `speech.voices` for the user to pick, one voice shared by the whole film and the digital human;
- **Generation capabilities**: from step 0's provider list, say which capabilities are ready, what each missing capability affects and how it falls back (section 5.5), and the easiest way to fill the gap: a TapVid key is enough (create one at https://tapvid.ai/developer/apikey, then run `node scripts/set-key.mjs tapvid`); a user who already has a vendor's key runs `node scripts/set-key.mjs <provider>`; a service the user wants that is not in the built-in list gets a provider written on the spot per section 5.7. Keys enter scripts only through the dialog or environment variables, never pasted into the conversation. The flow can continue without any generation provider; every media slot is then treated as "animation".

Only when the user explicitly hands over the choice ("you decide") does the skill offer 2–3 options to choose from, or choose directly and state the reason. In auto mode the skill decides all of the above itself. Then:

1. `node scripts/replica-init.mjs <project> <slug>` generates the `replicas/<slug>/replica.json` skeleton: scenes in the template's default order, each with its board's `example_data`, and each media slot with its reference material and subjects from `refs.json`.
2. **Replacement table**: write the user's replacements into `replace` in `replica.json`, each entry stating which subject of the original becomes what. A replacement can be the user's material, or a character sheet or product image AI generates from a description: generate one first and share it across every media slot in the film, which keeps it consistent. Replacements the user has not given and has not handed over to the skill are clarified with the user here. When the head top of the presenter portrait differs by more than 5 % of the frame height from the original presenter's head top recorded in the template (`media.headTop`), reframe it first for free with `reframe.mjs`: shift the whole picture, fill the gap with a blurred extension, feather the seam. Otherwise the template's pop-up elements cover the face.
3. When the new topic is an invented product (only with the user's agreement), first write `product.md`: name, one-line positioning, users, one brand colour plus one neutral colour, light or dark UI, and the 3–6 screens the video needs. Every UI prompt and all copy follow it.
4. Rewrite each scene's `narration` and `data`:
   - Keep the structure: the number of scenes and the board each scene uses do not change;
   - Respect each field's `maxChars` / `minItems` / `maxItems`;
   - Choose list counts within the range as the topic needs, not by copying the example's count;
   - **Copy budget** (`narration` mode): each scene's narration has no more syllables than the original's speech rate in that window (syllables per second, counting only speech) × the window duration × 1.08. Chinese counts one character as one syllable. Overlong copy is the root cause of replicas that are slow and long; `validate.mjs replica` warns per scene and prints both numbers;
   - In `music-only` / `silent` mode the `narration` field is on-screen copy only and is not voiced.
5. **Media plan**: decide the source and generation method for each `image` / `video` media slot (section 6.5):

   | Source | Generation method | Approach |
   |---|---|---|
   | `ai` | `reference` (default when a reference clip exists) | `video.generate` with the reference video (the corresponding shot of the original) and the replacement images. Prompt pattern: "Use video 1 as the reference for camera motion, composition and timing; replace the person with the person in image 1 and the product with the product in image 2; <scene description for the new topic>; no on-screen text, no logos" (the original's titles and captions are drawn by the boards; text or a logo that the original's footage itself shows, such as a shop sign or a phone screen, is described in its new-topic version instead). An image media slot uses `image.generate` instead, editing with the reference frame and the replacement images |
   | `ai` | `keyframe` (when the provider does not support reference videos) | First generate a new first frame with `image.generate` from the reference frame plus the replacements, then image-to-video with `video.generate`, the prompt describing the original camera motion recorded in `refs.json` |
   | `ai` | `text` (no reference material, e.g. more list items than the original) | Prompt only, plus one reference frame of the original as a style reference |
   | `user` | — | The user's material goes on screen directly |
   | `code` | — | The placeholder sketch is the final picture, at no cost (recommended for UI and chart media slots) |
   | `user` (GIF) | — | A media slot that is a GIF in the original: `gif.mjs search` searches GIPHY by the narration's meaning and builds a contact sheet of 8 candidates, the agent looks at it and picks one, and `gif.mjs pick` downloads it into the media slot (`loop: true`, attribution goes into the delivery report). Never the same GIF the original used |

   - A media slot can also use a video found with `video.search` whose license permits use (such as Pexels, Pixabay); it is downloaded and put on screen as a `user` source, with license and attribution written into the delivery report;
   - `element` fields are always implemented in code, written as `elements/<Board>.<key>.jsx`;
   - A board with an on-camera person (a `presenter` field) is sourced from a digital human and allows only `narration` mode; the portrait is the person from the replacement table;
   - A media slot that moves in the original never gets a still: use a GIF, a short AI clip, the user's screen recording, or a code animation (scrolling, a cursor, typing over the user's screenshot).
6. `node scripts/media.mjs plan <replica>` writes `plan.json` from `replica.json`. Routing picks a provider, model, resolution and duration for each request (section 5.5): media slots generated by reference prefer models that support reference videos. Small, brief pictures on screen (less than half the frame wide, or on screen for less than 3 seconds) carry the economy tier flag and automatically get the cheapest model that meets the resolution; a model the user specified for a media slot takes precedence. Then `media.mjs estimate plan.json` computes the estimated cost per row, per model (unit price, quantity, subtotal) and in total, summarised per provider; TapVid is counted in credits, everything else in US dollars.

### 4.1 Recording the user's product

Product launch and tutorial videos need footage of the user's product UI. The recommended approach is for the skill to record the product while the user logs in only once; whether to record is the user's decision (details in `references/capture.md`):

1. **Log in once**: `capture.mjs login <url>` opens a browser window where the user logs in themselves (passwords and two-factor authentication never pass through the agent); after the window closes, the login state is saved on this machine at `~/.tapvid-video/auth/<host>.json`, outside the project directory. Public pages need no login.
2. **Scouting and storyboard**: the agent first walks through the flow with the browser capability the client provides (Playwright MCP, Claude in Chrome, the Codex browser) to get the real button names and wait points, then writes `capture/<name>.json` following the replica's narration: `goto` / `click` / `type` / `press` / `hover` / `scroll` / `wait_for` / `hold`, with targets located semantically (role + name, label, placeholder, text, and only as a last resort a selector). Typed content comes from the replica's copy. `fake` replaces names, email addresses, amounts and the like with neutral data, and `mask` blurs regions that cannot be replaced; the storyboard never types a password; operations with real effect such as payments, publishing or deleting need the user's consent first.
3. **Recording**: `capture.mjs record` performs the storyboard and produces at the same time a 1080p screen recording `recording.mp4` (with a drawn cursor that glides to each target and a ripple on clicks), an action log `log.json` (each step's start and end on the video timeline and the box of the element it acted on, aligned by a flash frame at the start), and one 2x screenshot per step. If a step fails, recording stops and leaves an error screenshot; the agent fixes the storyboard and records again.
4. **Asset index**: `capture.mjs index` builds `index.json` from the recording and the log (for a recording the user provides without a log, from cut detection and motion analysis): `typing` / `click` / `scroll` / `wait` / `result` / `motion` / `still` segments with their times and screen regions, plus a contact sheet for the agent to look at.
5. **Cutting assets**: `capture.mjs clip` cuts per media slot: for a recording slot that moves in the original, the stretch the narration talks about, cropped to the region it talks about, with `--duration` compressing the waits to the media slot's duration (typing and cursor movement at most about 1.5x); for a still screenshot slot, that step's 2x screenshot cropped to the element box; for a board with a motion list, the screenshot plus focus / ring / click / type actions generated from the log. The media slot source is recorded as `user`.
6. For desktop or mobile apps, ask the user to record with the system recorder (macOS ⇧⌘5, Windows Win+Alt+R, `xcrun simctl io booted recordVideo --codec h264`, `adb shell screenrecord`) and pass the recording to `index`; when the product cannot be obtained at all, fall back to a code-drawn UI.

### Step 5: Review page media

What each media slot shows on the review page:

| Media slot | Picture on the review page |
|---|---|
| `ai`, with a reference clip | Plays the corresponding reference clip of the original, labelled "Reference", overlaid with the replacement notes ("Person → your photo", "Product → AI-generated", switching with the page language), with an expandable prompt |
| `ai`, without a reference clip | Placeholder motion sketch |
| `code` | Placeholder motion sketch, which is the final picture |
| `user` | The user's real material |

Once assets are generated, the replica preview switches to the generated assets and the real narration, with durations from the real narration.

For media slots that need a sketch, the agent writes `sketches/<Board>.<path>.jsx`. A sketch must match its prompt and be finished work; the bar is in section 7.2 and `references/sketches.md`. All the sketches of one board go to one sub-agent, in parallel; the sub-agent captures three frames at 25 % / 50 % / 85 % with `frames.mjs --sketch <file>` to self-check and rewrites anything below the bar, at most 2 rounds. GIF media slots are searched and chosen in this step (free).

Self-checks before stop 2: `validate.mjs replica` has no errors and the copy budget warnings are handled; every media slot that moves in the original has a moving source; product UI assets are ready from the source the user chose (recordings or user materials checked one by one at their first, middle and last frames for no personal information, no errors, no empty states; or drawn in code); the presenter portrait's head top has been checked; the warnings from `media.mjs plan` are understood.

### Step 6: Stop 2, replica and cost (the only confirmation before any cost is incurred)

`node scripts/review.mjs <project> <slug>` builds `replicas/<slug>/review/index.html` (section 7) and opens it for the user per platform (section 2.1), while the conversation gives the storyboard table and the per-model cost table (auto mode builds the review page but does not stop):

> Here is the replica. Once you confirm, asset generation starts (charges begin from this step):
>
> | # | Role | Visual | Narration / copy | Source | Made by | Duration | Estimated cost |
> |---|---|---|---|---|---|---|---|
> | 1 | Opening | Follows the push-in of shot 1 of the original, with the person replaced by your photo | How many hours a week does your team spend in meetings? | AI video (follows the original) | MiniMax | 2.1s | $0.28 |
> | 2 | Pain point | Three data cards popping up one by one | — | Animation | — | 4s | 0 |
>
> Cost by model:
>
> | Use | Model | Unit price | Count | Subtotal |
> |---|---|---|---|---|
> | Pop-up pictures above the head | Nano Banana (small pictures automatically use a cheaper model) | 6 credits/image | 12 images | 72 credits |
>
> Audio: narration (paced like the original) + music (2 options, switch between them on the review page to listen) + sound effects at the same positions as in the original; captions: same style as the original
> Estimated: MiniMax $1.40 · ElevenLabs $0.12, about **$1.52** in total
> The review page is open; in "Replica preview", tick "Compare with original" to play it in sync with the original

The user may change the copy, list counts or replacements, switch a media slot's source or provider, or change the voice or BGM: update `replica.json` and the sketches → re-estimate → rebuild the review page → confirm again. Problems with the template itself (fidelity, layout, transitions) go back to step 3 to fix the corresponding board or the transition table, followed by a rebuild.

### Step 7: Generate the footage

In `narration` mode the voice and durations are settled first and the footage is generated afterwards; video assets are generated at the final scene durations, with no trimming or padding afterwards:

1. A digital human that speaks its own lines (such as a TapVid digital human) is that scene's narration, so `plan` writes no separate narration request for those scenes and the digital human is generated first; the other scenes generate their narration first;
2. `timing.mjs`: transcribe the digital human clips that carry their own voice and align each narration line word by word to the real speech (a match rate below 80 % is a problem); then measure the whole film's speech rate against the original's. When it is more than 8 % slower than the original, speed up the whole film by one uniform factor (pitch unchanged): at most 1.3x for narration only, at most 1.12x for a presenter whose lips and gestures are visible. Lines are never sped up individually, or the pace jumps from line to line. The decision is written into `replica.audio.tempo`; `tempo.fixed` can set a factor (1 = no speed-up);
3. Rerun `media.mjs plan`; videos are generated at the final scene durations.

`node scripts/media.mjs run plan.json` (section 5.4): images, videos and digital humans are generated in parallel. No more than 10 requests are in flight globally, and no more than a provider's `meta.concurrency` per provider. Results are downloaded into `assets/gen/` and written into `tasks.json` and the render project's `manifest.json`.

- **Replacements first**: character sheets and product images that AI must generate are generated first; once they pass the check, they become the reference image for every media slot that uses them;
- **keyframe chain**: generate the first frame and open it for a check (the subject correctly replaced, hands and product shape); if it fails, regenerate once, then submit the corresponding video;
- **Invented product UI images**: generate the first one, check it, and use it as the reference image for the remaining UI images so they are the same app;
- **Digital humans checked one by one**: an avatar takes only the script and the portrait, no prompt, so each clip is checked against the original's presenter footage of its slot as soon as it finishes: framing, the person, and nothing in the picture that the original's footage lacks (text the original's footage shows is fine; garbled subtitles or a drawn caption are not). Only the failing clip is regenerated; when the same line fails twice, it is rephrased with the same meaning (words such as "subtitles", "captions" or "text" can make the model draw them);
- **Frame-by-frame quality check**: run `inspect.mjs` on each video clip after download and look at every full-size frame: extra hands, wrong finger counts, deformed products, garbled text, clipping, replacement drift (reverting to the original's subject midway or turning into someone else). If a clean stretch covers the media slot's duration, trim and use it; otherwise state the cost, revise the prompt and regenerate once;
- Failure handling is in section 5.4. When a vendor rejects a reference image, that request is retried without it; a portrait reframe falls back to `reframe.mjs`. When a media slot finally fails, it falls back to its sketch (source changed to `code`) and is listed in the delivery report.

### Step 8: Narration, music and durations

| Audio mode | Sound | Scene duration |
|---|---|---|
| `narration` | Narration + BGM (ducked automatically under narration) | Set by the narration: one `speech.synthesize` call per scene, or one per `narration` field for a segmented board; duration = lead-in silence + narration + tail silence, within the board's `minDuration` / `maxDuration`; beyond `maxDuration`, shorten the copy and voice it again |
| `music-only` | BGM only | Frame-for-frame the same as the original: scene, segment and transition durations all come from `timeline.json`; when the list count differs from the original, items are added or removed at the original's per-item pace |
| `silent` | No audio track | Same as `music-only` |

- Digital human media slots: `avatar.generate` uses the scene narration as its lines with the same voice, and its sound is that scene's narration; when the provider only supports lip-sync, run `speech.synthesize` first and drive it with the audio.
- Speech rate: see item 2 of step 7. When choosing the voice, pick one with energy close to the original's (an energetic voice for fast-paced talking-head videos).
- Sound effects: elements in the template that make a sound carry `data-sfx`, appear automatically on the new timeline, and are mixed under the narration at render time; `replica.audio.sfx: false` turns them off.
- BGM sources in priority order: the user's music → `music.generate` (generated for the whole film's duration when a provider is available) → local code-composed music (`music-compose.mjs`, free) → `music.search` royalty-free library. The candidates auditioned on the review page come only from free sources (the user's music, local code-composed music, the library); `music.generate` is paid, listed as one cost line in the storyboard table, and generated at the final duration only after the user confirms, with its request submitted separately in this step. In `music-only` mode, code-composed music writes its score from the original's beat table so that cuts land on the beat.
- `node scripts/timing.mjs <replica>` writes `resolved` in `replica.json`: each scene's `start` / `duration`, the `segments` of segmented boards, transition overlaps, audio offsets. When the narration has word-level timestamps, captions are timed per word; otherwise time is distributed weighted by character count (`references/captions.md`).

### Step 9: Render and deliver

1. `node scripts/project.mjs <replica> --final` generates the render project: one wrapper module per scene that hands the board, `Design`, the replica data, the media elements and `segments` to the board; scenes are joined according to the transition table (section 8). In `narration` mode the caption component is overlaid in the caption style from `replica.json`.
2. `validate.mjs project`: all assets present, every `__ASSET:<alias>__` resolves, scene durations match `resolved`, determinism checks pass.
3. `frames.mjs` outputs each scene's midpoint frame, each transition's start / middle / end frames, and the full-film contact sheet. The main agent checks each one for text overflow, captions being covered, transition jumps and audio/video desync, fixes and rechecks, at most 3 rounds.
4. `render.mjs` renders the 1080p `out/tapvid.mp4` directly; check the duration against the original, the speech rate printed by `timing.mjs`, and frames sampled across the whole film. Other versions the user asks for are saved as `out/tapvid-<label>.mp4`; `tapvid.mp4` is always the current version.
5. Rebuild the review page: the "Final cut" tab plays the final film in sync with the original line by line, with switchable versions; the "Assets" tab lists every generated asset with its vendor, model and cost.
6. Report: the final film is in the review page's "Final cut" tab (plus the file location), its duration, the actual cost per vendor and model (`media.mjs spend`), media slots that fell back to animation, attribution for GIFs and library assets, and the template directory (pass it in next time to change the topic).

Later changes happen in the same replica directory: changing copy or code only needs the relevant parts of steps 8–9 rerun; regenerating paid assets requires stating the cost and getting consent first.

## 5. Media capability layer

### 5.1 Layers and execution

```
skill (main agent)
   │  writes plan.json (unified requests)
   ▼
scripts/media.mjs (runner)   routing · parameter adaptation · concurrency · resume · estimates · retries · downloads
   │  submit / poll
   ▼
provider modules   scripts/providers/*.mjs (built-in) + ~/.tapvid-video/providers/*.mjs (written on the spot)
   │  HTTPS
   ▼
TapVid open API · MiniMax · fal · OpenAI · ElevenLabs · …
```

Every provider (including TapVid) is a script calling its own HTTP API directly. TapVid goes through the open REST API `https://mcp.tapvid.ai/api/public/v1`, which uses the same API key and the same capabilities as the TapVid MCP. Files are uploaded as multipart, without base64 wrapping, so large files such as reference videos upload directly. Whether the client has the TapVid MCP connected makes no difference to this plugin.

### 5.2 Capabilities and schemas

Each capability defines JSON Schemas for its `params` and its result in `assets/schemas/capabilities/<capability>.json`. Parameters use unified, vendor-neutral names that each provider maps to its own spelling.

| Capability | Main params | Result | Sync / async |
|---|---|---|---|
| `image.generate` | `prompt`, `aspect`, `min_short_edge` (target short edge in pixels), `refs[]` (local images, each with a `role`: `composition` composition reference / `subject` replacement subject / `style` art style) | `files[]`: png / jpg, with `width` / `height` | Mostly async |
| `video.generate` | `prompt`, `aspect`, `duration_s`, `min_short_edge`, `first_frame` / `last_frame` (local images), `refs[]` (as above), `ref_videos[]` (local videos, each with a `role`: `motion` camera motion and pacing / `subject` / `style`), `audio` (whether the model should produce its own sound, default `false`) | `files[]`: mp4, with `duration_s` / `width` / `height` | Async |
| `speech.synthesize` | `text`, `voice`, `language`, `style` (optional tone description), `speed` | `files[]`: mp3, with `duration_s`; `words[]` (`{text, start, end}`) when the provider supports it | Sync or async |
| `speech.voices` | `language`, `gender` (optional) | `items[]`: `{id, name, gender, language, sample_url, recommended}` | Sync |
| `speech.transcribe` | `file` (audio or video), `language` (optional) | `files[]`: `transcript.json` (`{language, text, segments[], words[]}`) | Sync or async |
| `video.understand` | `file` (video), `shots[]` (time windows, optional), `question` (optional) | `files[]`: `understanding.json` (per shot `{start, end, description, subjects[], camera}`) | Sync or async |
| `music.generate` | `prompt` (English style description), `duration_s`, `instrumental` (default `true`) | `files[]`: mp3, with `duration_s` and `bpm` (when known) | Sync or async |
| `music.search` | `query`, `min_s` / `max_s` | `items[]`: `{id, title, duration_s, download_url, license, attribution}` | Sync |
| `avatar.generate` | Mode `tts`: `script` + `voice`; mode `audio`: `audio` (local audio); both take `portrait` (local portrait image) or `avatar_id`, and `aspect` | `files[]`: mp4 with sound, with `duration_s` | Async |
| `avatar.list` | `gender` (optional) | `items[]`: `{id, name, gender, preview_url}` | Sync |
| `video.search` | `query`, `sort` (`views` / `recent` / `relevance`), `duration` (`short` / `medium` / `long`), `orientation`, `published_after`, `limit` (≤ 20) | `items[]`: `{id, provider, title, url, download_url, thumbnail_url, duration_s, width, height, views, published_at, channel, license, attribution}`, with `null` for fields that do not apply | Sync |
| `video.download` | `url` | `files[]`: mp4 and `info.json` (title, author, duration, original link) | Sync |
| `image.search` | `query`, `orientation`, `animated` | `items[]`: `{id, url, download_url, width, height, license, attribution}`; with `animated: true` also `video` (the GIF as mp4), `preview_video`, `duration_s`, `title`, `source_url`, `author` | Sync |

- Every input file is a **local path** and every output file is **downloaded locally**. When a provider needs a public URL or its own file id, it uploads with `ctx.upload` itself (section 5.3); the layers above never see it.
- `video.search` is the unified video search capability: it queries every available search provider (or the one specified) at once and merges the results, tagged by provider. Platform results (YouTube and the like) serve as reference videos; stock library results (Pexels, Pixabay) carry `license` and `download_url` and can serve both as reference videos and, in a replica, directly as on-screen material.

**Resolution, duration and aspect ratio are adapted per model**: models differ in how resolutions are written and which tiers exist (such as `768P` / `2K`, `720p` / `1080p`); some durations are ranges and some are discrete values; aspect ratios and reference limits differ too. A request states only what is needed; the runner adapts it to the chosen model's `meta` and writes the result back into `plan.json`:

- `min_short_edge`: the largest short edge the media slot is actually drawn at on the 1080p canvas (including pushes, pulls and zooms), converted from the board's `media.minWidthPx`. The runner picks the lowest tier the model supports that is not below it; when no tier reaches it, the highest tier is taken and the review page flags "insufficient resolution";
- `duration_s`: the shortest duration the model supports that is not shorter than it; range-type models take the whole second directly; beyond the model's maximum, switch to a model that supports it, or split into two parts (a `keyframe` chain);
- `aspect`: an aspect ratio the model supports; when unsupported, the closest ratio, cropped after generation;
- `refs` / `ref_videos`: beyond the model's limit, or when the model does not support reference videos, routing moves to the next model or provider; when none supports it, the generation method falls back from `reference` to `keyframe`.

**Request and result envelopes** (shared by every capability):

```json
{
  "id": "ledgerline-01-Hook01-cover",
  "capability": "video.generate",
  "provider": null,
  "model": null,
  "params": {
    "prompt": "Use video 1 as the reference for camera motion, composition and timing. Replace the person with the person in image 1 ...",
    "aspect": "16:9", "duration_s": 3, "min_short_edge": 1080,
    "refs": [{ "file": "assets/user/me.png", "role": "subject" }],
    "ref_videos": [{ "file": "../../template/refs/Hook01.cover.mp4", "role": "motion" }],
    "audio": false
  },
  "out": "assets/gen/Hook01.cover"
}
```

```json
{
  "id": "ledgerline-01-Hook01-cover",
  "status": "completed",
  "provider": "minimax",
  "model": "MiniMax-H3",
  "resolved_params": { "resolution": "2K", "duration": 4, "ratio": "16:9" },
  "files": [{ "path": "assets/gen/Hook01.cover.mp4", "mime": "video/mp4", "duration_s": 4.0, "width": 2560, "height": 1440 }],
  "items": null,
  "cost": { "usd": 0.32, "credits": null, "estimated": false },
  "error": null
}
```

- When `provider` / `model` is `null`, routing decides (section 5.5); when set, it is used as given;
- `tier` (optional, `economy` / `standard`): with `economy`, and no fixed model, the provider picks its cheapest model that meets the resolution, aspect ratio and reference image requirements. `plan` sets this flag on small, brief pictures on screen (less than half the frame wide, or on screen for less than 3 seconds);
- `resolved_params` are the adapted parameters actually sent to the vendor; the review page and the delivery report display them;
- `out` is the output file path prefix; the provider appends the extension of the actual format;
- `id` is the idempotency key, formatted `<slug>-<NN>-<Board>-<path>` (truncated with a hash appended beyond 64 characters); a rerun reuses the original `id` and never submits twice;
- Requests can depend on each other: a string in `params` of the form `"@<id>"` (or `"@<id>[n]"`) is replaced by that request's n-th output file once it completes, and the runner orders requests accordingly (such as first frame image → video, replacement → the media slots that reference it); for ordering without taking a value, write `"after": [<id>…]`; when a dependency fails, downstream requests are not submitted and are marked failed directly;
- `error.code` values: `auth` (invalid key), `quota` (insufficient balance or rate limited), `moderation` (rejected by content moderation), `invalid` (parameters not accepted), `unsupported` (this provider does not support this set of parameters), `transient` (network, 5xx, timeout), with a `message` and the provider's raw error.

### 5.3 Provider module interface

A provider is one Node ESM file that uses only Node built-ins (`fetch`, `fs`, `crypto`) and no third-party dependencies:

```js
export const meta = {
  name: 'minimax',
  displayName: 'MiniMax',
  docs: 'https://platform.minimax.io/docs',
  secrets: ['MINIMAX_API_KEY'],
  concurrency: 5,
  capabilities: {
    'video.generate': {
      models: [{
        id: 'MiniMax-H3', default: true,
        aspects: ['16:9', '9:16', '1:1'],
        duration: { min: 4, max: 15 },
        resolutions: [{ name: '768P', shortEdge: 768 }, { name: '2K', shortEdge: 1440 }],
        firstFrame: true, lastFrame: true, maxRefs: 4, maxRefVideos: 1, refVideoMaxS: 10,
        price: { usdPerSecond: { '768P': 0.05, '2K': 0.08 } },
      }],
    },
  },
};

export async function verify(ctx) {}                      // optional: the cheapest authenticated call; throws an auth error on failure
export async function estimate(capability, request) {}    // → { usd } | { credits }, computed from the price in meta
export async function submit(capability, request, ctx) {} // → { jobId } or { result } (sync APIs return the result directly)
export async function poll(capability, jobId, ctx, req) {} // → { status: 'running' } | { status: 'completed', result } | { status: 'failed', error }
export async function account(ctx) {}                     // optional: → { usd } | { credits } balance
export async function discover(ctx) {}                    // optional: fetch the latest models, tiers and prices from the API; cached by check --live and overriding meta
```

The values in the example above are illustrative; the values refreshed by `media.mjs check --live` are authoritative. `request` is the request the runner has already adapted to `meta`, with `resolved_params` settled.

`ctx` is provided by the runner:

| Member | Purpose |
|---|---|
| `secret(name)` | Read a key: environment variable first, then the system credential store (section 2.1) |
| `fetch` | fetch with a timeout and `transient` classification |
| `json(url, opts)` / `bytes(url, opts)` | Send a request and parse JSON / fetch binary; non-2xx throws the matching `MediaError` by status code and moderation keywords |
| `writeOut(outPrefix, buffer, ext)` | Write inline results such as base64 / hex to a file |
| `dataUri(file)` / `blob(file)` | Local file to a data URI / to a Blob for multipart |
| `download(url, outPrefix)` | Download locally, append the extension from Content-Type, return the path |
| `upload(file, via, { fresh })` | Turn a local file into a reference the provider can use (URL or file id). Cached by file sha256 + provider in `~/.tapvid-video/cache/uploads.json`, so the same file is never uploaded twice; `fresh: true` uploads again and replaces the cached reference, for a provider that refused the earlier one |
| `trim(file, { maxS, maxBytes })` | When a reference video exceeds the model's duration or size limit, cut and re-encode it |
| `probe(file)` | Read duration and dimensions with ffprobe |
| `log(msg)` | Debug log written to the ledger; **must never contain a key** |

Rules:

- Prices are module constants in the provider file, annotated with the date they were taken from the official pricing page. `estimate` is used only for the review page; the actual cost is what the provider returns, marked `estimated: true` when it cannot return one;
- `submit` returns `{ jobId }` as soon as it has the vendor's task id and never blocks polling inside `submit`. After an interruption, the runner can then continue `poll` with the `jobId` in `tasks.json` without submitting again;
- A parameter that cannot be mapped throws `unsupported` so routing moves to the next provider; it is never silently dropped (for example, `ref_videos` sent to a model that does not support reference videos);
- Result files always land through `ctx.download`; signed URLs are never written into results.

### 5.4 Runner

| Command | Purpose |
|---|---|
| `media.mjs providers [--json]` | List every provider (built-in + written on the spot), its capabilities, whether its key is configured, and whether `verify` passes |
| `media.mjs plan <replica.json>` | Write `plan.json` from the replica: media slot, replacement, narration and digital human requests (BGM is submitted separately in step 8), with provider and model already chosen by routing and `resolved_params` adapted |
| `media.mjs estimate <plan.json>` | Estimated cost per row, per model (unit price, quantity, subtotal, `byModel`) and summarised per provider |
| `media.mjs spend <replica>` | Actual cost from `tasks.json` summarised by vendor and model, for the delivery report |
| `media.mjs prices <provider>` | List each model's price table, refreshing the model list first when `discover` exists; starts no generation |
| `media.mjs run <plan.json \| request.json> [--only <id>]` | Execute: submit concurrently in dependency order (replacement → first frame → video), poll, download, write the ledger; can be rerun |
| `media.mjs check <provider> [--live --spend]` | Contract check: by default only validates `meta` and the schemas and replays `__fixtures__`; `--live` makes one minimal real call per capability and refreshes the models, tiers and prices in `meta`. Real calls are charged: with `--live` alone it lists the calls it would make and their estimated cost and exits with code 2; it runs them only with `--spend` (and the user's consent) |
| `media.mjs account` | Balance per provider (only those implementing `account`) |

`tasks.json` has one record per request: `id`, capability, provider, model, `params` hash, `jobId`, status, attempt count, result, cost, time. On a rerun: `completed` is skipped; one with a `jobId` that is not complete continues `poll`; a changed `params` hash is treated as a new request (`attempt + 1`). A `jobId` is dropped only when the provider reports the job failed: a poll or result download that loses its connection is retried on the same job until the provider's timeout, and after a timeout the job is polled again on the next attempt or rerun rather than submitted again.

Failure handling:

| `error.code` | Handling |
|---|---|
| `transient` | Retry once with the same provider |
| `moderation` | The main agent rewrites the prompt (removing brands, celebrities, copyrighted elements) and retries once; when the reference video is rejected, switch to the `keyframe` method |
| `unsupported` / `invalid` | Move to the next model or provider by routing |
| `auth` / `quota` | Disable that provider for this run and move to the next; when all are exhausted, stop and tell the user (add a key or top up) |
| All providers fail | The media slot falls back to its sketch (source changed to `code`), written into the delivery report |

### 5.5 Routing, keys and fallback

**Routing**: when a request names no provider, take the capability's ordered list from `~/.tapvid-video/config.json`; without configuration, use the built-in default order. Filter it to the providers whose key is configured, whose `verify` passes, and that can meet this set of parameters (aspect ratio, duration, resolution, first frame, reference images and reference videos), take the first one, and use its default model that meets the parameters. A provider the user specifies on the review page per media slot or per capability is written into `replica.json` and takes precedence over routing.

```json
{
  "routing": {
    "video.generate": ["tapvid", "minimax", "fal"],
    "speech.synthesize": ["elevenlabs", "tapvid"]
  },
  "models": {
    "video.generate": { "fal": "bytedance/seedance-2.5/reference-to-video" }
  }
}
```

Built-in default order: for capabilities where TapVid is configured, TapVid comes first (one account for billing, no per-vendor integration); the rest follow the order each capability lists in the table of section 5.6.

**Keys**:

- `node scripts/set-key.mjs <provider>` takes the key through the system's native password dialog, validates it with that provider's `verify`, and on success writes it into the system credential store (macOS Keychain, a DPAPI-encrypted file on Windows, see section 2.1). On failure it asks again, at most 3 times. The script outputs only `saved` / `cancelled` / `invalid-key`;
- An environment variable with the same name takes precedence over the system credential store, for CI and temporary switching;
- Keys are never written into any project file, ledger, log or the conversation.

**Fallback** (when a capability has no available provider, or the call fails):

| Capability | Fallback |
|---|---|
| `video.generate` | First generate an image with `image.generate` and add a code push/pull / parallax; if that is unavailable too, use the sketch |
| Reference videos of `video.generate` | The `keyframe` method: edit an image into a first frame, then image-to-video |
| `image.generate` | Sketch |
| `speech.synthesize` | Only `music-only` / `silent` mode is possible; tell the user |
| `speech.transcribe` | Local whisper (installed directly when `whisper.cpp` is missing) |
| `video.understand` | Skipped; rely on the frame-level timeline and frame reading only |
| `music.generate` | Local code-composed music |
| `avatar.generate` | Boards with an on-camera person use the portrait image with light motion instead; tell the user |
| `video.search` / `video.download` | With the user's permission, done through browser automation in the user's own browser (see step 1); failing that, ask the user to download manually and provide the file |

### 5.6 Built-in providers

Model ids, tiers and prices are written in each provider's `meta` and refreshed from the official responses by `media.mjs check --live`. The table below holds the first-release values (based on the official documentation as of 2026-10). The "First live test" column marks the providers for which a key is available in this round and `--live` runs during implementation; the rest ship with offline `__fixtures__` contract tests and get a live test once a key is available.

| provider | Auth (secret) | Capabilities | Call details | First live test |
|---|---|---|---|---|
| `tapvid` | `Authorization: Bearer` (`TAPVID_API_KEY`) | video (with reference videos) / image / speech / speech.voices / avatar / avatar.list | REST, base `https://mcp.tapvid.ai/api/public/v1`: submit with `POST /assets/{video,image,speech,avatar}` (the request body matches the parameters of the MCP tool of the same name, `idempotencyKey` = request `id` plus a 16-hex hash of the request body and its output path, because the backend returns the earlier task for a key it has already seen on the account — a retried request maps to its task, the same `id` in another project or with changed parameters is a new generation; a video's `references[]` can pass `{kind: image \| video, documentId}`), which returns 202 and a task; poll `GET /assets/task?task_id=` until `completed` / `failed`, then download from `document.url`; local files are uploaded through `POST /materials?usage=asset` (multipart, field `file`) in exchange for a `materialId`; `GET /assets/models?kind=` returns models, tiers and prices; `GET /voices/list`, `GET /avatars/list`, `GET /account` | ✓ |
| `minimax` | `Authorization: Bearer` (`MINIMAX_API_KEY`), international site `api.minimax.io`, China site `api.minimax.cn` (switched with `MINIMAX_HOST`) | video (with reference videos) / image / speech / music | Video H3: `POST /v2/video_generation`, `content[]` passes `first_frame` / `last_frame` / `reference_image` / `reference_video` by role (URL, `mm_file://` or base64 data URI, request body ≤ 64 MB), `resolution` (`768P` / `2K`) and `duration` (4–15) required; poll `GET /v2/query/video_generation/{task_id}` until `succeeded` / `failed`, result in `task.content.url`. Hailuo 2.3 uses `/v1/video_generation` + `/v1/query/video_generation` + `/v1/files/retrieve`. Image `POST /v1/image_generation` (`image-01`, sync); narration `POST /v1/t2a_v2` (`speech-2.8-hd`, sync, returns hex audio); music `POST /v1/music_generation` (`music-3.0`, `is_instrumental`). Music has not been available to new paying users since 2026-08-20; `verify` marks `music.generate` unavailable for accounts without it | ✓ |
| `fal` | `Authorization: Key` (`FAL_KEY`) | video (with reference videos) / image / avatar (`audio` mode) | Submit with `POST https://queue.fal.run/{endpoint}`, poll and fetch results with the returned `status_url` / `response_url` (status reaches `COMPLETED`); local files are uploaded to fal storage in exchange for a URL. Default endpoints: video `bytedance/seedance-2.5/{text-to-video,image-to-video,reference-to-video}`, optionally `fal-ai/kling-video/v3/pro/*`, `fal-ai/veo3.1`, `alibaba/wan-3.0/*`; image `bytedance/seedream/v5/pro/{text-to-image,edit}`, `fal-ai/flux-2-pro`; digital human `fal-ai/bytedance/omnihuman` (portrait + audio, ≤ 30 s), `fal-ai/infinitalk` | ✓ |
| `openai` | `Authorization: Bearer` (`OPENAI_API_KEY`) | image / speech / speech.voices / speech.transcribe (segment timing only) | Image `POST /v1/images/generations` (`gpt-image-2.5-flare`, returns base64), with reference images via `/v1/images/edits`; narration `POST /v1/audio/speech` (`gpt-4o-mini-tts`, supports `instructions` for tone, returns binary audio, fixed voice list, `marin` / `cedar` recommended); transcription `POST /v1/audio/transcriptions` (`gpt-transcribe`, ≤ 25 MB, no word-level timestamps). OpenAI no longer has a video generation API, so `video.generate` is not offered | ✓ |
| `elevenlabs` | `xi-api-key` (`ELEVENLABS_API_KEY`) | speech / speech.voices / speech.transcribe / music | Narration `POST /v1/text-to-speech/{voice_id}` (`eleven_v4`, `output_format=mp3_44100_128`, returns binary); music `POST /v1/music` (`music_v2_5`, `music_length_ms`, `force_instrumental`); transcription `POST /v1/speech-to-text` (`scribe_v2`, `timestamps_granularity=word`, returns `words[]`) | ✓ |
| `replicate` | `Authorization: Bearer` (`REPLICATE_API_TOKEN`) | video / image / avatar (`audio` mode) | Submit with `POST /v1/models/{owner}/{name}/predictions`, poll `GET /v1/predictions/{id}` until `succeeded` / `failed` / `canceled`; `output` is deleted after about 1 hour and must be downloaded immediately; local files are uploaded with `POST /v1/files`. Digital human defaults to `bytedance/omni-human`, lip-sync uses `sync/lipsync-2-pro`, `kwaivgi/kling-lip-sync` | — |
| `ark` | `Authorization: Bearer` (`ARK_API_KEY`), international BytePlus ModelArk, China Volcengine Ark (switched with `ARK_REGION`) | video / image | `POST /api/v3/contents/generations/tasks`, `content[]` holds text and `image_url` by role (`first_frame` / `last_frame` / `reference_image`); poll `GET /api/v3/contents/generations/tasks/{id}` until `succeeded`, result in `content.video_url`; image `POST /api/v3/images/generations` (Seedream) | — |
| `kling` | JWT (HS256, `iss` is the access key, valid for 30 minutes, signed with the secret key; `KLING_ACCESS_KEY` + `KLING_SECRET_KEY`) | video | The model is in the path: `POST /image-to-video/kling-4.0`, `contents[]` passes `first_frame` / `last_frame`; poll `GET /tasks?task_ids=` until `succeeded`, result in `outputs[].url` | — |
| `runway` | `Authorization: Bearer` (`RUNWAYML_API_SECRET`) + `X-Runway-Version: 2024-11-06` | video | `POST /v1/image_to_video` / `/v1/text_to_video` (`gen4.5`, `ratio` and `duration` required); poll `GET /v1/tasks/{id}` until `SUCCEEDED`; local files are uploaded through `POST /v1/uploads` | — |
| `luma` | `Authorization: Bearer` (`LUMA_API_KEY`) | video | `POST /dream-machine/v1/generations/video` (`ray-2`, `keyframes.frame0` passes the first frame, `duration` is `5s` / `9s`); poll until `completed`, result in `assets.video` | — |
| `gemini` | `x-goog-api-key` (`GEMINI_API_KEY`) | image / speech / video / video.understand | `POST /v1beta/interactions`: image with `gemini-nano-banana-2.1` (returns base64); narration with `gemini-3.8-flash-tts` (voices such as `Kore`, returns 24 kHz wav); video with `gemini-omni-1.1-flash` (`response_format.type = video`, result as base64 or a file `uri`); video understanding passes the video file and per-shot time windows and asks for a response in the structure of `understanding.json` | — |
| `heygen` | `X-Api-Key` (`HEYGEN_API_KEY`) | avatar (`tts` mode) / avatar.list | v3: submit with `POST /v3/videos`, poll `GET /v3/videos/{id}` until `completed`, result in the presigned `video_url` | — |
| `d-id` | Basic (`DID_API_KEY`) | avatar (`tts` and `audio` modes) | `POST /talks` (`source_url` is the portrait, `script` is text or audio); poll `GET /talks/{id}` until `done`, result in `result_url` | — |
| `youtube` | `key=` parameter (`YOUTUBE_API_KEY`) | video.search | `GET /youtube/v3/search?type=video&order=viewCount&videoDuration=…&publishedAfter=…`; trending via `GET /youtube/v3/videos?chart=mostPopular`; search quota about 100 calls per day | — |
| `pexels` | `Authorization: <key>` (`PEXELS_API_KEY`, no Bearer) | video.search / image.search | `GET /v1/videos/search`, `GET /v1/search`; take the `link` of a suitable resolution from `video_files[]` | — |
| `pixabay` | `key=` parameter (`PIXABAY_API_KEY`) | video.search / image.search | `GET /api/videos/?q=`; when `videos.large` is empty take `medium`; responses are cached for 24 hours per the terms | — |
| `giphy` | `api_key=` parameter (`GIPHY_API_KEY`, created free at https://developers.giphy.com/dashboard/) | image.search (only `animated: true`) | `GET /v1/gifs/search?q=&limit=&rating=pg-13`; take `images.original.mp4` and the preview mp4, dimensions, title, author; pexels / pixabay return `unsupported` for `animated: true` | — |
| `jamendo` | `client_id=` parameter (`JAMENDO_CLIENT_ID`) | music.search | `GET /v3.0/tracks/?search=…&vocalinstrumental=instrumental&include=licenses`; only tracks with `audiodownload_allowed` true are taken, with `license` and attribution written into the result | — |
| `ytdlp` | None (local `yt-dlp`, installed directly per section 2.1 when missing) | video.download | `yt-dlp -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4] / bv*+ba/b" --merge-output-format mp4 --write-info-json --no-playlist -o "<out>.%(ext)s" <url>` | ✓ |
| `whisper-local` | None (local `whisper-cli`, installed directly per section 2.1 when missing; model `ggml-large-v3-turbo` downloaded into `~/.tapvid-video/models/`) | speech.transcribe | First convert to a 16 kHz mono wav, then `whisper-cli -m <model> -f <wav> -ojf -of <out>`, assembling `segments[]` and `words[]` from the per-token JSON | ✓ |

Douyin, TikTok, Bilibili, Xiaohongshu and Instagram have no usable official search and download APIs, so none is built in. A user with a key for a third-party service (such as TikHub or Apify) connects it with a provider written on the spot per section 5.7; `provider-authoring.md` uses TikHub's `video.search` / `video.download` as the complete example.

Built-in default order per capability:

| Capability | Default order |
|---|---|
| `video.generate` | tapvid → minimax → fal → ark → kling → runway → luma → gemini → replicate |
| `image.generate` | tapvid → fal → openai → gemini → minimax → ark → replicate |
| `speech.synthesize` / `speech.voices` | tapvid → elevenlabs → minimax → openai → gemini |
| `speech.transcribe` | elevenlabs → whisper-local → openai |
| `video.understand` | gemini |
| `music.generate` | elevenlabs → minimax |
| `music.search` | jamendo |
| `avatar.generate` | tapvid → fal → replicate → heygen → d-id |
| `avatar.list` | tapvid → heygen |
| `video.search` | Queries every available provider among youtube, pexels, pixabay in parallel |
| `video.download` | ytdlp |
| `image.search` | pexels → pixabay; giphy for `animated: true` |

Local code-composed music is not a provider: it needs the agent to write a score first, and step 8 calls `music-compose.mjs` directly as the fallback when `music.generate` is unavailable.

### 5.7 Providers written on the spot

When a service the user wants is not in the built-in list (a new video model, a third-party Douyin API, an in-house company service), or a capability has no available provider while the user holds another vendor's key, **the skill writes a provider itself following the agreed pattern**; the user provides only two things:

1. The service's integration documentation: a link, or a document file / page content;
2. The key: entered through the `set-key.mjs` dialog, never in the conversation.

The skill's steps (details in `references/provider-authoring.md`):

1. Read the documentation and determine which capabilities the service covers, plus the auth method, the submit / poll / fetch-result endpoints, how local files are uploaded, and each model's resolution / duration / aspect ratio / reference limits and prices;
2. Copy `scripts/providers/_template.mjs` to `~/.tapvid-video/providers/<name>.mjs` (outside the plugin directory, so upgrades never lose it) and implement `meta`, `submit` / `poll` (sync APIs implement only `submit`) and `estimate`, optionally `verify` and `account`. Map parameters against `assets/schemas/capabilities/<capability>.json`; anything that cannot be mapped throws `unsupported`;
3. Write replay samples from the documentation's request and response examples into `~/.tapvid-video/providers/__fixtures__/<name>/`;
4. Run `media.mjs check <name>` and fix until it passes;
5. Tell the user the estimated cost of the real call and, with their consent, run `media.mjs check <name> --live`;
6. In `routing` in `config.json`, put it ahead for the capabilities the user wants it for.

A provider written on the spot with the same name as a built-in provider takes precedence.

## 6. Template format

The template follows the TapVid board conventions (compatible with the platform board contract). The transition table and the reference material are extensions of this plugin, defined and validated by this plugin's schemas.

### 6.1 `template/template.json`

```json
{
  "version": 1,
  "id": "saas-launch-explainer",
  "title": "SaaS feature launch",
  "canvas": { "width": 1920, "height": 1080 },
  "fps": 30,
  "category": "no_avatar",
  "audio": { "source_mode": "narration", "captions": "word-highlight", "bpm": 104 },
  "source": { "file": "../source/source.mp4", "duration_s": 48.2, "url": null },
  "boards": ["Hook01", "Problem02", "Demo03", "Proof04", "Outro05"],
  "transitions": [
    { "from": "Hook01", "to": "Problem02", "type": "page-flip", "duration": 0.533,
      "params": { "direction": "left", "curl": 0.35 } },
    { "from": "Problem02", "to": "Demo03", "type": "canvas-pan", "duration": 0.8,
      "params": { "vector": [1, 0], "zoom": [1, 0.85, 1], "easing": "inOutCubic" } }
  ]
}
```

- `canvas`: 1920×1080 for 16:9, 1080×1920 for 9:16, independent of the original's resolution;
- `boards`: the default scene order;
- `transitions`: one entry per boundary; boundaries not listed are hard cuts. Durations come from the transition windows in `timeline.json`, rounded to frames;
- `audio.captions`: the caption style matching the original's captions, `null` when there are none.

### 6.2 Board split and writing

**Split principle**: one board corresponds to one layout system, not to one shot. The count follows the original's structure, and can be one or dozens:

| The original | Split |
|---|---|
| One continuous take, an infinite canvas, one world coordinate shared by the whole film (the camera moves and zooms across the same canvas) | **One segmented board**: one segment per content node; elements, copy, media and the camera path are all parameters (lists); the whole film has only this one board |
| Consecutive shots with the same layout and different content (three features, five reviews) | One board, with a list field or repeated scenes |
| Sections with different layouts, hard cuts between them | One board each |
| Sections with different layouts and a designed transition between them (page flip, zoom-through, mask wipe, whip pan, canvas pan) | One board each; the transition goes into the transition table and is implemented by the render project |
| A transition that depends on content moving continuously across it (an element flying from its place in A to its place in B, one object running through both sections) | Merge into one segmented board: a transition between boards can only move the whole frame and cannot express element-level continuous motion |

Write the split and the reason for each boundary into `report.md`. The test: the picture at any point in time can be rebuilt from "the board it falls in + parameters + transition".

**Hard rules for boards** (`validate.mjs template` checks each):

- One file, `import React from "react"` only. Easing functions and sub-components are inlined in each board; the template has no shared module;
- Exactly one export, named like the file: `export function Hook01({ t, duration, segments, Design, ...props })`;
- `t` is scene time (seconds) and rendering is a pure function of `t`: no `Math.random`, `Date.now`, CSS transitions / animations, or own clock;
- In an unsegmented board every time is written as a fraction of `duration`; a segmented board times elements by the start and end of each segment in `segments`;
- Geometry is always `cqw` / `cqh` (root node `containerType: "size"`), never px;
- Colours and fonts come only from `Design`; no hex colour values appear in a board;
- Array fields determine element counts; any count from `minItems` to `maxItems` has no overflow, no overlap and no holes;
- `image` / `video` fields are passed in as ready-made `<img>` / `<video>` elements, and the board only places and crops them; `element` fields are passed in as React elements and rendered as they are;
- Boundary joins: at a boundary where the transition table declares a transition, the board does no entrance or exit of its own on that side (at `t = 0` and `t = duration` it is a complete still frame) and leaves the join to the transition; at a hard-cut boundary, the board has its own entrance and exit;
- Elements replay the measured values from `analysis/elements.json`: every instance has its own box (a measured table in the board indexed by list position; positions beyond the original's count are derived by rule), and images keep their own aspect ratio;
- Idle motion is also a function of `t`: boil takes `pose = floor(t × poses per second)`, each part's offset, angle and paper shape are determined by a seeded hash of `(pose, part)`, and it holds still between poses; drift, sway and pulse use smooth functions with the measured amplitude and period;
- Elements that make a sound carry `data-sfx="<type>"` (optionally `data-sfx-gain`, linear, default 1). The cue fires on the frame the element first becomes visible, identically in preview and render, and moves automatically with timeline changes; cue times are never written by hand;
- Code components carry `data-part="<short English noun>"` (`Title card`, `Sticker`, `Badge`, `Icon`, `Heading`, `Step number`, `Screen card`, `Call to action`); the review page draws a blue frame and labels it with this name, and translates common names automatically when switched to Chinese.

`boards/<Name>.json` contains:

- `schema.fields[]`: `key`, `type` (`string` / `number` / `string[]` / `image` / `video` / `object` / `object[]` / `narration` / `element`), `required`, `maxChars` / `minItems` / `maxItems`, a required `desc`, an optional `tiedTo`;
- `media` for each media field: `role` (`presenter` / `broll` / `screen`), `aspect`, `minWidthPx`; videos also have `motion` / `firstFrame`, GIF-style loops add `loop: true` (the player loops it while the media slot is on screen), and presenter fields also have `headTop` (the head top of the original presenter at rest, as a percentage of the frame height). Media whose content moves in the original (element inventory `content` is not `still`) is always a `video` field;
- `meta`: `displays`, `useWhen[]` / `dontUseWhen[]`, `minDuration` / `maxDuration`, `durationModel`, `motion`;
- Example data: `example_data`, `example_narration`, `example_segments` (segmented boards), `example_duration_ms`, `preview_t`.

Field writing, layering, text box sizing, segments and motion lists are detailed in `references/boards.md`.

`boards/<Name>.mp3` is example audio cut from the original, `.html` is a single-file preview page, and `.png` is a screenshot at `preview_t`; all three are generated by `build-boards.mjs`.

### 6.3 Transitions

Transitions are implemented by the render project's `src/system/transitions.js`; boards take no part. During a transition, the boards before and after are both mounted, each in its own full-canvas container, and `transitionStyles(type, progress, params)` returns the styles of both containers for `progress ∈ [0, 1]`. First-release transition library:

| Type | Effect | Main parameters |
|---|---|---|
| `crossfade` | Dissolve | — |
| `push` | Push | `direction` |
| `wipe` | Mask wipe | `shape` (line / circle / diamond), `direction`, `softness` |
| `zoom-through` | Zoom-through | `origin`, `scale` |
| `whip-pan` | Whip pan with motion blur | `direction`, `blur` |
| `page-flip` | Book / page flip, 3D perspective | `direction`, `curl` |
| `canvas-pan` | Infinite canvas: the boards before and after sit side by side on the same plane and the camera pans along a vector, optionally pulling back midway | `vector`, `zoom` (start / middle / end), `easing` |
| `slide-stack` | Stacked cards sliding in and out | `direction`, `depth` |

When a transition of the original has no matching type in the library, a new type is added to `transitions.js` following `references/transitions.md` and also written into the template's `template/transitions.js` extension file. The render project loads this extension file first, so the transition still works when the template is reused.

### 6.4 Reference material `template/refs/`

```json
{
  "Hook01.cover": {
    "clip": "Hook01.cover.mp4",
    "frame": "Hook01.cover.png",
    "window": { "start": 0, "end": 2.133 },
    "crop": [0.0, 0.0, 1.0, 1.0],
    "subjects": [
      { "id": "presenter", "kind": "person", "image": "subjects/presenter.png" },
      { "id": "laptop", "kind": "product", "image": "subjects/laptop.png" }
    ],
    "describe": "Medium shot of a woman at a desk looking at a laptop; slow dolly-in, warm side light"
  }
}
```

- The key is `<Board>.<field path>`; media slots in list items use the original's item number (`Demo03.steps.2.screen`);
- `clip` is the clip of the original within the media slot's window, cropped by `crop` (0–1 fractional coordinates); `frame` is the frame in it that best represents the composition;
- `subjects` are crops of the subjects that appear in the media slot; one subject shares one `id` across media slots, and the replacement table names replacements by `id`;
- `describe` is the English description of the picture and motion written by the main agent, used in the prompts of the `keyframe` and `text` methods.

The reference material is saved with the template and is available directly whenever the template is reused.

### 6.5 Narrative structure `template/skill/SKILL.md` and the replica `replicas/<slug>/replica.json`

**Narrative structure**: the YAML frontmatter contains `name`, `description`, `metadata.schema_version`, `metadata.sections[]`. Each section is one narrative node: `beat`, `brief` (what this section must achieve, written at the structural level, not the original's specific content), an optional `node`, `scenes[]` (each with `durationS` and `narration`), and optional `scenes_min` / `scenes_max`. The body says who the audience is, what the tone is and how the sections connect, and ends with a paragraph listing two or three other topics with the same structure. The agent reads it first when writing a replica.

**Replica**:

```json
{
  "version": 1,
  "slug": "ledgerline-launch",
  "topic": "Ledgerline reconciliation automation launch",
  "language": "en",
  "template": "../../template",
  "product": "product.md",
  "replace": [
    { "subject": "presenter", "with": { "file": "assets/user/me.png" }, "note": "The presenter becomes the user" },
    { "subject": "laptop", "with": { "generate": "A slim silver laptop showing the Ledgerline dashboard" }, "file": null }
  ],
  "audio": {
    "mode": "narration",
    "voice": { "provider": "elevenlabs", "id": "<voice id>", "name": "<display name>" },
    "captions": "word-highlight",
    "bgm": {
      "brief": "confident, modern, light electronic; 100-110 bpm",
      "candidates": [
        { "source": "compose", "title": "Light electronic, 104 bpm", "score": "music/score-1.js", "path": "assets/audio/candidates/1.mp3", "bpm": 104 },
        { "source": "compose", "title": "Piano and strings, 96 bpm", "score": "music/score-2.js", "path": "assets/audio/candidates/2.mp3", "bpm": 96 }
      ],
      "selected": 0,
      "path": null,
      "beats": null
    }
  },
  "scenes": [
    {
      "board": "Hook01",
      "beat": "Hook",
      "narration": "How many hours does your finance team spend on reconciliation every month?",
      "data": { "kicker": "Month-end close", "title": ["Three days of work", "done in ten minutes"] },
      "media": {
        "cover": {
          "kind": "video",
          "source": "ai",
          "mode": "reference",
          "ref": "Hook01.cover",
          "replace": ["presenter", "laptop"],
          "prompt": "Use video 1 as the reference for camera motion, composition and timing. Replace the woman with the person in image 1 and the laptop with the laptop in image 2. She is reviewing a finance dashboard; no on-screen text, no logos.",
          "visual": "Follows the push-in of shot 1 of the original, with the person replaced by your photo and the laptop by the new product",
          "aspect": "16:9",
          "duration_s": 2.133,
          "provider": null,
          "sketch": null,
          "file": null
        }
      }
    }
  ],
  "resolved": {}
}
```

- `replace`: `subject` matches a subject `id` in `refs.json`. `with.file` is the user's material; `with.generate` is generated by AI from the description, written into `file` once generated, and shared by the whole film;
- `media` is keyed by field path: top-level `cover`, inside a group `hero.logo`, a list item `features.2.shot`. When a list count changes, the corresponding entries are added or removed with it; a newly added entry has no reference in the original and its `mode` is `text`;
- `kind`: `image` / `video` / `avatar` / `element`. `source`: `ai` / `code` / `user`. `mode` (`ai` only): `reference` / `keyframe` / `text`. `element` can only be `code`, with `file` pointing to a component under `elements/`;
- `ref` points to a key in `refs.json`; `replace` lists the subjects this media slot replaces;
- `visual` is a one-sentence picture description for the user, used in the storyboard table and on the review page; `prompt` is the English prompt for the provider;
- `sketch`: present only for `ai` media slots without a reference clip and for `code` media slots;
- When `provider` is `null`, routing decides; `file` is written once the asset is generated or provided by the user;
- `audio.mode`: `narration` / `music-only` / `silent`. In the latter two modes `voice` and `captions` are `null` and `avatar` is not allowed; in `silent`, `bgm` is `null`;
- `resolved`: written by `timing.mjs` in step 8, formatted `{ "<index>-<Board>": { "start", "duration", "segments", "transitionIn", "audio", "audioOffset", "words" } }`.

### 6.6 Element inventory `analysis/elements.json` and sound effects

The element inventory is the measurement record made while building the template; boards replay it, so the first version of the template is already 1:1 (field details in `references/analysis.md` §9, schema `assets/schemas/elements.json`):

```json
{ "elements": [
  { "id": "Hook01.pops.0", "board": "Hook01", "kind": "picture", "path": "pops.0.image",
    "in": 3.2, "out": 4.9, "box": [0.315, 0.18, 0.37, 0.175],
    "enter": "pop", "exit": "cut", "idle": { "type": "none" }, "content": "loop", "font": null, "sfx": "pop" }
] }
```

- `kind`: `picture` / `screen` / `sticker` / `title` / `caption` / `icon` / `badge` / `presenter` / `footage` / `shape`; `box` is in 0–1 fractions of the canvas; `idle.type`: `none` / `boil` / `drift` / `pulse` / `sway` / `shake` (`boil` with `poses_per_s`); `content`: `still` / `loop` / `recording` / `footage`;
- `measure.mjs`: `grid` (overlays a 2 % grid on a frame, optionally zoomed into a region, for reading boxes), `motion` (inter-frame difference inside each element box, classified as still / boil / continuous motion, written to `analysis/motion.json`), `fonts` (candidate fonts rendered side by side with a crop of the original);
- `behind`: set only on an element that the person in a footage slot visibly covers in the original (hair, a shoulder or a hand passes in front of it), naming that `video` field. That field gets `media.cutout: true`, and the board draws three layers: the clip, the element, then the clip's cutout (prop `<key>Cutout`, the same clip with only the people opaque). An element beside the person or always in front of it, or one covered by something the board draws, is an ordinary layer; a hand-drawn silhouette of the original person is never used as a mask;
- `validate.mjs template` cross-checks: every media field has a matching element; an element whose content moves cannot be an `image` field; the measurements in `motion.json` match what is declared; every font role an element uses is in `fonts.json`; an element with `behind` points at a `video` field with `media.cutout`, every `media.cutout` field has an element behind it, and the board draws `<key>Cutout`;
- Sound effect library: `scripts/lib/sfx.mjs` synthesises `pop`, `click`, `whoosh`, `swoosh`, `ding`, `paper`, `typewriter`, `impact`, `riser`, `shutter` in pure Node, rendered into `~/.tapvid-video/sfx/` on first use, free and offline; a template can ship its own `template/sfx/<type>.wav` to override them. The original's audio never enters the final film;
- Caption style: `Design.captions` records the original's measured position, size, characters per group, font weight, background plate or not, letter case and word-by-word reveal; `Captions.jsx` draws from it, and unspecified items keep their defaults;
- Captions per board: whether a layout shows captions is part of the layout and is decided while building the board, in its `meta.captions` (required once the template has captions): `true`, `false` (the original shows none over this layout, e.g. a hook whose kinetic title is the spoken line), or an object whose `off` lists the narration fields with no captions (a title card that says its own line) and whose other keys override `Design.captions` tokens for this board (e.g. a lower `centerY` on a full-frame layout).

## 7. Review page

### 7.1 Page

`review.mjs` generates and builds a preview project with `project.mjs --preview`, wraps it in the `template/review.html` shell, and outputs `review/index.html`. The page references build output and media in the same directory, opens locally with a double-click, and needs no network. Every video, audio clip and image the user needs to see plays inside the page.

The page supports English and Chinese, defaults to English, has a switch in the header, and remembers the choice in the browser. All interface text comes from the English–Chinese dictionary inside the page; `review.mjs` and `project.mjs` output only language-neutral codes (asset kind, source, unit, scene number, badge code), which the page and a bridge script in the preview project display in the current language. User content such as copy, picture descriptions and prompts is shown as written.

The page adds tabs as stages progress: `review.mjs <project>` (without a slug) builds stop 1's clone comparison page `<project>/review/`, which has only "Clone comparison", with the template name, board count, comparison scores and known limits in the header; with a slug it builds `replicas/<slug>/review/` with the first three tabs, and "Final cut" and "Assets" are added once the final film is rendered:

| Tab | Contents |
|---|---|
| **Clone comparison** (还原对照) | The original on the left, the template on the right (boards use `example_data`, media slots are filled with the reference clips from `refs`, sound is the original's audio track and can be toggled); both play in sync on one clock and are sized to the browser window, so the two screens, the timeline and the options are all in view without zooming out; the template side plays the `data-sfx` sound effects. Component frames are on by default: red frames are media slots, blue frames are code components (title cards, stickers, captions …). Below is a timeline laid out by shot: one comparison score cell per shot, with those below 0.95 marked red and showing the reason written in the report; boundaries with a timing offset of more than 1 frame are marked red too |
| **Replica preview** (复刻预览) | The replica plays along its timeline, with media slots shown as in the table of step 5 (reference clip + replacement notes / sketch / user material; a digital human shows the portrait photo before it is generated); once assets are generated it uses the generated assets, the real narration and the real durations. Transitions match the final film, and sound effects play. Before narration is generated, `narration` mode reads the narration aloud with the browser's `speechSynthesis` and shows captions at the estimated durations. BGM candidates can be switched to audition. "Compare with original" (原片对比) puts the original on the left and plays it in sync, aligned line by line with the narration (when the original's line is shorter, it holds on its last frame). The progress bar is segmented by scene; clicking jumps |
| **Storyboard & cost** (分镜与费用) | The same storyboard table as in the conversation, with the per-model cost table (unit price, quantity, subtotal) on top, plus each media slot's generation method, the actually chosen model / resolution / duration, the estimated cost summarised per provider, and the unavailable capabilities with their fallback notes |
| **Final cut** (成片) | The final film and the original side by side, playing in sync line by line with the narration (the original muted by default, sound can be turned on); the version picker lists `out/*.mp4`, with `tapvid.mp4` first and marked "current" |
| **Assets** (素材) | Every generated asset and user material, grouped by scene: videos play directly and images show directly; each card states the scene and use ("Scene 1 · Digital human"), the vendor, the model and the actual cost |

Preview durations: once assets are generated and `timing.mjs` has run, the real durations; before that, `narration` mode estimates from copy length (4.5 characters per second for Chinese, 15 characters per second for English, both module constants), within the board's duration range; other modes match the original's timeline. Playback uses `window.scenePlayer`'s `play()` / `pause()` / `seekTo()`; no separate clock is written.

### 7.2 Placeholder motion sketches

Sketches are used for media slots without a reference in the original and for media slots whose source is `code`. The user relies on a sketch to judge what the shot will look like, so it is not "a gradient background plus one line of text" but an animated storyboard of the shot:

- **Form**: a React component with default export `({ t, duration, Design })` that fills its media slot. It may use SVG, CSS gradients, filters, Canvas; it is a pure function of `t` (same rules as boards) and imports only React;
- **Recognisable subject**: draw the subject and the key details from the prompt (the product's shape and material highlights, the person's pose and facing, the UI's layout), not geometric placeholder blocks; when there is a replacement image, put the image straight into the composition;
- **Space and light**: at least three layers, foreground, midground and background, with a difference in depth of field (background blurred or lower in contrast); light and shade, rim light and shadows follow the light direction in the prompt;
- **Colour**: the main colour comes from the colour the prompt describes, supported by `Design.palette`, in harmony with its board;
- **Motion**: camera motion matches the prompt or `media.motion` (push-in = scale, pan = translate, orbit = layered parallax); subject actions are expressed with keyframes (raising a hand, turning, steam, particles); the duration equals the media slot's duration;
- **UI media slots** (`role: screen`): draw a realistic UI from `product.md`, with a sidebar or tab bar and realistic data (names, amounts, dates), with the spot this line of narration talks about clearly visible. Such sketches can usually serve directly as the final picture (source `code`);
- **No explanatory text**: badges and prompts are overlaid by the review page shell; the sketch itself never shows words like "AI video";
- **Self-check**: capture three frames with `frames.mjs --sketch` and look at each. Rewrite when the subject is unrecognisable, there are only colour blocks, or the motion does not match the prompt. Keep each sketch within about 250 lines.

## 8. Rendering

The render project uses the bundled skeleton and protocols (`window.scenePlayer`, `__ASSET:<alias>__`, single-file `index.html`, the transition manifest of `mountProject`). The difference is that scene modules are generated by `project.mjs`, each scene wrapping one board:

```jsx
import React from 'react';
import { Design } from '../system/design.js';
import { Hook01 } from '../boards/Hook01.jsx';

export const duration = 2.133;
const segments = [];

export default function Scene({ t }) {
  return (
    <div style={{ position: 'absolute', inset: 0, containerType: 'size' }}>
      <Hook01 t={t} duration={duration} segments={segments} Design={Design}
        kicker="Month-end close" title={['Three days of work', 'done in ten minutes']}
        cover={<video src="__ASSET:01-Hook01-cover__" playsInline muted data-offset="0" />} />
    </div>
  );
}
```

- `src/boards/` copies the template's board files as they are; `src/system/design.js` copies the template's `design.js`; `src/system/fonts.js` injects `@font-face` from `fonts.json`; when the template has a `transitions.js` extension, it is copied too and loaded first;
- Media fields build elements from `media` in `replica.json`: `image` → `<img>`; `video` → `<video muted playsInline data-offset>`, driven by scene time through `videoSync.js`; `code` source → the sketch component element; `element` → the component element under `elements/`. Media inside list items goes into the matching item by field path;
- `src/index.jsx` generates the `mountProject` manifest from `resolved` and the template's `transitions`: at a boundary with a declared transition, the earlier scene's interval is extended by the transition duration to overlap the next scene, both are mounted at once and driven by `transitions.js`; every other boundary is a hard cut;
- The caption component is layered above the scenes (in `narration` mode when `audio.captions` is not null), styled from `Design.captions` and the board's `meta.captions`: none on a `false` board, the words of its `off` lines dropped, its token overrides merged; preview and final cut are generated the same way;
- A `media.cutout` field also passes `<key>Cutout`: a `<video>` of the clip's cutout (`<clip>.cutout.webm`, VP9 with alpha), synced like the clip. `project.mjs` makes it with `matte.mjs` when it is missing or older than the clip — the reference clip in the clone comparison, the generated, sped or user clip in the replica. `matte.mjs` runs Robust Video Matting (MobileNetV3, ONNX, 15 MB, sha256-checked) on onnxruntime-node, both installed into `~/.tapvid-video/` on first use without asking, at a downsample ratio that keeps the matted short side near 288 px;
- Videos with `data-loop` (`media.loop` or `loop: true` on the replica's media entry) loop at `t mod duration`;
- `render.mjs`: `seekTo(frame / fps)` frame by frame, screenshot once fonts, images and the video `seeked` event are done; several pages run in parallel, ffmpeg encodes and the parts are concatenated losslessly. The render page turns on frame-accurate mode (`window.__tapvidFrameAccurate`): `videoSync.js` does not treat the consecutive per-frame jumps as scrubbing the progress bar, so videos never play by themselves between two screenshots; the paused seek tolerance is under half a frame, and the target time is pushed slightly past the frame boundary so that the frame starting at `t` is captured; otherwise the picture stalls and then jumps, looking alternately fast and slow;
- During capture, the moment each `[data-sfx]` element first becomes visible is recorded and written to `project/sfx-cues.json`;
- Audio places each scene's narration and digital human tracks by `resolved` (using the sped-up files when there is a uniform speed-up), mixes in the BGM (ducked under narration, 0.5-second fade in and fade out at the start and end) and the sound effects (under the narration, not part of the BGM ducking); `silent` mode outputs only the video stream. The 1080p final film is rendered directly, with no draft.

## 9. Reference material

The workflow reads the documents in `references/` as needed: analysis, boards, structure,
acceptance, replica, sketches, transitions, audio, captions, providers and provider authoring.
All required instructions are distributed with the skill. No private repository is needed.

## 10. Testing

- `scripts/lib` and the runner have unit tests written with `node:test`, coverage ≥ 80 %. Covered: routing choice, per-model adaptation of resolution / duration / aspect ratio, switching provider on unsupported parameters, fallback from `reference` to `keyframe`, `tasks.json` resume (completed skipped, polling continued with a `jobId`, changed parameters treated as a new request), execution in dependency order, handling of each error code, estimate summaries. Driven by a fake provider, with no network requests.
- Every built-in provider has offline contract tests replaying `__fixtures__`: request mapping, response parsing, error classification; `media.mjs check <provider>` passes in full.
- `intake.mjs` is tested with a synthetic video with known cuts and transitions (generated with ffmpeg: hard cuts, a 0.5-second dissolve, colour blocks entering): cut and transition window errors are no more than 1 frame.
- `validate.mjs`, `timing.mjs`, `project.mjs`, `compare.mjs` and `transitions.js` are tested end to end with a small sample project committed with the tests, `tests/remix/fixtures/sample-clone/` (2 boards, 1 `page-flip` transition, 5 seconds): generate the replica project, render, and check duration, frame count and transition frames.
- The unit tests and the sample template's end-to-end tests run once on macOS and once on Windows; both branches of `platform.mjs` have tests (with mocked child processes, no real dialogs or installs).
- Each new module has offline unit tests: speech rate and syllable counting, copy budget warnings, word alignment and uniform speed-up for digital humans with their own voice, prompt `cue` parsing, sound effect detection (synthetic clicks) and the synthesis library, sound effect cues in rendering, `measure.mjs` motion classification (synthetic still / boil / loop clips), element inventory validation, looping videos, each stage of the review page, per-model estimates and actual cost summaries, refusal of `--live` without `--spend`, economy tier model choice, giphy replay, `gif.mjs`, `reframe.mjs`, whisper model mirror fallback.
- Real calls: each provider with a key runs `media.mjs check <provider> --live --spend` (with consent obtained first each time), with the results recorded in the verification record of section 12.

## 11. Distribution

Distribute the complete `skills/remix/` directory using the direct skill installation in
README.md. Future skills live beside it under `skills/<name>/`. This repository does not
currently ship marketplace adapters. Tests and repository contributor docs are development
resources; runtime scripts must not depend on them.

## 12. Extended verification (not an execution record)

1. Use three redistributable reference videos and hand-reviewed templates to calibrate the 0.95 structural similarity threshold in `compare.mjs` (ffmpeg `ssim`, 480×270). Record the measurement method and any calibration changes.
2. With 3 reference videos of different pacing (including 1 fast-paced video with a transition every 1–2 seconds), calibrate the hard-cut and soft-transition threshold constants of `intake.mjs` and compare the cuts with hand-labelled frame boundaries.
3. In headless Chromium, compare the rendered video asset frames frame by frame with the same frames converted directly by ffmpeg (1080p, 30fps, 10-second clip, including 24 fps material) to confirm that in frame-accurate mode the number of duplicated and skipped frames is no higher than that of the ffmpeg conversion itself.
4. With consent, run `media.mjs check --live --spend` for TapVid, MiniMax, fal, OpenAI and ElevenLabs one by one, and write the actual model ids, resolution tiers, duration ranges, reference limits and prices back into each provider's `meta`. The other built-in providers do the same once a key is available.
5. Test the `whisper.cpp` model download (speed and checksum from huggingface and the hf-mirror mirror) and the quality of word-level timestamps for Chinese and English; if quality is insufficient, local transcription takes only segment timestamps and word timing switches to weighted distribution.
6. Confirm that in Claude Code and the Codex desktop app (macOS and Windows), script child processes can read and write the system credential store (Keychain / DPAPI file) and show the password dialog; when the Codex sandbox blocks this, tell the user to use environment variables instead, and document it in `providers.md`.
7. Confirm the browser automation capabilities available in Claude Code and Codex (Chrome browser control, computer use), and how they search, get links and download in the user's logged-in browser; write the steps by the actual capabilities in the browser fallback section of `providers.md`.
8. Confirm that the Google Fonts `css2` endpoint returns woff2 without a key, and that `fonts.mjs` downloads from its response.
9. Confirm whether the current Codex version supports sub-agents; if not, steps 3 and 5 follow the serial path.
10. Settle the following call details item by item from the official documentation and write them into the corresponding providers:
    - fal's REST flow for uploading local files (storage upload initiate + PUT);
    - Gemini `interactions` background polling for video generation and video understanding, the duration parameter, and the video input size limit;
    - Kling's text-to-video path;
    - The request body of HeyGen `POST /v3/videos`;
    - How the key is written for D-ID Basic auth;
    - The resolution, aspect ratio and duration parameter names of Ark video tasks, the Seedance 2.5 model id, and whether reference videos are supported;
    - The field names of the `whisper-cli -ojf` output.
11. Open the review page in Chrome and Safari on macOS and Chrome and Edge on Windows, and confirm that `speechSynthesis` has usable voices for `zh` / `en` and that the original and the template play in sync within one frame.
12. On Windows 11, walk through step 0 (winget install, password dialog, DPAPI read/write) and one complete 10-second replica with both Claude Code and Codex, and confirm that Playwright's Chromium download, ffmpeg pipe encoding, and paths and file names containing Chinese and spaces all work.
13. With 3 reference videos containing sound effects, GIF stickers and boil, calibrate the classification thresholds of `measure.mjs motion` and the threshold constants of `intake.mjs` sound effect detection, and confirm that syllable counting on fast-paced English talking-head videos is within 5 % of a manual count.
14. With a free GIPHY key, run `media.mjs check giphy --live --spend` (no charge) to confirm the returned mp4 fields and the rating parameter.
