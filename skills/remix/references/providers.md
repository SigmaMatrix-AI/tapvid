# Media providers

For the main agent: what the media layer can do, how to read what is ready, how keys get in, what happens
when something is missing or fails, and how to report cost. Every call is a script talking HTTP to the vendor;
no MCP server is involved.

## 1. Capabilities

| Capability | In plain words (to the user) | Built-in vendors, default order |
|---|---|---|
| `video.generate` | AI video | TapVid → MiniMax → fal → Ark → Kling → Runway → Luma → Gemini → Replicate |
| `image.generate` | AI image | TapVid → fal → OpenAI → Gemini → MiniMax → Ark → Replicate |
| `speech.synthesize`, `speech.voices` | voice-over, voice list | TapVid → ElevenLabs → MiniMax → OpenAI → Gemini |
| `speech.transcribe` | transcribing the original | ElevenLabs → local Whisper → OpenAI |
| `video.understand` | AI watching the original | Gemini |
| `music.generate` | AI music | ElevenLabs → MiniMax |
| `music.search` | royalty-free music | Jamendo |
| `avatar.generate`, `avatar.list` | digital human | TapVid → fal → Replicate → HeyGen → D-ID |
| `video.search` | finding videos | YouTube, Pexels, Pixabay — all ready ones at once, results merged |
| `video.download` | downloading a video from a link | yt-dlp (local) |
| `image.search` | stock photos; with `animated: true`, reaction GIFs (as mp4) | Pexels → Pixabay; animated: GIPHY |

Params and results: `$SKILL_ROOT/assets/schemas/capabilities/<capability>.json`. Douyin, TikTok, Bilibili, Xiaohongshu
and Instagram have no usable official search / download API; connect a third-party service the user has a key
for (TikHub, Apify) with a written provider (`references/provider-authoring.md`).

## 2. What is ready

`node "$SKILL_ROOT/scripts/media.mjs" providers --json` →

```json
{ "providers": [ { "name": "minimax", "displayName": "MiniMax", "custom": false, "secrets": ["MINIMAX_API_KEY"],
                   "configured": true, "ready": true, "capabilities": ["video.generate", "image.generate", "speech.synthesize"],
                   "reason": null } ],
  "byCapability": { "video.generate": [ { "provider": "tapvid", "ready": false }, { "provider": "minimax", "ready": true } ] } }
```

- `ready` = key present and `verify` passed (cached 12 h; `--verify` re-checks now). `configured` without
  `ready` = a key that was rejected: `reason` says why (`auth: …`).
- `capabilities` already leaves out what the account lacks (e.g. a MiniMax account without music access).
- A capability with no ready entry in `byCapability` is missing: apply §4 and tell the user its effect.
- `custom: true` marks a provider written into `~/.tapvid-video/providers/`; it replaces a built-in of the
  same name.

## 3. Keys and routing

- `node "$SKILL_ROOT/scripts/set-key.mjs" <provider>` opens the system password box (one per secret the provider
  declares), verifies, and stores the key in the macOS Keychain or a Windows DPAPI file. Output: `saved` /
  `cancelled` / `invalid-key` (three rejections). `--delete` removes it.
- An environment variable of the secret's name (`MINIMAX_API_KEY`) wins over the stored key — the way to
  switch keys temporarily, or the fallback when the client's sandbox blocks the password box or the keychain
  (tell the user to set it in their shell profile and restart the client; never ask for the value).
- Keys never go into chat, project files, ledgers or logs.
- TapVid: one key covers video (with reference video), image, voice, voice list and digital humans, on one
  bill in credits. Key page: https://tapvid.ai/developer/apikey.

Routing for a request without a fixed vendor: the order in `~/.tapvid-video/config.json`, else the default
order above, TapVid first wherever it is configured; keep vendors that are ready and whose models fit the
request (aspect, duration, resolution, first / last frame, reference images and videos); take the first, with
its default model that fits.

```json
{ "routing": { "video.generate": ["tapvid", "minimax", "fal"], "speech.synthesize": ["elevenlabs", "tapvid"] },
  "models": { "video.generate": { "fal": "bytedance/seedance-2.5/reference-to-video" } } }
```

A vendor the user picks for one slot goes into that slot's `provider` (and `model`) in `replica.json` and wins
over routing. A vendor the user prefers for a whole capability goes into `config.json` `routing`.

