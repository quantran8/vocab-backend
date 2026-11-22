import {
  ASSESSMENT_INTENT, AssessmentIntent, FSRS_GRADE, MEMORY_SIGNAL, NEW_WORD_GROUP, NewWordGroup, OUTCOME, Outcome, PRACTICE_EXCLUDED_REASON,
  PRACTICE_GROUP, PracticeExcludedReason, PracticeGroup, RESULT_CAUSE, ResultCause, REVIEW_GROUP, ReviewGroup, Skill, SPEAKING_CHANGE,
  PronunciationBand, SPEAKING_METHOD, SpeakingChange, StoredSpeakingStatus, TASK_PHASE,
} from '../../../common/constants/domain';
import { MemoryDraft, signalOf } from '../../memory-srs/memory-reducer';
import { SrsState } from '../../memory-srs/fsrs';
import { skillOf } from '../../practice-resolver/task-skill';
import { ServerEvaluation } from '../../practice-resolver/task.types';
import { SpeakingResult } from '../../speaking/speaking-progress';
import { pronunciationBand } from '../../speech/domain/pronunciation-bands';
import { EvaluatedTask, LearnStepRow, TargetRow } from './commit-evaluator';

/** What the results screen shows for a Meaning, read at commit in the learner's explanation locale. */
export interface MeaningLabel {
  meaningId: string;
  wordId: string;
  lemma: string;
  gloss: string;
  pronunciationIds: string[];
}

export class Labels {
  private readonly byMeaning: Map<string, MeaningLabel>;
  private readonly byPronunciation = new Map<string, MeaningLabel[]>();

  constructor(labels: MeaningLabel[]) {
    this.byMeaning = new Map(labels.map((l) => [l.meaningId, l]));
    for (const label of labels) {
      for (const id of label.pronunciationIds) this.byPronunciation.set(id, [...(this.byPronunciation.get(id) ?? []), label]);
    }
  }

  meaning(id: string) {
    return this.byMeaning.get(id);
  }

  /** A pronunciation is shared by the Meanings of one word type; prefer one the session is about. */
  ofTarget(target: Pick<TargetRow, 'meaningId' | 'pronunciationId'>, prefer?: Set<string>) {
    if (target.meaningId) return this.byMeaning.get(target.meaningId);
    const owners = target.pronunciationId ? this.byPronunciation.get(target.pronunciationId) ?? [] : [];
    return owners.find((o) => prefer?.has(o.meaningId)) ?? owners[0];
  }

  ownersOf(pronunciationId: string) {
    return (this.byPronunciation.get(pronunciationId) ?? []).map((l) => l.meaningId);
  }
}

const item = (meaningId: string, labels: Labels) => {
  const label = labels.meaning(meaningId);
  return { meaningId, wordId: label?.wordId ?? null, lemma: label?.lemma ?? '', gloss: label?.gloss ?? '' };
};

const emptyGroups = <K extends string, T>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, [] as T[]])) as Record<K, T[]>;

const iso = (date: Date | undefined) => date?.toISOString() ?? null;

/** Meanings in the order the plan first shows them. */
export function planOrder(tasks: { id: string; ordinal: number }[], targets: TargetRow[], steps: LearnStepRow[]) {
  const ordinal = new Map(tasks.map((t) => [t.id, t.ordinal]));
  const first = new Map<string, number>();
  for (const target of targets) {
    if (!target.meaningId) continue;
    const at = ordinal.get(target.taskId) ?? Number.MAX_SAFE_INTEGER;
    if (at < (first.get(target.meaningId) ?? Number.MAX_SAFE_INTEGER)) first.set(target.meaningId, at);
  }
  for (const step of steps) {
    const card = ordinal.get(step.firstRecallTaskId) ?? Number.MAX_SAFE_INTEGER;
    if (card < (first.get(step.meaningId) ?? Number.MAX_SAFE_INTEGER)) first.set(step.meaningId, card);
  }
  return (ids: Iterable<string>) => [...ids].sort((a, b) => (first.get(a) ?? Number.MAX_SAFE_INTEGER) - (first.get(b) ?? Number.MAX_SAFE_INTEGER));
}

// --- Why a word is in a weaker group ---------------------------------------------------------------

/** One answer to a task, with what the results sheet needs to explain it. */
interface Answer {
  intent: AssessmentIntent;
  outcome: Outcome;
  hintCount: number;
  attemptCount: number;
  ordinal: number;
  skill: Skill | null;
}

// Worst first: the cause shown is the most serious thing that happened to the word.
const CAUSE_ORDER: ResultCause[] = [
  RESULT_CAUSE.REVEALED, RESULT_CAUSE.OUT_OF_TRIES, RESULT_CAUSE.WRONG_CHOICE, RESULT_CAUSE.NOT_PASSED,
  RESULT_CAUSE.RETRIED, RESULT_CAUSE.HINTED, RESULT_CAUSE.PRIMED,
];

