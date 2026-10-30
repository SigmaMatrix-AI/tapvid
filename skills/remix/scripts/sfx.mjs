#!/usr/bin/env node
// The built-in sound-effect library (lib/sfx.mjs).
//   node sfx.mjs list
//   node sfx.mjs render <kind> <out.wav>
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fail, parseArgs } from './lib/common.mjs';
import { SFX_KINDS, renderSfx } from './lib/sfx.mjs';

const USAGE = 'usage: node sfx.mjs list | render <kind> <out.wav>';
const [cmd, kind, out] = parseArgs()._;
if (cmd === 'list') {
  console.log(SFX_KINDS.join('\n'));
} else if (cmd === 'render' && kind && out) {
  try {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    console.log(renderSfx(kind, resolve(out)));
  } catch (e) {
    fail(e.message);
  }
} else fail(USAGE, 2);
