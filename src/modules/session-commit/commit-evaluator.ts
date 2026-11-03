import { DELIVERY_MODE, DeliveryMode, PROMPT_TYPE, Template, TaskPhase } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { AnswerKey, ClientBody, evaluateTask, ReceiptView, TargetOutcome } from '../practice-evaluator/evaluate';
import { CommitBody } from '../practice-evaluator/events';
import { MemoryFact, reduceMemory } from '../memory-srs/memory-reducer';
import { Prompt, ServerEvaluation } from '../practice-resolver/task.types';
import { PlanLearnStep, PlanTask } from '../session-planner/session-plan';
import { deriveEvidence, EvidenceDraft } from '../skill-verification/skill-evidence';

export type TaskRow = Omit<PlanTask, 'targets'>;

export interface TargetRow {
  taskId: string;
  ordinal: number;
  meaningId: string | null;
  pronunciationId: string | null;
}

export type LearnStepRow = Pick<PlanLearnStep, 'id' | 'meaningId' | 'firstRecallTaskId'>;

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

export function evaluateBatch(
  body: CommitBody,
  tasks: TaskRow[],
  targets: TargetRow[],
  steps: LearnStepRow[],
  receipts: Map<string, ReceiptView & { taskId: string }>,
): EvaluatedTask[] {
  const submitted = new Map(body.taskResults.map((r) => [r.taskId, r]));
  if (submitted.size !== body.taskResults.length) throw invalid('Duplicate taskId');
  if (submitted.size !== tasks.length) throw invalid('Every issued task needs a result');

  const stepIds = new Set(steps.map((s) => s.id));
  const completed = new Set(body.learnStepsCompleted);
  if (completed.size !== stepIds.size || steps.some((s) => !completed.has(s.id))) throw invalid('Every Learn step must be completed');

  const ordinalsByTask = Map.groupBy(targets, (t) => t.taskId);

  const evaluated = tasks.map((task): EvaluatedTask => {
    const result = submitted.get(task.id);
    if (!result) throw invalid('Result missing for an issued task');
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
  for (const step of steps) {
    const recall = byTask.get(step.firstRecallTaskId);
    if (!recall?.targets.some((t) => t.attemptCount > 0)) throw invalid('First recall needs a submitted attempt');
  }
  return evaluated;
}

const targetKey = (taskId: string, ordinal: number) => `${taskId}:${ordinal}`;

const targetIndex = (targets: TargetRow[]) => new Map(targets.map((t) => [targetKey(t.taskId, t.ordinal), t]));

/** The durable record of a commit; it must stay readable after the plan is purged. */
export function sessionResult(evaluated: EvaluatedTask[], targets: TargetRow[], receipts: Map<string, { accuracyScore?: number | null }>) {
  const index = targetIndex(targets);
  return {
    tasks: evaluated.map(({ task, deliveryMode, receiptId, targets: outcomes }) => ({
      taskId: task.id,
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

export function memoryDrafts(evaluated: EvaluatedTask[], targets: TargetRow[]) {
  const index = targetIndex(targets);
  const facts = evaluated.flatMap(({ task, targets: outcomes }) => {
    const server = task.serverEvaluation as ServerEvaluation;
    return outcomes.map((o): MemoryFact => ({
      taskId: task.id,
      ordinal: task.ordinal,
      meaningId: index.get(targetKey(task.id, o.ordinal))?.meaningId ?? null,
      intent: server.intent,
      outcome: o.outcome,
      hintCount: o.hintCount,
      isPrimed: server.isPrimed,
    }));
  });
  return reduceMemory(facts);
}

export interface EvidenceRowDraft extends EvidenceDraft {
  taskId: string;
  targetOrdinal: number;
  receiptId?: string;
  evaluatorVersion: string;
}

export function evidenceDrafts(evaluated: EvaluatedTask[], targets: TargetRow[]): EvidenceRowDraft[] {
  const index = targetIndex(targets);
  return evaluated.flatMap(({ task, targets: outcomes, deliveryMode, receiptId }) => {
    const server = task.serverEvaluation as ServerEvaluation;
    return outcomes.flatMap((o) => {
      const target = index.get(targetKey(task.id, o.ordinal));
      return deriveEvidence({
        template: task.template as Template,
        intent: server.intent,
        phase: task.phase as TaskPhase,
        promptIsTargetAudio: server.promptIsTargetAudio,
        qualityQualified: server.qualityQualified,
        isPrimed: server.isPrimed,
        deliveryMode,
        outcome: o.outcome,
        hintCount: o.hintCount,
        meaningId: target?.meaningId ?? null,
        pronunciationId: target?.pronunciationId ?? null,
      }).map((draft) => ({ ...draft, taskId: task.id, targetOrdinal: o.ordinal, receiptId, evaluatorVersion: task.evaluatorVersion }));
    });
  });
}
