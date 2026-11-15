import { ASSESSMENT_INTENT, DELIVERY_MODE, EVIDENCE_REASON as R, OUTCOME, SKILL, SKILL_ISSUE, SKILL_STATUS, TASK_PHASE, TEMPLATE, VALIDITY } from '../../common/constants/domain';
import { addHours } from '../../common/constants/time';
import { deriveEvidence, deriveSkillStatus, EvidenceRow, SkillFact, skillOf } from './skill-evidence';

const AT = new Date('2026-10-30T00:00:00Z');
const fact = (overrides: Partial<SkillFact>): SkillFact => ({
  template: TEMPLATE.SELECT, intent: ASSESSMENT_INTENT.MEANING_RECOGNITION, phase: TASK_PHASE.DUE_REVIEW,
  promptIsTargetAudio: false, qualityQualified: true, isPrimed: false, deliveryMode: DELIVERY_MODE.NONE,
  outcome: OUTCOME.CORRECT, hintCount: 0, attemptCount: 1, meaningId: 'm', pronunciationId: 'p', ...overrides,
});
const audio = { promptIsTargetAudio: true, deliveryMode: DELIVERY_MODE.AUDIO };
const typing = { intent: ASSESSMENT_INTENT.MEANING_RECALL, template: TEMPLATE.TYPING };
const row = (sessionId: string, hours: number, passed: boolean, reasons: EvidenceRow['reasons'] = []): EvidenceRow => ({ sessionId, passed, reasons, committedAt: addHours(AT, hours) });

describe('skillOf', () => {
  const cases = Object.values(ASSESSMENT_INTENT).flatMap((intent) => [false, true].map((promptIsTargetAudio) => ({ intent, promptIsTargetAudio })));

  it.each(cases)('matches the evidence for $intent audio=$promptIsTargetAudio', ({ intent, promptIsTargetAudio }) => {
    const [evidence] = deriveEvidence(fact({ intent, promptIsTargetAudio, deliveryMode: DELIVERY_MODE.AUDIO }));
    expect(skillOf(intent, promptIsTargetAudio)).toBe(evidence?.skill ?? null);
  });
});

