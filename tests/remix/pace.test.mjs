import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACE_TOLERANCE, TEMPO_CAP, speechRate, speechSpans, syllables, tempoFactor, textSyllables, wordTokens,
} from '../../skills/remix/scripts/lib/pace.mjs';

test('syllables: English heuristic, CJK characters, digits and symbols, other languages', () => {
  const en = (w) => syllables(w, 'en');
  assert.deepEqual(['the', 'make', 'makes', 'table', 'voices', 'jumped', 'wanted', 'nova', 'replies', 'yellow', 'idea'].map(en),
    [1, 1, 1, 2, 2, 1, 2, 2, 2, 2, 2]);
  assert.equal(en('Notes,'), 1, 'punctuation is ignored');
  assert.equal(en('—'), 0);
  assert.equal(en('2024'), 5, 'two-zero-two-four read as twenty twenty-four');
  assert.equal(en('50%'), 5, 'digits read one by one (five-ze-ro) plus per-cent: rough, as intended');
  assert.equal(syllables('会议', 'zh'), 2);
  assert.equal(syllables('こんにちは', 'ja'), 5);
  assert.equal(syllables('안녕', 'ko'), 2);
  assert.equal(syllables('用Nova', 'zh'), 3, 'a Latin word inside Chinese copy uses the English heuristic');
  assert.equal(syllables('ciudad', 'es'), 2, 'vowel groups');
  assert.equal(textSyllables('Meet Nova, the notes app that writes back.', 'en'), 9);
  assert.equal(textSyllables('twenty-four hours', 'en'), 4, 'hyphenated words split');
});

test('speechSpans merges words closer than the gap and keeps pauses out', () => {
  const words = [{ text: 'a', start: 0, end: 0.3 }, { text: 'b', start: 0.4, end: 0.7 }, { text: 'c', start: 1.2, end: 1.5 }];
  assert.deepEqual(speechSpans(words), [{ start: 0, end: 0.7 }, { start: 1.2, end: 1.5 }]);
  assert.deepEqual(speechSpans(words, 1), [{ start: 0, end: 1.5 }]);
  assert.deepEqual(speechSpans([]), []);
});

test('speechRate counts syllables over speech time inside [from, to)', () => {
  const words = [
    { text: 'one', start: 0, end: 0.25 }, { text: 'two', start: 0.3, end: 0.5 },
    { text: 'seven', start: 2, end: 2.5 }, { text: 'eight', start: 3, end: 3.25 },
  ];
  const all = speechRate(words, { language: 'en' });
  assert.equal(all.syllables, 5);
  assert.ok(Math.abs(all.speechS - 1.25) < 1e-9, String(all.speechS));
  assert.ok(Math.abs(all.sylPerS - 4) < 1e-9);
  const win = speechRate(words, { language: 'en', from: 2, to: 3 });
  assert.deepEqual([win.syllables, win.speechS], [2, 0.5]);
  assert.deepEqual(speechRate([], { language: 'en' }), { syllables: 0, speechS: 0, sylPerS: 0 });
});

test('tempoFactor: never slows down, ignores matching pace, caps per kind', () => {
  assert.equal(PACE_TOLERANCE, 0.08);
  assert.deepEqual(TEMPO_CAP, { voiceover: 1.3, presenter: 1.12 });
  assert.equal(tempoFactor(5, 6, 'voiceover'), 1, 'take already faster');
  assert.equal(tempoFactor(5.3, 5, 'voiceover'), 1, 'within 8 %');
  assert.equal(tempoFactor(6, 5, 'voiceover'), 1.2);
  assert.equal(tempoFactor(8, 5, 'voiceover'), 1.3);
  assert.equal(tempoFactor(6, 5, 'presenter'), 1.12);
  assert.equal(tempoFactor(0, 5, 'voiceover'), 1);
  assert.equal(tempoFactor(5, 0, 'voiceover'), 1);
});

test('wordTokens normalizes case, punctuation, number words and CJK', () => {
  assert.deepEqual(wordTokens("It's THREE steps, 3 clicks!"), ['its', '3', 'steps', '3', 'clicks']);
  assert.deepEqual(wordTokens('会议，太长'), ['会', '议', '太', '长']);
});
