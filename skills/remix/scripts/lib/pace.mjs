// Speech pace: syllables per second over the spans where someone is actually speaking, so a
// replica's copy can be budgeted against the original's window and its voice sped up evenly
// when it runs slower than the original. Words per minute misjudges monosyllabic lines and
// counts pauses; syllables over speech spans do neither.

// Within 8 % of the original's rate counts as matching: about the spread between two takes of
// the same line by one voice, and below what a listener notices as a different pace.
export const PACE_TOLERANCE = 0.08;
// Largest uniform speed-up per kind of footage. Voice-over has no picture to betray it; a
// presenter's lips and gestures are visible — a user judged 1.1× natural and 1.4× fast-forward.
export const TEMPO_CAP = { voiceover: 1.3, presenter: 1.12 };
// Gap that splits speech spans: gaps between words of fluent speech stay under ~0.25 s, a
// comma or sentence pause runs 0.3 s and longer, so pauses drop out of the speaking time.
export const SPAN_GAP_S = 0.3;

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/g;
const isCjkLanguage = (language) => /^(zh|ja|ko)/i.test(language || '');
// Rough spoken length of digits and symbols ("7" → "se-ven", "%" → "per-cent").
const DIGIT_SYL = { 0: 2, 7: 2 };
const SYMBOL_SYL = { '%': 2, '&': 1, '+': 1, '@': 1, $: 2 };

function englishSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  let n = (w.replace(/^y/, '').match(/[aeiouy]+/g) || []).length;
  // Silent endings: "make", "makes", "jumped" (but not "table", "voices", "wanted").
  if (/[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w)) n -= 1;
  else if (/[^aeiouysxzgc]es$/.test(w) && !/(ch|sh)es$/.test(w)) n -= 1;
  else if (/[^aeiouytd]ed$/.test(w)) n -= 1;
  return Math.max(1, n);
}

function vowelGroups(word) {
  const w = word.toLowerCase().replace(/[^\p{L}]/gu, '');
  if (!w) return 0;
  return Math.max(1, (w.match(/[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ]+/g) || []).length);
}

// Syllables of one word: one per Han / Kana / Hangul character, Latin words by the English
// heuristic (also inside Chinese, Japanese or Korean copy), other languages by vowel groups.
export function syllables(word, language) {
  const str = String(word || '');
  const cjk = (str.match(CJK) || []).length;
  const rest = str.replace(CJK, ' ');
  const digits = [...rest.replace(/[^0-9]/g, '')].reduce((a, d) => a + (DIGIT_SYL[d] || 1), 0);
  const symbols = [...rest].reduce((a, c) => a + (SYMBOL_SYL[c] || 0), 0);
  const english = /^en/i.test(language || 'en') || isCjkLanguage(language);
  const letters = rest.split(/[^\p{L}']+/u).filter(Boolean).reduce((a, w) => a + (english ? englishSyllables(w) : vowelGroups(w)), 0);
  return cjk + digits + symbols + letters;
}

export function textSyllables(text, language) {
  return String(text || '').split(/[\s\-–—/]+/).filter(Boolean).reduce((a, w) => a + syllables(w, language), 0);
}

// Word intervals merged where the gap to the next word is under gapS.
export function speechSpans(words, gapS = SPAN_GAP_S) {
  const sorted = [...(words || [])].sort((a, b) => a.start - b.start);
  return sorted.reduce((spans, w) => {
    const last = spans[spans.length - 1];
    if (last && w.start - last.end < gapS) return [...spans.slice(0, -1), { start: last.start, end: Math.max(last.end, w.end) }];
    return [...spans, { start: w.start, end: w.end }];
  }, []);
}

// Syllables per second of speech over the words starting inside [from, to).
export function speechRate(words, { language, from = -Infinity, to = Infinity } = {}) {
  const inside = (words || []).filter((w) => w.start >= from && w.start < to);
  const count = inside.reduce((a, w) => a + textSyllables(w.text, language), 0);
  const speechS = speechSpans(inside).reduce((a, s) => a + (s.end - s.start), 0);
  return { syllables: count, speechS, sylPerS: speechS > 0 ? count / speechS : 0 };
}

// One speed factor for the whole film: 1 when the take already matches the source or is faster
// (we never slow a voice down), else the ratio capped for the kind of footage, to 0.01.
export function tempoFactor(sourceRate, takeRate, kind) {
  if (!(sourceRate > 0) || !(takeRate > 0)) return 1;
  const ratio = sourceRate / takeRate;
  if (ratio <= 1 + PACE_TOLERANCE) return 1;
  return Number(Math.min(ratio, TEMPO_CAP[kind] ?? TEMPO_CAP.voiceover).toFixed(2));
}

// Normalized comparison tokens of a text: lower case, no punctuation, one token per CJK
// character, number words up to twenty as digits ("three" and "3" match).
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
export function wordTokens(text) {
  return (String(text || '').toLowerCase().match(/[぀-ヿ㐀-鿿豈-﫿가-힯]|[\p{L}\p{N}']+/gu) || [])
    .map((t) => t.replace(/'/g, ''))
    .filter(Boolean)
    .map((t) => (NUMBER_WORDS.includes(t) ? String(NUMBER_WORDS.indexOf(t)) : t));
}
