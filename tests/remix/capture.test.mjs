// capture.mjs: record a storyboard on a local fixture site, index it, cut clips and stills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readJson, requireRuntime, RUNTIME, runtimePath } from '../../skills/remix/scripts/lib/common.mjs';
import { parseFake } from '../../skills/remix/scripts/lib/capture-page.mjs';
import { loadStoryboard } from '../../skills/remix/scripts/lib/capture-record.mjs';
import { stillRuns } from '../../skills/remix/scripts/lib/capture-index.mjs';
import { cropRect } from '../../skills/remix/scripts/capture.mjs';

const SCRIPT = join(import.meta.dirname, '..', '..', 'skills', 'remix', 'scripts', 'capture.mjs');
const runtimeReady = existsSync(runtimePath('playwright'));
const skip = !runtimeReady && 'runtime not installed (node scripts/ensure-runtime.mjs)';
const VIEWPORT = { width: 640, height: 360 };

const who = (name, email) => `<p id="who">Signed in as ${name}, ${email}</p><p id="secret" style="width:200px;background:#c33;color:#fff">Card 4242 4242</p>`;
const formPage = (name, email) => `<!doctype html><html><head><style>body{margin:0;font:20px sans-serif;background:#f4f4f6}main{padding:20px}
#result{display:none;margin-top:12px;width:300px;height:80px;background:#1a7f37;color:#fff}</style></head><body><main>${who(name, email)}
<label>Describe your video <input type="text"></label> <label>Password <input type="password"></label>
<button onclick="setTimeout(()=>{document.getElementById('result').style.display='block'},1000)">Generate</button>
<div id="result" data-testid="result">Done</div></main></body></html>`;
const PAGES = {
  '/': formPage('Jane Cooper', 'jane.cooper@corp.com'),
  // The same page as it must look after the storyboard's fake rules, for the screenshot comparison.
  '/faked': formPage('Alex Kim', 'alex@example.com'),
  '/long': `<!doctype html><html><body style="margin:0;font:20px sans-serif">${Array.from({ length: 60 }, (_, i) => `<p style="height:40px;margin:0;background:hsl(${i * 6},70%,70%)">Row ${i}</p>`).join('')}</body></html>`,
};

function serve() {
  const server = createServer((req, res) => {
    const body = PAGES[new URL(req.url, 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    res.end(body || 'not found');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

// The CLI as a child process without blocking this process, which serves the fixture site.
async function cli(args, env = { TAPVID_VIDEO_HOME: tempHome() }) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

// A tapvid home of its own (no saved sessions) that shares the installed runtime.
function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'tapvid-home-'));
  symlinkSync(RUNTIME, join(home, 'runtime'));
  return home;
}

function storyboard(dir, sb) {
  const file = join(dir, 'capture', `${sb.name}.json`);
  mkdirSync(join(dir, 'capture'), { recursive: true });
  writeFileSync(file, JSON.stringify({ viewport: VIEWPORT, ...sb }));
  return file;
}

const probeStream = (file) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate', '-of', 'csv=p=0', file], { encoding: 'utf-8' }).trim();
const dims = (file) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf-8' }).trim();
const probeDuration = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf-8' }));

// Grey pixels of a crop of an image or of every video frame.
function grey(file, [x, y, w, h]) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
}
const meanAbsDiff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

test('parseFake reads plain strings and /regex/flags (always global)', () => {
  assert.deepEqual(parseFake([{ find: 'Jane', replace: 'Alex' }, { find: '/\\d+/i', replace: '0' }]), [
    { text: 'Jane', replace: 'Alex' }, { source: '\\d+', flags: 'ig', replace: '0' },
  ]);
  assert.throws(() => parseFake([{ find: '/(/', replace: '' }]));
  assert.throws(() => parseFake([{ find: '', replace: 'x' }]), /find/);
});

test('loadStoryboard fills defaults and rejects bad steps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tapvid-capture-'));
  const ok = loadStoryboard(storyboard(dir, { name: 'a', url: 'https://x.test', viewport: undefined, steps: [{ id: 'one', do: 'hold' }] }));
  assert.deepEqual([ok.viewport, ok.fps, ok.auth, ok.mask], [{ width: 1920, height: 1080 }, 60, false, []]);
  const bad = (steps, re) => assert.throws(() => loadStoryboard(storyboard(dir, { name: 'b', url: 'https://x.test', steps })), re);
  bad([{ id: 'x', do: 'fly' }], /unknown "do"/);
  bad([{ id: 'x', do: 'click' }], /needs a target/);
  bad([{ id: 'x', do: 'click', target: { text: 'a', role: 'button' } }], /exactly one/);
  bad([{ id: 'x', do: 'hold' }, { id: 'x', do: 'hold' }], /unique/);
  bad([{ id: 'x', do: 'scroll' }], /to.y or a target/);
});

