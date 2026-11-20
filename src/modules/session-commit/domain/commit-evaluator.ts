import {
  ASSESSMENT_INTENT, DELIVERY_MODE, DeliveryMode, EVENT_ACTION, OUTCOME, PROMPT_TYPE, SPEAKING_METHOD, TASK_PHASE, Template, VALIDITY,
} from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { AnswerKey, ClientBody, evaluateTask, ReceiptView, TargetOutcome } from '../../practice-evaluator/evaluate';
import { CommitBody } from '../../practice-evaluator/events';
import { MemoryFact, reduceMemory } from '../../memory-srs/memory-reducer';
import { Prompt, ServerEvaluation } from '../../practice-resolver/task.types';
import { PlanLearnStep, PlanTask } from '../../session-planner/domain/session-plan';
import { SpeakingResult } from '../../speaking/speaking-progress';

export type TaskRow = Omit<PlanTask, 'targets'>;

export interface TargetRow {
  taskId: string;
  ordinal: number;
  meaningId: string | null;
  pronunciationId: string | null;
}

export type LearnStepRow = Pick<PlanLearnStep, 'id' | 'meaningId' | 'firstRecallTaskId' | 'knownCheckTaskId' | 'skippableTaskIds'>;

export interface EvaluatedTask {
  task: TaskRow;
  rawEvents: CommitBody['taskResults'][number]['events'];
  deliveryMode: DeliveryMode;
  targets: TargetOutcome[];
  receiptId?: string;
}

const invalid = (message: string) => new ApiError('INVALID_SUBMISSION', message);

// The claim is cross-checked against the issued prompt; a text prompt cannot have played audio.
function resolveDelivery(prompt: Prompt | undefined, claimed: DeliveryMode | undefined): DeliveryMode {
  if (prompt?.type === PROMPT_TYPE.AUDIO) {
    if (!claimed) throw invalid('Audio task needs deliveryMode');
    return claimed;
  }
  if (claimed === DELIVERY_MODE.AUDIO || claimed === DELIVERY_MODE.FALLBACK) throw invalid('deliveryMode contradicts text prompt');
  return DELIVERY_MODE.NONE;
}

/** Meanings whose optional known check came back correct, first try and without hints. */
export function knownMeanings(steps: LearnStepRow[], byTask: Map<string, EvaluatedTask>) {
  return new Set(steps.flatMap((step) => {
    const check = step.knownCheckTaskId && byTask.get(step.knownCheckTaskId);
    const passed = check && check.targets.length > 0 && check.targets.every((t) => t.outcome === OUTCOME.CORRECT && t.hintCount === 0);
    return passed ? [step.meaningId] : [];
  }));
}

