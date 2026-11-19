import { describe, expect, it } from 'vitest';
import { isValidIpa, locateTarget, wordsAboveLevel } from './rules';

describe('locateTarget', () => {
  const forms = ['run', 'runs', 'ran', 'running'];

  it('finds an inflected form as a whole word', () => {
    expect(locateTarget('She ran to the bus.', 'ran', forms)).toEqual({ start: 4, end: 7 });
    expect(locateTarget('Running is fun.', 'Running', forms)).toEqual({ start: 0, end: 7 });
  });

  it('rejects a target that is not a form of the headword or not a whole word', () => {
    expect(locateTarget('She walked home.', 'walked', forms)).toBeNull();
    expect(locateTarget('The runner was fast.', 'run', forms)).toBeNull();
  });
});

describe('wordsAboveLevel', () => {
  const levels = { the: 'A1', she: 'A1', go: 'A1', to: 'A1', bank: 'A1', every: 'A1', week: 'A1', at: 'A1', do: 'A1', can: 'A1', mortgage: 'C1' } as const;

  it('reports unknown and above-level words, but not the headword or names', () => {
    expect(wordsAboveLevel('She goes to the bank every week.', 'A1', levels, ['go', 'goes'])).toEqual([]);
    expect(wordsAboveLevel('She paid the mortgage at the bank.', 'A1', levels, ['bank'])).toEqual(['paid', 'mortgage']);
    expect(wordsAboveLevel('Then Anna went to the bank.', 'A1', levels, ['bank'])).toEqual(['then', 'went']);
    expect(wordsAboveLevel("She can't go and doesn't go.", 'A1', levels, [])).toEqual(['and', 'does']);
  });
});

describe('isValidIpa', () => {
  it('accepts dictionary IPA between slashes', () => {
    expect(isValidIpa('/ˈdɑːktər/')).toBe(true);
    expect(isValidIpa('ˈdɑːktər')).toBe(false);
    expect(isValidIpa('/DAA1K/')).toBe(false);
  });
});
