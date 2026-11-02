// Caption phrases: words grouped up to maxChars, and never across a silence, so a phrase is gone when
// its words end. Muted lines (a board's meta.captions.off) leave such a silence in the words; without
// the break the phrase before one stayed on screen until the phrase after it.
// Sentence pauses in narration run up to about 0.4 s; a muted line is rarely shorter than a second.
const MAX_WORD_GAP_S = 0.6;

export function phrases(words, maxChars) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const w of words) {
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length && (len + w.text.length > maxChars || gap > MAX_WORD_GAP_S)) { out.push(cur); cur = []; len = 0; }
    cur.push(w);
    len += w.text.length;
  }
  if (cur.length) out.push(cur);
  return out.map((ws) => ({ words: ws, start: ws[0].start, end: ws[ws.length - 1].end }));
}
