# TapVid

Reusable skills for making videos with a coding agent. Each skill contains its own instructions, scripts and assets, so it can be installed independently.

| Skill | What it does |
| --- | --- |
| [remix](skills/remix/SKILL.md) | Rebuild a reference video as reusable React boards, then adapt it to a new topic with new copy, media, narration and music. Render the result locally as `tapvid.mp4`. |

Remix supports a faithful `high` tier (default) and a faster `low` tier. It accepts a local video, a URL, search keywords or an existing clone project. It needs a local coding agent with filesystem, shell and visual inspection capabilities; the scripts alone do not replace the agent's analysis and creative work.

## Install

```sh
git clone https://github.com/SigmaMatrix-AI/tapvid.git
cd tapvid
```

Copy the **whole** `skills/remix` directory into your agent's skills directory. For a first installation on macOS:

```sh
# Codex
mkdir -p "$HOME/.agents/skills"
cp -R skills/remix "$HOME/.agents/skills/remix"

# Or Claude Code
mkdir -p "$HOME/.claude/skills"
cp -R skills/remix "$HOME/.claude/skills/remix"
```

On Windows, copy the folder into `%USERPROFILE%\.agents\skills\remix` for Codex or `%USERPROFILE%\.claude\skills\remix` for Claude Code. If `remix` is already installed, back up local changes and replace that skill folder instead of nesting another copy inside it. User projects and `~/.tapvid-video` should be kept.

These are the documented [Codex skill locations](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) and [Claude Code skill locations](https://code.claude.com/docs/en/skills#choose-where-skills-load). Reload skills or start a new agent session after installation. This repository currently uses direct skill installation, without marketplace manifests.

## Use

Ask your agent, for example:

> Use remix to recreate `/absolute/path/reference.mp4` for my note-taking app. Start with the low tier.

Or invoke `/remix /absolute/path/reference.mp4 low` in Claude Code. The workflow builds a reusable template first, then prepares the new topic, previews the plan and renders the final video. By default, it requests confirmation at the review points described in [SKILL.md](skills/remix/SKILL.md). `auto` delegates production choices within any budget you specify.

Projects contain `source/`, `analysis/`, `template/` and `replicas/`. Each replica's final output is `replicas/<slug>/out/tapvid.mp4`. Existing TapVid clone projects, provider settings and stored credentials retain their current formats and locations.

## Requirements and setup

- Node.js 20 or newer with npm; current Node.js 22 or 24 is recommended for development.
- FFmpeg and ffprobe on `PATH`.
- Internet access for the initial npm dependencies and Playwright Chromium download.
- macOS and Windows platform adapters are included. The migration is locally tested on macOS; the CI workflow covers macOS and Windows. Linux requires manual system dependency setup and does not have native key-dialog or credential-store integration.

From the checkout, bootstrap the runtime:

```sh
node skills/remix/scripts/ensure-runtime.mjs
```

The agent runs the equivalent command from the installed skill automatically. When available, the setup command uses Homebrew on macOS or winget on Windows to install missing system tools. It installs pinned npm dependencies with `npm ci` into `~/.tapvid-video/runtime`, then installs and checks Chromium. Subsequent runs reuse the dependencies and repair a missing browser cache. A successful setup ends with `ready`; `missing: ...` identifies system tools that need manual installation.

Set `TAPVID_VIDEO_HOME` to place runtime data, caches and custom providers elsewhere. `PLAYWRIGHT_BROWSERS_PATH` controls the browser cache. Neither the checkout nor an installed skill needs `node_modules`.

## Media providers and optional downloads

Local template creation, offline provider checks, code animation and rendering do not require a TapVid account. Generated video, images, narration or avatars require a suitable provider and may incur charges. Configure only the providers you use; see [providers](skills/remix/references/providers.md) and [provider authoring](skills/remix/references/provider-authoring.md).

Keys can come from provider environment variables or the native credential store through `set-key.mjs`. Do not put keys in chat, project files or commits. For example, `TAPVID_API_KEY` is needed only for the TapVid provider. Media providers use direct HTTP APIs; no MCP connection is required.

Optional features download their own tools or assets on first use: yt-dlp for downloads, whisper.cpp and a transcription model (about 1.6 GB), ONNX Runtime and an RVM model for matting, Google Fonts, and VSCO samples for composed music. These have separate licenses and service terms; see [third-party notices](THIRD_PARTY_NOTICES.md). Model downloads, live provider checks and paid generation are not part of the offline test suite.

## Development

```sh
node skills/remix/scripts/ensure-runtime.mjs
npm run test:full
```

`npm test` runs offline regressions but skips browser-dependent tests when the runtime is absent. `npm run test:full` first requires all core dependencies and a launchable Chromium, preventing missing runtime dependencies from silently skipping render coverage. The optional real matting test can still skip when its model and engine are absent.

See [CONTRIBUTING.md](CONTRIBUTING.md) to add a skill or provider. Code is covered by the repository's [Apache-2.0 license](LICENSE); third-party components and downloaded content retain their own terms.
