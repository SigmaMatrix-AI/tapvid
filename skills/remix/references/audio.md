# Audio: mode, voice, music

For the main agent: the audio mode and voice in step 1, music candidates in step 5, the final voice and music
in steps 7–8. The original's sound never goes into the film; it only tells you what to recommend.

## 1. Mode

Recommend from `analysis/brief.json` `audio`, follow the user's explicit wish over it:

| Mode | Recommend when | Sound | Scene lengths |
|---|---|---|---|
| `narration` | the original has a voice-over | voice + music, music ducked under the voice | set by the voice: each scene = lead-in + takes + tail, inside the board's `minDuration` / `maxDuration` |
| `music-only` | the original has music and no voice | music only | the original's timeline, frame for frame (scene, segment and transition lengths from the source); a list with a different count repeats or drops the original's per-item rhythm |
| `silent` | the user asks for no sound | no audio stream | as `music-only` |

In `music-only` / `silent`, narration fields are on-screen copy only, there are no captions and no digital
humans (a presenter slot becomes an image or footage slot). Without a speech provider only these two modes are
possible — tell the user.

## 2. Voice (narration mode)

```json
{ "id": "voices-zh", "capability": "speech.voices", "params": { "language": "zh", "gender": "female" } }
```

Save it as `$PROJECT/requests/voices.json`, run `node "$SKILL_ROOT/scripts/media.mjs" run "$PROJECT/requests/voices.json"`
and read `tasks["voices-zh"].result.items` in `$PROJECT/requests/tasks.json` (`id`, `name`, `gender`,
`language`, `sample_url`, `recommended`, `provider`). Propose two or three: the recommended ones first, matching
the original voice's gender and register. Offer the samples (open `sample_url`). Record the choice as
`audio.voice = { provider, id, name }` — `provider` pins the vendor for every take and for the digital human,
so the whole film has one voice.

A take is one `speech.synthesize` per scene, or per `narration` field on a segmented board (the plan writes
them). A take that pushes its scene past `maxDuration` is shortened in the copy and voiced again.

A digital human that speaks the script itself (TapVid avatars do) is its own take: the plan writes no
separate narration for its scenes, and `timing.mjs` transcribes the avatar's audio and lays the lines on its
real words, so lips, captions and pop-ups stay together.

### Pace

A replica that talks slower than the original feels flat and runs long. Pace is syllables per second over the
speech (pauses left out) — words per minute misreads lines of short words.

1. **Copy budget first** (`references/replica.md` §4): the copy fits the original's pace × the scene's window.
2. **One tempo for the film.** `timing.mjs` measures the voiced takes against the original and, when they are
   more than 8 % slower, speeds the whole film's voice by one factor (pitch kept): up to 1.3× for a voice-over,
   up to 1.12× where a presenter's lips and gestures are visible (beyond that it looks fast-forwarded). Never a
   factor per line: lines then lurch between speeds. `replica.audio.tempo.fixed` overrides the factor (1 =
   off); the decision is stored in `replica.audio.tempo`.
3. Choose voices with the original's energy: a fast creator read needs a lively voice, not a calm narrator.

## Sound effects

The original's sound effects are listed by `intake.mjs` (`source/sfx.json`) and given to elements in the
template (`references/analysis.md` §9). Each sounding element carries `data-sfx`; the review page plays them
with the preview and `render.mjs` mixes them under the voice from a built-in library synthesised locally
(`pop`, `click`, `whoosh`, `swoosh`, `ding`, `paper`, `typewriter`, `impact`, `riser`, `shutter`; free;
`node "$SKILL_ROOT/scripts/sfx.mjs" list`). A template may ship its own `template/sfx/<kind>.wav`, which wins. The
original's audio is never cut into the film. `replica.audio.sfx: false` turns them off.

## 3. Music: sources and priority

