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

  it('bands each syllable good or poor', () => {
    expect(bandedSyllables([{ text: 'ci', ipa: 'ʃi', score: 42 }, { text: 'ap', ipa: 'ə', score: 90 }]).map((s) => s.band))
      .toEqual([SYLLABLE_BAND.POOR, SYLLABLE_BAND.GOOD]);
  });
});
