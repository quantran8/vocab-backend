import { ASSESSMENT_INTENT, DELIVERY_MODE, EVENT_ACTION, OUTCOME, Outcome, SPEAKING_METHOD, TASK_PHASE, TaskPhase, VALIDITY } from '../../../common/constants/domain';
import { addHours } from '../../../common/constants/time';
import { EvaluatedTask, SessionReceipt, speakingResults, TargetRow } from './commit-evaluator';

const NOW = new Date('2026-11-20T12:00:00Z');

type Spec = { id: string; ordinal: number; pronunciationId: string; outcome: Outcome; attempts?: number; phase?: TaskPhase; onDevice?: boolean };

function recordings(specs: Spec[]) {
  const counted = specs.map((s): EvaluatedTask => ({
    task: {
      id: s.id, ordinal: s.ordinal, phase: s.phase ?? TASK_PHASE.DUE_REVIEW, template: 'recording', variant: null, curatedItemId: null,
      clientPayload: {}, evaluatorVersion: 'v1',
      serverEvaluation: { intent: ASSESSMENT_INTENT.PRONUNCIATION, promptIsTargetAudio: false, isPrimed: false, qualityQualified: true },
    },
    rawEvents: s.onDevice === false
      ? [{ action: EVENT_ACTION.ASSESSED, assessmentReceiptId: 'r', elapsedMs: 1 }]
      : Array.from({ length: s.attempts ?? 1 }, () => ({ action: EVENT_ACTION.TRANSCRIBED, transcript: 'x', elapsedMs: 1 })),
    deliveryMode: DELIVERY_MODE.NONE,
    targets: [{ ordinal: 0, outcome: s.outcome, firstAttemptCorrect: null, attemptCount: s.attempts ?? 1, hintCount: 0 }],
  }) as EvaluatedTask);
  const targets = specs.map((s): TargetRow => ({ taskId: s.id, ordinal: 0, meaningId: null, pronunciationId: s.pronunciationId }));
  return { counted, targets };
}

const receipt = (taskId: string, hoursAgo: number, accuracyScore: number | null, validity: string = VALIDITY.VALID): SessionReceipt => ({
  taskId, validity, passed: validity === VALIDITY.VALID ? (accuracyScore ?? 0) >= 80 : null, accuracyScore, assessedAt: addHours(NOW, -hoursAgo),
});

describe('speakingResults', () => {
  it('on-device passes only on the first take', () => {
    const { counted, targets } = recordings([
      { id: 't1', ordinal: 1, pronunciationId: 'p1', outcome: OUTCOME.ASSESSED_PASSED },
      { id: 't2', ordinal: 2, pronunciationId: 'p2', outcome: OUTCOME.ASSESSED_PASSED, attempts: 2 },
      { id: 't3', ordinal: 3, pronunciationId: 'p3', outcome: OUTCOME.ASSESSED_FAILED },
    ]);
    expect(speakingResults(counted, targets, [])).toEqual([
      { pronunciationId: 'p1', method: SPEAKING_METHOD.DEVICE, passed: true },
      { pronunciationId: 'p2', method: SPEAKING_METHOD.DEVICE, passed: false },
      { pronunciationId: 'p3', method: SPEAKING_METHOD.DEVICE, passed: false },
    ]);
  });

  it('Azure scores the first valid receipt, not the one the learner kept', () => {
    const { counted, targets } = recordings([{ id: 't1', ordinal: 1, pronunciationId: 'p1', outcome: OUTCOME.ASSESSED_PASSED, onDevice: false }]);
    const receipts = [receipt('t1', 1, 95), receipt('t1', 3, 62), receipt('t1', 4, null, VALIDITY.INVALID), receipt('other', 5, 10)];
    expect(speakingResults(counted, targets, receipts)).toEqual([{ pronunciationId: 'p1', method: SPEAKING_METHOD.AZURE, passed: false, score: 62 }]);
  });

  it('skips new-word, invalid and unavailable recordings, and keeps one result per pronunciation', () => {
    const { counted, targets } = recordings([
      { id: 't1', ordinal: 1, pronunciationId: 'p1', outcome: OUTCOME.ASSESSED_FAILED, phase: TASK_PHASE.NEW_PRACTICE },
      { id: 't2', ordinal: 2, pronunciationId: 'p2', outcome: OUTCOME.INVALID },
      { id: 't3', ordinal: 3, pronunciationId: 'p3', outcome: OUTCOME.UNAVAILABLE, attempts: 0 },
      { id: 't5', ordinal: 5, pronunciationId: 'p4', outcome: OUTCOME.ASSESSED_FAILED },
      { id: 't4', ordinal: 4, pronunciationId: 'p4', outcome: OUTCOME.ASSESSED_PASSED },
    ]);
    expect(speakingResults(counted, targets, [])).toEqual([{ pronunciationId: 'p4', method: SPEAKING_METHOD.DEVICE, passed: true }]);
  });
});
