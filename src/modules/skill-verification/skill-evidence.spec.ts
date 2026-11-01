import { ASSESSMENT_INTENT, DELIVERY_MODE, DIRECTNESS, OUTCOME, SKILL, SKILL_STATUS, TASK_PHASE, TEMPLATE, VALIDITY } from '../../common/constants/domain';
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
    expect(deriveEvidence(fact({}))).toEqual([expect.objectContaining({ skill: SKILL.READING, directness: DIRECTNESS.DIRECT, meaningId: 'm', pronunciationId: null })]);
  });
  it('C45 select(audio) gives direct Listening on the Pronunciation', () => {
    expect(deriveEvidence(fact(audio))).toEqual([expect.objectContaining({ skill: SKILL.LISTENING, directness: DIRECTNESS.DIRECT, passed: true, pronunciationId: 'p' })]);
  });
  it('C19 fallback is neither direct nor a failure', () => {
    expect(deriveEvidence(fact({ ...audio, deliveryMode: DELIVERY_MODE.FALLBACK, outcome: OUTCOME.INCORRECT }))).toEqual([
      expect.objectContaining({ directness: DIRECTNESS.SUPPORTING, validity: VALIDITY.INVALID, passed: null }),
    ]);
  });
  it('C46 localized audio gives no Listening', () => {
    const [e] = deriveEvidence(fact({ intent: ASSESSMENT_INTENT.MEANING_RECALL, template: TEMPLATE.TYPING, deliveryMode: DELIVERY_MODE.AUDIO }));
    expect(e.skill).toBe(SKILL.WRITING);
  });
  it('C16 hint downgrades to supporting', () => {
    expect(deriveEvidence(fact({ hintCount: 1 }))[0].directness).toBe(DIRECTNESS.SUPPORTING);
  });
  it('new learning stays supporting', () => {
    expect(deriveEvidence(fact({ phase: TASK_PHASE.NEW_PRACTICE }))[0].directness).toBe(DIRECTNESS.SUPPORTING);
  });
  it('C20 invalid Azure is invalid evidence; unavailable is none', () => {
    const speech = { intent: ASSESSMENT_INTENT.PRONUNCIATION, template: TEMPLATE.RECORDING };
    expect(deriveEvidence(fact({ ...speech, outcome: OUTCOME.INVALID }))[0]).toMatchObject({ validity: VALIDITY.INVALID, passed: null });
    expect(deriveEvidence(fact({ ...speech, outcome: OUTCOME.UNAVAILABLE }))).toEqual([]);
  });
  it('C50 transcription gives Listening, never Writing or memory', () => {
    const [e] = deriveEvidence(fact({ ...audio, intent: ASSESSMENT_INTENT.TRANSCRIPTION, template: TEMPLATE.TYPING }));
    expect(e.skill).toBe(SKILL.LISTENING);
  });
  it('C51 unqualified flyReorder is supporting', () => {
    const fly = { intent: ASSESSMENT_INTENT.MEANING_RECALL, template: TEMPLATE.FLY_REORDER };
    expect(deriveEvidence(fact(fly))[0].directness).toBe(DIRECTNESS.DIRECT);
    expect(deriveEvidence(fact({ ...fly, qualityQualified: false }))[0].directness).toBe(DIRECTNESS.SUPPORTING);
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