test('cropRect widens a box to the aspect around its centre and keeps it inside the frame', () => {
  assert.deepEqual(cropRect([0.25, 0.25, 0.5, 0.5], 1920, 1080), { x: 480, y: 270, w: 960, h: 540 });
  assert.deepEqual(cropRect([0.4, 0.4, 0.1, 0.2], 1000, 1000, 1), { x: 350, y: 400, w: 200, h: 200 });
  // Too wide for the frame at that aspect: shrunk to fit, pushed back inside.
  assert.deepEqual(cropRect([0.9, 0, 0.1, 1], 1000, 500, 4), { x: 0, y: 125, w: 1000, h: 250 });
});

test('stillRuns keeps a one-frame change and folds short pauses into the motion around them', () => {
  const counts = [0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 3, 0, 3, 0, 3, 0, 0, 0, 0, 0];
  assert.deepEqual(stillRuns(counts, 10, 0, counts.length).map((r) => [r.kind, r.from, r.to]), [
    ['still', 0, 6], ['motion', 6, 7], ['still', 7, 12], ['motion', 12, 17], ['still', 17, 22],
  ]);
});

test('login --check tells whether a session is saved for the host', async () => {
  const home = tempHome();
  mkdirSync(join(home, 'auth'));
  writeFileSync(join(home, 'auth', 'app.example.com.json'), '{"cookies":[],"origins":[]}');
  const env = { TAPVID_VIDEO_HOME: home };
  assert.equal((await cli(['login', '--check', 'https://app.example.com/home'], env)).stdout.trim(), 'logged-in app.example.com');
  assert.equal((await cli(['login', '--check', 'https://other.example.com'], env)).stdout.trim(), 'none');
});

