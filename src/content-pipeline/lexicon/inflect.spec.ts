import { describe, expect, it } from 'vitest';
import { posForms } from './inflect';

describe('posForms', () => {
  it('keeps only the forms of this part of speech from an NGSL word family', () => {
    expect(posForms('time', 'verb', ['time', 'times', 'timed', 'timing'])).toEqual(expect.arrayContaining(['time', 'times', 'timed', 'timing']));
    expect(posForms('time', 'noun', ['time', 'times', 'timed', 'timing'])).toEqual(['time', 'times']);
    expect(posForms('go', 'verb', ['go', 'goes', 'went', 'going', 'gone', 'goin', 'gonna'])).toEqual(expect.arrayContaining(['went', 'gone']));
    expect(posForms('go', 'verb', ['go', 'gonna'])).not.toContain('gonna');
    expect(posForms('child', 'noun', ['child', 'children'])).toEqual(['child', 'childs', 'children']);
    expect(posForms('good', 'adjective', ['good', 'better', 'best'])).toEqual(expect.arrayContaining(['better', 'best']));
    expect(posForms('record', 'verb', ['record', 'records', 'recorded', 'recording', 'recordings'])).not.toContain('recordings');
    expect(posForms('think', 'verb', ['think', 'thinks', 'thought', 'thinking', 'thoughts'])).not.toContain('thoughts');
    expect(posForms('think', 'verb', ['think', 'thinks', 'thought', 'thinking', 'thoughts'])).toContain('thought');
  });

  it('gives pronouns and other closed classes only the headword', () => {
    expect(posForms('i', 'pronoun', ['i', 'me', 'my', 'mine'])).toEqual(['i']);
    expect(posForms('who', 'pronoun', ['who', 'whom', 'whose'])).toEqual(['who']);
    expect(posForms('other', 'pronoun', ['other', 'others', 'otherwise'])).toEqual(['other', 'others']);
    expect(posForms('well', 'adverb', ['well', 'wells', 'welled'])).toEqual(['well']);
  });
});
