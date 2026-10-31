import { EVENT_ACTION, OUTCOME, Outcome, TEMPLATE, Template, VALIDITY } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { TaskEvent } from './events';
import { normalizeAnswer } from './normalizer';

export interface Option { id: number; text: string }
export interface PairKey { leftId: number; rightId: number }

export interface ClientBody {
  options?: Option[];
  tiles?: Option[];
  pairs?: { left: Option[]; right: Option[] };
}

export interface AnswerKey {
  correctOptionId?: number;
  acceptedResponses?: string[];
  correctPairs?: PairKey[];
  wrongGraphemeIndex?: number;
  replacement?: string;
  // match: leftId -> target ordinal
  pairTargets?: Record<string, number>;
}

export interface ReceiptView {
  id: string;
  validity: string;
  passed: boolean | null;
  accuracyScore?: number | null;
}

export interface TargetOutcome {
  ordinal: number;
  outcome: Outcome;
  firstAttemptCorrect: boolean | null;
  attemptCount: number;
  hintCount: number;
}

export interface TaskEvaluation {
  targets: TargetOutcome[];
  receiptId?: string;
}

export interface EvaluateInput {
  template: Template;
  body: ClientBody;
  key: AnswerKey;
  targetOrdinals: number[];
  events: TaskEvent[];
  receipts?: Map<string, ReceiptView>;
}

type SubmitEvent = Extract<TaskEvent, { action: 'submit' }>;

const invalid = (message: string) => new ApiError('INVALID_SUBMISSION', message);

function assertMonotonic(events: TaskEvent[]) {
  events.reduce((previous, event) => {
    if (event.seq <= previous) throw invalid('Event seq must strictly increase');
    return event.seq;
  }, 0);
}

interface AttemptTally {
  attempts: number;
  hints: number;
  revealed: boolean;
  firstCorrect: boolean | null;
  solved: boolean;
}

function tallyAttempts(events: TaskEvent[], isCorrect: (event: SubmitEvent) => boolean, onOther?: (event: TaskEvent) => void) {
  const tally: AttemptTally = { attempts: 0, hints: 0, revealed: false, firstCorrect: null, solved: false };
  for (const event of events) {
    if (tally.solved) throw invalid('Events after a correct submit');
    if (event.action === EVENT_ACTION.hint) tally.hints += 1;
    else if (event.action === EVENT_ACTION.reveal) tally.revealed = true;
    else if (event.action === EVENT_ACTION.submit) {
      const correct = isCorrect(event);
      tally.attempts += 1;
      tally.firstCorrect ??= correct;
      tally.solved = correct;
    } else if (onOther) onOther(event);
    else throw invalid(`Unexpected event ${event.action}`);
  }
  if (tally.attempts === 0 && !tally.revealed) throw invalid('Task has no terminal attempt');
  return tally;
}

function outcomeOf(tally: AttemptTally): Outcome {
  if (tally.firstCorrect === true && !tally.revealed) return OUTCOME.correct;
  if (tally.revealed) return OUTCOME.revealed;
  return tally.solved ? OUTCOME.correctedAfterRetry : OUTCOME.incorrect;
}

const singleTarget = (ordinals: number[], tally: AttemptTally): TaskEvaluation => ({
  targets: ordinals.map((ordinal) => ({
    ordinal,
    outcome: outcomeOf(tally),
    firstAttemptCorrect: tally.firstCorrect,
    attemptCount: tally.attempts,
    hintCount: tally.hints,
  })),
});

function evaluateOption({ body, key, targetOrdinals, events }: EvaluateInput) {
  const ids = new Set((body.options ?? []).map((o) => o.id));
  const tally = tallyAttempts(events, (event) => {
    if (event.optionId === undefined || !ids.has(event.optionId)) throw invalid('Unknown optionId');
    return event.optionId === key.correctOptionId;
  });
  return singleTarget(targetOrdinals, tally);
}

function evaluateTyping({ key, targetOrdinals, events }: EvaluateInput) {
  const accepted = new Set((key.acceptedResponses ?? []).map(normalizeAnswer));
  const tally = tallyAttempts(events, (event) => {
    if (event.value === undefined) throw invalid('Submit needs a value');
    return accepted.has(normalizeAnswer(event.value));
  });
  return singleTarget(targetOrdinals, tally);
}

function evaluateSurgery({ key, targetOrdinals, events }: EvaluateInput) {
  const expected = normalizeAnswer(key.replacement ?? '');
  const tally = tallyAttempts(events, (event) => {
    if (event.graphemeIndex === undefined) throw invalid('Submit needs graphemeIndex');
    return event.graphemeIndex === key.wrongGraphemeIndex && normalizeAnswer(event.replacement ?? '') === expected;
  });
  return singleTarget(targetOrdinals, tally);
}

