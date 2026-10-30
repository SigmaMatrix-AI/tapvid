# Third-party notices

The repository's Apache-2.0 license applies to project code whose rights are held by the contributors. It does not replace the licenses of dependencies, optional models, fonts, samples or API-supplied content.

## Runtime dependencies

Runtime packages are installed by npm, not vendored in the skill. Exact versions and integrity hashes are in [runtime-package-lock.json](skills/remix/scripts/runtime-package-lock.json); installed packages carry their own license texts.

| Component | Locked version | Declared license / source |
| --- | --- | --- |
| esbuild | 0.24.2 | MIT — https://github.com/evanw/esbuild |
| Playwright / playwright-core | 1.64.1 | Apache-2.0 — https://github.com/microsoft/playwright |
| React / React DOM | 18.3.1 | MIT — https://github.com/facebook/react |
| Tone.js | 15.1.22 | MIT — https://github.com/Tonejs/Tone.js |

Transitive packages have their own entries in the lockfile. Chromium installed by Playwright and FFmpeg installed through a system package manager retain their upstream licenses. This repository does not ship their binaries. Consult the exact distribution before redistributing binaries.

## Optional assets and services

- **Robust Video Matting:** `scripts/lib/matte.mjs` downloads the MobileNetV3 ONNX model from the [upstream v1.0.0 release](https://github.com/PeterL1n/RobustVideoMatting/releases/tag/v1.0.0). The [upstream code license](https://github.com/PeterL1n/RobustVideoMatting/blob/master/LICENSE) is GPL-3.0. The Apache-2.0 license here does not grant rights to the model. The model is not bundled; maintainers must resolve its applicable weight/use terms before public release or redistribution. ONNX Runtime is installed separately (1.20.1; [MIT](https://github.com/microsoft/onnxruntime/blob/main/LICENSE)).
- **VSCO 2 Community Edition:** instrument samples are fetched on demand from [VSCO-2-CE](https://github.com/sgossner/VSCO-2-CE), which declares CC0-1.0. The skill includes an instrument index, not sample recordings.
- **Google Fonts:** fonts are downloaded into the user's generated template. `fonts.json` records the detected license; preserve the selected font's actual license text when redistributing a template. Font files are not included in this repository.
- **whisper.cpp / Whisper:** optional local transcription uses separately installed [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and downloaded model weights. Refer to those distributions and their licenses. Models are not bundled.
- **yt-dlp:** an optional external download tool. Refer to [yt-dlp](https://github.com/yt-dlp/yt-dlp) and the terms of the source site. Downloading a file does not grant permission to reuse it.
- **Media APIs and stock services:** generated clips, avatars, voice, music, stock footage and GIFs remain subject to the provider's terms and the asset's license. Preserve supplied credits and attribution. Provider integration code does not convey rights to returned media.

## Committed media fixtures

All five media files were regenerated from original synthetic signals by [tests/tools/generate-fixtures.mjs](tests/tools/generate-fixtures.mjs):

- `tests/remix/fixtures/sample-clone/source/source.mp4`: five seconds of geometric color fields and a sine tone.
- `skills/remix/scripts/providers/__fixtures__/_assets/tiny.{png,mp4,wav,mp3}`: solid-color visuals and sine tones.

Inline base64 and hexadecimal payloads in provider replay JSON are regenerated from the same files. They contain no downloaded images, recorded voices, commercial music or fonts and are provided under this repository's Apache-2.0 license.

## Imported implementation provenance

The initial Remix implementation was extracted from the maintainers' existing TapVid plugin. Its design records identify earlier rendering work from `ugc-video` and analysis/workflow work from `sigmatrx-video-clone`. Those repositories are not runtime or installation dependencies. The imported snapshot did not include a standalone license grant. Before public release, maintainers must confirm ownership and authorization for these contributions and preserve any required third-party attribution. This migration does not itself establish that authorization.
