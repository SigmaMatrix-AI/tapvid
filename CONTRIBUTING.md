# Contributing

## Repository layout

Add new skills under `skills/<name>/`, with a unique lowercase, hyphenated name and a `SKILL.md` containing `name` and `description` frontmatter. Put executable code in `scripts/`, reading material in `references/`, and templates or structured resources in `assets/`. Add tests under `tests/<name>/`.

Include a `README.md` for people using the skill: explain its purpose and output, show usage examples, and document supported environments, setup, MCP dependencies, external APIs, and account requirements. Keep the agent's execution instructions in `SKILL.md`. Add a row to the root README's available-skills table linking to the skill's README; keep the root README focused on the collection and shared installation instructions.

A skill must work when only its directory is copied to another location, including paths containing spaces. Resolve bundled resources from module or skill locations, not the caller's working directory. Do not introduce runtime imports from repository-level tests, another skill, or a private repository. Introduce shared packages only when there is a concrete need and a distribution strategy for independently installed skills.

Keep user state in the documented home directory. Updates must preserve existing projects, `TAPVID_*` environment variables, custom providers and credentials. The root package.json is for development and is not an npm publishing entry point.

## Test changes

The current test suite covers Remix. Use Node.js 22 or 24 and install FFmpeg/ffprobe. Then, from the repository root:

```sh
node skills/remix/scripts/ensure-runtime.mjs
npm run test:full
```

`npm test` runs offline regressions but skips browser-dependent tests when the runtime is absent. `npm run test:full` first requires all core dependencies and a launchable Chromium, preventing missing runtime dependencies from silently skipping render coverage. The optional real matting test can still skip when its model and engine are absent.

For isolated tests, set `TAPVID_VIDEO_HOME` to a scratch directory and `PLAYWRIGHT_BROWSERS_PATH` to a separate browser cache before both setup and tests. No API keys are needed. Never run live or paid provider tests in a normal pull-request workflow.

Use meaningful behavioral tests for changed logic. Include standalone installation coverage when moving resources. Tests should exercise project output, provider replay contracts, timing and actual rendering; do not weaken assertions to hide missing tools. Report skips and platform limits.

The workflow under `.github/workflows/ci.yml` checks macOS and Windows with Node.js 22 and 24. A configured matrix is not evidence of a successful run: inspect its results before release. Native credential dialogs, real provider accounts and optional models require separate manual verification.

## Runtime dependencies

The runtime manifest and lockfile live in `skills/remix/scripts/`. To change them, copy `runtime-package.json` and `runtime-package-lock.json` into a temporary directory as `package.json` and `package-lock.json`, update dependencies there with npm, and copy both files back under their original names. Review the complete lockfile diff. Validate a clean `ensure-runtime.mjs` run, reuse, and browser-cache repair before submitting.

## Providers and fixtures

See [provider authoring](skills/remix/references/provider-authoring.md). Built-in provider modules live in `skills/remix/scripts/providers/`; their `__fixtures__/` directory ships with the skill because `media.mjs check <provider>` uses it offline. User providers live under `TAPVID_VIDEO_HOME/providers` (default `~/.tapvid-video/providers`).

Keep fixtures synthetic or explicitly licensed for redistribution. `npm run fixtures` regenerates the five committed media fixtures from color fields, rectangles and sine waves using FFmpeg. It downloads nothing. Byte output may vary by FFmpeg version; validate dimensions, duration and behavior rather than byte equality. Document any additional asset source and license in `THIRD_PARTY_NOTICES.md`.

## Pull requests and release

Explain the user-visible change and its validation. Keep credentials, browser sessions, models, generated projects and personal media out of commits. Review code provenance and third-party obligations when importing code or assets. Run a secret scan of the proposed release tree and its new history.

Before the first public release, maintainers must confirm the rights to relicense the imported implementation under Apache-2.0, resolve the optional RVM model distribution/use policy, verify the intended clients and Windows runtime, and review the final file list. Publication, repository visibility changes and old-repository retirement are separate release actions.
