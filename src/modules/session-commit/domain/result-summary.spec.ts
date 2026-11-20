import {
  ASSESSMENT_INTENT, AssessmentIntent, DELIVERY_MODE, FSRS_GRADE, FsrsGrade, MEMORY_SIGNAL, MemorySignal, OUTCOME, Outcome,
  Skill, SPEAKING_CHANGE, SPEAKING_METHOD, SPEAKING_STATUS, TASK_PHASE, TaskPhase,
} from '../../../common/constants/domain';
import { addHours } from '../../../common/constants/time';
import { SrsState } from '../../memory-srs/fsrs';
import { EvaluatedTask, LearnStepRow, TargetRow } from './commit-evaluator';
import { countedAsReview, Labels, newWordSummary, planOrder, practiceSummary, reviewSummary, speakingSummary } from './result-summary';

const NOW = new Date('2026-11-13T12:00:00Z');
const labels = new Labels(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
  meaningId: id, wordId: `w-${id}`, lemma: `lemma-${id}`, gloss: `gloss-${id}`, pronunciationIds: [`p-${id}`],
})));

const state = (nextReviewAt: Date): SrsState => ({
  learnedAt: addHours(NOW, -24 * 10), lastReviewedAt: null, nextReviewAt, stability: 2, difficulty: 5, lapseCount: 0,
});
const gradeOf = (signal: MemorySignal, isPrimed: boolean): FsrsGrade => {
  if (signal === MEMORY_SIGNAL.FAILED_RECALL || signal === MEMORY_SIGNAL.FAILED_RECOGNITION) return FSRS_GRADE.AGAIN;
  return signal === MEMORY_SIGNAL.ASSISTED_RECALL || isPrimed ? FSRS_GRADE.HARD : FSRS_GRADE.GOOD;
};
const draft = (meaningId: string, signal: MemorySignal, isPrimed = false, grade = gradeOf(signal, isPrimed)) =>
  ({ meaningId, signal, isPrimed, sourceTaskIds: [], grade, weight: 1 });

