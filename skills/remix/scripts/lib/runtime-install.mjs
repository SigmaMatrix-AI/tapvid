// Shared runtime installation; the skill itself never needs node_modules.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export async function chromiumReady(runtime) {
  try {
    const require = createRequire(join(runtime, 'package.json'));
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ timeout: 15000 });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

// step and browserReady isolate the two external operations for offline tests.
export async function ensureRuntime({ runtime, packageFile, lockFile, npm, log = console.log,
  browserReady = () => chromiumReady(runtime),
  step = (cmd, args) => {
    const result = spawnSync(cmd, args, { cwd: runtime, stdio: ['ignore', 'ignore', 'inherit'] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`failed: ${[cmd, ...args].join(' ')}`);
  },
}) {
  mkdirSync(runtime, { recursive: true });
  const marker = join(runtime, '.installed');
  const want = createHash('sha256').update(readFileSync(packageFile)).update('\0').update(readFileSync(lockFile)).digest('hex');
  const have = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';
  if (have !== want || !existsSync(join(runtime, 'node_modules'))) {
    rmSync(marker, { force: true });
    log(`installing runtime dependencies into ${runtime}`);
    copyFileSync(packageFile, join(runtime, 'package.json'));
    copyFileSync(lockFile, join(runtime, 'package-lock.json'));
    step(npm[0], [...npm[1], 'ci', '--no-audit', '--no-fund', '--loglevel=error']);
  } else {
    log('runtime up to date');
  }
  if (!await browserReady()) {
    rmSync(marker, { force: true });
    log('installing Chromium');
    step(process.execPath, [join(runtime, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium']);
    if (!await browserReady()) throw new Error('Chromium could not launch after installation; check Playwright system dependencies.');
  }
  writeFileSync(marker, `${want}\n`, 'utf8');
}