describe('evidence mapping', () => {
  it('select(text) and match test meaning only: no skill evidence', () => {
    expect(deriveEvidence(fact({}))).toEqual([]);
    expect(deriveEvidence(fact({ intent: ASSESSMENT_INTENT.PAIRING, template: TEMPLATE.MATCH }))).toEqual([]);
  });
  it('a recall gives direct Spelling on the Meaning', () => {
    expect(deriveEvidence(fact(typing))).toEqual([expect.objectContaining({ skill: SKILL.SPELLING, reasons: [], meaningId: 'm', pronunciationId: null })]);
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
    const [e] = deriveEvidence(fact({ ...typing, deliveryMode: DELIVERY_MODE.AUDIO }));
    expect(e.skill).toBe(SKILL.SPELLING);
  });
  it('C16 each kind of help is its own reason', () => {
    expect(deriveEvidence(fact({ ...typing, hintCount: 1 }))[0].reasons).toEqual([R.HINTED]);
    expect(deriveEvidence(fact({ ...typing, hintCount: 1, outcome: OUTCOME.REVEALED, isPrimed: true }))[0].reasons).toEqual([R.HINTED, R.REVEALED, R.PRIMED]);
  });
  it('only a second-try recall without a hint is retried', () => {
    const recall = { intent: ASSESSMENT_INTENT.MEANING_RECALL, template: TEMPLATE.TYPING, outcome: OUTCOME.CORRECTED_AFTER_RETRY };
    expect(deriveEvidence(fact({ ...recall, attemptCount: 2 }))[0]).toMatchObject({ reasons: [R.RETRIED], passed: false });
    expect(deriveEvidence(fact({ ...recall, attemptCount: 3 }))[0].reasons).toEqual([]);
    expect(deriveEvidence(fact({ ...recall, attemptCount: 2, hintCount: 1 }))[0].reasons).toEqual([R.HINTED]);
    expect(deriveEvidence(fact({ ...audio, outcome: OUTCOME.CORRECTED_AFTER_RETRY, attemptCount: 2 }))[0].reasons).toEqual([]);
    expect(deriveEvidence(fact({ ...audio, intent: ASSESSMENT_INTENT.TRANSCRIPTION, template: TEMPLATE.TYPING, outcome: OUTCOME.CORRECTED_AFTER_RETRY, attemptCount: 2 }))[0].reasons).toEqual([]);
  });
  it('records every reason that applies', () => {
    const surgery = { intent: ASSESSMENT_INTENT.SPELLING_REPAIR, template: TEMPLATE.SURGERY };
    expect(deriveEvidence(fact(surgery))[0].reasons).toEqual([R.WEAK_TEMPLATE]);
    expect(deriveEvidence(fact({ ...surgery, hintCount: 1, phase: TASK_PHASE.NEW_PRACTICE }))[0].reasons).toEqual([R.NEW_PRACTICE, R.WEAK_TEMPLATE, R.HINTED]);
    expect(deriveEvidence(fact({ ...audio, intent: ASSESSMENT_INTENT.SOUND_DISCRIMINATION }))[0].reasons).toEqual([R.WEAK_TEMPLATE]);
    expect(deriveEvidence(fact({ ...audio, deliveryMode: DELIVERY_MODE.FALLBACK, hintCount: 1 }))[0].reasons).toEqual([R.AUDIO_NOT_PLAYED, R.HINTED]);
  });
  it('new learning is never direct', () => {
    expect(deriveEvidence(fact({ ...typing, phase: TASK_PHASE.NEW_PRACTICE }))[0].reasons).toEqual([R.NEW_PRACTICE]);
    const speech = { intent: ASSESSMENT_INTENT.PRONUNCIATION, template: TEMPLATE.RECORDING, outcome: OUTCOME.ASSESSED_PASSED };
    expect(deriveEvidence(fact({ ...speech, phase: TASK_PHASE.NEW_PRACTICE }))[0].reasons).toEqual([R.NEW_PRACTICE]);
    expect(deriveEvidence(fact(speech))[0].reasons).toEqual([]);
  });
  it('C20 invalid Azure is invalid evidence; unavailable is none', () => {
    const speech = { intent: ASSESSMENT_INTENT.PRONUNCIATION, template: TEMPLATE.RECORDING };
    expect(deriveEvidence(fact({ ...speech, outcome: OUTCOME.INVALID }))[0]).toMatchObject({ reasons: [R.INVALID_RECORDING], validity: VALIDITY.INVALID, passed: null });
    expect(deriveEvidence(fact({ ...speech, outcome: OUTCOME.UNAVAILABLE }))).toEqual([]);
  });
  it('C50 transcription gives Listening, never Spelling or memory', () => {
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
  it('starts notVerified, then a clean pass demonstrates it; spacing is left to FSRS', () => {
    expect(deriveSkillStatus([]).status).toBe(SKILL_STATUS.NOT_VERIFIED);
    expect(deriveSkillStatus([row('a', 0, true)]).status).toBe(SKILL_STATUS.DEMONSTRATED);
    expect(deriveSkillStatus([row('a', 0, true), row('b', 24, true)]).status).toBe(SKILL_STATUS.DEMONSTRATED);
  });
  it('C22 a later valid failure opens an issue', () => {
    expect(deriveSkillStatus([row('a', 0, true), row('c', 30, false)])).toEqual({ status: SKILL_STATUS.DEMONSTRATED, needsPractice: true, issue: SKILL_ISSUE.FAILED });
  });
  describe('issue per skill', () => {
    const passed = [row('a', 0, true)];
    it('help on a correct answer or a second try is an assisted issue', () => {
      for (const weak of [row('c', 30, true, [R.HINTED]), row('c', 30, false, [R.RETRIED])]) {
        expect(deriveSkillStatus([...passed, weak])).toEqual({ status: SKILL_STATUS.DEMONSTRATED, needsPractice: true, issue: SKILL_ISSUE.ASSISTED });
      }
    });
    it('a wrong or revealed answer is a failed issue, with or without help', () => {
      for (const reasons of [[], [R.HINTED], [R.REVEALED], [R.PRIMED]] as EvidenceRow['reasons'][]) {
        expect(deriveSkillStatus([...passed, row('c', 30, false, reasons)]).issue).toBe(SKILL_ISSUE.FAILED);
      }
    });
    it('a clean pass clears the issue only after the recovery delay', () => {
      const weak = row('c', 30, true, [R.HINTED]);
      expect(deriveSkillStatus([...passed, weak, row('d', 41, true)]).issue).toBe(SKILL_ISSUE.ASSISTED);
      expect(deriveSkillStatus([...passed, weak, row('d', 42, true)])).toMatchObject({ needsPractice: false, issue: null });
      expect(deriveSkillStatus([...passed, weak, row('d', 42, true, [R.HINTED])]).issue).toBe(SKILL_ISSUE.ASSISTED);
    });
    it('a primed success is neutral, and the worst answer in a session wins', () => {
      expect(deriveSkillStatus([...passed, row('c', 30, true, [R.PRIMED])]).issue).toBeNull();
      expect(deriveSkillStatus([row('c', 30, false), row('c', 30, true, [R.HINTED])]).issue).toBe(SKILL_ISSUE.FAILED);
    });
    it('new learning and weak templates never raise an issue', () => {
      expect(deriveSkillStatus([row('a', 0, false, [R.NEW_PRACTICE])])).toEqual({ status: SKILL_STATUS.NOT_VERIFIED, needsPractice: false, issue: null });
      expect(deriveSkillStatus([row('a', 0, false, [R.WEAK_TEMPLATE, R.HINTED])]).issue).toBeNull();
    });
  });
});