describe('reviewSummary', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const progress = new Map(ids.map((id) => [id, state(NOW)]));
  const newStates = new Map(ids.map((id) => [id, state(addHours(NOW, 72))]));
  const order = (list: Iterable<string>) => [...list].sort();

  // One answer per word, matching the drafts below.
  const answers = tasks([
    { id: 'ta', ordinal: 1, outcome: OUTCOME.CORRECT, target: { meaningId: 'a' } },
    { id: 'tb', ordinal: 2, outcome: OUTCOME.CORRECT, target: { meaningId: 'b' } },
    { id: 'tc', ordinal: 3, outcome: OUTCOME.CORRECTED_AFTER_RETRY, attempts: 2, target: { meaningId: 'c' } },
    { id: 'td', ordinal: 4, intent: ASSESSMENT_INTENT.MEANING_RECOGNITION, outcome: OUTCOME.CORRECT, target: { meaningId: 'd' } },
    { id: 'te', ordinal: 5, outcome: OUTCOME.REVEALED, target: { meaningId: 'e' } },
    { id: 'tf', ordinal: 6, intent: ASSESSMENT_INTENT.MEANING_RECOGNITION, audio: true, outcome: OUTCOME.INCORRECT, target: { meaningId: 'f' } },
  ]);
  const base = { progress, newStates, labels, order, counted: answers.evaluated, targets: answers.targets };

  it('groups by correctness, and never counts a word learned in this session', () => {
    const memory = [
      draft('a', MEMORY_SIGNAL.UNAIDED_RECALL),
      draft('b', MEMORY_SIGNAL.UNAIDED_RECALL, true),
      draft('c', MEMORY_SIGNAL.ASSISTED_RECALL),
      draft('d', MEMORY_SIGNAL.RECOGNITION_SUCCESS),
      draft('e', MEMORY_SIGNAL.FAILED_RECALL),
      draft('f', MEMORY_SIGNAL.FAILED_RECOGNITION),
    ];
    const summary = reviewSummary({ ...base, memory, learnedHere: new Set() });
    expect(summary.total).toBe(6);
    // A clean select is remembered: weight only moves the schedule.
    expect(summary.groups.solid.map((i) => i.meaningId)).toEqual(['a', 'd']);
    expect(summary.groups.shaky.map((i) => i.meaningId)).toEqual(['b', 'c']);
    expect(summary.groups.relearn.map((i) => i.meaningId)).toEqual(['e', 'f']);
    expect(summary.groups.solid[0]).toEqual({
      meaningId: 'a', wordId: 'w-a', lemma: 'lemma-a', gloss: 'gloss-a',
      nextReviewAt: addHours(NOW, 72).toISOString(), learnedAt: addHours(NOW, -240).toISOString(),
    });

    const fresh = reviewSummary({ ...base, memory, learnedHere: new Set(['a']) });
    expect(fresh.total).toBe(5);
    expect(fresh.groups.solid.map((i) => i.meaningId)).toEqual(['d']);

    // Each weaker word says why, from the answer that decided it.
    const causes = [...summary.groups.shaky, ...summary.groups.relearn].map((i) => [i.meaningId, i.cause, i.struggledAt]);
    expect(causes).toEqual([
      ['b', 'primed', undefined],
      ['c', 'retried', 'spelling'],
      ['e', 'revealed', 'spelling'],
      ['f', 'wrong_choice', 'listening'],
    ]);
  });

  it('a hint is the cause only when it decided the group', () => {
    const hinted = tasks([
      { id: 't1', ordinal: 1, outcome: OUTCOME.CORRECT, hints: 1, target: { meaningId: 'a' } },
      { id: 't2', ordinal: 2, intent: ASSESSMENT_INTENT.MEANING_RECOGNITION, outcome: OUTCOME.INCORRECT, target: { meaningId: 'a' } },
    ]);
    const summary = reviewSummary({
      ...base, counted: hinted.evaluated, targets: hinted.targets, learnedHere: new Set(), memory: [draft('a', MEMORY_SIGNAL.ASSISTED_RECALL)],
    });
    // The wrong recognition did not decide the group (assisted recall outranks it), so it is not shown.
    expect(summary.groups.shaky[0]).toMatchObject({ cause: 'hinted', struggledAt: 'spelling' });
  });

  it('a clean recall after a wrong pick is shaky, and the pick is why', () => {
    const mixed = tasks([
      { id: 't1', ordinal: 1, intent: ASSESSMENT_INTENT.MEANING_RECOGNITION, outcome: OUTCOME.INCORRECT, target: { meaningId: 'a' } },
      { id: 't2', ordinal: 2, outcome: OUTCOME.CORRECT, target: { meaningId: 'a' } },
    ]);
    const summary = reviewSummary({
      ...base, counted: mixed.evaluated, targets: mixed.targets, learnedHere: new Set(),
      memory: [draft('a', MEMORY_SIGNAL.UNAIDED_RECALL, false, FSRS_GRADE.HARD)],
    });
    expect(summary.groups.shaky[0]).toMatchObject({ meaningId: 'a', cause: 'wrong_choice' });
  });

  it('leaves out a due word whose tasks gave no memory signal', () => {
    const summary = reviewSummary({ ...base, memory: [], learnedHere: new Set() });
    expect(summary).toEqual({ total: 0, groups: { solid: [], shaky: [], relearn: [] } });
  });
});

type Spec = {
  id: string; ordinal: number; phase?: TaskPhase; intent?: AssessmentIntent; audio?: boolean; primed?: boolean;
  outcome: Outcome; hints?: number; attempts?: number; target?: Partial<TargetRow>;
};

