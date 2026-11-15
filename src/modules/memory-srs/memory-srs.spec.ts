import { fsrs } from 'ts-fsrs';
import { ASSESSMENT_INTENT, FSRS_GRADE, MEMORY_SIGNAL, OUTCOME, VARIANT } from '../../common/constants/domain';
import { addHours, HOURS_PER_DAY } from '../../common/constants/time';
import { POLICY } from '../../config/policy';
import { answerWeight, combineWeights, isEasyAnswer } from './evidence-weight';
import { applyReview, fsrsStep, initialState, intervalDays, knownState, retrievability, SrsState } from './fsrs';
import { MemoryFact, reduceMemory } from './memory-reducer';

const AT = new Date('2026-10-30T00:00:00Z');
const fact = (overrides: Partial<MemoryFact>): MemoryFact => ({
  taskId: 't', ordinal: 0, meaningId: 'm', intent: ASSESSMENT_INTENT.MEANING_RECOGNITION,
  outcome: OUTCOME.CORRECT, hintCount: 0, attemptCount: 1, isPrimed: false,
  variant: VARIANT.GLOSS, optionCount: 4, promptIsTargetAudio: false, firstSubmitMs: null, answerUnits: 0, ...overrides,
});
const recall = { intent: ASSESSMENT_INTENT.MEANING_RECALL, variant: VARIANT.MEANING_RECALL, optionCount: null };
const W = POLICY.memoryEvidence.weights;