/** What went wrong in one answer; null for a clean one or one that says nothing (no mic, unusable audio). */
function answerCause({ intent, outcome, hintCount }: Pick<Answer, 'intent' | 'outcome' | 'hintCount'>): ResultCause | null {
  switch (outcome) {
    case OUTCOME.REVEALED:
      return RESULT_CAUSE.REVEALED;
    case OUTCOME.INCORRECT:
      return intent === ASSESSMENT_INTENT.MEANING_RECALL ? RESULT_CAUSE.OUT_OF_TRIES : RESULT_CAUSE.WRONG_CHOICE;
    case OUTCOME.CORRECTED_AFTER_RETRY:
      return intent === ASSESSMENT_INTENT.MEANING_RECALL ? RESULT_CAUSE.RETRIED : RESULT_CAUSE.WRONG_CHOICE;
    case OUTCOME.ASSESSED_FAILED:
      return RESULT_CAUSE.NOT_PASSED;
    case OUTCOME.CORRECT:
      return hintCount > 0 ? RESULT_CAUSE.HINTED : null;
    default:
      return null;
  }
}

/** The worst cause among `answers`, from the earliest task on a tie, with the skill that task trains. */
function worstCause(answers: Answer[]): { cause: ResultCause; struggledAt?: Skill } | null {
  let worst: { cause: ResultCause; answer: Answer } | null = null;
  for (const answer of answers) {
    const cause = answerCause(answer);
    if (!cause) continue;
    const rank = CAUSE_ORDER.indexOf(cause);
    const best = worst ? CAUSE_ORDER.indexOf(worst.cause) : Number.MAX_SAFE_INTEGER;
    if (rank < best || (rank === best && answer.ordinal < worst!.answer.ordinal)) worst = { cause, answer };
  }
  if (!worst) return null;
  return { cause: worst.cause, ...(worst.answer.skill && { struggledAt: worst.answer.skill }) };
}

/** Every counted answer, by the Meaning it targets (a pronunciation-only target counts for its owners in `scope`). */
function answersByMeaning(counted: EvaluatedTask[], targets: TargetRow[], labels: Labels, scope: Set<string>, phase?: string) {
  const byTarget = new Map(targets.map((t) => [`${t.taskId}:${t.ordinal}`, t]));
  const answers = new Map<string, Answer[]>();
  for (const evaluated of counted) {
    if (phase && evaluated.task.phase !== phase) continue;
    const server = evaluated.task.serverEvaluation as ServerEvaluation;
    // Speaking in Daily is opt-in practice: it never decides a word's group.
    if (server.intent === ASSESSMENT_INTENT.PRONUNCIATION) continue;
    for (const outcome of evaluated.targets) {
      const target = byTarget.get(`${evaluated.task.id}:${outcome.ordinal}`);
      if (!target) continue;
      const owners = target.meaningId ? [target.meaningId] : target.pronunciationId ? labels.ownersOf(target.pronunciationId) : [];
      for (const meaningId of owners.filter((id) => scope.has(id))) {
        answers.set(meaningId, [...(answers.get(meaningId) ?? []), {
          intent: server.intent,
          outcome: outcome.outcome,
          hintCount: outcome.hintCount,
          attemptCount: outcome.attemptCount,
          ordinal: evaluated.task.ordinal,
          skill: skillOf(server.intent, server.promptIsTargetAudio),
        }]);
      }
    }
  }
  return answers;
}

// --- Daily: review ---------------------------------------------------------------------------------

// By correctness, not evidence weight: a clean select is remembered even though it moves the schedule less.
function reviewGroupOf(draft: MemoryDraft): ReviewGroup {
  if (draft.grade === FSRS_GRADE.AGAIN) return REVIEW_GROUP.RELEARN;
  return draft.grade === FSRS_GRADE.HARD ? REVIEW_GROUP.SHAKY : REVIEW_GROUP.SOLID;
}

/** Only the answers that gave the deciding signal explain the group; a later clean answer does not. */
function reviewCause(draft: MemoryDraft, answers: Answer[]) {
  if (draft.grade === FSRS_GRADE.AGAIN) return worstCause(answers.filter((a) => signalOf(a) === draft.signal));
  if (draft.grade !== FSRS_GRADE.HARD) return null;
  if (draft.signal === MEMORY_SIGNAL.ASSISTED_RECALL) return worstCause(answers.filter((a) => signalOf(a) === draft.signal));
  if (draft.isPrimed) return { cause: RESULT_CAUSE.PRIMED };
  // A clean recall that outranked a wrong pick: the pick is the doubt.
  return worstCause(answers);
}

