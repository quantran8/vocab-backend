import { ASSESSMENT_INTENT, MEMORY_SIGNAL, OUTCOME } from '../../common/constants/domain';
import { addHours } from '../../common/constants/time';
import { POLICY } from '../../config/policy';
import { MemoryFact, reduceMemory } from './memory-reducer';
import { applyDailyDue, applyNonDaily, initialState, SrsState } from './srs';

const AT = new Date('2026-10-30T00:00:00Z');
const fact = (overrides: Partial<MemoryFact>): MemoryFact => ({
  taskId: 't', ordinal: 0, meaningId: 'm', intent: ASSESSMENT_INTENT.MEANING_RECOGNITION,
  outcome: OUTCOME.CORRECT, hintCount: 0, isPrimed: false, ...overrides,
});
const clean = { isPrimed: false };

describe('memory reducer', () => {
  it('C33 yields one observation per Meaning per session', () => {
    const drafts = reduceMemory([
      fact({ taskId: 'a', outcome: OUTCOME.INCORRECT }),
      fact({ taskId: 'b', outcome: OUTCOME.INCORRECT }),
      fact({ taskId: 'c', intent: ASSESSMENT_INTENT.MEANING_RECALL }),
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ signal: MEMORY_SIGNAL.UNAIDED_RECALL, sourceTaskIds: ['a', 'b', 'c'] });
  });

  it('a wrong recall is not hidden by a correct select', () => {
    const [draft] = reduceMemory([
      fact({ taskId: 'a' }),
      fact({ taskId: 'b', intent: ASSESSMENT_INTENT.MEANING_RECALL, outcome: OUTCOME.INCORRECT }),
    ]);
    expect(draft.signal).toBe(MEMORY_SIGNAL.FAILED_RECALL);
  });

  it('C15 C16 recall quality', () => {
    const recall = { intent: ASSESSMENT_INTENT.MEANING_RECALL };
    expect(reduceMemory([fact({ ...recall, outcome: OUTCOME.CORRECTED_AFTER_RETRY })])[0].signal).toBe(MEMORY_SIGNAL.FAILED_RECALL);
    expect(reduceMemory([fact({ ...recall, hintCount: 1 })])[0].signal).toBe(MEMORY_SIGNAL.ASSISTED_RECALL);
  });

  it('C35 non-semantic intents produce no signal', () => {
    const intents = [ASSESSMENT_INTENT.PRONUNCIATION, ASSESSMENT_INTENT.SOUND_DISCRIMINATION, ASSESSMENT_INTENT.SPELLING_REPAIR, ASSESSMENT_INTENT.TRANSCRIPTION];
    expect(reduceMemory(intents.map((intent) => fact({ intent })))).toEqual([]);
  });
});

describe('SRS', () => {
  const state = (overrides: Partial<SrsState> = {}): SrsState => ({
    ...initialState({ signal: MEMORY_SIGNAL.UNAIDED_RECALL, ...clean }, addHours(AT, -48)), ...overrides,
  });

  it('initial schedule depends on the first recall', () => {
    const hours = (signal: Parameters<typeof initialState>[0]) => initialState(signal, AT).intervalHours;
    expect(hours({ signal: MEMORY_SIGNAL.UNAIDED_RECALL, ...clean })).toBe(48);
    expect(hours({ signal: MEMORY_SIGNAL.ASSISTED_RECALL, ...clean })).toBe(24);
    expect(hours({ signal: MEMORY_SIGNAL.FAILED_RECALL, ...clean })).toBe(12);
  });

  it('C17 primed unaided recall gets no strong credit', () => {
    expect(initialState({ signal: MEMORY_SIGNAL.UNAIDED_RECALL, isPrimed: true }, AT).intervalHours).toBe(24);
  });

  it('grows with bounded factor and ceiling', () => {
    const next = applyDailyDue(state({ intervalHours: 48, unaidedStreak: 1 }), { signal: MEMORY_SIGNAL.UNAIDED_RECALL, ...clean }, AT);
    expect(next.intervalHours).toBeCloseTo(48 * 1.75);
    const capped = applyDailyDue(state({ intervalHours: POLICY.srs.maxIntervalHours, unaidedStreak: 99 }), { signal: MEMORY_SIGNAL.UNAIDED_RECALL, ...clean }, AT);
    expect(capped.intervalHours).toBe(POLICY.srs.maxIntervalHours);
  });

  it('C23 recognition grace applies once, then due stays', () => {
    const due = state({ nextReviewAt: AT });
    const first = applyDailyDue(due, { signal: MEMORY_SIGNAL.RECOGNITION_SUCCESS, ...clean }, AT);
    expect(first).toMatchObject({ recognitionGraceUsed: true, nextReviewAt: addHours(AT, 24), intervalHours: due.intervalHours });
    const later = addHours(AT, 24);
    const second = applyDailyDue(first, { signal: MEMORY_SIGNAL.RECOGNITION_SUCCESS, ...clean }, later);
    expect(second.nextReviewAt).toEqual(first.nextReviewAt);
  });

  it('failed recognition only pulls due earlier', () => {
    const near = addHours(AT, 2);
    expect(applyDailyDue(state({ nextReviewAt: near }), { signal: MEMORY_SIGNAL.FAILED_RECOGNITION, ...clean }, AT).nextReviewAt).toEqual(near);
  });

  it('C24 non-Daily success never extends, failure pulls closer', () => {
    const far = addHours(AT, 500);
    const base = state({ nextReviewAt: far });
    expect(applyNonDaily(base, { signal: MEMORY_SIGNAL.UNAIDED_RECALL, ...clean }, AT).nextReviewAt).toEqual(far);
    expect(applyNonDaily(base, { signal: MEMORY_SIGNAL.FAILED_RECALL, ...clean }, AT).nextReviewAt).toEqual(addHours(AT, 24));
  });
});
