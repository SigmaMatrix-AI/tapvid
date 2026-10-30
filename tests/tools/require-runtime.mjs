// Full-suite preflight: missing core tools must fail CI, not turn renders into skips.
import { execFileSync } from 'node:child_process';
import { requireRuntime, RUNTIME } from '../../skills/remix/scripts/lib/common.mjs';
import { chromiumReady } from '../../skills/remix/scripts/lib/runtime-install.mjs';
for (const name of ['esbuild', 'playwright', 'react', 'react-dom', 'tone']) requireRuntime.resolve(name);
for (const name of ['ffmpeg', 'ffprobe']) execFileSync(name, ['-version'], { stdio: 'ignore' });
if (!await chromiumReady(RUNTIME)) throw new Error('Chromium is unavailable; run node skills/remix/scripts/ensure-runtime.mjs');
console.log('Core runtime, FFmpeg and Chromium are ready.');
