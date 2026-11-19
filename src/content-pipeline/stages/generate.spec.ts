import { describe, expect, it } from 'vitest';
import { GeneratedEntry } from '../build.types';
import { CollectionSpec } from '../collections/collection.types';
import { Lexicon, LexiconEntry } from '../lexicon/lexicon.types';
import { toGeneratedEntry } from './generate';

const spec = { slug: 's', promptVersion: 3, maxLevel: 'B2', examplesPerMeaning: 1, maxMeanings: () => 5, topics: [] } as unknown as CollectionSpec;
const entry: LexiconEntry = {
  key: 'get|verb', lemma: 'get', pos: 'verb', cefr: 'A1', cefrSource: 'cefrj', ngslRank: 30, forms: ['get', 'got'],
  senses: [{ key: 'get%2:40:00::', gloss: 'come into possession', lexname: 'verb.possession', homograph: null, pronunciations: [], count: 9 }],
  ipaUs: ['/ɡet/'], ipaUk: [], confusables: { homophones: [], spelling: [] },
};
const lexicon = { entries: [entry], levelOfForm: { i: 'A1', a: 'A1', letter: 'A1', some: 'A1', milk: 'A1' } } as unknown as Lexicon;
const meaning = (gloss: string, text: string) => ({ senses: [1], cefrLevel: 'A1' as const, gloss, definition: 'x', ipa: 1, topic: 't', examples: [{ text, target: 'got' }] });

describe('toGeneratedEntry', () => {
  it('gives an old meaning id to only one of two meanings that start from the same sense', () => {
    const output = { key: 'get|verb', skip: null, meanings: [meaning('receive', 'I got a letter.'), meaning('buy', 'I got some milk.')] };
    const first = toGeneratedEntry(spec, lexicon, entry, { ...output, meanings: [output.meanings[0]] }, undefined, 'm');
    const second: GeneratedEntry = toGeneratedEntry(spec, lexicon, entry, output, first, 'm');
    expect(second.meanings[0].meaningId).toBe(first.meanings[0].meaningId);
    expect(second.meanings[1].meaningId).not.toBe(first.meanings[0].meaningId);
  });
});
