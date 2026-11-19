import { describe, expect, it } from 'vitest';
import { GeneratedEntry, GeneratedMeaning } from '../build.types';
import { corpusContradictions, LemmaGroup, popularities } from './rank';

const meaning = (meaningId: string): GeneratedMeaning => ({
  meaningId, senseKeys: [], cefrLevel: 'A1', gloss: meaningId, definition: '', ipaUs: '/x/', topic: 't', examples: [],
});
const entry = (pos: GeneratedEntry['pos']) => ({ key: `take|${pos}`, lemma: 'take', pos } as GeneratedEntry);
const group = (items: [GeneratedEntry['pos'], string, number | null][]): LemmaGroup => ({
  lemma: 'take', sourceHash: 'h', meanings: items.map(([pos, id, semcorCount]) => ({ entry: entry(pos), m: meaning(id), semcorCount })),
});

describe('popularities', () => {
  it('uses the model frequencies as popularity', () => {
    const g = group([['verb', 'create', 120], ['verb', 'cause', 702]]);
    const out = popularities(g, { key: 'take', sourceHash: 'h', model: 'm', frequencies: { create: 95, cause: 88 } })!;
    expect(out).toEqual(new Map([['create', 95], ['cause', 88]]));
  });

  it('flags a clear inversion between parts of speech, not within one', () => {
    const g = group([['noun', 'film-take', 0], ['verb', 'get-hold', 135], ['verb', 'need-time', 74]]);
    expect(corpusContradictions(g, { 'film-take': 90, 'get-hold': 60, 'need-time': 70 })).toHaveLength(2);
    expect(corpusContradictions(g, { 'film-take': 8, 'get-hold': 60, 'need-time': 70 })).toEqual([]);
    expect(corpusContradictions(group([['verb', 'used-to', 0], ['noun', 'purpose', 25]]), { 'used-to': 70, purpose: 60 })).toEqual([]);
  });

  it('needs a current rank for a word with several meanings, but not for a single one', () => {
    expect(popularities(group([['verb', 'a', 1], ['verb', 'b', 2]]), undefined)).toBeNull();
    expect(popularities(group([['verb', 'a', 1], ['verb', 'b', 2]]), { key: 'take', sourceHash: 'old', model: 'm', frequencies: {} })).toBeNull();
    expect(popularities(group([['verb', 'a', 1]]), undefined)).toEqual(new Map([['a', 100]]));
  });
});
