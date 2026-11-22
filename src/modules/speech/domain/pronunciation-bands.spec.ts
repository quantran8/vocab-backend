import { PRONUNCIATION_BAND, SYLLABLE_BAND } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';
import { bandedSyllables, pronunciationBand } from './pronunciation-bands';

describe('pronunciation bands', () => {
  it.each([
    [100, PRONUNCIATION_BAND.EXCELLENT],
    [90, PRONUNCIATION_BAND.EXCELLENT],
    [89.9, PRONUNCIATION_BAND.GOOD],
    [POLICY.speech.passAccuracy, PRONUNCIATION_BAND.GOOD],
    [60, PRONUNCIATION_BAND.FAIR],
    [59, PRONUNCIATION_BAND.POOR],
  ])('scores %d as %s', (score, band) => {
    expect(pronunciationBand(score)).toBe(band);
  });

  const syl = (text: string, score: number) => ({ text, ipa: text, score });
  const bands = (syllables: ReturnType<typeof syl>[], passed: boolean) => bandedSyllables(syllables, passed).map((s) => s.band);

  it('colours a one-syllable word by the overall result, not its own score', () => {
    expect(bands([syl('can', 78)], true)).toEqual([SYLLABLE_BAND.GOOD]);
    expect(bands([syl('think', 82)], false)).toEqual([SYLLABLE_BAND.POOR]);
  });

  it('bands each syllable of a longer word by the pass mark', () => {
    expect(bands([syl('ap', 90), syl('ci', 78)], true)).toEqual([SYLLABLE_BAND.GOOD, SYLLABLE_BAND.POOR]);
  });
});