function tasks(specs: Spec[]) {
  const evaluated = specs.map((s): EvaluatedTask => ({
    task: {
      id: s.id, ordinal: s.ordinal, phase: s.phase ?? TASK_PHASE.NEW_PRACTICE, template: 'typing', variant: null, curatedItemId: null,
      clientPayload: {}, evaluatorVersion: 'v1',
      serverEvaluation: { intent: s.intent ?? ASSESSMENT_INTENT.MEANING_RECALL, promptIsTargetAudio: s.audio ?? false, isPrimed: s.primed ?? false, qualityQualified: true },
    },
    rawEvents: [],
    deliveryMode: DELIVERY_MODE.NONE,
    targets: [{ ordinal: 0, outcome: s.outcome, firstAttemptCorrect: s.outcome === OUTCOME.CORRECT, attemptCount: s.attempts ?? 1, hintCount: s.hints ?? 0 }],
  }));
  const targets = specs.map((s): TargetRow => ({ taskId: s.id, ordinal: 0, meaningId: 'a', pronunciationId: null, ...s.target }));
  return { evaluated, targets };
}

const step = (meaningId: string): LearnStepRow => ({ id: `step-${meaningId}`, meaningId, firstRecallTaskId: `first-${meaningId}` });

describe('newWordSummary', () => {
  const run = (specs: Spec[], known = new Set<string>(), steps = [step('a')]) => {
    const { evaluated, targets } = tasks(specs);
    return newWordSummary({ steps, counted: evaluated, targets, known, newStates: new Map(), labels });
  };
  const groupOf = (summary: ReturnType<typeof run>) =>
    Object.entries(summary.groups).flatMap(([group, items]) => items.map((i) => {
      const { struggledAt, cause } = i as { struggledAt?: Skill; cause?: string };
      return { group, struggledAt, ...(cause && { cause }) };
    }));

  it('every task right and unhinted: picked up right away', () => {
    expect(groupOf(run([{ id: '1', ordinal: 1, outcome: OUTCOME.CORRECT }]))).toEqual([{ group: 'smooth', struggledAt: undefined }]);
  });

  it('a hint without a retry, or a retry, needed a retry', () => {
    expect(groupOf(run([{ id: '1', ordinal: 1, outcome: OUTCOME.CORRECT, hints: 1 }]))).toEqual([{ group: 'retried', struggledAt: 'spelling', cause: 'hinted' }]);
    expect(groupOf(run([{ id: '1', ordinal: 1, outcome: OUTCOME.CORRECTED_AFTER_RETRY }]))).toEqual([{ group: 'retried', struggledAt: 'spelling', cause: 'retried' }]);
  });

  it('a reveal, or running out of tries, saw the answer', () => {
    expect(groupOf(run([{ id: '1', ordinal: 1, outcome: OUTCOME.REVEALED }]))[0]).toMatchObject({ group: 'revealed', cause: 'revealed' });
    expect(groupOf(run([{ id: '1', ordinal: 1, outcome: OUTCOME.INCORRECT }]))[0]).toMatchObject({ group: 'revealed', cause: 'out_of_tries' });
  });

  it('a recording the learner could not do does not lower the group', () => {
    const summary = run([
      { id: '1', ordinal: 1, outcome: OUTCOME.CORRECT },
      { id: '2', ordinal: 2, intent: ASSESSMENT_INTENT.PRONUNCIATION, outcome: OUTCOME.UNAVAILABLE, target: { meaningId: null, pronunciationId: 'p-a' } },
    ]);
    expect(groupOf(summary)).toEqual([{ group: 'smooth', struggledAt: undefined }]);
  });

  it('a failed recording does not lower the group: speaking in Daily is opt-in practice', () => {
    const summary = run([
      { id: '1', ordinal: 1, outcome: OUTCOME.CORRECT },
      { id: '2', ordinal: 2, intent: ASSESSMENT_INTENT.PRONUNCIATION, outcome: OUTCOME.ASSESSED_FAILED, target: { meaningId: null, pronunciationId: 'p-a' } },
    ]);
    expect(groupOf(summary)).toEqual([{ group: 'smooth', struggledAt: undefined }]);
  });

  it('struggledAt is the worst task, the earlier one on a tie', () => {
    const summary = run([
      { id: '1', ordinal: 1, intent: ASSESSMENT_INTENT.MEANING_RECOGNITION, audio: true, outcome: OUTCOME.CORRECT, hints: 1 },
      { id: '2', ordinal: 2, intent: ASSESSMENT_INTENT.MEANING_RECOGNITION, outcome: OUTCOME.REVEALED },
      { id: '3', ordinal: 3, outcome: OUTCOME.INCORRECT },
    ]);
    // A text recognition trains no form skill, so nothing is named.
    expect(groupOf(summary)).toEqual([{ group: 'revealed', cause: 'revealed' }]);
  });

  it('a known word skips everything else and stays out of the total', () => {
    const summary = run([{ id: '1', ordinal: 1, outcome: OUTCOME.REVEALED }], new Set(['a']), [step('a'), step('b')]);
    expect(summary.total).toBe(1);
    expect(summary.groups.known.map((i) => i.meaningId)).toEqual(['a']);
    expect(summary.groups.smooth.map((i) => i.meaningId)).toEqual(['b']);
  });

  it('ignores review tasks', () => {
    expect(groupOf(run([{ id: '1', ordinal: 1, phase: TASK_PHASE.DUE_REVIEW, outcome: OUTCOME.REVEALED }]))[0].group).toBe('smooth');
  });
});

