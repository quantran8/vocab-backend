import { ASSESSMENT_INTENT, MEMORY_SIGNAL, OUTCOME } from '../../common/constants/domain';
import { addHours } from '../../common/constants/time';
import { POLICY } from '../../config/policy';
import { MemoryFact, reduceMemory } from './memory-reducer';
import { applyDailyDue, applyNonDaily, initialState, SrsState } from './srs';

const AT = new Date('2026-10-30T00:00:00Z');
const fact = (overrides: Partial<MemoryFact>): MemoryFact => ({
  taskId: 't', ordinal: 0, meaningId: 'm', intent: ASSESSMENT_INTENT.meaningRecognition,
  outcome: OUTCOME.correct, hintCount: 0, isPrimed: false, ...overrides,
});
const clean = { isPrimed: false };

describe('memory reducer', () => {
  it('C33 yields one observation per Meaning per session', () => {
    const drafts = reduceMemory([
      fact({ taskId: 'a', outcome: OUTCOME.incorrect }),
      fact({ taskId: 'b', outcome: OUTCOME.incorrect }),
      fact({ taskId: 'c', intent: ASSESSMENT_INTENT.meaningRecall }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ signal: MEMORY_SIGNAL.unaidedRecall, sourceTaskIds: ['a', 'b', 'c'] });
  });

  it('a wrong recall is not hidden by a correct select', () => {
    const [draft] = reduceMemory([
      fact({ taskId: 'a' }),
      fact({ taskId: 'b', intent: ASSESSMENT_INTENT.meaningRecall, outcome: OUTCOME.incorrect }),
    ]);
    expect(draft.signal).toBe(MEMORY_SIGNAL.failedRecall);
  });

  it('C15 C16 recall quality', () => {
    const recall = { intent: ASSESSMENT_INTENT.meaningRecall };
    expect(reduceMemory([fact({ ...recall, outcome: OUTCOME.correctedAfterRetry })])[0].signal).toBe(MEMORY_SIGNAL.failedRecall);
    expect(reduceMemory([fact({ ...recall, hintCount: 1 })])[0].signal).toBe(MEMORY_SIGNAL.assistedRecall);
  });

  it('C35 non-semantic intents produce no signal', () => {
    const intents = [ASSESSMENT_INTENT.pronunciation, ASSESSMENT_INTENT.soundDiscrimination, ASSESSMENT_INTENT.spellingRepair, ASSESSMENT_INTENT.transcription];
    expect(reduceMemory(intents.map((intent) => fact({ intent })))).toEqual([]);
  });
});

describe('SRS', () => {
  const state = (overrides: Partial<SrsState> = {}): SrsState => ({
    ...initialState({ signal: MEMORY_SIGNAL.unaidedRecall, ...clean }, addHours(AT, -48)), ...overrides,
  });

  it('initial schedule depends on the first recall', () => {
    const hours = (signal: Parameters<typeof initialState>[0]) => initialState(signal, AT).intervalHours;
    expect(hours({ signal: MEMORY_SIGNAL.unaidedRecall, ...clean })).toBe(48);
    expect(hours({ signal: MEMORY_SIGNAL.assistedRecall, ...clean })).toBe(24);
    expect(hours({ signal: MEMORY_SIGNAL.failedRecall, ...clean })).toBe(12);
  });

  it('C17 primed unaided recall gets no strong credit', () => {
    expect(initialState({ signal: MEMORY_SIGNAL.unaidedRecall, isPrimed: true }, AT).intervalHours).toBe(24);
  });

  it('grows with bounded factor and ceiling', () => {
    const next = applyDailyDue(state({ intervalHours: 48, unaidedStreak: 1 }), { signal: MEMORY_SIGNAL.unaidedRecall, ...clean }, AT);
    expect(next.intervalHours).toBeCloseTo(48 * 1.75);
    const capped = applyDailyDue(state({ intervalHours: POLICY.srs.maxIntervalHours, unaidedStreak: 99 }), { signal: MEMORY_SIGNAL.unaidedRecall, ...clean }, AT);
    expect(capped.intervalHours).toBe(POLICY.srs.maxIntervalHours);
  });

  it('C23 recognition grace applies once, then due stays', () => {
    const due = state({ nextReviewAt: AT });
    const first = applyDailyDue(due, { signal: MEMORY_SIGNAL.recognitionSuccess, ...clean }, AT);
    expect(first).toMatchObject({ recognitionGraceUsed: true, nextReviewAt: addHours(AT, 24), intervalHours: due.intervalHours });
    const later = addHours(AT, 24);
    const second = applyDailyDue(first, { signal: MEMORY_SIGNAL.recognitionSuccess, ...clean }, later);
    expect(second.nextReviewAt).toEqual(first.nextReviewAt);
  });

  it('failed recognition only pulls due earlier', () => {
    const near = addHours(AT, 2);
    expect(applyDailyDue(state({ nextReviewAt: near }), { signal: MEMORY_SIGNAL.failedRecognition, ...clean }, AT).nextReviewAt).toEqual(near);
  });

  it('C24 non-Daily success never extends, failure pulls closer', () => {
    const far = addHours(AT, 500);
    const base = state({ nextReviewAt: far });
    expect(applyNonDaily(base, { signal: MEMORY_SIGNAL.unaidedRecall, ...clean }, AT).nextReviewAt).toEqual(far);
    expect(applyNonDaily(base, { signal: MEMORY_SIGNAL.failedRecall, ...clean }, AT).nextReviewAt).toEqual(addHours(AT, 24));
  });
});
