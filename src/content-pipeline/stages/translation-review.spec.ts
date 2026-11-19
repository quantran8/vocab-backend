import { describe, expect, it } from 'vitest';
import { GeneratedEntry, TranslatedMeaning, TranslationReview } from '../build.types';
import { JsonlStore } from '../jsonl';
import { meaningSourceHash } from './translate';
import {
  canRetranslate, isTranslationApproved, isTranslationRejected, reviewableWords, toTranslationReviews, translationHash, translationReviewInput,
  translationReviewProblems,
} from './translation-review';

const entry = (lemma: string, pos: GeneratedEntry['pos'], glosses: string[]): GeneratedEntry => ({
  key: `${lemma}|${pos}`, lemma, pos, promptVersion: 5, model: 'm', generatedAt: '', skipped: null, issues: {},
  meanings: glosses.map((gloss) => ({ meaningId: `${lemma}-${gloss}`, senseKeys: [], cefrLevel: 'A1', gloss, definition: 'd', ipaUs: '/x/', topic: 't', examples: [] })),
});

const entries = [entry('more', 'adverb', ['to a greater degree']), entry('more', 'pronoun', ['extra']), entry('get', 'verb', ['receive'])];

function translations(text: Record<string, string>) {
  const store = new JsonlStore<TranslatedMeaning>('/dev/null');
  for (const e of entries) for (const m of e.meanings) {
    if (!text[m.gloss]) continue;
    store.rows.set(m.meaningId, { key: m.meaningId, meaningId: m.meaningId, sourceHash: meaningSourceHash(e, m), meaningText: text[m.gloss], definitionText: 'x', exampleTranslations: [], model: 'm' });
  }
  return store;
}

describe('translation review', () => {
  it('groups every translated card of a word together and skips untranslated ones', () => {
    const words = reviewableWords(entries, 'vi-VN', translations({ 'to a greater degree': 'hơn', extra: 'thêm' }));
    expect(words.map((w) => w.map(({ m }) => m.gloss))).toEqual([['to a greater degree', 'extra']]);
  });

  it('stores a verdict only for text that is still the one reviewed, and requires every asked meaning', () => {
    const store = translations({ 'to a greater degree': 'hơn', extra: 'thêm', receive: 'nhận được' });
    const input = translationReviewInput('vi-VN', reviewableWords(entries, 'vi-VN', store));
    expect(translationReviewProblems(input, { meanings: [] })).toHaveLength(3);

    store.rows.get('more-extra')!.meaningText = 'thêm nữa';
    const out = { meanings: input.words.flatMap((w) => w.meanings.map((m) => ({ id: m.id, problems: m.id === 'get-receive' ? [{ kind: 'unnatural' as const, note: 'n' }] : [] }))) };
    const rows = toTranslationReviews(input, out, store, 'm');
    expect(rows.map((r) => r.key).sort()).toEqual(['get-receive', 'more-to a greater degree']);

    const reviews = new JsonlStore<TranslationReview>('/dev/null');
    for (const r of rows) reviews.rows.set(r.key, r);
    expect(isTranslationApproved(store.rows.get('more-to a greater degree')!, reviews)).toBe(true);
    expect(isTranslationRejected(store.rows.get('get-receive')!, reviews)).toBe(true);
    expect(isTranslationApproved(store.rows.get('more-extra')!, reviews)).toBe(false);
  });

  it('changes the review hash when the English source changes', () => {
    const t = translations({ receive: 'nhận được' }).rows.get('get-receive')!;
    expect(translationHash({ ...t, sourceHash: 'other' })).not.toBe(translationHash(t));
  });

  it('stops model redos after MAX_ATTEMPTS', () => {
    const t = translations({ receive: 'nhận được' }).rows.get('get-receive')!;
    expect(canRetranslate(t)).toBe(true);
    expect(canRetranslate({ ...t, attempts: 3 })).toBe(false);
  });
});
