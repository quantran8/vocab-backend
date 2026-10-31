import { ASSESSMENT_INTENT, DELIVERY_MODE, DIRECTNESS, OUTCOME, SKILL, SKILL_STATUS, TASK_PHASE, TEMPLATE, VALIDITY } from '../../common/constants/domain';
import { addHours } from '../../common/constants/time';
import { deriveEvidence, deriveSkillStatus, EvidenceRow, isWordFullyVerified, SkillFact } from './skill-evidence';

const AT = new Date('2026-10-30T00:00:00Z');
const fact = (overrides: Partial<SkillFact>): SkillFact => ({
  template: TEMPLATE.select, intent: ASSESSMENT_INTENT.meaningRecognition, phase: TASK_PHASE.dueReview,
  promptIsTargetAudio: false, qualityQualified: true, isPrimed: false, deliveryMode: DELIVERY_MODE.none,
  outcome: OUTCOME.correct, hintCount: 0, meaningId: 'm', pronunciationId: 'p', ...overrides,
});
const audio = { promptIsTargetAudio: true, deliveryMode: DELIVERY_MODE.audio };
const row = (sessionId: string, hours: number, passed: boolean): EvidenceRow => ({ sessionId, passed, committedAt: addHours(AT, hours) });

describe('evidence mapping', () => {
  it('select(text) gives direct Reading on the Meaning', () => {
    expect(deriveEvidence(fact({}))).toEqual([expect.objectContaining({ skill: SKILL.reading, directness: DIRECTNESS.direct, meaningId: 'm', pronunciationId: null })]);
  });
  it('C45 select(audio) gives direct Listening on the Pronunciation', () => {
    expect(deriveEvidence(fact(audio))).toEqual([expect.objectContaining({ skill: SKILL.listening, directness: DIRECTNESS.direct, passed: true, pronunciationId: 'p' })]);
  });
  it('C19 fallback is neither direct nor a failure', () => {
    expect(deriveEvidence(fact({ ...audio, deliveryMode: DELIVERY_MODE.fallback, outcome: OUTCOME.incorrect }))).toEqual([
      expect.objectContaining({ directness: DIRECTNESS.supporting, validity: VALIDITY.invalid, passed: null }),
    ]);
  });
  it('C46 localized audio gives no Listening', () => {
    const [e] = deriveEvidence(fact({ intent: ASSESSMENT_INTENT.meaningRecall, template: TEMPLATE.typing, deliveryMode: DELIVERY_MODE.audio }));
    expect(e.skill).toBe(SKILL.writing);
  });
  it('C16 hint downgrades to supporting', () => {
    expect(deriveEvidence(fact({ hintCount: 1 }))[0].directness).toBe(DIRECTNESS.supporting);
  });
  it('new learning stays supporting', () => {
    expect(deriveEvidence(fact({ phase: TASK_PHASE.newPractice }))[0].directness).toBe(DIRECTNESS.supporting);
  });
  it('C20 invalid Azure is invalid evidence; unavailable is none', () => {
    const speech = { intent: ASSESSMENT_INTENT.pronunciation, template: TEMPLATE.recording };
    expect(deriveEvidence(fact({ ...speech, outcome: OUTCOME.invalid }))[0]).toMatchObject({ validity: VALIDITY.invalid, passed: null });
    expect(deriveEvidence(fact({ ...speech, outcome: OUTCOME.unavailable }))).toEqual([]);
  });
  it('C50 transcription gives Listening, never Writing or memory', () => {
    const [e] = deriveEvidence(fact({ ...audio, intent: ASSESSMENT_INTENT.transcription, template: TEMPLATE.typing }));
    expect(e.skill).toBe(SKILL.listening);
  });
  it('C51 unqualified flyReorder is supporting', () => {
    const fly = { intent: ASSESSMENT_INTENT.meaningRecall, template: TEMPLATE.flyReorder };
    expect(deriveEvidence(fact(fly))[0].directness).toBe(DIRECTNESS.direct);
    expect(deriveEvidence(fact({ ...fly, qualityQualified: false }))[0].directness).toBe(DIRECTNESS.supporting);
  });
});

describe('skill status', () => {
  it('starts notVerified, then demonstrated', () => {
    expect(deriveSkillStatus([]).status).toBe(SKILL_STATUS.notVerified);
    expect(deriveSkillStatus([row('a', 0, true)]).status).toBe(SKILL_STATUS.demonstrated);
  });
  it('C21 two passes in one session do not verify', () => {
    expect(deriveSkillStatus([row('a', 0, true), row('a', 48, true)]).status).toBe(SKILL_STATUS.demonstrated);
  });
  it('needs the delayed recheck', () => {
    expect(deriveSkillStatus([row('a', 0, true), row('b', 2, true)]).status).toBe(SKILL_STATUS.demonstrated);
    expect(deriveSkillStatus([row('a', 0, true), row('b', 24, true)]).status).toBe(SKILL_STATUS.verified);
  });
  it('C22 later valid failure revokes verified', () => {
    const state = deriveSkillStatus([row('a', 0, true), row('b', 24, true), row('c', 30, false)]);
    expect(state).toEqual({ status: SKILL_STATUS.demonstrated, needsPractice: true });
  });
  it('word needs every learned scope verified', () => {
    const v = SKILL_STATUS.verified;
    expect(isWordFullyVerified({ learnedMeaningCount: 0, readingWriting: [], listeningSpeaking: [] })).toBe(false);
    expect(isWordFullyVerified({ learnedMeaningCount: 1, readingWriting: [v, v], listeningSpeaking: [v, v] })).toBe(true);
    expect(isWordFullyVerified({ learnedMeaningCount: 2, readingWriting: [v, v, v, SKILL_STATUS.demonstrated], listeningSpeaking: [v, v] })).toBe(false);
  });
});