export function reviewSummary(input: {
  memory: MemoryDraft[];
  progress: Map<string, SrsState>;
  learnedHere: Set<string>;
  newStates: Map<string, SrsState>;
  counted: EvaluatedTask[];
  targets: TargetRow[];
  labels: Labels;
  order: (ids: Iterable<string>) => string[];
}) {
  const { memory, progress, learnedHere, newStates, counted, targets, labels, order } = input;
  type ReviewItem = ReturnType<typeof item> & { nextReviewAt: string | null; learnedAt: string | null; cause?: ResultCause; struggledAt?: Skill };
  const groups = emptyGroups<ReviewGroup, ReviewItem>(Object.values(REVIEW_GROUP));
  const drafts = new Map(memory.filter((m) => !learnedHere.has(m.meaningId) && progress.has(m.meaningId)).map((m) => [m.meaningId, m]));
  const answers = answersByMeaning(counted, targets, labels, new Set(drafts.keys()));
  for (const meaningId of order(drafts.keys())) {
    const draft = drafts.get(meaningId)!;
    groups[reviewGroupOf(draft)].push({
      ...item(meaningId, labels),
      nextReviewAt: iso(newStates.get(meaningId)?.nextReviewAt),
      learnedAt: iso(progress.get(meaningId)?.learnedAt),
      ...reviewCause(draft, answers.get(meaningId) ?? []),
    });
  }
  return { total: drafts.size, groups };
}

// --- Daily: new words ------------------------------------------------------------------------------

/** The group one answer puts a new word in; null when it says nothing about the learner (no mic, unusable recording). */
const SEVERITY = { CLEAN: 0, RETRIED: 1, REVEALED: 2 } as const;

function newWordGroupOf({ outcome, hintCount }: Pick<Answer, 'outcome' | 'hintCount'>): { group: Exclude<NewWordGroup, 'known'>; severity: number } | null {
  switch (outcome) {
    case OUTCOME.UNAVAILABLE:
    case OUTCOME.INVALID:
      return null;
    case OUTCOME.REVEALED:
    case OUTCOME.INCORRECT:
      return { group: NEW_WORD_GROUP.REVEALED, severity: SEVERITY.REVEALED };
    case OUTCOME.CORRECTED_AFTER_RETRY:
    case OUTCOME.ASSESSED_FAILED:
      return { group: NEW_WORD_GROUP.RETRIED, severity: SEVERITY.RETRIED };
    case OUTCOME.CORRECT:
      return hintCount > 0 ? { group: NEW_WORD_GROUP.RETRIED, severity: SEVERITY.RETRIED } : { group: NEW_WORD_GROUP.SMOOTH, severity: SEVERITY.CLEAN };
    case OUTCOME.ASSESSED_PASSED:
      return { group: NEW_WORD_GROUP.SMOOTH, severity: SEVERITY.CLEAN };
  }
}

export function newWordSummary(input: {
  steps: LearnStepRow[];
  counted: EvaluatedTask[];
  targets: TargetRow[];
  known: Set<string>;
  newStates: Map<string, SrsState>;
  labels: Labels;
}) {
  const { steps, counted, targets, known, newStates, labels } = input;
  const answers = answersByMeaning(counted, targets, labels, new Set(steps.map((s) => s.meaningId)), TASK_PHASE.NEW_PRACTICE);

  type NewWordItem = ReturnType<typeof item> & { nextReviewAt: string | null; cause?: ResultCause; struggledAt?: Skill };
  const groups = emptyGroups<NewWordGroup, NewWordItem>(Object.values(NEW_WORD_GROUP));
  for (const step of steps) {
    const base = { ...item(step.meaningId, labels), nextReviewAt: iso(newStates.get(step.meaningId)?.nextReviewAt) };
    if (known.has(step.meaningId)) {
      groups[NEW_WORD_GROUP.KNOWN].push(base);
      continue;
    }
    const mine = answers.get(step.meaningId) ?? [];
    const group = mine.reduce<{ group: Exclude<NewWordGroup, 'known'>; severity: number }>(
      (w, a) => { const g = newWordGroupOf(a); return g && g.severity > w.severity ? g : w; },
      { group: NEW_WORD_GROUP.SMOOTH, severity: SEVERITY.CLEAN }).group;
    // The cause comes from the answers that put the word in its group, worst first.
    const deciding = mine.filter((a) => newWordGroupOf(a)?.group === group);
    groups[group].push(group === NEW_WORD_GROUP.SMOOTH ? base : { ...base, ...worstCause(deciding) });
  }
  const total = steps.length - groups[NEW_WORD_GROUP.KNOWN].length;
  return { total, groups };
}

// --- Random / Weak: practice answers ---------------------------------------------------------------

