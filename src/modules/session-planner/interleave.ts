import { TEMPLATE, Template, VARIANT, Variant } from '../../common/constants/domain';
import { POLICY } from '../../config/policy';

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
    ? { template: TEMPLATE.typing, variant: VARIANT.meaningRecall }
    : { template: TEMPLATE.flyReorder, variant: VARIANT.spellingRecall };

/** Trial cycle per Meaning: gloss -> reverseGloss -> typing|flyReorder -> recording -> gloss, interleaved. */
export function planNewMeanings(count: number, rng: Rng): PlanSlot[] {
  if (count === 0) return [];
  const slots: PlanSlot[] = [];
  const task = (meaningIndex: number, template: Template, variant: Variant, isFirstRecall = false): TaskSlot => ({
    kind: 'task', meaningIndex, template, variant, isFirstRecall,
  });

  let last: number | undefined;
  const round = (add: (meaningIndex: number) => void) => {
    const order = roundOrder(count, last, rng);
    order.forEach(add);
    last = order.at(-1);
  };

  round((i) => slots.push({ kind: 'learn', meaningIndex: i }, task(i, TEMPLATE.select, VARIANT.gloss)));
  round((i) => slots.push(task(i, TEMPLATE.select, VARIANT.reverseGloss)));
  round((i) => {
    const recall = pickRecall(rng);
    slots.push(task(i, recall.template, recall.variant, true));
  });
  round((i) => slots.push(task(i, TEMPLATE.recording, VARIANT.scriptedPronunciation)));
  round((i) => slots.push(task(i, TEMPLATE.select, VARIANT.gloss)));
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
