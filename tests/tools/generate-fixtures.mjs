// Original synthetic fixtures: color fields, rectangles, and sine waves only.
// Run from any cwd. Requires ffmpeg; no downloaded media or fonts.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const media = (relative, args) => {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  mkdirSync(dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-y', '-v', 'error', ...args, file], { stdio: 'inherit' });
};
const assets = '../../skills/remix/scripts/providers/__fixtures__/_assets/';
media(`${assets}tiny.png`, ['-f', 'lavfi', '-i', 'color=c=0x3478c0:s=16x16', '-frames:v', '1']);
media(`${assets}tiny.mp4`, ['-f', 'lavfi', '-i', 'color=c=0x3478c0:s=32x32:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
media(`${assets}tiny.wav`, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=16000', '-c:a', 'pcm_s16le']);
media(`${assets}tiny.mp3`, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=44100', '-c:a', 'libmp3lame', '-b:a', '64k']);
media('../remix/fixtures/sample-clone/source/source.mp4', [
  '-f', 'lavfi', '-i', 'color=c=0x293b55:s=640x360:r=30:d=5',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5:sample_rate=44100',
  '-vf', "drawbox=x=332:y=43:w=269:h=274:color=0x56a8cc:t=fill:enable='lt(t,2.5)',drawbox=x=38:y=90:w=260:h=50:color=0xa4c87b:t=fill:enable='gte(t,2.5)'",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
]);
// Keep inline HTTP payloads in replay fixtures consistent with the generated files.
const tiny = (ext, encoding = 'base64') => readFileSync(new URL(`${assets}tiny.${ext}`, import.meta.url)).toString(encoding);
const update = (name, edit) => {
  const file = new URL(`${assets}../${name}.json`, import.meta.url);
  const fixture = JSON.parse(readFileSync(file, 'utf8'));
  edit(fixture.exchanges[0]);
  writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
};
for (const name of ['image', 'image-edit']) update(`openai/${name}`, (e) => { e.response.json.data[0].b64_json = tiny('png'); });
for (const [name, ext] of [['image-generate', 'png'], ['video-generate', 'mp4'], ['speech-synthesize', 'wav']]) {
  update(`gemini/${name}`, (e) => { e.response.json.steps[1].content[0].data = tiny(ext); });
}
update('elevenlabs/speech', (e) => { e.response.json.audio_base64 = tiny('mp3'); });
update('minimax/image', (e) => { e.response.json.data.image_base64[0] = tiny('png'); });
for (const name of ['music', 'speech']) update(`minimax/${name}`, (e) => { e.response.json.data.audio = tiny('mp3', 'hex'); });
update('minimax/video-first-last-frame', (e) => { e.request.bodyIncludes.content[1].image_url.url = `data:image/png;base64,${tiny('png')}`; });
console.log('Generated five synthetic media fixtures and updated their inline replay payloads.');
