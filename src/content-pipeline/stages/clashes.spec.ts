import { describe, expect, it } from 'vitest';
import { GeneratedEntry, TranslatedMeaning } from '../build.types';
import { JsonlStore } from '../jsonl';
import { clashingMeaningIds, terms, translationClashes } from './clashes';
import { meaningSourceHash } from './translate';

const entry = (pos: GeneratedEntry['pos'], glosses: string[]): GeneratedEntry => ({
  key: `work|${pos}`, lemma: 'work', pos, promptVersion: 4, model: 'm', generatedAt: '', skipped: null, issues: {},
  meanings: glosses.map((gloss) => ({ meaningId: `${pos}-${gloss}`, senseKeys: [], cefrLevel: 'A1', gloss, definition: 'd', ipaUs: '/x/', topic: 't', examples: [] })),
});

function vietnamese(entries: GeneratedEntry[], text: Record<string, string>) {
  const store = new JsonlStore<TranslatedMeaning>('/dev/null');
  for (const e of entries) for (const m of e.meanings) {
    store.rows.set(m.meaningId, { key: m.meaningId, meaningId: m.meaningId, sourceHash: meaningSourceHash(e, m), meaningText: text[m.gloss], definitionText: 'x', exampleTranslations: [], model: 'm' });
  }
  return store;
}

describe('translation clashes', () => {
  it('splits a meaningText into equivalents, ignoring notes in brackets', () => {
    expect(terms('Cầm, nắm (bằng tay)')).toEqual(['cầm', 'nắm']);
    expect(terms('công việc (được trả lương)')).toEqual(['công việc']);
  });

  it('flags two meanings of a word that share a Vietnamese equivalent, across parts of speech', () => {
    const entries = [entry('noun', ['tasks', 'paid job']), entry('verb', ['do tasks'])];
    const clashes = translationClashes(entries, vietnamese(entries, { tasks: 'công việc', 'paid job': 'công việc (được trả lương)', 'do tasks': 'làm việc' }));
    expect(clashes).toHaveLength(1);
    expect([...clashingMeaningIds(clashes)].sort()).toEqual(['noun-paid job', 'noun-tasks']);
  });

  it('accepts distinct equivalents', () => {
    const entries = [entry('noun', ['job', 'workplace'])];
    expect(translationClashes(entries, vietnamese(entries, { job: 'việc làm', workplace: 'chỗ làm' }))).toEqual([]);
  });
});
