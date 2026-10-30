// A generated clip against the time its slot is on screen. Models have a minimum length (5 s on most), so a
// shot of 2 s gets a 5 s clip: played as it is, only its opening shows and its move never happens. The clip
// is sped up to fit, and past the speed limit the rest is cut.
import { existsSync } from 'node:fs';
import { run } from './common.mjs';
import { probeDuration } from './replica.mjs';

// Above this a generated move stops reading as camera or hand motion. It lets a 5 s clip finish in a 2 s shot.
const MAX_CLIP_SPEED = 2.5;
// A clip this close to its slot plays as it is: the scene's end cuts the difference.
const SPEED_TOLERANCE = 1.05;

// → null when the clip plays as it is, else { speed, cutS }: cutS seconds of the clip's end never show.
export function clipFit(clipS, targetS) {
  if (!(clipS > 0) || !(targetS > 0) || clipS / targetS <= SPEED_TOLERANCE) return null;
  const speed = Math.min(clipS / targetS, MAX_CLIP_SPEED);
  return { speed: Number(speed.toFixed(3)), cutS: Number(Math.max(0, clipS - targetS * speed).toFixed(3)) };
}

// → { file, fit }: the copy of `file` retimed to targetS, next to it, or `file` itself when fit is null.
export function fitClip(file, targetS) {
  const fit = clipFit(probeDuration(file), targetS);
  if (!fit) return { file, fit };
  const out = `${file.replace(/\.[^.]+$/, '')}.fit-${targetS.toFixed(3)}.mp4`;
  if (!existsSync(out)) {
    run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-an', '-vf', `setpts=PTS/${fit.speed}`, '-t', String(targetS),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', out]);
  }
  return { file: out, fit };
}
