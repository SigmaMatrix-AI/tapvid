#!/usr/bin/env node
// Free portrait headroom: move a picture down (or up) inside the same canvas and fill the
// uncovered edge with a blurred, slightly stretched copy of the picture's own edge band, so a
// presenter whose face sits too high leaves room for the overlays above the head — no AI reframe.
//   node reframe.mjs <in.png|jpg> <out.png> --head-top <current %> --target <target %> [--feather 150]
// --head-top / --target: the top of the head as a percentage of the picture height, now and wanted.
// Moving down crops the bottom and fills the top; moving up crops the top and fills the bottom.
// The seam is feathered over --feather px (a vertical alpha ramp on the shifted picture).
// Output size = input size. Prints the output path and the applied shift.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, parseArgs, run } from './lib/common.mjs';

// 150 px hid the seam on a 1080-wide portrait in practice (blurred wall behind the presenter).
const DEFAULT_FEATHER = 150;
// The edge band is stretched by this much before blurring, so the fill does not mirror the
// picture's edge detail one to one.
const STRETCH = 1.15;
// Blur sigma as a fraction of the width: 1/40 (27 px at 1080) washes out all detail, so the fill
// reads as out-of-focus background.
const BLUR_FRACTION = 1 / 40;

function size(file) {
  const [w, h] = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
    .trim().split(',').map(Number);
  return { w, h };
}

// The filter graph for moving the picture down by `shift` px (shift > 0); moving up runs the same
// graph on the vertically flipped picture.
function downGraph({ w, h }, shift, feather) {
  const f = Math.max(1, Math.min(feather, h - shift));
  const fillH = shift + f;
  const band = Math.max(2, Math.min(h, Math.round(fillH / STRETCH)));
  const sigma = Math.max(1, Math.round(w * BLUR_FRACTION));
  return [
    '[0:v]format=rgba,split[a][b]',
    `[a]crop=${w}:${band}:0:0,scale=${w}:${fillH},gblur=sigma=${sigma},pad=${w}:${h}:0:0:black[bg]`,
    `[b]crop=${w}:${h - shift}:0:0,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(Y,${f}),255*Y/${f},255)'[fg]`,
    `[bg][fg]overlay=0:${shift},format=rgb24`,
  ];
}

export function reframe(input, output, { headTop, target, feather = DEFAULT_FEATHER }) {
  const dims = size(input);
  const shift = Math.round(((target - headTop) / 100) * dims.h);
  if (Math.abs(shift) >= dims.h) throw new Error(`shift ${shift}px is not smaller than the picture height ${dims.h}px`);
  let graph;
  if (shift === 0) graph = '[0:v]format=rgb24';
  else if (shift > 0) graph = downGraph(dims, shift, feather).join(';');
  else {
    const g = downGraph(dims, -shift, feather);
    graph = [g[0].replace('[0:v]', '[0:v]vflip,'), ...g.slice(1, -1), `${g.at(-1)},vflip`].join(';');
  }
  run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-filter_complex', graph, '-frames:v', '1', output]);
  return { output, shift, ...dims };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  const [input, output] = args._;
  const headTop = Number(args['head-top']);
  const target = Number(args.target);
  const feather = args.feather === undefined ? DEFAULT_FEATHER : Number(args.feather);
  if (!input || !output || !Number.isFinite(headTop) || !Number.isFinite(target)) {
    fail('usage: node reframe.mjs <in.png|jpg> <out.png> --head-top <current %> --target <target %> [--feather 150]');
  }
  if (!Number.isInteger(feather) || feather < 1) fail(`--feather must be a positive integer, got ${args.feather}`);
  try {
    const r = reframe(input, output, { headTop, target, feather });
    console.log(r.output);
    console.log(`shift: ${r.shift >= 0 ? '+' : ''}${r.shift}px (head top ${headTop}% → ${target}% of ${r.h}px)`);
  } catch (e) {
    fail(e.message);
  }
}