describe('practiceSummary', () => {
  it('sorts each answered target into clean, helped and missed, and counts what says nothing about the learner', () => {
    const recording = { intent: ASSESSMENT_INTENT.PRONUNCIATION };
    const { evaluated, targets } = tasks([
      { id: '1', ordinal: 1, outcome: OUTCOME.CORRECT, target: { meaningId: 'a' } },
      { id: '2', ordinal: 2, outcome: OUTCOME.CORRECT, hints: 1, target: { meaningId: 'b' } },
      { id: '3', ordinal: 3, outcome: OUTCOME.CORRECT, primed: true, target: { meaningId: 'c' } },
      { id: '4', ordinal: 4, outcome: OUTCOME.CORRECTED_AFTER_RETRY, attempts: 2, target: { meaningId: 'd' } },
      { id: '5', ordinal: 5, outcome: OUTCOME.INCORRECT, target: { meaningId: 'e' } },
      { id: '6', ordinal: 6, outcome: OUTCOME.REVEALED, target: { meaningId: 'f' } },
      { id: '7', ordinal: 7, ...recording, outcome: OUTCOME.ASSESSED_PASSED, target: { meaningId: null, pronunciationId: 'p-a' } },
      { id: '8', ordinal: 8, ...recording, outcome: OUTCOME.ASSESSED_FAILED, target: { meaningId: null, pronunciationId: 'p-b' } },
      { id: '9', ordinal: 9, ...recording, outcome: OUTCOME.INVALID, target: { meaningId: null, pronunciationId: 'p-c' } },
      { id: '10', ordinal: 10, ...recording, outcome: OUTCOME.UNAVAILABLE, target: { meaningId: null, pronunciationId: 'p-d' } },
    ]);
    const summary = practiceSummary({ counted: evaluated, targets, labels, sessionMeanings: new Set() });
    expect(summary.groups.clean.map((i) => [i.meaningId, i.skill])).toEqual([['a', 'spelling'], ['a', 'speaking']]);
    expect(summary.groups.helped.map((i) => i.meaningId)).toEqual(['b', 'c', 'd']);
    expect(summary.groups.missed.map((i) => i.meaningId)).toEqual(['e', 'f', 'b']);
    expect(summary.total).toBe(8);
    expect(summary.excluded).toEqual({ count: 2, reasons: ['invalid_recording', 'unavailable'] });
    expect(summary.groups.clean[0]).toEqual({ meaningId: 'a', wordId: 'w-a', lemma: 'lemma-a', gloss: 'gloss-a', skill: 'spelling' });
  });

  it('a text recognition names no skill', () => {
    const { evaluated, targets } = tasks([{ id: '1', ordinal: 1, intent: ASSESSMENT_INTENT.MEANING_RECOGNITION, outcome: OUTCOME.CORRECT }]);
    expect(practiceSummary({ counted: evaluated, targets, labels, sessionMeanings: new Set() }).groups.clean[0].skill).toBeNull();
  });
});

