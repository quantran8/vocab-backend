import { PRONUNCIATION_BAND, PronunciationBand, SYLLABLE_BAND, SyllableBand } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';
import { SpeechSyllable } from '../providers/speech.provider';

const { bandFloors, syllableGoodFloor } = POLICY.speech;

export function pronunciationBand(score: number): PronunciationBand {
  if (score >= bandFloors[PRONUNCIATION_BAND.EXCELLENT]) return PRONUNCIATION_BAND.EXCELLENT;
  if (score >= bandFloors[PRONUNCIATION_BAND.GOOD]) return PRONUNCIATION_BAND.GOOD;
  if (score >= bandFloors[PRONUNCIATION_BAND.FAIR]) return PRONUNCIATION_BAND.FAIR;
  return PRONUNCIATION_BAND.POOR;
}

export const syllableBand = (score: number): SyllableBand =>
  (score >= syllableGoodFloor ? SYLLABLE_BAND.GOOD : SYLLABLE_BAND.POOR);

export const bandedSyllables = (syllables: SpeechSyllable[] = []) =>
  syllables.map((s) => ({ ...s, band: syllableBand(s.score) }));
