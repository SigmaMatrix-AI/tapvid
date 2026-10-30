// Pages measure.mjs screenshots: a source frame under a labelled percent grid (optionally zoomed
// to a box), and a font sheet (the source crop above candidate families setting the same text).
// The labels are HTML/CSS because the local ffmpeg has no drawtext.

// Grid lines: every `step` % thin, every 10 % thick and labelled.
export const DEFAULT_STEP = 2;
const MAJOR = 10;
// A zoomed box is shown at this multiple of source pixels, so small type and edges are readable.
export const ZOOM = 2;
// Font sheet: candidate label column width (px) and the gap between rows.
const LABEL_W = 360;
const ROW_GAP = 24;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (v) => Number(v.toFixed(4));

// "--box x,y,w,h": 0–1 fractions of the canvas, or percent when any value is above 1. Returns fractions.
export function parseBox(arg) {
  const v = String(arg).split(',').map((s) => Number(s.trim()));
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x) || x < 0)) throw new Error(`--box must be x,y,w,h, got ${arg}`);
  const box = v.some((x) => x > 1) ? v.map((x) => x / 100) : v;
  if (box[2] <= 0 || box[3] <= 0 || box[0] + box[2] > 1.0001 || box[1] + box[3] > 1.0001) throw new Error(`--box ${arg} is not inside the canvas`);
  return box;
}

// "--at 12.4,13.0" → [12.4, 13]
export function parseTimes(arg) {
  const v = String(arg).split(',').map((s) => Number(s.trim()));
  if (!v.length || v.some((x) => !Number.isFinite(x) || x < 0)) throw new Error(`--at must be seconds (comma-separated), got ${arg}`);
  return v;
}

// "Source Serif 4:900,Bree Serif:400,Fraunces" → [{ family, weight }]; weight defaults to 400.
export function parseCandidates(arg) {
  return String(arg).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(.*?)(?::(\d{3}))?$/);
    const family = m[1].trim();
    if (!family) throw new Error(`--candidates: empty family in "${s}"`);
    return { family, weight: Number(m[2] || 400) };
  });
}

export const googleCssUrl = ({ family, weight }) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weight}&display=block`;

// Percent values of the grid lines in [from, to] (inclusive), on the `step` lattice.
function lines(from, to, step) {
  const out = [];
  for (let p = Math.ceil(from / step - 1e-9) * step; p <= to + 1e-9; p += step) out.push(num(p));
  return out;
}

/**
 * The grid page for one frame.
 * @param {object} o
 * @param {string} o.image   frame URL (a data: URI)
 * @param {number} o.width   source frame width (px)
 * @param {number} o.height  source frame height (px)
 * @param {number} [o.step]  grid step in % (default 2)
 * @param {number[]} [o.box] zoom box, 0–1 fractions; the page then shows only the box at ZOOM×
 * @returns {{html: string, width: number, height: number}} the page and its viewport
 */
export function gridHtml({ image, width, height, step = DEFAULT_STEP, box }) {
  const [bx, by, bw, bh] = box || [0, 0, 1, 1];
  const scale = box ? ZOOM : 1;
  const vw = Math.round(width * bw * scale);
  const vh = Math.round(height * bh * scale);
  const imgW = width * scale;
  const imgH = height * scale;
  const x = (p) => num((p / 100) * imgW - bx * imgW);
  const y = (p) => num((p / 100) * imgH - by * imgH);
  // Zoomed, every line is labelled (only a few are in view); full frame, the 10 % lines.
  const major = (p) => Math.abs(p % MAJOR) < 1e-6 || Math.abs((p % MAJOR) - MAJOR) < 1e-6;
  const labelled = (p) => Boolean(box) || major(p);
  const parts = [];
  for (const p of lines(bx * 100, (bx + bw) * 100, step)) {
    parts.push(`<div class="v ${major(p) ? 'M' : ''}" style="left:${x(p)}px"></div>`);
    if (labelled(p)) parts.push(`<div class="lx" style="left:${x(p)}px">${p}</div><div class="lx b" style="left:${x(p)}px">${p}</div>`);
  }
  for (const p of lines(by * 100, (by + bh) * 100, step)) {
    parts.push(`<div class="h ${major(p) ? 'M' : ''}" style="top:${y(p)}px"></div>`);
    if (labelled(p)) parts.push(`<div class="ly" style="top:${y(p)}px">${p}</div><div class="ly r" style="top:${y(p)}px">${p}</div>`);
  }
  // Zoomed labels sit on every line, so they shrink to fit the line spacing (9–16 px).
  const fs = box ? Math.max(9, Math.min(16, Math.round((step / 100) * imgW * 0.4))) : Math.max(14, Math.round(Math.min(vw, vh) / 60));
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#000;overflow:hidden}
#c{position:relative;width:${vw}px;height:${vh}px;overflow:hidden}
#c img{position:absolute;left:${num(-bx * imgW)}px;top:${num(-by * imgH)}px;width:${imgW}px;height:${imgH}px}
.v,.h{position:absolute;background:rgba(255,0,255,.45)}
.v{top:0;bottom:0;width:1px}.h{left:0;right:0;height:1px}
.v.M{width:2px;margin-left:-.5px;background:rgba(255,235,0,.9);box-shadow:0 0 0 1px rgba(0,0,0,.6)}
.h.M{height:2px;margin-top:-.5px;background:rgba(255,235,0,.9);box-shadow:0 0 0 1px rgba(0,0,0,.6)}
.lx,.ly{position:absolute;font:700 ${fs}px/1 monospace;color:#ffeb00;background:rgba(0,0,0,.75);padding:2px 4px;border-radius:3px}
.lx{top:2px;transform:translateX(-50%)}.lx.b{top:auto;bottom:2px}
.ly{left:2px;transform:translateY(-50%)}.ly.r{left:auto;right:2px}
</style></head><body><div id="c"><img src="${image}">${parts.join('')}</div></body></html>`;
  return { html, width: vw, height: vh };
}

