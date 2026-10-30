# Remix

Turn a reference video into a reusable template, then create a new video for your topic with new copy, media, narration, and music. Remix builds React boards and renders the result locally as `tapvid.mp4`.

Use it to adapt a reference video's structure and visual style for a product launch, explainer, or marketing video. Inputs can be a local video, a URL, search keywords, or an existing clone project.

## Install

Follow the [TapVid skill installation instructions](https://github.com/SigmaMatrix-AI/tapvid#install-a-skill), selecting `skills/remix`. Copy the whole folder, including `scripts/`, `references/`, and `assets/`.

Remix needs a local coding agent with filesystem, shell, and visual inspection capabilities. The scripts support the agent's analysis and creative work. The workflow instructions are in [SKILL.md](SKILL.md).

## Examples

Ask your agent:

> Use remix to recreate `/absolute/path/reference.mp4` for my note-taking app. Start with the low tier.

> Use remix to rebuild `/absolute/path/reference.mp4` at the high tier, then adapt it for my product launch.

> Use remix to adapt the existing template in `/absolute/path/clone-demo` for my new topic.

In Claude Code, you can also invoke:

```text
/remix /absolute/path/reference.mp4 low
```

## Workflow and output

Remix builds a reusable template first, prepares the new topic, previews the plan and estimated media cost, then renders the final video.

| Tier | Use it for |
| --- | --- |
| `low` | A faster adaptation of the reference's scenes and layout. |
| `high` (default) | A more faithful reconstruction of the reference's layouts, motion, transitions, and sound effects. |

By default, the workflow requests confirmation at the review points described in [SKILL.md](SKILL.md). Add `auto` to delegate production choices within any budget you specify.

Projects contain `source/`, `analysis/`, `template/`, and `replicas/`. Each replica's final video is saved to `replicas/<slug>/out/tapvid.mp4`. You can reuse a project's template for additional topics.

## Requirements and supported environments

- A local coding agent, such as Codex or Claude Code, with the capabilities listed above.
- Node.js 20 or newer with npm.
- FFmpeg and ffprobe on `PATH`.
- Internet access for the initial npm dependencies and Playwright Chromium download.

| Environment | Support |
| --- | --- |
| macOS | System setup and native credential storage are included. The standalone migration has been tested locally on macOS. |
| Windows | System setup and native credential storage are included. A macOS/Windows CI matrix is configured; native dialogs and complete client workflows require separate verification. |
| Linux | System dependencies require manual setup. Native key dialogs and credential-store integration are not included. |

## Runtime setup

The agent runs setup automatically from the installed skill. To run it manually, open a terminal in the Remix skill directory and run:

```sh
node scripts/ensure-runtime.mjs
```

From the repository root, the equivalent command is:

```sh
node skills/remix/scripts/ensure-runtime.mjs
```

When available, setup uses Homebrew on macOS or winget on Windows to install missing system tools. It installs pinned npm dependencies with `npm ci` into `~/.tapvid-video/runtime`, then installs and checks Chromium. Subsequent runs reuse the dependencies and repair a missing browser cache. A successful setup ends with `ready`; `missing: ...` identifies system tools that need manual installation.

Set `TAPVID_VIDEO_HOME` to place runtime data, caches, and custom providers elsewhere. `PLAYWRIGHT_BROWSERS_PATH` controls the browser cache. Neither the checkout nor an installed skill needs `node_modules`.

Updating the installed skill preserves existing TapVid clone projects, provider settings, and stored credentials in their current formats and locations. Keep your projects and `~/.tapvid-video` when replacing the skill folder.

## Media providers and MCP

**MCP dependency: None.** Remix calls media providers through direct HTTP APIs.

Local template creation, offline provider checks, code animation, and rendering do not require a TapVid account. Generated video, images, narration, or avatars require a suitable provider and may incur charges. Configure only the providers you use; see [media providers](references/providers.md) for available capabilities and setup, or [provider authoring](references/provider-authoring.md) to add your own.

Keys can come from provider environment variables or the native credential store through `scripts/set-key.mjs`. For example, `TAPVID_API_KEY` is needed only for the TapVid provider. Do not put keys in chat, project files, or commits.

## Optional downloads

Some features download additional tools or assets on first use:

- yt-dlp for video downloads.
- whisper.cpp and a transcription model (about 1.6 GB) for local transcription.
- ONNX Runtime and an RVM model for matting.
- Google Fonts for typography and VSCO samples for composed music.

These have separate licenses and service terms; see [third-party notices](https://github.com/SigmaMatrix-AI/tapvid/blob/main/THIRD_PARTY_NOTICES.md). Model downloads, live provider checks, and paid generation are not part of the offline test suite.
