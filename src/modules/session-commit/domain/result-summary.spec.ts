import {
  ASSESSMENT_INTENT, AssessmentIntent, DELIVERY_MODE, EVIDENCE_REASON, EvidenceReason, MEMORY_SIGNAL, MemorySignal, OUTCOME, Outcome,
  SKILL, Skill, TASK_PHASE, TaskPhase, VALIDITY,
} from '../../../common/constants/domain';
import { addHours } from '../../../common/constants/time';
import { SrsState } from '../../memory-srs/srs';
import { EvidenceRow } from '../../skill-verification/skill-evidence';
import { EvaluatedTask, EvidenceRowDraft, LearnStepRow, TargetRow } from './commit-evaluator';
import { countedAsReview, Labels, newWordSummary, planOrder, practiceSummary, reviewSummary, skillChanges } from './result-summary';

const NOW = new Date('2026-11-13T12:00:00Z');
const labels = new Labels(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
  meaningId: id, wordId: `w-${id}`, lemma: `lemma-${id}`, gloss: `gloss-${id}`, pronunciationIds: [`p-${id}`],
})));

const state = (nextReviewAt: Date): SrsState => ({
  learnedAt: addHours(NOW, -24 * 10), lastReviewedAt: null, nextReviewAt, intervalHours: 48, unaidedStreak: 1, lapseCount: 0, recognitionGraceUsed: false,
});
const draft = (meaningId: string, signal: MemorySignal, isPrimed = false) => ({ meaningId, signal, isPrimed, sourceTaskIds: [] });

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

  it('groups by the signal SRS used, and never counts a word learned in this session', () => {
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
    expect(summary.groups.solid.map((i) => i.meaningId)).toEqual(['a']);
    expect(summary.groups.shaky.map((i) => i.meaningId)).toEqual(['b', 'c', 'd']);
    expect(summary.groups.relearn.map((i) => i.meaningId)).toEqual(['e', 'f']);
    expect(summary.groups.solid[0]).toEqual({
      meaningId: 'a', wordId: 'w-a', lemma: 'lemma-a', gloss: 'gloss-a',
      nextReviewAt: addHours(NOW, 72).toISOString(), learnedAt: addHours(NOW, -240).toISOString(),
    });

    const fresh = reviewSummary({ ...base, memory, learnedHere: new Set(['a']) });
    expect(fresh.total).toBe(5);
    expect(fresh.groups.solid).toEqual([]);

    // Each weaker word says why, from the answer that decided it.
    const causes = [...summary.groups.shaky, ...summary.groups.relearn].map((i) => [i.meaningId, i.cause, i.struggledAt]);
    expect(causes).toEqual([
      ['b', 'primed', undefined],
      ['c', 'retried', 'writing'],
      ['d', 'recognized_only', 'reading'],
      ['e', 'revealed', 'writing'],
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
    expect(summary.groups.shaky[0]).toMatchObject({ cause: 'hinted', struggledAt: 'writing' });
  });

  it('leaves out a due word whose tasks gave no memory signal', () => {
    const summary = reviewSummary({ ...base, memory: [], learnedHere: new Set() });
    expect(summary).toEqual({ total: 0, groups: { solid: [], shaky: [], relearn: [] } });
  });
});

type Spec = { id: string; ordinal: number; phase?: TaskPhase; intent?: AssessmentIntent; audio?: boolean; outcome: Outcome; hints?: number; attempts?: number; target?: Partial<TargetRow> };