/**
 * The font sheet: the source crop at ZOOM× on top, then one row per candidate setting `text` so its
 * ink height equals the crop's displayed height. Each row is labelled with family / weight, or
 * "not found" when the family did not load. `cssUrl` builds each candidate's stylesheet URL.
 */
export function fontsHtml({ image, cropWidth, cropHeight, text, candidates, cssUrl = googleCssUrl, timeoutMs }) {
  const w = Math.round(cropWidth * ZOOM);
  const h = Math.round(cropHeight * ZOOM);
  const links = candidates.map((c) => `<link rel="stylesheet" href="${esc(cssUrl(c))}">`).join('\n');
  const rows = candidates.map((c, i) => `<div class="row"><div class="lab" id="lab${i}">${esc(c.family)} ${c.weight}</div>`
    + `<div class="txt" id="txt${i}" style="font-family:'${esc(c.family.replace(/'/g, ''))}',monospace;font-weight:${c.weight}">${esc(text)}</div></div>`).join('\n');
  // In-page: load each face, scale its font size so the text's ink height (canvas measureText)
  // equals the crop's height, then flag window.__sheetReady.
  const script = `
const C=${JSON.stringify(candidates)},H=${h},T=${JSON.stringify(text)},TO=${Number(timeoutMs) || 15000};
const wait=(p)=>Promise.race([p,new Promise((r)=>setTimeout(()=>r([]),TO))]);
(async()=>{
  const ctx=document.createElement('canvas').getContext('2d');
  for(let i=0;i<C.length;i++){
    const c=C[i],fam="'"+c.family.replace(/'/g,'')+"'";
    let faces=[];try{faces=await wait(document.fonts.load(c.weight+' 100px '+fam,T));}catch(e){}
    const lab=document.getElementById('lab'+i),txt=document.getElementById('txt'+i);
    if(!faces.length){lab.textContent=c.family+' '+c.weight+' — not found';lab.className='lab miss';txt.style.visibility='hidden';continue;}
    ctx.font=c.weight+' 100px '+fam;const m=ctx.measureText(T);
    const ink=m.actualBoundingBoxAscent+m.actualBoundingBoxDescent;
    txt.style.fontSize=(ink>0?100*H/ink:H)+'px';
  }
  await document.fonts.ready;window.__sheetReady=true;
})();`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${links}<style>
html,body{margin:0;padding:0;background:#2a2a2a}
#sheet{display:inline-block;padding:${ROW_GAP}px;color:#fff;font:600 20px/1.2 monospace}
.row{display:flex;align-items:center;gap:${ROW_GAP}px;margin-bottom:${ROW_GAP}px}
.lab{width:${LABEL_W}px;flex:none}.lab.miss{color:#ff6b6b}
.txt{white-space:pre;line-height:1.25;color:#fff}
.src{width:${w}px;height:${h}px;display:block;outline:1px solid #ffeb00}
</style></head><body><div id="sheet">
<div class="row"><div class="lab">source ×${ZOOM}</div><img class="src" src="${image}"></div>
${rows}
</div><script>${script}</script></body></html>`;
}
