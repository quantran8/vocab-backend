import { ASSESSMENT_INTENT, AssessmentIntent, SKILL, Skill } from '../../common/constants/domain';

/** The form a task of this shape trains, as a label for Random filters and the results sheet. Meaning-only tasks train none. */
export function skillOf(intent: AssessmentIntent, promptIsTargetAudio: boolean): Skill | null {
  switch (intent) {
    case ASSESSMENT_INTENT.MEANING_RECOGNITION:
    case ASSESSMENT_INTENT.TRANSCRIPTION:
      return promptIsTargetAudio ? SKILL.LISTENING : null;
    case ASSESSMENT_INTENT.SOUND_DISCRIMINATION:
      return SKILL.LISTENING;
    case ASSESSMENT_INTENT.PRONUNCIATION:
      return SKILL.SPEAKING;
    case ASSESSMENT_INTENT.PAIRING:
      return null;
    case ASSESSMENT_INTENT.MEANING_RECALL:
    case ASSESSMENT_INTENT.SPELLING_REPAIR:
      return SKILL.SPELLING;
  }
}