| Priority | Source | When | Cost |
|---|---|---|---|
| 1 | The user's file | they give one | free; copy to `$REPLICA/assets/audio/` |
| 2 | `music.generate` | a ready provider (ElevenLabs, MiniMax) and the user wants original AI music | paid — a row in the estimate, generated after confirmation |
| 3 | Local composition (`music-compose.mjs`) | default otherwise; always available | free |
| 4 | `music.search` | a ready provider (Jamendo) and the user wants a real recording | free; only tracks with download allowed; licence and credit in the report |

`audio.bgm.brief`: one English line — mood, genre, instruments, bpm range — read from the original (its
`bpm` from `timeline.json`). It is the prompt for `music.generate`, the query for `music.search`, and the brief
for the scores.

## 4. Candidates (step 5, before confirmation)

Make two or three free candidates, so the review page can switch between them:

- the user's file, when given (the only candidate unless they want options);
- two composed scores with different arrangement or tempo (§5);
- optionally one `music.search` hit:
  `{ "id": "bgm-search", "capability": "music.search", "params": { "query": "<brief keywords>", "min_s": <total − 5>, "max_s": <total + 60> } }`
  in `$REPLICA/bgm-search.json`; download its `download_url` into `assets/audio/candidates/`.

When `music.generate` is ready and the user wants AI music, add it as one more option, described by vendor and
price ("Original AI music, ElevenLabs, about $0.40" — in the user's language); it is generated after the confirmation, at the final length, and the
user can still switch back to a composed one.

Fill `audio.bgm.candidates[]` (`source`, a user-facing `title` in the user's language such as "Light electronic, 104 bpm", `path`, `score` for
composed ones, `bpm`) and `selected`.

## 5. Composing (free)

A score is a plain script that calls `score({...})`:

```js
score({
  bpm: 104,
  instruments: ['marimba'],
  oneShots: ['crash'],
  compose({ Tone, ugc, seconds, bars, cues }) {
    const pad = ugc.synth.pad({ volume: -14, wet: 0.5 });
    const bass = ugc.synth.bass({ volume: -10 });
    const pluck = ugc.synth.pluck({ volume: -16, wet: 0.3 });
    const drums = ugc.drums({ kick: -8, hat: -20 });
    for (const { bar, notes, root } of ugc.progression(['A:m7', 'F:maj7', 'C:maj7', 'G:sus4'], { octave: 3 })) {
      pad.triggerAttackRelease(notes, '1m', ugc.at(bar, 0, 0));
      bass.triggerAttackRelease(root, '2n', ugc.at(bar, 0, 0));
      notes.forEach((n, i) => pluck.triggerAttackRelease(n, '8n', ugc.at(bar, i, 2)));
      for (let b = 0; b < 4; b++) { drums.kick.triggerAttackRelease('C1', '8n', ugc.at(bar, b, 0)); drums.hat.triggerAttackRelease('C1', '16n', ugc.at(bar, b, 2)); }
    }
    for (const c of cues) ugc.oneShot('crash', { volume: -12 }).start(c);
  },
});
```

```bash
node "$SKILL_ROOT/scripts/music-compose.mjs" "$REPLICA" music/score-1.js --seconds <total> --out assets/audio/candidates/1.mp3 [--cues music/cues.json]
```

It renders exactly `seconds` of audio and writes `<out>.beats.json` beside it. `--cues` is a JSON array of
seconds (scene boundaries, the reveal) passed to the score as `cues`.

Helpers: `ugc.sampler(name, { volume, wet, release })`, `ugc.oneShot(name, { volume, wet })`,
`ugc.synth.pad / keys / pluck / lead / bass / subBass({ volume, wet })`, `ugc.drums({ kick, snare, clap, hat })`,
`ugc.chord('C:maj7', octave)`, `ugc.progression(names, { bars, octave, totalBars })` →
`[{ bar, time, name, notes, root }]` filling the film, `ugc.at(bar, beat, sixteenth)`, `ugc.bars`,
`ugc.seconds`. Chord qualities: `maj m dim aug sus2 sus4 maj7 m7 7 m9 maj9 add9 6 m6`. Samplers
(`template/music/instruments.json`): `violins`, `violins-pizz`, `cellos`, `contrabass-pizz`, `harp`, `piano`,
`flute`, `horn`, `marimba`, `glockenspiel`; one-shots `bass-drum`, `snare`, `crash`, `triangle`, `tambourine`,
`sleighbells`, `gong`, `cymbal-swell`. All CC0 (VSCO 2 Community Edition) or synthesis: no attribution, safe for
commercial use. The master bus already compresses, limits, adds reverb and fades out.

Rules: schedule everything inside `compose` on transport times; no unseeded randomness; in narration mode
leave room for the voice (fewer mid-range parts, softer leads). Structure follows the film: a 1–2 bar intro,
the groove under the body, a lift before the call to action, a resolved last chord.

| Style | bpm | Parts | Progression |
|---|---|---|---|
| Tech / SaaS | 100–118 | pad, saw bass, 8th pluck arpeggio, four-on-floor + offbeat hat | `A:m7 F:maj7 C:maj7 G:sus4` |
| Corporate upbeat | 96–110 | piano or keys stabs, bass, kick + clap on 2 & 4, marimba hook | `C:maj G:maj A:m F:maj` |
| Warm / family | 72–90 | harp arpeggios, cello roots, glockenspiel, no drums | `F:maj7 D:m7 A#:maj7 C:sus4` |
| Festive | 100–120 | violins-pizz, glockenspiel, sleighbells / tambourine 8ths, contrabass-pizz | `C:maj F:maj G:7 C:maj` |
| Lo-fi / lifestyle | 78–90 | keys m7 / m9, sub bass, soft swung drums | `D:m9 G:7 C:maj7 A:m7` |
| Epic reveal | 80–96 | cellos + horn, violin swells, bass-drum + cymbal-swell into the reveal cue, crash on it | `D:m A#:maj F:maj C:maj` |
| Luxury | 70–84 | sparse piano, violin pad, sub bass | `E:m9 C:maj7 G:maj7 D:add9` |
| Sport / energy | 120–140 | lead riff, 8th bass, snare rolls into cuts | `E:m C:maj G:maj D:maj` |

Say so honestly when a requested sound has no sample (guzheng, erhu, vocals, guitar): offer the user's own file,
AI music if a provider is ready, or the nearest substitute (guzheng → harp + pluck; erhu → violins, slow attack;
guitar → pluck).

## 6. Final music (step 8)

After the takes exist and `timing.mjs` has fixed the total length:

- **composed**: re-render the selected score at the resolved total to `assets/audio/bgm.mp3`
  (`--seconds <total> --out assets/audio/bgm.mp3`, cues at the scene boundaries); its beat grid is written
  beside it;
- **AI music**: `{ "id": "<slug>-bgm-1", "capability": "music.generate", "params": { "prompt": "<brief>", "duration_s": <total>, "instrumental": true }, "out": "assets/audio/bgm" }`
  saved as `$REPLICA/bgm.request.json`, run with `media.mjs run`; then the beat grid;
- **user file / search hit**: copy to `assets/audio/bgm.mp3`; beat grid when it has a steady beat:
  `node "$SKILL_ROOT/scripts/beats.mjs" "$REPLICA/assets/audio/bgm.mp3" --out "$REPLICA/assets/audio/bgm.beats.json" [--bpm N]`.

Set `audio.bgm.path` and `audio.bgm.beats`. **music-only**: compose from the original's beat table — the score's
`bpm` = the source `bpm`, cues = the source shot boundaries — so the cuts land on beats exactly as in the
original; then run `timing.mjs` again (it snaps scene lengths to the beat grid) and, if the total moved,
re-render the score at the new total.

The render ducks the music under the voice in narration mode and fades in / out 0.5 s at the ends.
