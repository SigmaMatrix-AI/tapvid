// The four operating-system dependent operations (spec §2.1): installing system tools,
// asking for a secret in a native dialog, storing / reading secrets, opening a file.
// Everything else in the plugin is platform-neutral. `exec` is injectable for tests.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOME } from './common.mjs';

const KEYCHAIN_SERVICE = 'tapvid-video';

// System tools and how each platform installs them.
const PACKAGES = {
  node: { brew: 'node', winget: 'OpenJS.NodeJS.LTS' },
  ffmpeg: { brew: 'ffmpeg', winget: 'Gyan.FFmpeg' },
  ffprobe: { brew: 'ffmpeg', winget: 'Gyan.FFmpeg' },
  'yt-dlp': { brew: 'yt-dlp', winget: 'yt-dlp.yt-dlp' },
  'whisper-cli': { brew: 'whisper.cpp', winget: null },
};

// whisper.cpp has no winget package; Windows users get the release zip unpacked here.
export const WHISPER_WINDOWS_RELEASE = 'https://github.com/ggml-org/whisper.cpp/releases/latest';

const defaultExec = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', ...opts });

export function createPlatform({ os = process.platform, exec = defaultExec, home = HOME, env = process.env } = {}) {
  const kind = os === 'darwin' ? 'mac' : os === 'win32' ? 'windows' : 'other';
  const secretsDir = join(home, 'secrets');

  // Resolve an executable: PATH first, then (Windows) the default winget install dirs, since a
  // fresh winget install is not on this session's PATH yet.
  function which(tool) {
    const exe = kind === 'windows' ? `${tool}.exe` : tool;
    try {
      const out = exec(kind === 'windows' ? 'where' : 'which', [exe]).trim().split(/\r?\n/)[0];
      if (out) return out;
    } catch { /* not on PATH */ }
    const extra = [join(home, 'bin', exe)];
    if (kind === 'windows' && env.LOCALAPPDATA) {
      extra.push(join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe));
    }
    return extra.find((p) => existsSync(p)) || null;
  }

  function installCommand(tools) {
    if (kind === 'mac') {
      const pkgs = [...new Set(tools.map((t) => PACKAGES[t]?.brew).filter(Boolean))];
      return pkgs.length ? { cmd: 'brew', args: ['install', ...pkgs], text: `brew install ${pkgs.join(' ')}` } : null;
    }
    if (kind === 'windows') {
      const ids = [...new Set(tools.map((t) => PACKAGES[t]?.winget).filter(Boolean))];
      const manual = tools.filter((t) => PACKAGES[t] && !PACKAGES[t].winget);
      return {
        cmd: 'winget',
        args: ['install', '--accept-package-agreements', '--accept-source-agreements', ...ids.flatMap((id) => ['--id', id])],
        text: ids.map((id) => `winget install --id ${id}`).join(' && '),
        manual: manual.map((t) => (t === 'whisper-cli'
          ? `download whisper-bin-x64.zip from ${WHISPER_WINDOWS_RELEASE} and unzip into ${join(home, 'bin')}`
          : t)),
      };
    }
    return { cmd: null, args: [], text: `install manually: ${tools.join(', ')}`, manual: tools };
  }

  // Native password dialog. Returns the entered string, or null when cancelled.
  function promptSecret(title, message) {
    try {
      if (kind === 'mac') {
        const script = `display dialog ${JSON.stringify(message)} with title ${JSON.stringify(title)} default answer "" with hidden answer buttons {"Cancel","OK"} default button "OK"\ntext returned of result`;
        return exec('osascript', ['-e', script]).replace(/\r?\n$/, '');
      }
      if (kind === 'windows') {
        const ps = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '$f = New-Object Windows.Forms.Form; $f.Text = $env:TV_TITLE; $f.Width = 460; $f.Height = 170; $f.StartPosition = "CenterScreen"; $f.TopMost = $true',
          '$l = New-Object Windows.Forms.Label; $l.Text = $env:TV_MESSAGE; $l.Left = 12; $l.Top = 12; $l.Width = 420; $f.Controls.Add($l)',
          '$t = New-Object Windows.Forms.TextBox; $t.UseSystemPasswordChar = $true; $t.Left = 12; $t.Top = 44; $t.Width = 420; $f.Controls.Add($t)',
          '$b = New-Object Windows.Forms.Button; $b.Text = "OK"; $b.Left = 356; $b.Top = 80; $b.DialogResult = "OK"; $f.AcceptButton = $b; $f.Controls.Add($b)',
          'if ($f.ShowDialog() -eq "OK") { [Console]::Out.Write($t.Text) } else { exit 2 }',
        ].join('; ');
        return exec('powershell', ['-NoProfile', '-Command', ps], { env: { ...env, TV_TITLE: title, TV_MESSAGE: message } });
      }
    } catch {
      return null;
    }
    return null;
  }

  function writeSecret(name, value) {
    if (kind === 'mac') {
      exec('security', ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w', value, '-U']);
      return;
    }
    if (kind === 'windows') {
      mkdirSync(secretsDir, { recursive: true });
      const ps = '$s = ConvertTo-SecureString $env:TV_SECRET -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString $s))';
      const enc = exec('powershell', ['-NoProfile', '-Command', ps], { env: { ...env, TV_SECRET: value } }).trim();
      writeFileSync(join(secretsDir, `${name}.dpapi`), enc, 'utf-8');
      return;
    }
    throw new Error('secret storage is not supported on this platform; set the environment variable instead');
  }

  function readSecret(name) {
    try {
      if (kind === 'mac') {
        return exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w']).replace(/\r?\n$/, '') || null;
      }
      if (kind === 'windows') {
        const file = join(secretsDir, `${name}.dpapi`);
        if (!existsSync(file)) return null;
        const ps = '$s = ConvertTo-SecureString $env:TV_ENC; [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)))';
        return exec('powershell', ['-NoProfile', '-Command', ps], { env: { ...env, TV_ENC: readFileSync(file, 'utf-8').trim() } }) || null;
      }
    } catch {
      return null;
    }
    return null;
  }

  function deleteSecret(name) {
    try {
      if (kind === 'mac') exec('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name]);
      if (kind === 'windows') rmSync(join(secretsDir, `${name}.dpapi`), { force: true });
    } catch { /* already absent */ }
  }

  function openFile(path) {
    if (kind === 'mac') return exec('open', [path]);
    if (kind === 'windows') return exec('cmd', ['/c', 'start', '', path]); // Node quotes the empty title as ""
    return null;
  }

  return { kind, which, installCommand, promptSecret, writeSecret, readSecret, deleteSecret, openFile };
}

export const platform = createPlatform();

// npm runs through its own CLI script under the current node, so Windows needs no npm.cmd
// shell call; falls back to an npm on PATH. Returns [command, leading args] or null.
export function npmCommand() {
  const bin = dirname(process.execPath);
  const cli = [join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    .find((p) => existsSync(p));
  if (cli) return [process.execPath, [cli]];
  const npm = platform.which('npm');
  return npm ? [npm, []] : null;
}
