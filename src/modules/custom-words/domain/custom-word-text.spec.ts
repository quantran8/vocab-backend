import { audioKey, bareIpa, contextKey, locateTarget, normalizeText } from './custom-word-text';

describe('custom word text', () => {
  it('normalizes case, spacing and curly apostrophes', () => {
    expect(normalizeText('  Don’t   STOP ')).toBe("don't stop");
  });

  it('keeps one cache key for the same context', () => {
    expect(contextKey('u1', 'a  Bank ')).toBe(contextKey('u1', 'a bank'));
    expect(contextKey('u1', 'a bank')).not.toBe(contextKey('u1', 'a river'));
    expect(contextKey('u1', 'a bank')).not.toBe(contextKey('u2', 'a bank'));
  });

  it('locates the target case-insensitively and rejects a miss', () => {
    expect(locateTarget('She RAN home.', 'ran')).toEqual({ start: 4, end: 7 });
    expect(locateTarget('She ran home.', 'walked')).toBeNull();
    expect(locateTarget('She ran home.', '  ')).toBeNull();
  });

  it('strips the delimiters editors type around IPA', () => {
    expect(bareIpa(' /ˈriːd/ ')).toBe('ˈriːd');
    expect(bareIpa('[rɛd]')).toBe('rɛd');
    expect(bareIpa('rɛd')).toBe('rɛd');
    expect(bareIpa(' // ')).toBeNull();
    expect(bareIpa(null)).toBeNull();
  });

  it('keys audio by sound, not spelling, without revealing the word', () => {
    expect(audioKey('v', 'en-US', 'rɛd')).toBe(audioKey('v', 'en-US', 'rɛd'));
    expect(audioKey('v', 'en-US', 'rɛd')).not.toBe(audioKey('v', 'en-US', 'riːd'));
    expect(audioKey('v', 'en-US', 'rɛd')).toMatch(/^tts\/v\/en-US\/[0-9a-f]{64}\.mp3$/);
  });
});
