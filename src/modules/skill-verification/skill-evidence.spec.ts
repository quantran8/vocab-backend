import { ASSESSMENT_INTENT, DELIVERY_MODE, EVIDENCE_REASON as R, OUTCOME, SKILL, SKILL_STATUS, TASK_PHASE, TEMPLATE, VALIDITY } from '../../common/constants/domain';
import { addHours } from '../../common/constants/time';
import { deriveEvidence, deriveSkillStatus, EvidenceRow, isWordFullyVerified, SkillFact } from './skill-evidence';

const AT = new Date('2026-10-30T00:00:00Z');
const fact = (overrides: Partial<SkillFact>): SkillFact => ({
  template: TEMPLATE.SELECT, intent: ASSESSMENT_INTENT.MEANING_RECOGNITION, phase: TASK_PHASE.DUE_REVIEW,
  promptIsTargetAudio: false, qualityQualified: true, isPrimed: false, deliveryMode: DELIVERY_MODE.NONE,
  outcome: OUTCOME.CORRECT, hintCount: 0, meaningId: 'm', pronunciationId: 'p', ...overrides,
});
const audio = { promptIsTargetAudio: true, deliveryMode: DELIVERY_MODE.AUDIO };
const row = (sessionId: string, hours: number, passed: boolean): EvidenceRow => ({ sessionId, passed, committedAt: addHours(AT, hours) });

describe('evidence mapping', () => {
  it('select(text) gives direct Reading on the Meaning', () => {
    expect(deriveEvidence(fact({}))).toEqual([expect.objectContaining({ skill: SKILL.READING, reasons: [], meaningId: 'm', pronunciationId: null })]);
  });
  it('C45 select(audio) gives direct Listening on the Pronunciation', () => {
    expect(deriveEvidence(fact(audio))).toEqual([expect.objectContaining({ skill: SKILL.LISTENING, reasons: [], passed: true, pronunciationId: 'p' })]);
  });
  it('C19 fallback is neither direct nor a failure', () => {
    expect(deriveEvidence(fact({ ...audio, deliveryMode: DELIVERY_MODE.FALLBACK, outcome: OUTCOME.INCORRECT }))).toEqual([
      expect.objectContaining({ reasons: [R.AUDIO_NOT_PLAYED], validity: VALIDITY.INVALID, passed: null }),
    ]);
  });
  it('C46 localized audio gives no Listening', () => {
    const [e] = deriveEvidence(fact({ intent: ASSESSMENT_INTENT.MEANING_RECALL, template: TEMPLATE.TYPING, deliveryMode: DELIVERY_MODE.AUDIO }));
    expect(e.skill).toBe(SKILL.WRITING);
  });
  it('C16 each kind of help is its own reason', () => {
    expect(deriveEvidence(fact({ hintCount: 1 }))[0].reasons).toEqual([R.HINTED]);
    expect(deriveEvidence(fact({ hintCount: 1, outcome: OUTCOME.REVEALED, isPrimed: true }))[0].reasons).toEqual([R.HINTED, R.REVEALED, R.PRIMED]);
  });
  it('records every reason that applies', () => {
    const match = { intent: ASSESSMENT_INTENT.PAIRING, template: TEMPLATE.MATCH };
    expect(deriveEvidence(fact(match))[0].reasons).toEqual([R.WEAK_TEMPLATE]);
    expect(deriveEvidence(fact({ ...match, hintCount: 1, phase: TASK_PHASE.NEW_PRACTICE }))[0].reasons).toEqual([R.NEW_PRACTICE, R.WEAK_TEMPLATE, R.HINTED]);
    expect(deriveEvidence(fact({ ...audio, intent: ASSESSMENT_INTENT.SOUND_DISCRIMINATION }))[0].reasons).toEqual([R.WEAK_TEMPLATE]);
    expect(deriveEvidence(fact({ ...audio, deliveryMode: DELIVERY_MODE.FALLBACK, hintCount: 1 }))[0].reasons).toEqual([R.AUDIO_NOT_PLAYED, R.HINTED]);
  });
  it('new learning is never direct', () => {
    expect(deriveEvidence(fact({ phase: TASK_PHASE.NEW_PRACTICE }))[0].reasons).toEqual([R.NEW_PRACTICE]);
    const speech = { intent: ASSESSMENT_INTENT.PRONUNCIATION, template: TEMPLATE.RECORDING, outcome: OUTCOME.ASSESSED_PASSED };
    expect(deriveEvidence(fact({ ...speech, phase: TASK_PHASE.NEW_PRACTICE }))[0].reasons).toEqual([R.NEW_PRACTICE]);
    expect(deriveEvidence(fact(speech))[0].reasons).toEqual([]);
  });
  it('C20 invalid Azure is invalid evidence; unavailable is none', () => {
    const speech = { intent: ASSESSMENT_INTENT.PRONUNCIATION, template: TEMPLATE.RECORDING };
    expect(deriveEvidence(fact({ ...speech, outcome: OUTCOME.INVALID }))[0]).toMatchObject({ reasons: [R.INVALID_RECORDING], validity: VALIDITY.INVALID, passed: null });
    expect(deriveEvidence(fact({ ...speech, outcome: OUTCOME.UNAVAILABLE }))).toEqual([]);
  });
  it('C50 transcription gives Listening, never Writing or memory', () => {
    const [e] = deriveEvidence(fact({ ...audio, intent: ASSESSMENT_INTENT.TRANSCRIPTION, template: TEMPLATE.TYPING }));
    expect(e.skill).toBe(SKILL.LISTENING);
  });
  it('C51 unqualified flyReorder is not direct', () => {
    const fly = { intent: ASSESSMENT_INTENT.MEANING_RECALL, template: TEMPLATE.FLY_REORDER };
    expect(deriveEvidence(fact(fly))[0].reasons).toEqual([]);
    expect(deriveEvidence(fact({ ...fly, qualityQualified: false }))[0].reasons).toEqual([R.QUALITY_UNQUALIFIED]);
  });
});