test('record → index → clip on a local site', { skip, timeout: 120_000 }, async () => {
  const { server, url } = await serve();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'tapvid-capture-'));
    const file = storyboard(dir, {
      name: 'flow', url, fake: [{ find: 'Jane Cooper', replace: 'Alex Kim' }, { find: '/[\\w.]+@[\\w.]+/', replace: 'alex@example.com' }], mask: ['#secret'],
      steps: [
        { id: 'open', do: 'goto', url: `${url}/`, hold: 0.5, note: 'the app' },
        { id: 'prompt', do: 'type', target: { label: 'Describe your video' }, text: 'A launch video', cps: 20 },
        { id: 'go', do: 'click', target: { role: 'button', name: 'Generate' }, hold: 0 },
        { id: 'result', do: 'wait_for', target: { testId: 'result' }, timeout: 5 },
        { id: 'long', do: 'goto', url: `${url}/long`, hold: 0.3 },
        { id: 'scroll', do: 'scroll', to: { y: 900 }, duration: 0.8 },
        { id: 'end', do: 'hold', hold: 0.5 },
      ],
    });
    const rec = await cli(['record', dir, file]);
    assert.equal(rec.code, 0, rec.stderr);
    const out = join(dir, 'assets', 'capture', 'flow');
    const mp4 = join(out, 'recording.mp4');
    assert.equal(probeStream(mp4), 'h264,640,360,60/1');
    const log = readJson(join(out, 'log.json'));
    assert.equal(log.fps, 60);
    assert.deepEqual(log.steps.map((s) => s.id), ['open', 'prompt', 'go', 'result', 'long', 'scroll', 'end']);
    const last = log.steps.at(-1);
    assert.ok(log.duration >= last.end + 0.5 && log.duration < last.end + 3, `duration ${log.duration}, last step ends ${last.end}`);
    log.steps.forEach((s, i) => {
      assert.ok(s.start >= 0 && s.start <= s.end && s.end <= (log.steps[i + 1]?.start ?? log.duration), `${s.id} ${s.start}–${s.end}`);
      if (s.box) assert.ok(s.box.every((v) => v >= 0 && v <= 1) && s.box[0] + s.box[2] <= 1.0001 && s.box[1] + s.box[3] <= 1.0001, `${s.id} box`);
      assert.equal(dims(join(out, s.shot)), '1280,720');
    });
    assert.equal(log.steps[0].note, 'the app');
    assert.equal(log.steps[1].text, 'A launch video');
    assert.equal(log.steps.find((s) => s.id === 'long').url, `${url}/long`);
    assert.ok(log.steps.find((s) => s.id === 'go').box, 'click step has a box');

    // The result appears 1 s after the click; the log's wait_for end is that moment on the mp4 timeline.
    const res = log.steps.find((s) => s.id === 'result');
    const [bx, by, bw, bh] = res.box;
    const rect = [Math.round(bx * 640), Math.round(by * 360), Math.round(bw * 640), Math.round(bh * 360)];
    const px = rect[2] * rect[3];
    const frames = grey(mp4, rect);
    const mean = (k) => frames.subarray(k * px, (k + 1) * px).reduce((a, v) => a + v, 0) / px;
    const from = Math.round(log.steps.find((s) => s.id === 'go').end * 60);
    let k = from;
    while (mean(k) > 150) k++;
    assert.ok(Math.abs(res.end - k / 60) <= 2 / 60 + 1e-3, `wait_for end ${res.end}, result visible at ${(k / 60).toFixed(3)}`);
    assert.ok(Math.abs(res.end - log.steps.find((s) => s.id === 'go').end - 1) < 0.1);

    assert.ok(Math.abs(log.cursor.length - log.duration * 15) <= 2, `${log.cursor.length} cursor samples`);
    assert.ok(log.cursor.every(([t, x, y]) => t >= 0 && t <= log.duration && x >= 0 && x <= 1 && y >= 0 && y <= 1));
    const goBox = log.steps.find((s) => s.id === 'go').box;
    const atClick = log.cursor.filter(([t]) => t >= log.steps.find((s) => s.id === 'go').end).at(0);
    assert.ok(Math.abs(atClick[1] - (goBox[0] + goBox[2] / 2)) < 0.01, 'cursor is on the button when it is clicked');

    // Fake rules and masks are in the shot: the name line renders like the page with the fake text
    // typed in, and the masked card does not.
    const { chromium } = requireRuntime('playwright');
    const browser = await chromium.launch();
    const refShot = join(dir, 'ref.png');
    const rect2x = (bb) => [bb.x, bb.y, bb.width, bb.height].map((v) => Math.round(v * 2));
    let nameLine;
    let card;
    try {
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
      await page.goto(`${url}/faked`);
      await page.screenshot({ path: refShot });
      nameLine = rect2x(await page.locator('#who').boundingBox());
      card = rect2x(await page.locator('#secret').boundingBox());
    } finally {
      await browser.close();
    }
    const shot = join(out, 'shots', 'open.png');
    assert.ok(meanAbsDiff(grey(shot, nameLine), grey(refShot, nameLine)) < 1, 'name line is faked');
    assert.ok(meanAbsDiff(grey(shot, card), grey(refShot, card)) > 5, 'card is blurred');

    const idx = await cli(['index', dir, out]);
    assert.equal(idx.code, 0, idx.stderr);
    const index = readJson(join(out, 'index.json'));
    assert.equal(index.from, 'log');
    assert.ok(existsSync(join(out, 'sheet.png')));
    const kinds = new Set(index.segments.map((s) => s.kind));
    for (const kind of ['typing', 'click', 'wait', 'result', 'scroll', 'still']) assert.ok(kinds.has(kind), `index has ${kind}`);
    const result = index.segments.find((s) => s.kind === 'result');
    assert.deepEqual([result.step, result.start], ['result', res.end]);
    assert.match(idx.stdout, /\| prompt \| typing \|/);

    const typing = log.steps.find((s) => s.id === 'prompt');
    const cut = await cli(['clip', dir, '--from', 'flow', '--start', String(typing.start), '--end', String(typing.end), '--box', typing.box.join(','),
      '--aspect', '16:9', '--duration', '0.5', '--out', 'assets/capture/prompt.mp4']);
    assert.equal(cut.code, 0, cut.stderr);
    const clipFile = join(dir, 'assets', 'capture', 'prompt.mp4');
    assert.equal(cut.stdout.split('\n')[0], clipFile);
    const [codec, w, h] = probeStream(clipFile).split(',');
    assert.equal(codec, 'h264');
    assert.ok(Number(w) % 2 === 0 && Number(h) % 2 === 0 && Math.abs(Number(w) / Number(h) - 16 / 9) < 0.03, `${w}×${h}`);
    assert.ok(Math.abs(probeDuration(clipFile) - 0.5) <= 2 / 60, `clip lasts ${probeDuration(clipFile)}`);

    const still = await cli(['clip', dir, '--from', out, '--still', String(typing.end + 0.2), '--box', '0.25,0.25,0.5,0.5', '--out', 'assets/capture/prompt.png']);
    assert.equal(still.code, 0, still.stderr);
    assert.match(still.stdout, /640×360 \(2× shot of prompt\)/);
    assert.equal(dims(join(dir, 'assets', 'capture', 'prompt.png')), '640,360');

    // A recording the user supplies: no log, segments from the video alone.
    const bare = join(dir, 'demo.mp4');
    copyFileSync(mp4, bare);
    const vidx = await cli(['index', dir, bare]);
    assert.equal(vidx.code, 0, vidx.stderr);
    const vindex = readJson(join(dir, 'assets', 'capture', 'demo', 'index.json'));
    assert.equal(vindex.from, 'video');
    assert.ok(existsSync(join(dir, 'assets', 'capture', 'demo', 'recording.mp4')));
    assert.ok(vindex.segments.some((s) => s.kind === 'motion' && s.box) && vindex.segments.some((s) => s.kind === 'still'));
    const reveal = vindex.segments.find((s) => s.kind === 'motion' && Math.abs(s.start - res.end) <= 3 / 60);
    assert.ok(reveal, 'the result appearing is a motion segment of its own');
  } finally {
    server.close();
  }
});