const EXCLUDED: Partial<Record<Outcome, PracticeExcludedReason>> = {
  [OUTCOME.INVALID]: PRACTICE_EXCLUDED_REASON.INVALID_RECORDING,
  [OUTCOME.UNAVAILABLE]: PRACTICE_EXCLUDED_REASON.UNAVAILABLE,
};

function practiceGroupOf(outcome: Outcome, hintCount: number, isPrimed: boolean): PracticeGroup {
  switch (outcome) {
    case OUTCOME.CORRECT:
      return hintCount > 0 || isPrimed ? PRACTICE_GROUP.HELPED : PRACTICE_GROUP.CLEAN;
    case OUTCOME.CORRECTED_AFTER_RETRY:
      return PRACTICE_GROUP.HELPED;
    case OUTCOME.ASSESSED_PASSED:
      return PRACTICE_GROUP.CLEAN;
    default:
      return PRACTICE_GROUP.MISSED;
  }
}

/** One item per counted task target; answers that say nothing about the learner are only counted as excluded. */
export function practiceSummary(input: { counted: EvaluatedTask[]; targets: TargetRow[]; labels: Labels; sessionMeanings: Set<string> }) {
  const { counted, targets, labels, sessionMeanings } = input;
  const byTarget = new Map(targets.map((t) => [`${t.taskId}:${t.ordinal}`, t]));
  const groups = emptyGroups<PracticeGroup, ReturnType<typeof item> & { skill: Skill | null }>(Object.values(PRACTICE_GROUP));
  const reasons = new Set<PracticeExcludedReason>();
  let excluded = 0;

  for (const { task, targets: outcomes } of counted) {
    const server = task.serverEvaluation as ServerEvaluation;
    for (const o of outcomes) {
      const reason = EXCLUDED[o.outcome];
      if (reason) {
        excluded += 1;
        reasons.add(reason);
        continue;
      }
      const target = byTarget.get(`${task.id}:${o.ordinal}`);
      const label = target && labels.ofTarget(target, sessionMeanings);
      if (!label) continue;
      groups[practiceGroupOf(o.outcome, o.hintCount, server.isPrimed)].push({
        ...item(label.meaningId, labels),
        skill: skillOf(server.intent, server.promptIsTargetAudio),
      });
    }
  }
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  return { total, excluded: { count: excluded, reasons: [...reasons].sort() }, groups };
}

// --- Every mode: speaking --------------------------------------------------------------------------

export interface SpeakingOutcome { result: SpeakingResult; status: StoredSpeakingStatus; change: SpeakingChange | null }

/**
 * Null when the session scored no recording. `groups` lists every counted result in plan order, split by `passed`.
 * `score` and `band` come from the Azure receipt the result used (band as the assessment showed it); both null on-device.
 */
export function speakingSummary(input: { outcomes: SpeakingOutcome[]; labels: Labels; sessionMeanings: Set<string> }) {
  const { outcomes, labels, sessionMeanings } = input;
  if (outcomes.length === 0) return null;
  type SpeakingItem = ReturnType<typeof item> & { status: StoredSpeakingStatus; score: number | null; band: PronunciationBand | null };
  const items = (keep: (o: SpeakingOutcome) => boolean) => outcomes.filter(keep).flatMap(({ result, status }): SpeakingItem[] => {
    const label = labels.ofTarget({ meaningId: null, pronunciationId: result.pronunciationId }, sessionMeanings);
    if (!label) return [];
    const azure = result.method === SPEAKING_METHOD.AZURE;
    return [{ ...item(label.meaningId, labels), status, score: azure ? result.score : null, band: azure ? pronunciationBand(result.score) : null }];
  });
  return {
    total: outcomes.length,
    passed: outcomes.filter((o) => o.result.passed).length,
    groups: { passed: items((o) => o.result.passed), notPassed: items((o) => !o.result.passed) },
    becameFluent: items((o) => o.change === SPEAKING_CHANGE.BECAME_FLUENT),
    slipped: items((o) => o.change === SPEAKING_CHANGE.SLIPPED),
  };
}

/** Practice that served as the due review: a word due before the session, answered cleanly (GOOD or EASY). */
export function countedAsReview(input: {
  memory: MemoryDraft[];
  progress: Map<string, SrsState>;
  newStates: Map<string, SrsState>;
  now: Date;
  labels: Labels;
  order: (ids: Iterable<string>) => string[];
}) {
  const { memory, progress, newStates, now, labels, order } = input;
  const ids = memory
    .filter((m) => {
      const state = progress.get(m.meaningId);
      return state !== undefined && state.nextReviewAt <= now && (m.grade === FSRS_GRADE.GOOD || m.grade === FSRS_GRADE.EASY);
    })
    .map((m) => m.meaningId);
  return order(ids).map((meaningId) => ({ ...item(meaningId, labels), nextReviewAt: iso(newStates.get(meaningId)?.nextReviewAt) }));
}