describe('skill status', () => {
  it('starts notVerified, then demonstrated', () => {
    expect(deriveSkillStatus([]).status).toBe(SKILL_STATUS.NOT_VERIFIED);
    expect(deriveSkillStatus([row('a', 0, true)]).status).toBe(SKILL_STATUS.DEMONSTRATED);
  });
  it('C21 two passes in one session do not verify', () => {
    expect(deriveSkillStatus([row('a', 0, true), row('a', 48, true)]).status).toBe(SKILL_STATUS.DEMONSTRATED);
  });
  it('needs the delayed recheck', () => {
    expect(deriveSkillStatus([row('a', 0, true), row('b', 2, true)]).status).toBe(SKILL_STATUS.DEMONSTRATED);
    expect(deriveSkillStatus([row('a', 0, true), row('b', 24, true)]).status).toBe(SKILL_STATUS.VERIFIED);
  });
  it('C22 later valid failure revokes verified', () => {
    const state = deriveSkillStatus([row('a', 0, true), row('b', 24, true), row('c', 30, false)]);
    expect(state).toEqual({ status: SKILL_STATUS.DEMONSTRATED, needsPractice: true });
  });
  it('word needs every learned scope verified', () => {
    const v = SKILL_STATUS.VERIFIED;
    expect(isWordFullyVerified({ learnedMeaningCount: 0, readingWriting: [], listeningSpeaking: [] })).toBe(false);
    expect(isWordFullyVerified({ learnedMeaningCount: 1, readingWriting: [v, v], listeningSpeaking: [v, v] })).toBe(true);
    expect(isWordFullyVerified({ learnedMeaningCount: 2, readingWriting: [v, v, v, SKILL_STATUS.DEMONSTRATED], listeningSpeaking: [v, v] })).toBe(false);
  });
});
