import { parseVoices } from './app-config';

describe('voice options', () => {
  it('puts the default first, takes labels, and drops repeats and blanks', () => {
    expect(parseVoices('def', 'a:Anna, b , def:Main voice,,a:Again')).toEqual([
      { id: 'def', name: 'Main voice' }, { id: 'a', name: 'Anna' }, { id: 'b', name: 'b' },
    ]);
  });

  it('works with only the default or only options', () => {
    expect(parseVoices('def', undefined)).toEqual([{ id: 'def', name: 'def' }]);
    expect(parseVoices(undefined, 'a:Anna')).toEqual([{ id: 'a', name: 'Anna' }]);
    expect(parseVoices(undefined, undefined)).toEqual([]);
  });
});
