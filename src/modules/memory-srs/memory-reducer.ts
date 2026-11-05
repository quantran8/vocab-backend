import { ASSESSMENT_INTENT, AssessmentIntent, MEMORY_SIGNAL, MemorySignal, OUTCOME, Outcome } from '../../common/constants/domain';
import { POLICY } from '../../config/policy';

export interface MemoryFact {
  taskId: string;
  ordinal: number;
  meaningId: string | null;
  intent: AssessmentIntent;
  outcome: Outcome;
  hintCount: number;
  attemptCount: number;
  isPrimed: boolean;
}

export interface MemoryDraft {
  meaningId: string;
  signal: MemorySignal;
  isPrimed: boolean;
  sourceTaskIds: string[];
}

// Grading rules — see memory memory-assessment-rework.
export const isLightRetry = ({ outcome, attemptCount, hintCount }: Pick<MemoryFact, 'outcome' | 'attemptCount' | 'hintCount'>) =>
  outcome === OUTCOME.CORRECTED_AFTER_RETRY && attemptCount === POLICY.memory.lightRetryAttempts && hintCount === 0;

const recallSignal = (fact: MemoryFact): MemorySignal => {
  if (isLightRetry(fact)) return MEMORY_SIGNAL.ASSISTED_RECALL;
  if (fact.outcome !== OUTCOME.CORRECT) return MEMORY_SIGNAL.FAILED_RECALL;
  return fact.hintCount > 0 ? MEMORY_SIGNAL.ASSISTED_RECALL : MEMORY_SIGNAL.UNAIDED_RECALL;
};

const recognitionSignal = (fact: MemoryFact): MemorySignal =>
  fact.outcome === OUTCOME.CORRECT && fact.hintCount === 0 ? MEMORY_SIGNAL.RECOGNITION_SUCCESS : MEMORY_SIGNAL.FAILED_RECOGNITION;

// Worst first: a wrong recall must not be hidden by a later success.
const SEVERITY: MemorySignal[] = [
  MEMORY_SIGNAL.FAILED_RECALL,
  MEMORY_SIGNAL.ASSISTED_RECALL,
  MEMORY_SIGNAL.UNAIDED_RECALL,
  MEMORY_SIGNAL.FAILED_RECOGNITION,
  MEMORY_SIGNAL.RECOGNITION_SUCCESS,
];

const signalOf = (fact: MemoryFact) => {
  if (fact.intent === ASSESSMENT_INTENT.MEANING_RECALL) return recallSignal(fact);
  return fact.intent === ASSESSMENT_INTENT.MEANING_RECOGNITION ? recognitionSignal(fact) : null;
};

/** At most one observation per Meaning per session; recall outranks recognition. */
export function reduceMemory(facts: MemoryFact[]): MemoryDraft[] {
  const byMeaning = new Map<string, { fact: MemoryFact; signal: MemorySignal }[]>();
  for (const fact of facts) {
    const signal = signalOf(fact);
    if (!signal || !fact.meaningId) continue;
    const list = byMeaning.get(fact.meaningId) ?? [];
    list.push({ fact, signal });
    byMeaning.set(fact.meaningId, list);
  }

  return [...byMeaning].map(([meaningId, entries]) => {
    const signal = SEVERITY.find((s) => entries.some((e) => e.signal === s))!;
    const sources = entries.filter((e) => e.signal === signal);
    return {
      meaningId,
      signal,
      isPrimed: sources.some((e) => e.fact.isPrimed),
      sourceTaskIds: entries.map((e) => e.fact.taskId),
    };
  });
}