export function evaluateBatch(
  body: CommitBody,
  tasks: TaskRow[],
  targets: TargetRow[],
  steps: LearnStepRow[],
  receipts: Map<string, ReceiptView & { taskId: string }>,
): { evaluated: EvaluatedTask[]; known: Set<string>; declared: Set<string> } {
  const submitted = new Map(body.taskResults.map((r) => [r.taskId, r]));
  if (submitted.size !== body.taskResults.length) throw invalid('Duplicate taskId');
  const issued = new Set(tasks.map((t) => t.id));
  if (body.taskResults.some((r) => !issued.has(r.taskId))) throw invalid('Result for a task that was not issued');

  const ordinalsByTask = Map.groupBy(targets, (t) => t.taskId);

  const evaluated = tasks.filter((task) => submitted.has(task.id)).map((task): EvaluatedTask => {
    const result = submitted.get(task.id)!;
    const payload = task.clientPayload as ClientBody & { prompt?: Prompt };
    const taskReceipts = new Map([...receipts].filter(([, r]) => r.taskId === task.id));
    const evaluation = evaluateTask({
      template: task.template as Template,
      body: payload,
      key: task.serverEvaluation as AnswerKey,
      targetOrdinals: (ordinalsByTask.get(task.id) ?? []).map((t) => t.ordinal),
      events: result.events,
      receipts: taskReceipts,
    });
    return {
      task,
      rawEvents: result.events,
      deliveryMode: resolveDelivery(payload.prompt, result.deliveryMode),
      ...evaluation,
    };
  });

  const byTask = new Map(evaluated.map((e) => [e.task.id, e]));
  const declared = declaredKnown(body, steps);
  const known = new Set([...knownMeanings(steps, byTask), ...declared]);
  // Known checks are optional; a known word may also drop the tasks that test only it.
  const optional = new Set(steps.flatMap((s) => [
    ...(s.knownCheckTaskId ? [s.knownCheckTaskId] : []),
    ...(known.has(s.meaningId) ? s.skippableTaskIds ?? [] : []),
  ]));
  if (tasks.some((t) => !submitted.has(t.id) && !optional.has(t.id))) throw invalid('Every issued task needs a result');

  const stepIds = new Set(steps.map((s) => s.id));
  const completed = new Set(body.learnStepsCompleted);
  const taught = steps.filter((s) => !known.has(s.meaningId));
  if ([...completed].some((id) => !stepIds.has(id)) || taught.some((s) => !completed.has(s.id))) {
    throw invalid('Every Learn step must be completed');
  }
  for (const step of taught) {
    const recall = byTask.get(step.firstRecallTaskId);
    if (!recall?.targets.some((t) => t.attemptCount > 0)) throw invalid('First recall needs a submitted attempt');
  }
  return { evaluated, known, declared };
}

/** Meanings of the Learn steps the learner marked known; only steps planned with a known check may be. */
function declaredKnown(body: CommitBody, steps: LearnStepRow[]) {
  const ids = new Set(body.knownLearnSteps ?? []);
  if (ids.size !== (body.knownLearnSteps ?? []).length) throw invalid('Duplicate known Learn step');
  const completed = new Set(body.learnStepsCompleted);
  const byId = new Map(steps.map((s) => [s.id, s]));
  return new Set([...ids].map((id) => {
    const step = byId.get(id);
    if (!step?.knownCheckTaskId) throw invalid('Learn step does not offer "I know this"');
    if (completed.has(id)) throw invalid('A known Learn step cannot also be completed');
    return step.meaningId;
  }));
}

/** A failed known check only routes the word to teaching; it is not a memory signal. */
export function countedTasks(evaluated: EvaluatedTask[], targets: TargetRow[], known: Set<string>) {
  const index = targetIndex(targets);
  return evaluated.filter((e) => e.task.phase !== TASK_PHASE.KNOWN_CHECK
    || e.targets.every((o) => known.has(index.get(targetKey(e.task.id, o.ordinal))?.meaningId ?? '')));
}

const targetKey = (taskId: string, ordinal: number) => `${taskId}:${ordinal}`;

const targetIndex = (targets: TargetRow[]) => new Map(targets.map((t) => [targetKey(t.taskId, t.ordinal), t]));

/** The durable record of a commit; it must stay readable after the plan is purged. */
export function sessionResult(evaluated: EvaluatedTask[], targets: TargetRow[], receipts: Map<string, { accuracyScore?: number | null }>) {
  const index = targetIndex(targets);
  return {
    tasks: evaluated.map(({ task, deliveryMode, receiptId, targets: outcomes, rawEvents }) => ({
      taskId: task.id,
      // Kept to calibrate the Easy thresholds.
      firstSubmitMs: rawEvents.find((e) => e.action === EVENT_ACTION.SUBMIT)?.elapsedMs ?? null,
      template: task.template,
      variant: task.variant,
      intent: (task.serverEvaluation as ServerEvaluation).intent,
      deliveryMode,
      accuracyScore: (receiptId && receipts.get(receiptId)?.accuracyScore) ?? null,
      targets: outcomes.map((o) => {
        const target = index.get(targetKey(task.id, o.ordinal));
        return { ...o, meaningId: target?.meaningId ?? null, pronunciationId: target?.pronunciationId ?? null };
      }),
    })),
  };
}

