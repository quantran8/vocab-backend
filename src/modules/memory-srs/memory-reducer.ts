import { ASSESSMENT_INTENT, AssessmentIntent, FSRS_GRADE, FsrsGrade, MEMORY_SIGNAL, MemorySignal, OUTCOME, Outcome } from '../../common/constants/domain';
import { POLICY } from '../../config/policy';
import { answerWeight, combineWeights, isEasyAnswer } from './evidence-weight';

export interface MemoryFact {
  taskId: string;
  ordinal: number;
  meaningId: string | null;
  intent: AssessmentIntent;
  outcome: Outcome;
  hintCount: number;
  attemptCount: number;
  isPrimed: boolean;
  variant: string | null;
  optionCount: number | null;
  promptIsTargetAudio: boolean;
  /** ms from showing the task to its first submit; null when the client did not send timing. */
  firstSubmitMs: number | null;
  /** Answer length for the Easy threshold (characters or tiles). */
  answerUnits: number;
}

export interface MemoryDraft {
  meaningId: string;
  signal: MemorySignal;
  isPrimed: boolean;
  sourceTaskIds: string[];
  /** null: the session says nothing the schedule can use (only classless tasks). */
  grade: FsrsGrade | null;
  weight: number;
}

// Grading rules — see memory memory-assessment-rework.
export const isLightRetry = ({ outcome, attemptCount, hintCount }: Pick<MemoryFact, 'outcome' | 'attemptCount' | 'hintCount'>) =>
  outcome === OUTCOME.CORRECTED_AFTER_RETRY && attemptCount === POLICY.memory.lightRetryAttempts && hintCount === 0;

const recallSignal = (fact: Pick<MemoryFact, 'outcome' | 'hintCount' | 'attemptCount'>): MemorySignal => {
  if (isLightRetry(fact)) return MEMORY_SIGNAL.ASSISTED_RECALL;
  if (fact.outcome !== OUTCOME.CORRECT) return MEMORY_SIGNAL.FAILED_RECALL;
  return fact.hintCount > 0 ? MEMORY_SIGNAL.ASSISTED_RECALL : MEMORY_SIGNAL.UNAIDED_RECALL;
};

const recognitionSignal = (fact: Pick<MemoryFact, 'outcome' | 'hintCount'>): MemorySignal =>
  fact.outcome === OUTCOME.CORRECT && fact.hintCount === 0 ? MEMORY_SIGNAL.RECOGNITION_SUCCESS : MEMORY_SIGNAL.FAILED_RECOGNITION;

// Worst first: a wrong recall must not be hidden by a later success.
const SEVERITY: MemorySignal[] = [
  MEMORY_SIGNAL.FAILED_RECALL,
  MEMORY_SIGNAL.ASSISTED_RECALL,
  MEMORY_SIGNAL.UNAIDED_RECALL,
  MEMORY_SIGNAL.FAILED_RECOGNITION,
  MEMORY_SIGNAL.RECOGNITION_SUCCESS,
];

/** The memory signal one answer gives; null for intents that say nothing about memory. */
export const signalOf = (fact: Pick<MemoryFact, 'intent' | 'outcome' | 'hintCount' | 'attemptCount'>) => {
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
    const isPrimed = sources.some((e) => e.fact.isPrimed);
    return {
      meaningId,
      signal,
      isPrimed,
      sourceTaskIds: entries.map((e) => e.fact.taskId),
      ...gradeOf(signal, isPrimed, entries),
    };
  });
}

const CLEAN_SIGNALS: MemorySignal[] = [MEMORY_SIGNAL.UNAIDED_RECALL, MEMORY_SIGNAL.RECOGNITION_SUCCESS];

function gradeOf(signal: MemorySignal, isPrimed: boolean, entries: { fact: MemoryFact; signal: MemorySignal }[]) {
  if (signal === MEMORY_SIGNAL.FAILED_RECALL || signal === MEMORY_SIGNAL.FAILED_RECOGNITION) return { grade: FSRS_GRADE.AGAIN, weight: 1 };
  // A recall that outranked a wrong pick, or any help, is a pass with doubt.
  if (signal === MEMORY_SIGNAL.ASSISTED_RECALL || isPrimed || entries.some((e) => e.signal === MEMORY_SIGNAL.FAILED_RECOGNITION)) {
    return { grade: FSRS_GRADE.HARD, weight: 1 };
  }
  const clean = entries.filter((e) => CLEAN_SIGNALS.includes(e.signal) && !e.fact.isPrimed).map((e) => e.fact);
  const weight = combineWeights(clean.map(answerWeight));
  if (weight === 0) return { grade: null, weight: 0 };
  const easy = clean.some((f) => isEasyAnswer(f.variant, f.firstSubmitMs, f.answerUnits));
  return { grade: easy ? FSRS_GRADE.EASY : FSRS_GRADE.GOOD, weight };
}