function tasks(specs: Spec[]) {
  const evaluated = specs.map((s): EvaluatedTask => ({
    task: {
      id: s.id, ordinal: s.ordinal, phase: s.phase ?? TASK_PHASE.NEW_PRACTICE, template: 'typing', variant: null, curatedItemId: null,
      clientPayload: {}, evaluatorVersion: 'v1',
      serverEvaluation: { intent: s.intent ?? ASSESSMENT_INTENT.MEANING_RECALL, promptIsTargetAudio: s.audio ?? false, isPrimed: false, qualityQualified: true },
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
    expect(groupOf(run([{ id: '1', ordinal: 1, outcome: OUTCOME.CORRECT, hints: 1 }]))).toEqual([{ group: 'retried', struggledAt: 'writing', cause: 'hinted' }]);
    expect(groupOf(run([{ id: '1', ordinal: 1, outcome: OUTCOME.CORRECTED_AFTER_RETRY }]))).toEqual([{ group: 'retried', struggledAt: 'writing', cause: 'retried' }]);
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

  it('a failed recording counts against the word it says', () => {
    const summary = run([
      { id: '1', ordinal: 1, outcome: OUTCOME.CORRECT },
      { id: '2', ordinal: 2, intent: ASSESSMENT_INTENT.PRONUNCIATION, outcome: OUTCOME.ASSESSED_FAILED, target: { meaningId: null, pronunciationId: 'p-a' } },
    ]);
    expect(groupOf(summary)).toEqual([{ group: 'retried', struggledAt: 'speaking', cause: 'not_passed' }]);
  });

  it('struggledAt is the worst task, the earlier one on a tie', () => {
    const summary = run([
      { id: '1', ordinal: 1, intent: ASSESSMENT_INTENT.MEANING_RECOGNITION, audio: true, outcome: OUTCOME.CORRECT, hints: 1 },
      { id: '2', ordinal: 2, intent: ASSESSMENT_INTENT.MEANING_RECOGNITION, outcome: OUTCOME.REVEALED },
      { id: '3', ordinal: 3, outcome: OUTCOME.INCORRECT },
    ]);
    expect(groupOf(summary)).toEqual([{ group: 'revealed', struggledAt: 'reading', cause: 'revealed' }]);
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

const evidence = (taskId: string, skill: Skill, passed: boolean | null, reasons: EvidenceReason[] = [], meaningId = 'a'): EvidenceRowDraft => ({
  taskId, targetOrdinal: 0, evaluatorVersion: 'v1', skill, reasons, validity: passed === null ? VALIDITY.INVALID : VALIDITY.VALID, passed,
  meaningId: skill === SKILL.READING || skill === SKILL.WRITING ? meaningId : null,
  pronunciationId: skill === SKILL.READING || skill === SKILL.WRITING ? null : `p-${meaningId}`,
});

describe('practiceSummary', () => {
  it('sorts answers into clean, helped and missed, and counts what could not judge a skill', () => {
    const drafts = [
      evidence('1', SKILL.WRITING, true),
      evidence('2', SKILL.WRITING, true, [EVIDENCE_REASON.HINTED], 'b'),
      evidence('3', SKILL.WRITING, true, [EVIDENCE_REASON.PRIMED], 'c'),
      evidence('4', SKILL.WRITING, false, [EVIDENCE_REASON.RETRIED], 'd'),
      evidence('5', SKILL.WRITING, false, [], 'e'),
      evidence('6', SKILL.READING, false, [EVIDENCE_REASON.REVEALED], 'f'),
      evidence('7', SKILL.READING, true, [EVIDENCE_REASON.WEAK_TEMPLATE]),
      evidence('8', SKILL.SPEAKING, null, [EVIDENCE_REASON.INVALID_RECORDING]),
    ];
    const { evaluated } = tasks([
      ...['1', '2', '3', '4', '5', '6', '7', '8'].map((id, i) => ({ id, ordinal: i, outcome: OUTCOME.CORRECT })),
      { id: '9', ordinal: 9, intent: ASSESSMENT_INTENT.PRONUNCIATION, outcome: OUTCOME.UNAVAILABLE },
    ]);
    const summary = practiceSummary({ counted: evaluated, drafts, before: new Map(), labels, sessionMeanings: new Set() });
    expect(summary.groups.clean.map((i) => i.meaningId)).toEqual(['a']);
    expect(summary.groups.helped.map((i) => i.meaningId)).toEqual(['b', 'c', 'd']);
    expect(summary.groups.missed.map((i) => i.meaningId)).toEqual(['e', 'f']);
    expect(summary.total).toBe(6);
    expect(summary.excluded).toEqual({ count: 3, reasons: ['invalid_recording', 'unavailable', 'weak_template'] });
    expect(summary.groups.clean[0]).toMatchObject({ wordId: 'w-a', lemma: 'lemma-a', skill: 'writing', hadIssue: false });
  });
});

const row = (sessionId: string, hoursAgo: number, passed: boolean, reasons: EvidenceReason[] = []): EvidenceRow =>
  ({ sessionId, passed, committedAt: addHours(NOW, -hoursAgo), reasons });

describe('skillChanges', () => {
  const run = (before: EvidenceRow[], drafts: EvidenceRowDraft[]) =>
    skillChanges({ drafts, before: new Map([['writing:a', before]]), sessionId: 'now', now: NOW, labels, sessionMeanings: new Set() });
  const pass = [evidence('1', SKILL.WRITING, true)];
  const fail = [evidence('1', SKILL.WRITING, false)];

  it('a first clean pass levels up to demonstrated', () => {
    expect(run([], pass).leveledUp).toEqual([expect.objectContaining({ skill: 'writing', from: 'not_verified', to: 'demonstrated' })]);
  });

  it('a pass in a second session at least 24 h later verifies; the same day only stays demonstrated', () => {
    expect(run([row('s1', 30, true)], pass).leveledUp).toEqual([expect.objectContaining({ from: 'demonstrated', to: 'verified' })]);
    expect(run([row('s1', 3, true)], pass).leveledUp).toEqual([]);
  });

  it('a clean pass before 12 h waits to confirm; after 12 h it clears the issue', () => {
    const early = run([row('s1', 30, true), row('s2', 3, false)], pass);
    expect(early.pendingConfirm).toEqual([expect.objectContaining({ confirmableAt: addHours(NOW, 9).toISOString() })]);
    expect(early.cleared).toEqual([]);
    const late = run([row('s1', 30, true), row('s2', 13, false)], pass);
    expect(late.cleared).toHaveLength(1);
    expect(late.pendingConfirm).toEqual([]);
  });

  it('a failure on a verified skill regresses it', () => {
    const changes = run([row('s1', 60, true), row('s2', 30, true)], fail);
    expect(changes.regressed).toEqual([expect.objectContaining({ from: 'verified', to: 'demonstrated' })]);
    expect(changes.leveledUp).toEqual([]);
  });

  it('rows that cannot move a skill change nothing', () => {
    const changes = run([], [evidence('1', SKILL.WRITING, true, [EVIDENCE_REASON.WEAK_TEMPLATE])]);
    expect(Object.values(changes).flat()).toEqual([]);
  });
});

describe('countedAsReview', () => {
  const order = (ids: Iterable<string>) => [...ids];
  it('lists due words recalled unaided and unprimed, nothing else', () => {
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
