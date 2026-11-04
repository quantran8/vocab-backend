import { TEMPLATE, Template, VARIANT, Variant } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';

export type Rng = () => number;

export interface LearnSlot { kind: 'learn'; meaningIndex: number }
export interface TaskSlot { kind: 'task'; meaningIndex: number; template: Template; variant: Variant; isFirstRecall: boolean }
export type PlanSlot = LearnSlot | TaskSlot;

export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Keeps a Meaning out of adjacent rounds' boundary, so its answer never directly precedes its own task.
function roundOrder(count: number, previousLast: number | undefined, rng: Rng) {
  const order = shuffle(Array.from({ length: count }, (_, i) => i), rng);
  if (count > 1 && order[0] === previousLast) [order[0], order[1]] = [order[1], order[0]];
  return order;
}

const pickRecall = (rng: Rng) =>
  rng() < POLICY.newLearning.recallTypingWeight
    ? { template: TEMPLATE.TYPING, variant: VARIANT.MEANING_RECALL }
    : { template: TEMPLATE.FLY_REORDER, variant: VARIANT.SPELLING_RECALL };

// Even batches of at most introBatchSize, so no batch is left with a lone trailing Meaning.
function batchSizes(count: number) {
  const batches = Math.ceil(count / POLICY.newLearning.introBatchSize);
  return Array.from({ length: batches }, (_, i) => Math.floor((count + i) / batches));
}

/** Per batch of 2-3 Meanings: their learn cards back to back, then the trial cycle interleaved. */
export function planNewMeanings(count: number, rng: Rng): PlanSlot[] {
  const slots: PlanSlot[] = [];
  let offset = 0;
  for (const size of batchSizes(count)) {
    slots.push(...planBatch(size, offset, rng));
    offset += size;
  }
  return slots;
}

/** Trial cycle per Meaning: gloss -> reverseGloss -> typing|flyReorder -> recording -> gloss, interleaved. */
function planBatch(count: number, offset: number, rng: Rng): PlanSlot[] {
  const slots: PlanSlot[] = [];
  const task = (meaningIndex: number, template: Template, variant: Variant, isFirstRecall = false): TaskSlot => ({
    kind: 'task', meaningIndex: meaningIndex + offset, template, variant, isFirstRecall,
  });

  let last: number | undefined;
  const round = (add: (meaningIndex: number) => void) => {
    const order = roundOrder(count, last, rng);
    order.forEach(add);
    last = order.at(-1);
  };

  for (let i = 0; i < count; i += 1) slots.push({ kind: 'learn', meaningIndex: i + offset });
  round((i) => slots.push(task(i, TEMPLATE.SELECT, VARIANT.GLOSS)));
  round((i) => slots.push(task(i, TEMPLATE.SELECT, VARIANT.REVERSE_GLOSS)));
  round((i) => {
    const recall = pickRecall(rng);
    slots.push(task(i, recall.template, recall.variant, true));
  });
  round((i) => slots.push(task(i, TEMPLATE.RECORDING, VARIANT.SCRIPTED_PRONUNCIATION)));
  round((i) => slots.push(task(i, TEMPLATE.SELECT, VARIANT.GLOSS)));
  return slots;
}

export function pickWeighted<T>(entries: readonly { value: T; weight: number }[], rng: Rng): T | undefined {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) return undefined;
  let cursor = rng() * total;
  for (const entry of entries) {
    cursor -= entry.weight;
    if (cursor < 0) return entry.value;
  }
  return entries.at(-1)?.value;
}
