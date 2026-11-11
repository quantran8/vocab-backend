import { EVENT_ACTION, OUTCOME, Outcome, TEMPLATE, Template, VALIDITY } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { TaskEvent } from './events';
import { normalizeAnswer, splitGraphemes } from './normalizer';
import { transcriptMatches } from './transcript';

export interface Option { id: number; text: string }
export interface PairKey { leftId: number; rightId: number }

export interface ClientBody {
  options?: Option[];
  tiles?: Option[];
  pairs?: { left: Option[]; right: Option[] };
  word?: string;
  // Absent on snapshots issued before the limit existed: those stay unlimited.
  maxRetries?: number;
}

export interface AnswerKey {
  correctOptionId?: number;
  acceptedResponses?: string[];
  correctPairs?: PairKey[];
  wrongGraphemeIndex?: number;
  replacement?: string;
  referenceText?: string;
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

type SubmitEvent = Extract<TaskEvent, { action: typeof EVENT_ACTION.SUBMIT }>;

const invalid = (message: string) => new ApiError('INVALID_SUBMISSION', message);

const attemptLimit = (body: ClientBody) => 1 + (body.maxRetries ?? Infinity);

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

function tallyAttempts(body: ClientBody, events: TaskEvent[], isCorrect: (event: SubmitEvent) => boolean, onOther?: (event: TaskEvent) => void) {
  const limit = attemptLimit(body);
  const tally: AttemptTally = { attempts: 0, hints: 0, revealed: false, firstCorrect: null, solved: false };
  for (const event of events) {
    if (tally.solved) throw invalid('Events after a correct submit');
    if (event.action === EVENT_ACTION.HINT) tally.hints += 1;
    else if (event.action === EVENT_ACTION.REVEAL) tally.revealed = true;
    else if (event.action === EVENT_ACTION.SUBMIT) {
      if (tally.attempts >= limit) throw invalid('Attempt limit exceeded');
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
  if (tally.firstCorrect === true && !tally.revealed) return OUTCOME.CORRECT;
  if (tally.revealed) return OUTCOME.REVEALED;
  return tally.solved ? OUTCOME.CORRECTED_AFTER_RETRY : OUTCOME.INCORRECT;
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
  const tally = tallyAttempts(body, events, (event) => {
    if (event.optionId === undefined || !ids.has(event.optionId)) throw invalid('Unknown optionId');
    return event.optionId === key.correctOptionId;
  });
  return singleTarget(targetOrdinals, tally);
}

function evaluateTyping({ body, key, targetOrdinals, events }: EvaluateInput) {
  const accepted = new Set((key.acceptedResponses ?? []).map(normalizeAnswer));
  const tally = tallyAttempts(body, events, (event) => {
    if (event.value === undefined) throw invalid('Submit needs a value');
    return accepted.has(normalizeAnswer(event.value));
  });
  return singleTarget(targetOrdinals, tally);
}

interface GraphemeEdit { graphemeIndex: number; replacement: string }

function surgeryEdits(event: SubmitEvent): GraphemeEdit[] {
  if (event.edits) {
    if (event.graphemeIndex !== undefined || event.replacement !== undefined) throw invalid('Send edits or graphemeIndex, not both');
    if (new Set(event.edits.map((e) => e.graphemeIndex)).size !== event.edits.length) throw invalid('Duplicate graphemeIndex in edits');
    return event.edits;
  }
  if (event.graphemeIndex === undefined) throw invalid('Submit needs edits or graphemeIndex');
  return [{ graphemeIndex: event.graphemeIndex, replacement: event.replacement ?? '' }];
}

const applyEdits = (graphemes: string[], edits: GraphemeEdit[]) => {
  const byIndex = new Map(edits.map((e) => [e.graphemeIndex, e.replacement]));
  return graphemes.map((g, i) => byIndex.get(i) ?? g).join('');
};

// Scores the repaired word, so any fix that spells it right counts (e.g. deleting either "r" of "clarrify").
function evaluateSurgery({ body, key, targetOrdinals, events }: EvaluateInput) {
  const fix = { graphemeIndex: key.wrongGraphemeIndex ?? -1, replacement: key.replacement ?? '' };
  const graphemes = body.word === undefined ? undefined : splitGraphemes(body.word);
  const expected = graphemes && normalizeAnswer(applyEdits(graphemes, [fix]));
  const tally = tallyAttempts(body, events, (event) => {
    const edits = surgeryEdits(event);
    if (!graphemes) {
      // Without the word, only the single expected fix can be checked.
      return edits.length === 1 && edits[0].graphemeIndex === fix.graphemeIndex
        && normalizeAnswer(edits[0].replacement) === normalizeAnswer(fix.replacement);
    }
    if (edits.some((e) => e.graphemeIndex >= graphemes.length)) throw invalid('graphemeIndex out of range');
    return normalizeAnswer(applyEdits(graphemes, edits)) === expected;
  });
  return singleTarget(targetOrdinals, tally);
}

function evaluateFlyReorder({ body, key, targetOrdinals, events }: EvaluateInput) {
  const tiles = new Map((body.tiles ?? []).map((t) => [t.id, t.text]));
  const accepted = new Set((key.acceptedResponses ?? []).map(normalizeAnswer));
  let placed: number[] = [];

  const replay = (event: TaskEvent) => {
    if (event.action === EVENT_ACTION.TAP_TILE) {
      if (!tiles.has(event.tileId) || placed.includes(event.tileId)) throw invalid('Invalid tile tap');
      placed.push(event.tileId);
    } else if (event.action === EVENT_ACTION.REMOVE_TILE) {
      if (!placed.includes(event.tileId)) throw invalid('Removing an unplaced tile');
      placed = placed.filter((id) => id !== event.tileId);
    } else if (event.action === EVENT_ACTION.MOVE_TILE) {
      if (!placed.includes(event.tileId) || event.toIndex >= placed.length) throw invalid('Invalid tile move');
      placed = placed.filter((id) => id !== event.tileId);
      placed.splice(event.toIndex, 0, event.tileId);
    } else throw invalid(`Unexpected event ${event.action}`);
  };

  const tally = tallyAttempts(
    body,
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
  const limit = attemptLimit(body);
  let hints = 0;
  let revealed = false;

  for (const event of events) {
    if (event.action === EVENT_ACTION.HINT) hints += 1;
    else if (event.action === EVENT_ACTION.REVEAL) revealed = true;
    else if (event.action === EVENT_ACTION.PAIR) {
      const left = perLeft.get(event.leftId);
      if (!left || !rights.has(event.rightId)) throw invalid('Unknown pair ids');
      if (left.solved) throw invalid('Pair already solved');
      if (left.attempts >= limit) throw invalid('Attempt limit exceeded');
      const isCorrect = correct.get(event.leftId) === event.rightId;
      left.attempts += 1;
      left.firstCorrect ??= isCorrect;
      left.solved = isCorrect;
    } else throw invalid(`Unexpected event ${event.action}`);
  }
  // A pair out of attempts is finished: it scores incorrect and cannot block the board.
  if (!revealed && [...perLeft.values()].some((l) => !l.solved && l.attempts < limit)) throw invalid('Match board is incomplete');

  const targets = [...perLeft].map(([leftId, left]): TargetOutcome => {
    const ordinal = key.pairTargets?.[leftId];
    if (ordinal === undefined) throw new ApiError('TASK_DATA_INVALID', 'Pair has no target');
    const tally = { attempts: left.attempts, hints, revealed: revealed && !left.solved, firstCorrect: left.firstCorrect, solved: left.solved };
    return { ordinal, outcome: outcomeOf(tally), firstAttemptCorrect: left.firstCorrect, attemptCount: left.attempts, hintCount: hints };
  });
  return { targets };
}

function evaluateRecording({ body, key, targetOrdinals, events, receipts }: EvaluateInput): TaskEvaluation {
  const target = (outcome: Outcome, attemptCount: number) =>
    targetOrdinals.map((ordinal) => ({ ordinal, outcome, firstAttemptCorrect: null, attemptCount, hintCount: 0 }));

  // On-device takes: one event per take, the last one counts.
  if (events.some((e) => e.action === EVENT_ACTION.TRANSCRIBED)) {
    if (events.some((e) => e.action !== EVENT_ACTION.TRANSCRIBED)) throw invalid('Transcribed takes cannot mix with other events');
    if (events.length > attemptLimit(body)) throw invalid('Attempt limit exceeded');
    if (!key.referenceText) throw new ApiError('TASK_DATA_INVALID', 'Recording has no reference');
    const last = events[events.length - 1] as Extract<TaskEvent, { action: typeof EVENT_ACTION.TRANSCRIBED }>;
    const matches = transcriptMatches(last.transcript, key.referenceText);
    const outcome = matches === null ? OUTCOME.INVALID : matches ? OUTCOME.ASSESSED_PASSED : OUTCOME.ASSESSED_FAILED;
    return { targets: target(outcome, events.length) };
  }

  if (events.length !== 1) throw invalid('Recording needs exactly one terminal event');
  const [event] = events;

  if (event.action === EVENT_ACTION.UNAVAILABLE) return { targets: target(OUTCOME.UNAVAILABLE, 0) };
  if (event.action !== EVENT_ACTION.ASSESSED) throw invalid('Recording needs assessed, unavailable or transcribed');

  const receipt = receipts?.get(event.assessmentReceiptId);
  if (!receipt) throw invalid('Unknown assessment receipt');
  const outcome =
    receipt.validity === VALIDITY.INVALID ? OUTCOME.INVALID : receipt.passed ? OUTCOME.ASSESSED_PASSED : OUTCOME.ASSESSED_FAILED;
  return { targets: target(outcome, 1), receiptId: receipt.id };
}

const EVALUATORS: Record<Template, (input: EvaluateInput) => TaskEvaluation> = {
  [TEMPLATE.SELECT]: evaluateOption,
  [TEMPLATE.CLOZE_SELECT]: evaluateOption,
  [TEMPLATE.MATCH]: evaluateMatch,
  [TEMPLATE.TYPING]: evaluateTyping,
  [TEMPLATE.FLY_REORDER]: evaluateFlyReorder,
  [TEMPLATE.SURGERY]: evaluateSurgery,
  [TEMPLATE.RECORDING]: evaluateRecording,
};

export function evaluateTask(input: EvaluateInput): TaskEvaluation {
  assertMonotonic(input.events);
  return EVALUATORS[input.template](input);
}
