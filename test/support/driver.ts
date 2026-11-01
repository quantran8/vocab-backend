import { TEMPLATE } from '../../src/common/constants/domain';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const tasksOf = (plan: Json): Json[] => plan.steps.filter((s: Json) => s.type === 'practice').map((s: Json) => s.task);
export const learnIds = (plan: Json): string[] => plan.steps.filter((s: Json) => s.type === 'learn').map((s: Json) => s.id);

const wrongOption = (task: Json) => task.options.find((o: Json) => o.id !== task.evaluation.correctOptionId).id;

function correctEvents(task: Json, receiptId?: string): Json[] {
  switch (task.template) {
    case TEMPLATE.SELECT:
    case TEMPLATE.CLOZE_SELECT:
      return [{ seq: 1, action: 'submit', optionId: task.evaluation.correctOptionId }];
    case TEMPLATE.TYPING:
      return [{ seq: 1, action: 'submit', value: task.evaluation.acceptedResponses[0] }];
    case TEMPLATE.FLY_REORDER: {
      const pool = [...task.tiles];
      const ids = [...task.evaluation.acceptedResponses[0]].map((letter) => {
        const index = pool.findIndex((t: Json) => t.text === letter);
        return pool.splice(index, 1)[0].id;
      });
      return [...ids.map((tileId, i) => ({ seq: i + 1, action: 'tap_tile', tileId })), { seq: ids.length + 1, action: 'submit', tileIds: ids }];
    }
    case TEMPLATE.MATCH:
      return task.evaluation.correctPairs.map((p: Json, i: number) => ({ seq: i + 1, action: 'pair', ...p }));
    case TEMPLATE.SURGERY:
      return [{ seq: 1, action: 'submit', graphemeIndex: task.evaluation.wrongGraphemeIndex, replacement: task.evaluation.replacement }];
    case TEMPLATE.RECORDING:
      return receiptId
        ? [{ seq: 1, action: 'assessed', assessmentReceiptId: receiptId }]
        : [{ seq: 1, action: 'unavailable', reason: 'microphoneDenied' }];
    default:
      throw new Error(`No driver for ${task.template}`);
  }
}

export interface AnswerOptions {
  override?: (task: Json) => Json[] | undefined;
  deliveryMode?: string;
  receipts?: Map<string, string>;
}

export const wrongEvents = (task: Json): Json[] => {
  if (task.options) return [{ seq: 1, action: 'submit', optionId: wrongOption(task) }];
  if (task.template === TEMPLATE.TYPING) return [{ seq: 1, action: 'submit', value: 'zzz' }];
  if (task.template === TEMPLATE.FLY_REORDER) {
    const ids = task.tiles.map((t: Json) => t.id);
    return [...ids.map((tileId: number, i: number) => ({ seq: i + 1, action: 'tap_tile', tileId })), { seq: ids.length + 1, action: 'submit', tileIds: ids }];
  }
  throw new Error(`No wrong events for ${task.template}`);
};

export function answers(plan: Json, { override, deliveryMode = 'audio', receipts }: AnswerOptions = {}) {
  return {
    learnStepsCompleted: learnIds(plan),
    taskResults: tasksOf(plan).map((task) => ({
      taskId: task.id,
      events: override?.(task) ?? correctEvents(task, receipts?.get(task.id)),
      ...(task.prompt?.type === 'audio' && { deliveryMode }),
    })),
  };
}
