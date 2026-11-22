import { PRONUNCIATION_BAND, PronunciationBand, SYLLABLE_BAND } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';
import { SpeechSyllable } from '../providers/speech.provider';

const { bandFloors, syllableGoodFloor } = POLICY.speech;

export function pronunciationBand(score: number): PronunciationBand {
  if (score >= bandFloors[PRONUNCIATION_BAND.EXCELLENT]) return PRONUNCIATION_BAND.EXCELLENT;
  if (score >= bandFloors[PRONUNCIATION_BAND.GOOD]) return PRONUNCIATION_BAND.GOOD;
  if (score >= bandFloors[PRONUNCIATION_BAND.FAIR]) return PRONUNCIATION_BAND.FAIR;
  return PRONUNCIATION_BAND.POOR;
}

// A one-syllable word is the whole word, so its colour follows the overall result instead of its own score.
export function bandedSyllables(syllables: SpeechSyllable[] = [], passed: boolean) {
  if (syllables.length === 1) return [{ ...syllables[0], band: passed ? SYLLABLE_BAND.GOOD : SYLLABLE_BAND.POOR }];
  return syllables.map((s) => ({ ...s, band: s.score >= syllableGoodFloor ? SYLLABLE_BAND.GOOD : SYLLABLE_BAND.POOR }));
}
