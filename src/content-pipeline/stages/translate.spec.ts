import { describe, expect, it } from 'vitest';
import { GeneratedEntry, TranslatedMeaning } from '../build.types';
import { JsonlStore } from '../jsonl';
import { entryHash } from './review';
import { meaningSourceHash, otherCards, PendingMeaning, translationInput } from './translate';

const entry = (lemma: string, pos: GeneratedEntry['pos'], glosses: string[]): GeneratedEntry => ({
  key: `${lemma}|${pos}`, lemma, pos, promptVersion: 5, model: 'm', generatedAt: '', skipped: null, issues: {},
  meanings: glosses.map((gloss) => ({ meaningId: `${lemma}-${gloss}`, senseKeys: [], cefrLevel: 'A1', gloss, definition: 'd', ipaUs: '/x/', topic: 't', examples: [] })),
});

describe('translate input', () => {
  it('shows the other cards of each headword with their current translation, and null when stale or missing', () => {
    const entries = [entry('get', 'verb', ['receive', 'buy', 'understand']), entry('take', 'verb', ['carry'])];
    const [get] = entries;
    const vi = new JsonlStore<TranslatedMeaning>('/dev/null');
    const row = (gloss: string, text: string, sourceHash = meaningSourceHash(get, get.meanings.find((m) => m.gloss === gloss)!)) =>
      vi.rows.set(`get-${gloss}`, { key: `get-${gloss}`, meaningId: `get-${gloss}`, sourceHash, meaningText: text, definitionText: '', exampleTranslations: [], model: 'm' });
    row('receive', 'nhận được');
    row('buy', 'mua', 'stale');
    const batch: PendingMeaning[] = [{ entry: get, m: get.meanings[2], sourceHash: '', missing: ['vi-VN'] }];

    const others = otherCards(entries, new Map([['vi-VN', vi]]), ['vi-VN'], batch);
    expect(others).toEqual({
      get: [
        { partOfSpeech: 'verb', gloss: 'receive', meaningText: { 'vi-VN': 'nhận được' } },
        { partOfSpeech: 'verb', gloss: 'buy', meaningText: { 'vi-VN': null } },
      ],
    });
    expect(translationInput(['vi-VN'], batch, new Map(), others).otherCards).toBe(others);
  });

  it('asks for a fresh entry review when the prompt version changes, even if the text is the same', () => {
    const e = entry('get', 'verb', ['receive']);
    expect(entryHash({ ...e, promptVersion: 6 })).not.toBe(entryHash(e));
  });
});