describe('memory reducer', () => {
  it('C33 yields one observation per Meaning per session', () => {
    const drafts = reduceMemory([
      fact({ taskId: 'a', outcome: OUTCOME.INCORRECT }),
      fact({ taskId: 'b', outcome: OUTCOME.INCORRECT }),
      fact({ taskId: 'c', ...recall }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ signal: MEMORY_SIGNAL.UNAIDED_RECALL, sourceTaskIds: ['a', 'b', 'c'] });
  });

  it('a wrong recall is not hidden by a correct select', () => {
    const [draft] = reduceMemory([fact({ taskId: 'a' }), fact({ taskId: 'b', ...recall, outcome: OUTCOME.INCORRECT })]);
    expect(draft).toMatchObject({ signal: MEMORY_SIGNAL.FAILED_RECALL, grade: FSRS_GRADE.AGAIN });
  });

  it('C15 C16 recall quality', () => {
    const signal = (overrides: Partial<MemoryFact>) => reduceMemory([fact({ ...recall, ...overrides })])[0].signal;
    expect(signal({})).toBe(MEMORY_SIGNAL.UNAIDED_RECALL);
    expect(signal({ hintCount: 1 })).toBe(MEMORY_SIGNAL.ASSISTED_RECALL);
    const retry = { outcome: OUTCOME.CORRECTED_AFTER_RETRY };
    expect(signal({ ...retry, attemptCount: 2 })).toBe(MEMORY_SIGNAL.ASSISTED_RECALL);
    expect(signal({ ...retry, attemptCount: 2, hintCount: 1 })).toBe(MEMORY_SIGNAL.FAILED_RECALL);
    expect(signal({ ...retry, attemptCount: 3 })).toBe(MEMORY_SIGNAL.FAILED_RECALL);
    expect(signal({ outcome: OUTCOME.INCORRECT, attemptCount: 3 })).toBe(MEMORY_SIGNAL.FAILED_RECALL);
    expect(signal({ outcome: OUTCOME.REVEALED, attemptCount: 0 })).toBe(MEMORY_SIGNAL.FAILED_RECALL);
  });

  it('recognition has no light level: a hint or a retry is a failure', () => {
    const signal = (overrides: Partial<MemoryFact>) => reduceMemory([fact(overrides)])[0].signal;
    expect(signal({})).toBe(MEMORY_SIGNAL.RECOGNITION_SUCCESS);
    expect(signal({ hintCount: 1 })).toBe(MEMORY_SIGNAL.FAILED_RECOGNITION);
    expect(signal({ outcome: OUTCOME.CORRECTED_AFTER_RETRY, attemptCount: 2 })).toBe(MEMORY_SIGNAL.FAILED_RECOGNITION);
  });

  it('C35 non-semantic intents produce no signal', () => {
    const intents = [ASSESSMENT_INTENT.PRONUNCIATION, ASSESSMENT_INTENT.SOUND_DISCRIMINATION, ASSESSMENT_INTENT.SPELLING_REPAIR, ASSESSMENT_INTENT.TRANSCRIPTION];
    expect(reduceMemory(intents.map((intent) => fact({ intent })))).toEqual([]);
  });

  it('grades: a clean answer is GOOD with its weight, help is HARD, a miss is AGAIN', () => {
    const draft = (...facts: Partial<MemoryFact>[]) => reduceMemory(facts.map((f, i) => fact({ taskId: `t${i}`, ...f })))[0];
    expect(draft({})).toMatchObject({ grade: FSRS_GRADE.GOOD, weight: W.recognize });
    expect(draft({}, {}, {}).weight).toBeCloseTo(1 - (1 - W.recognize) ** 3);
    expect(draft(recall)).toMatchObject({ grade: FSRS_GRADE.GOOD, weight: 1 });
    expect(draft({ ...recall, hintCount: 1 })).toMatchObject({ grade: FSRS_GRADE.HARD, weight: 1 });
    expect(draft({ ...recall, isPrimed: true })).toMatchObject({ grade: FSRS_GRADE.HARD });
    expect(draft({ outcome: OUTCOME.INCORRECT })).toMatchObject({ grade: FSRS_GRADE.AGAIN, weight: 1 });
    // A recall outranks a wrong pick, but the miss keeps doubt.
    expect(draft({ outcome: OUTCOME.INCORRECT }, recall)).toMatchObject({ signal: MEMORY_SIGNAL.UNAIDED_RECALL, grade: FSRS_GRADE.HARD });
    // The last match pair has one choice left: no evidence, no review.
    expect(draft({ variant: VARIANT.MEANING_PAIRS, optionCount: 1 })).toMatchObject({ grade: null, weight: 0 });
  });

  it('Easy needs a fast, clean recall', () => {
    const grade = (overrides: Partial<MemoryFact>) => reduceMemory([fact({ ...recall, answerUnits: 5, ...overrides })])[0].grade;
    expect(grade({ firstSubmitMs: 2_000 })).toBe(FSRS_GRADE.EASY);
    expect(grade({ firstSubmitMs: 60_000 })).toBe(FSRS_GRADE.GOOD);
    expect(grade({ firstSubmitMs: null })).toBe(FSRS_GRADE.GOOD);
    expect(grade({ firstSubmitMs: 2_000, isPrimed: true })).toBe(FSRS_GRADE.HARD);
    expect(reduceMemory([fact({ firstSubmitMs: 500 })])[0].grade).toBe(FSRS_GRADE.GOOD);
  });
});

describe('evidence weight', () => {
  const shape = { optionCount: 4, promptIsTargetAudio: false };

  it('classes share a weight; match is a select', () => {
    expect(answerWeight({ ...shape, variant: VARIANT.GLOSS })).toBe(W.recognize);
    expect(answerWeight({ ...shape, variant: VARIANT.MEANING_PAIRS })).toBe(W.recognize);
    expect(answerWeight({ ...shape, variant: VARIANT.SINGLE_BLANK })).toBe(W.recognize_context);
    expect(answerWeight({ ...shape, variant: VARIANT.SPELLING_RECALL, optionCount: null })).toBe(W.recall_assembled);
    expect(answerWeight({ ...shape, variant: VARIANT.MEANING_RECALL, optionCount: null })).toBe(1);
    expect(answerWeight({ ...shape, variant: VARIANT.SCRIPTED_PRONUNCIATION })).toBe(0);
  });

  it('fewer choices are easier to guess', () => {
    expect(answerWeight({ ...shape, variant: VARIANT.GLOSS, optionCount: 2 })).toBeCloseTo(W.recognize * (0.5 / 0.75));
    expect(answerWeight({ ...shape, variant: VARIANT.GLOSS, optionCount: 1 })).toBe(0);
  });

  it('an audio prompt is harder, capped at the next class up', () => {
    expect(answerWeight({ ...shape, variant: VARIANT.GLOSS, promptIsTargetAudio: true })).toBeCloseTo(W.recognize * POLICY.memoryEvidence.audioFactor);
    expect(answerWeight({ ...shape, variant: VARIANT.SINGLE_BLANK, promptIsTargetAudio: true })).toBeCloseTo(W.recognize_context * POLICY.memoryEvidence.audioFactor);
    expect(answerWeight({ ...shape, variant: VARIANT.MEANING_RECALL, optionCount: null, promptIsTargetAudio: true })).toBe(1);
  });

  it('combines as independent evidence', () => {
    expect(combineWeights([])).toBe(0);
    expect(combineWeights([0.3, 0.7])).toBeCloseTo(0.79);
    expect(combineWeights([1, 0.3])).toBe(1);
  });

  it('Easy only for recall classes within the threshold', () => {
    expect(isEasyAnswer(VARIANT.GLOSS, 100, 0)).toBe(false);
    expect(isEasyAnswer(VARIANT.MEANING_RECALL, null, 5)).toBe(false);
    const { baseMs, perUnitMs } = POLICY.memoryEvidence.easy.recall_produce;
    expect(isEasyAnswer(VARIANT.MEANING_RECALL, baseMs + perUnitMs * 5, 5)).toBe(true);
    expect(isEasyAnswer(VARIANT.MEANING_RECALL, baseMs + perUnitMs * 5 + 1, 5)).toBe(false);
  });
});

describe('FSRS', () => {
  const reference = fsrs().model.algorithm;
  const days = (state: SrsState) => (state.nextReviewAt.getTime() - AT.getTime()) / (HOURS_PER_DAY * 3_600_000);
  const reviewed = (stability: number, difficulty: number, elapsedDays: number): SrsState => ({
    learnedAt: addHours(AT, -elapsedDays * 24), lastReviewedAt: addHours(AT, -elapsedDays * 24), nextReviewAt: AT, stability, difficulty, lapseCount: 0,
  });

  it('matches ts-fsrs for full-weight grades', () => {
    for (const [s, d, t] of [[3, 5, 3], [20, 7, 30], [1, 2, 0], [60, 9, 90]]) {
      for (const g of [1, 2, 3, 4]) {
        const ours = fsrsStep({ stability: s, difficulty: d }, t, g);
        const theirs = reference.next_state({ stability: s, difficulty: d }, t, g);
        expect(ours.stability).toBeCloseTo(theirs.stability, 4);
        expect(ours.difficulty).toBeCloseTo(theirs.difficulty, 4);
      }
    }
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 6);
    expect(intervalDays(10)).toBeCloseTo(10, 6);
  });

  it('first state: a weak success starts between Hard and Good', () => {
    const good = initialState({ grade: FSRS_GRADE.GOOD, weight: 1 }, AT);
    const weak = initialState({ grade: FSRS_GRADE.GOOD, weight: 0.3 }, AT);
    const hard = initialState({ grade: FSRS_GRADE.HARD, weight: 1 }, AT);
    expect(good.stability).toBeCloseTo(POLICY.fsrs.w[2]);
    expect(weak.stability).toBeGreaterThan(hard.stability);
    expect(weak.stability).toBeLessThan(good.stability);
    expect(initialState(undefined, AT).stability).toBeCloseTo(POLICY.fsrs.w[0]);
    expect(knownState(AT).stability).toBe(POLICY.fsrs.knownInitialDays);
  });

  it('success stability grows with the evidence weight', () => {
    const due = reviewed(5, 5, 5);
    const at = (weight: number) => applyReview(due, { grade: FSRS_GRADE.GOOD, weight }, AT).stability;
    expect(at(0.3)).toBeGreaterThan(5);
    expect(at(0.3)).toBeLessThan(at(0.7));
    expect(at(1)).toBeCloseTo(fsrsStep(due, 5, 3).stability);
    expect(applyReview(due, { grade: FSRS_GRADE.EASY, weight: 1 }, AT).stability).toBeGreaterThan(at(1));
  });

  it('an early review earns little; a failure lapses whatever the mode', () => {
    const fresh = reviewed(30, 5, 1);
    expect(applyReview(fresh, { grade: FSRS_GRADE.GOOD, weight: 1 }, AT).stability).toBeLessThan(30 * 1.2);
    const failed = applyReview(fresh, { grade: FSRS_GRADE.AGAIN, weight: 1 }, AT);
    expect(failed.stability).toBeLessThan(30);
    expect(failed.lapseCount).toBe(1);
    expect(failed.lastReviewedAt).toEqual(AT);
  });

  it('clamps the next review between the policy bounds', () => {
    expect(days(applyReview(reviewed(0.01, 5, 1), { grade: FSRS_GRADE.AGAIN, weight: 1 }, AT)) * 24).toBeCloseTo(POLICY.fsrs.minIntervalHours);
    expect(days(applyReview(reviewed(1000, 1, 1000), { grade: FSRS_GRADE.EASY, weight: 1 }, AT))).toBeCloseTo(POLICY.fsrs.maxIntervalDays);
  });
});
