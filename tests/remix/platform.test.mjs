import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../../skills/remix/scripts/lib/platform.mjs';

// A recording fake for execFileSync: answers by command name.
function fakeExec(answers = {}) {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const a = answers[cmd];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(args, opts) : a ?? '';
  };
  return { exec, calls };
}

test('mac: brew install command, keychain round trip, open', () => {
  const { exec, calls } = fakeExec({ security: (args) => (args[0] === 'find-generic-password' ? 'sk-123\n' : ''), which: '/opt/homebrew/bin/ffmpeg\n' });
  const p = createPlatform({ os: 'darwin', exec, home: mkdtempSync(join(tmpdir(), 'tv-')) });
  assert.equal(p.kind, 'mac');
  assert.equal(p.installCommand(['ffmpeg', 'ffprobe', 'yt-dlp']).text, 'brew install ffmpeg yt-dlp');
  p.writeSecret('FAL_KEY', 'sk-123');
  assert.deepEqual(calls.at(-1).args, ['add-generic-password', '-s', 'tapvid-video', '-a', 'FAL_KEY', '-w', 'sk-123', '-U']);
  assert.equal(p.readSecret('FAL_KEY'), 'sk-123');
  assert.equal(p.which('ffmpeg'), '/opt/homebrew/bin/ffmpeg');
  p.openFile('/tmp/x.html');
  assert.deepEqual(calls.at(-1), { cmd: 'open', args: ['/tmp/x.html'], env: undefined });
  p.deleteSecret('FAL_KEY');
  assert.equal(calls.at(-1).args[0], 'delete-generic-password');
});

test('mac: a cancelled dialog and a missing secret return null', () => {
  const { exec } = fakeExec({ osascript: new Error('User canceled'), security: new Error('not found'), which: new Error('none') });
  const p = createPlatform({ os: 'darwin', exec, home: mkdtempSync(join(tmpdir(), 'tv-')) });
  assert.equal(p.promptSecret('t', 'm'), null);
  assert.equal(p.readSecret('X'), null);
  assert.equal(p.which('nope'), null);
});

test('windows: winget ids, manual whisper step, DPAPI file, start', () => {
  const home = mkdtempSync(join(tmpdir(), 'tv-'));
  const { exec, calls } = fakeExec({
    powershell: (args, opts) => (opts.env.TV_SECRET ? 'ENC(' + opts.env.TV_SECRET + ')' : opts.env.TV_ENC ? opts.env.TV_ENC.slice(4, -1) : 'typed-key'),
  });
  const p = createPlatform({ os: 'win32', exec, home, env: {} });
  const cmd = p.installCommand(['ffmpeg', 'yt-dlp', 'whisper-cli']);
  assert.deepEqual(cmd.args.filter((a) => a.includes('.')), ['Gyan.FFmpeg', 'yt-dlp.yt-dlp']);
  assert.match(cmd.manual[0], /whisper-bin-x64\.zip/);
  p.writeSecret('OPENAI_API_KEY', 'sk-w');
  const file = join(home, 'secrets', 'OPENAI_API_KEY.dpapi');
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, 'utf-8'), 'ENC(sk-w)');
  assert.equal(calls.at(-1).env.TV_SECRET, 'sk-w', 'the secret travels in the environment, not the command line');
  assert.equal(p.readSecret('OPENAI_API_KEY'), 'sk-w');
  assert.equal(p.promptSecret('Title', 'Paste'), 'typed-key');
  p.openFile('C:\\x.html');
  assert.deepEqual(calls.at(-1).args, ['/c', 'start', '', 'C:\\x.html']);
  p.deleteSecret('OPENAI_API_KEY');
  assert.equal(existsSync(file), false);
  assert.equal(p.readSecret('OPENAI_API_KEY'), null);
});

test('other platforms: manual install hint, no secret store', () => {
  const p = createPlatform({ os: 'linux', exec: fakeExec().exec, home: mkdtempSync(join(tmpdir(), 'tv-')) });
  assert.equal(p.kind, 'other');
  assert.match(p.installCommand(['ffmpeg']).text, /install manually/);
  assert.throws(() => p.writeSecret('A', 'b'), /environment variable/);
  assert.equal(p.readSecret('A'), null);
  assert.equal(p.openFile('/x'), null);
});