describe('speakingSummary', () => {
  const device = (id: string, passed: boolean) => ({ pronunciationId: `p-${id}`, method: SPEAKING_METHOD.DEVICE, passed });

  it('is null when no recording was scored', () => {
    expect(speakingSummary({ outcomes: [], labels, sessionMeanings: new Set() })).toBeNull();
  });

  it('counts results and lists the words that changed status', () => {
    const summary = speakingSummary({
      outcomes: [
        { result: device('a', true), status: SPEAKING_STATUS.FLUENT, change: SPEAKING_CHANGE.BECAME_FLUENT },
        { result: device('b', false), status: SPEAKING_STATUS.PRACTICING, change: SPEAKING_CHANGE.SLIPPED },
        { result: { pronunciationId: 'p-c', method: SPEAKING_METHOD.AZURE, passed: true, score: 91 }, status: SPEAKING_STATUS.FLUENT, change: SPEAKING_CHANGE.BECAME_FLUENT },
        { result: device('d', true), status: SPEAKING_STATUS.PRACTICING, change: null },
      ],
      labels,
      sessionMeanings: new Set(),
    });
    expect(summary).toEqual({
      total: 4,
      passed: 3,
      becameFluent: [
        { meaningId: 'a', wordId: 'w-a', lemma: 'lemma-a', gloss: 'gloss-a', status: 'fluent', score: null },
        { meaningId: 'c', wordId: 'w-c', lemma: 'lemma-c', gloss: 'gloss-c', status: 'fluent', score: 91 },
      ],
      slipped: [{ meaningId: 'b', wordId: 'w-b', lemma: 'lemma-b', gloss: 'gloss-b', status: 'practicing', score: null }],
    });
  });
});

describe('countedAsReview', () => {
  const order = (ids: Iterable<string>) => [...ids];
  it('lists due words answered cleanly (GOOD or EASY), nothing else', () => {
    const progress = new Map([['a', state(addHours(NOW, -1))], ['b', state(addHours(NOW, 5))], ['c', state(addHours(NOW, -1))], ['d', state(addHours(NOW, -1))]]);
    const memory = [draft('a', MEMORY_SIGNAL.UNAIDED_RECALL), draft('b', MEMORY_SIGNAL.UNAIDED_RECALL), draft('c', MEMORY_SIGNAL.UNAIDED_RECALL, true), draft('d', MEMORY_SIGNAL.ASSISTED_RECALL)];
    const listed = countedAsReview({ memory, progress, newStates: new Map([['a', state(addHours(NOW, 96))]]), now: NOW, labels, order });
    expect(listed).toEqual([{ meaningId: 'a', wordId: 'w-a', lemma: 'lemma-a', gloss: 'gloss-a', nextReviewAt: addHours(NOW, 96).toISOString() }]);
  });
});

describe('planOrder', () => {
  it('orders Meanings by the first task that shows them', () => {
    const order = planOrder(
      [{ id: 't1', ordinal: 1 }, { id: 't2', ordinal: 2 }],
      [{ taskId: 't2', ordinal: 0, meaningId: 'a', pronunciationId: null }, { taskId: 't1', ordinal: 0, meaningId: 'b', pronunciationId: null }],
      [],
    );
    expect(order(['a', 'b'])).toEqual(['b', 'a']);
  });
});