## 4. When a capability is missing

| Missing | What happens | Say |
|---|---|---|
| `video.generate` | images with code camera moves (push, pan, parallax); without images too, the sketch | "These shots will be AI images with camera moves" |
| reference video support | `keyframe`: a new first frame, then image-to-video with the original's move described | "The camera moves are recreated from a description, not copied frame by frame" |
| `image.generate` | the sketch | "These pictures will be animation" |
| `speech.synthesize` | only `music-only` / `silent` | "No voice service is set up, so the film can only be music-only or silent" |
| `speech.transcribe` | local Whisper (`ensure-runtime.mjs --tool whisper-cli` installs it, no question asked) | — |
| `video.understand` | skipped; frame-level reading only | — |
| `music.generate` | local composition | — |
| `avatar.generate` | the portrait image with gentle motion on presenter boards | "The presenter will be a photo with gentle motion, not a talking digital human" |
| `video.search` / `video.download` | browser fallback (§6), else the user downloads | — |
| animated `image.search` (GIPHY) | moving original pictures become AI clips (paid) or code animation | "The original's GIFs will be AI pictures brought to life (paid per clip) or animation; with a free GIPHY key they can be real GIFs" |

## 5. Failures during a run

`media.mjs run` handles these itself and records every attempt in `tasks.json`:

| Error | Runner | You |
|---|---|---|
| `transient` (network, 5xx, timeout) | retries once on the same vendor, then the next | rerun `run` later — finished requests are skipped, submitted jobs resume polling |
| `moderation` | stops that request | rewrite the prompt (no brands, celebrities, copyrighted elements) and rerun it once; a refused reference video → switch the slot to `keyframe` |
| `unsupported` / `invalid` | next model or vendor | nothing, unless every one failed |
| `auth` / `quota` | that vendor is off for the rest of the run, next vendor | tell the user: new key (`set-key.mjs`) or top up; when no vendor is left, stop and wait |
| every vendor failed | the request is `failed` | the slot falls back to its sketch (`source: code`), listed in the delivery report |

Rerunning is always safe: the request `id` is the idempotency key, a completed request with unchanged params
is reused, a changed request gets a new attempt. The exit code is 2 when any request did not complete.

## 6. Browser fallback for search and download

When `video.search` / `video.download` cannot do it (no provider for the platform, a login wall, a refused
download):

1. Ask first: "I can search for / open this video in your browser; you would log in yourself. OK?"
2. With consent, use the browser automation the client offers (Chrome control in Claude Code, a browser or
   computer-use tool in Codex). Work in the user's own browser profile; the user logs in themselves — never
   ask for or type their password.
3. Search on the platform's own page, read the result list (title, length, views, date, link) and show it as
   the usual table; open only the video the user picks.
4. Get the file the way the page offers it to that user (its download or save button), or copy the video
   page's link and retry `video.download` with it. Never bypass a paywall, DRM, captcha or a "download
   disabled" setting; never bulk-download.
5. If none of this works, ask the user to download it themselves and give you the file path.

Tell the user the original is used for analysis, the review comparison and as reference input to the models
— it never appears in the finished film.

## 7. Cost

- Before: `media.mjs estimate "$REPLICA/plan.json" --json` → `{ rows: [{ id, provider, model, usd, credits, note }],
  byModel: [{ provider, model, capability, unit, unitPrice, count, subtotal, currency }],
  totals: { <provider>: { usd, credits } } }`. `byModel` is the table the user sees at stop 2. TapVid in credits, others in dollars, totals per vendor; never
  add credits and dollars together. Prices are each provider's table from the vendor's price page; the vendor's
  own charge is final.
- After: each completed request's `cost` in `tasks.json` (`estimated: true` when the vendor does not report
  one) — `media.mjs spend "$REPLICA"` sums them per vendor and model for the delivery report. `media.mjs account` prints balances for vendors that expose
  them; quote the TapVid balance before and after when the user asks what the run cost.
- Anything new and paid after the confirmation (a regeneration, a longer clip, AI music) is announced with its
  price and waits for a yes (auto mode: within the user's budget).
- Prices: `media.mjs prices <provider>` lists each model's price (refreshing the vendor's model list) and
  spends nothing. `media.mjs check <provider> --live` makes real, paid test calls: it refuses without
  `--spend`, and `--spend` needs the user's yes with the amount it prints.
