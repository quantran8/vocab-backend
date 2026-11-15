import { CLASS_BY_VARIANT, EVIDENCE_CLASS, EvidenceClass, Variant } from '../../common/constants/domain';
import { POLICY } from '../../config/policy';

const E = POLICY.memoryEvidence;

// Easiest first: an audio bonus never lifts a class above the next one.
const CLASS_ORDER: EvidenceClass[] = [EVIDENCE_CLASS.RECOGNIZE, EVIDENCE_CLASS.RECOGNIZE_CONTEXT, EVIDENCE_CLASS.RECALL_ASSEMBLED, EVIDENCE_CLASS.RECALL_PRODUCE];
const RECALL_CLASSES: EvidenceClass[] = [EVIDENCE_CLASS.RECALL_ASSEMBLED, EVIDENCE_CLASS.RECALL_PRODUCE];

export interface AnswerShape {
  variant: string | null;
  /** Choices shown (select options, match pairs); null for recall templates. */
  optionCount: number | null;
  promptIsTargetAudio: boolean;
}

export const evidenceClassOf = (variant: string | null): EvidenceClass | null => CLASS_BY_VARIANT[variant as Variant] ?? null;

const beyondChance = (n: number) => Math.max(0, 1 - 1 / n);

/** Memory evidence of one clean correct answer, 0 for a task that does not test meaning. */
export function answerWeight({ variant, optionCount, promptIsTargetAudio }: AnswerShape): number {
  const cls = evidenceClassOf(variant);
  if (!cls) return 0;
  let weight: number = E.weights[cls];
  if (optionCount !== null && !RECALL_CLASSES.includes(cls)) weight *= beyondChance(optionCount) / beyondChance(E.baseOptionCount);
  if (promptIsTargetAudio) {
    const next = CLASS_ORDER[CLASS_ORDER.indexOf(cls) + 1];
    weight = Math.min(weight * E.audioFactor, next ? E.weights[next] : 1);
  }
  return Math.min(1, weight);
}

/** Independent pieces of evidence: three clean selects at 0.3 give about 0.66. Rounded to the stored precision. */
export const combineWeights = (weights: number[]) => Math.round(Math.min(1, 1 - weights.reduce((rest, w) => rest * (1 - w), 1)) * 1000) / 1000;

/** A fast first-try recall earns Easy; `units` is the answer's length (characters or tiles). */
export function isEasyAnswer(variant: string | null, firstSubmitMs: number | null, units: number) {
  const cls = evidenceClassOf(variant);
  if (firstSubmitMs === null || !cls || !RECALL_CLASSES.includes(cls)) return false;
  const limit = E.easy[cls as keyof typeof E.easy];
  return firstSubmitMs <= limit.baseMs + limit.perUnitMs * units;
}