test('record stops on a failing step, refuses passwords and asks for a login', { skip, timeout: 90_000 }, async () => {
  const { server, url } = await serve();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'tapvid-capture-'));
    const failing = storyboard(dir, { name: 'broken', url, steps: [
      { id: 'open', do: 'goto', url: `${url}/`, hold: 0.2 },
      { id: 'missing', do: 'wait_for', target: { testId: 'nowhere' }, timeout: 0.5 },
    ] });
    const r = await cli(['record', dir, failing]);
    assert.equal(r.code, 1);
    assert.match(r.stderr.trim(), /^step missing failed: .*not visible after 0.5s$/);
    const out = join(dir, 'assets', 'capture', 'broken');
    const log = readJson(join(out, 'log.json'));
    assert.equal(log.error.step, 'missing');
    assert.deepEqual(log.steps.map((s) => s.id), ['open']);
    assert.ok(existsSync(join(out, 'shots', 'missing-error.png')) && existsSync(join(out, 'recording.mp4')));

    const pw = storyboard(dir, { name: 'pw', url, steps: [
      { id: 'open', do: 'goto', url: `${url}/`, hold: 0 },
      { id: 'secret', do: 'type', target: { label: 'Password' }, text: 'hunter2' },
    ] });
    const p = await cli(['record', dir, pw]);
    assert.equal(p.code, 2);
    assert.match(p.stderr, /password field/);
    assert.doesNotMatch(readJson(join(dir, 'assets', 'capture', 'pw', 'log.json')).steps.map((s) => s.text ?? '').join(''), /hunter2/);

    const auth = storyboard(dir, { name: 'auth', url, auth: true, steps: [{ id: 'open', do: 'goto', url }] });
    const a = await cli(['record', dir, auth]);
    assert.equal(a.code, 2);
    assert.equal(a.stderr.trim(), `login needed: ${new URL(url).host}`);
  } finally {
    server.close();
  }
});

// A DOM animation frame is not a recording frame: at a low capture rate a short
// rAF-only flash can disappear between video samples and make the take unusable.
test('record preserves its alignment marker at a low recording frame rate', { skip, timeout: 30000 }, async () => {
  const { server, url } = await serve();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'tapvid-capture-slow-'));
    const file = storyboard(dir, { name: 'slow', url, fps: 5, steps: [
      { id: 'open', do: 'goto', url, hold: 0.8 },
      { id: 'end', do: 'hold', hold: 0.4 },
    ] });
    const result = await cli(['record', dir, file]);
    assert.equal(result.code, 0, result.stderr);
    const out = join(dir, 'assets', 'capture', 'slow');
    assert.equal(probeStream(join(out, 'recording.mp4')), 'h264,640,360,5/1');
    const log = readJson(join(out, 'log.json'));
    assert.equal(log.fps, 5);
    assert.deepEqual(log.steps.map((s) => s.id), ['open', 'end']);
    assert.ok(log.steps[0].start >= 0 && log.duration >= log.steps.at(-1).end);
  } finally { server.close(); }
});