/** What the weight and the Easy threshold need from a task, read from the issued payload. */
function answerShape({ task, rawEvents }: EvaluatedTask) {
  const payload = task.clientPayload as ClientBody;
  const key = task.serverEvaluation as AnswerKey;
  const optionCount = payload.options?.length ?? payload.pairs?.left.length ?? null;
  const firstSubmit = rawEvents.find((e) => e.action === EVENT_ACTION.SUBMIT);
  return {
    variant: task.variant ?? null,
    optionCount,
    firstSubmitMs: firstSubmit?.elapsedMs ?? null,
    answerUnits: payload.tiles?.length ?? key.acceptedResponses?.[0]?.length ?? 0,
  };
}

export function memoryDrafts(evaluated: EvaluatedTask[], targets: TargetRow[]) {
  const index = targetIndex(targets);
  const facts = evaluated.flatMap((e) => {
    const { task, targets: outcomes } = e;
    const server = task.serverEvaluation as ServerEvaluation;
    const shape = answerShape(e);
    return outcomes.map((o): MemoryFact => ({
      taskId: task.id,
      ordinal: task.ordinal,
      meaningId: index.get(targetKey(task.id, o.ordinal))?.meaningId ?? null,
      intent: server.intent,
      outcome: o.outcome,
      hintCount: o.hintCount,
      attemptCount: o.attemptCount,
      isPrimed: server.isPrimed,
      promptIsTargetAudio: server.promptIsTargetAudio,
      ...shape,
    }));
  });
  return reduceMemory(facts);
}

export interface SessionReceipt {
  taskId: string;
  validity: string;
  passed: boolean | null;
  accuracyScore: number | null;
  assessedAt: Date;
}

const SPEAKING_SKIPPED = new Set<string>([OUTCOME.INVALID, OUTCOME.UNAVAILABLE]);

/**
 * One result per pronunciation: its first usable recording by task ordinal. A recording right after Learn is skipped (the word was just modelled).
 * On-device passes only on the first take; Azure scores the task's first valid receipt, not the one the learner kept.
 */
export function speakingResults(counted: EvaluatedTask[], targets: TargetRow[], receipts: SessionReceipt[]): SpeakingResult[] {
  const index = targetIndex(targets);
  const firstReceipt = new Map<string, SessionReceipt>();
  for (const receipt of [...receipts].sort((a, b) => a.assessedAt.getTime() - b.assessedAt.getTime())) {
    if (receipt.validity === VALIDITY.VALID && !firstReceipt.has(receipt.taskId)) firstReceipt.set(receipt.taskId, receipt);
  }
  const results = new Map<string, SpeakingResult>();
  for (const { task, targets: outcomes, rawEvents } of [...counted].sort((a, b) => a.task.ordinal - b.task.ordinal)) {
    const server = task.serverEvaluation as ServerEvaluation;
    if (server.intent !== ASSESSMENT_INTENT.PRONUNCIATION || task.phase === TASK_PHASE.NEW_PRACTICE) continue;
    const onDevice = rawEvents.some((e) => e.action === EVENT_ACTION.TRANSCRIBED);
    for (const o of outcomes) {
      const pronunciationId = index.get(targetKey(task.id, o.ordinal))?.pronunciationId;
      if (!pronunciationId || results.has(pronunciationId) || SPEAKING_SKIPPED.has(o.outcome)) continue;
      if (onDevice) {
        results.set(pronunciationId, { pronunciationId, method: SPEAKING_METHOD.DEVICE, passed: o.attemptCount === 1 && o.outcome === OUTCOME.ASSESSED_PASSED });
        continue;
      }
      const receipt = firstReceipt.get(task.id);
      if (receipt) results.set(pronunciationId, { pronunciationId, method: SPEAKING_METHOD.AZURE, passed: receipt.passed === true, score: receipt.accuracyScore ?? 0 });
    }
  }
  return [...results.values()];
}