function evaluateFlyReorder({ body, key, targetOrdinals, events }: EvaluateInput) {
  const tiles = new Map((body.tiles ?? []).map((t) => [t.id, t.text]));
  const accepted = new Set((key.acceptedResponses ?? []).map(normalizeAnswer));
  let placed: number[] = [];

  const replay = (event: TaskEvent) => {
    if (event.action === EVENT_ACTION.tapTile) {
      if (!tiles.has(event.tileId) || placed.includes(event.tileId)) throw invalid('Invalid tile tap');
      placed.push(event.tileId);
    } else if (event.action === EVENT_ACTION.removeTile) {
      if (!placed.includes(event.tileId)) throw invalid('Removing an unplaced tile');
      placed = placed.filter((id) => id !== event.tileId);
    } else if (event.action === EVENT_ACTION.moveTile) {
      if (!placed.includes(event.tileId) || event.toIndex >= placed.length) throw invalid('Invalid tile move');
      placed = placed.filter((id) => id !== event.tileId);
      placed.splice(event.toIndex, 0, event.tileId);
    } else throw invalid(`Unexpected event ${event.action}`);
  };

  const tally = tallyAttempts(
    events,
    (event) => {
      const ids = event.tileIds;
      // tileIds must agree with the replayed state; the client string is never trusted.
      if (!ids || ids.length !== placed.length || ids.some((id, i) => id !== placed[i])) {
        throw invalid('Submitted tiles do not match replay');
      }
      return accepted.has(normalizeAnswer(ids.map((id) => tiles.get(id)).join('')));
    },
    replay,
  );
  return singleTarget(targetOrdinals, tally);
}

function evaluateMatch({ body, key, events }: EvaluateInput) {
  const correct = new Map((key.correctPairs ?? []).map((p) => [p.leftId, p.rightId]));
  const rights = new Set(body.pairs?.right.map((o) => o.id));
  const perLeft = new Map(
    [...correct.keys()].map((leftId) => [leftId, { attempts: 0, firstCorrect: null as boolean | null, solved: false }]),
  );
  let hints = 0;
  let revealed = false;

  for (const event of events) {
    if (event.action === EVENT_ACTION.hint) hints += 1;
    else if (event.action === EVENT_ACTION.reveal) revealed = true;
    else if (event.action === EVENT_ACTION.pair) {
      const left = perLeft.get(event.leftId);
      if (!left || !rights.has(event.rightId)) throw invalid('Unknown pair ids');
      if (left.solved) throw invalid('Pair already solved');
      const isCorrect = correct.get(event.leftId) === event.rightId;
      left.attempts += 1;
      left.firstCorrect ??= isCorrect;
      left.solved = isCorrect;
    } else throw invalid(`Unexpected event ${event.action}`);
  }
  if (!revealed && [...perLeft.values()].some((l) => !l.solved)) throw invalid('Match board is incomplete');

  const targets = [...perLeft].map(([leftId, left]): TargetOutcome => {
    const ordinal = key.pairTargets?.[leftId];
    if (ordinal === undefined) throw new ApiError('TASK_DATA_INVALID', 'Pair has no target');
    const tally = { attempts: left.attempts, hints, revealed: revealed && !left.solved, firstCorrect: left.firstCorrect, solved: left.solved };
    return { ordinal, outcome: outcomeOf(tally), firstAttemptCorrect: left.firstCorrect, attemptCount: left.attempts, hintCount: hints };
  });
  return { targets };
}

function evaluateRecording({ targetOrdinals, events, receipts }: EvaluateInput): TaskEvaluation {
  if (events.length !== 1) throw invalid('Recording needs exactly one terminal event');
  const [event] = events;
  const target = (outcome: Outcome, attemptCount: number) =>
    targetOrdinals.map((ordinal) => ({ ordinal, outcome, firstAttemptCorrect: null, attemptCount, hintCount: 0 }));

  if (event.action === EVENT_ACTION.unavailable) return { targets: target(OUTCOME.unavailable, 0) };
  if (event.action !== EVENT_ACTION.assessed) throw invalid('Recording needs assessed or unavailable');

  const receipt = receipts?.get(event.assessmentReceiptId);
  if (!receipt) throw invalid('Unknown assessment receipt');
  const outcome =
    receipt.validity === VALIDITY.invalid ? OUTCOME.invalid : receipt.passed ? OUTCOME.assessedPassed : OUTCOME.assessedFailed;
  return { targets: target(outcome, 1), receiptId: receipt.id };
}

const EVALUATORS: Record<Template, (input: EvaluateInput) => TaskEvaluation> = {
  [TEMPLATE.select]: evaluateOption,
  [TEMPLATE.clozeSelect]: evaluateOption,
  [TEMPLATE.match]: evaluateMatch,
  [TEMPLATE.typing]: evaluateTyping,
  [TEMPLATE.flyReorder]: evaluateFlyReorder,
  [TEMPLATE.surgery]: evaluateSurgery,
  [TEMPLATE.recording]: evaluateRecording,
};

export function evaluateTask(input: EvaluateInput): TaskEvaluation {
  assertMonotonic(input.events);
  return EVALUATORS[input.template](input);
}
