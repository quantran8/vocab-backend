import {
  ASSESSMENT_INTENT, AssessmentIntent, EVIDENCE_REASON, EvidenceReason, MEMORY_SIGNAL, NEW_WORD_GROUP, NewWordGroup, OUTCOME, Outcome,
  PRACTICE_GROUP, PracticeGroup, RESULT_CAUSE, ResultCause, REVIEW_GROUP, ReviewGroup, SKILL_CHANGE, SKILL_ISSUE, SKILL_STATUS, Skill, SkillChange,
  SkillStatus, TASK_PHASE, VALIDITY,
} from '../../../common/constants/domain';
import { addHours } from '../../../common/constants/time';
import { POLICY } from '../../../config/policy';
import { MemoryDraft, signalOf } from '../../memory-srs/memory-reducer';
import { SrsState } from '../../memory-srs/srs';
import { ServerEvaluation } from '../../practice-resolver/task.types';
import { deriveSkillStatus, EvidenceRow, isCleanPass, openIssue, SKILL_STATE_REASONS, skillOf } from '../../skill-verification/skill-evidence';
import { EvaluatedTask, EvidenceRowDraft, LearnStepRow, TargetRow } from './commit-evaluator';

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
  RESULT_CAUSE.RETRIED, RESULT_CAUSE.HINTED, RESULT_CAUSE.PRIMED, RESULT_CAUSE.RECOGNIZED_ONLY,
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

// Same signal that picks the SRS branch, so the group can never disagree with the new schedule.
function reviewGroupOf(draft: MemoryDraft): ReviewGroup {
  if (draft.signal === MEMORY_SIGNAL.UNAIDED_RECALL) return draft.isPrimed ? REVIEW_GROUP.SHAKY : REVIEW_GROUP.SOLID;
  if (draft.signal === MEMORY_SIGNAL.ASSISTED_RECALL || draft.signal === MEMORY_SIGNAL.RECOGNITION_SUCCESS) return REVIEW_GROUP.SHAKY;
  return REVIEW_GROUP.RELEARN;
}

/** Only the answers that gave the deciding signal explain the group; a later clean answer does not. */
function reviewCause(draft: MemoryDraft, answers: Answer[]) {
  if (draft.signal === MEMORY_SIGNAL.UNAIDED_RECALL) return draft.isPrimed ? { cause: RESULT_CAUSE.PRIMED } : null;
  const deciding = answers.filter((a) => signalOf(a) === draft.signal);
  if (draft.signal === MEMORY_SIGNAL.RECOGNITION_SUCCESS) {
    const first = deciding.reduce<Answer | null>((f, a) => (!f || a.ordinal < f.ordinal ? a : f), null);
    return { cause: RESULT_CAUSE.RECOGNIZED_ONLY, ...(first?.skill && { struggledAt: first.skill }) };
  }
  return worstCause(deciding);
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

// Reasons that come from the task or the device, not from the answer: the row never moves a skill.
const NOT_FROM_ANSWER: EvidenceReason[] = [
  EVIDENCE_REASON.WEAK_TEMPLATE, EVIDENCE_REASON.QUALITY_UNQUALIFIED, EVIDENCE_REASON.AUDIO_NOT_PLAYED,
  EVIDENCE_REASON.INVALID_RECORDING, EVIDENCE_REASON.NEW_PRACTICE, EVIDENCE_REASON.UNKNOWN,
];

/** Recorded on a recording task the learner could not do (no mic); there is no evidence row to carry it. */
export const RECORDING_UNAVAILABLE = OUTCOME.UNAVAILABLE;

function practiceGroupOf(draft: EvidenceRowDraft): PracticeGroup {
  if (draft.reasons.includes(EVIDENCE_REASON.REVEALED)) return PRACTICE_GROUP.MISSED;
  if (draft.passed) return draft.reasons.length === 0 ? PRACTICE_GROUP.CLEAN : PRACTICE_GROUP.HELPED;
  // A light retry is a right answer on the second try.
  return draft.reasons.includes(EVIDENCE_REASON.RETRIED) ? PRACTICE_GROUP.HELPED : PRACTICE_GROUP.MISSED;
}

const scopeKey = (skill: string, row: { meaningId: string | null; pronunciationId: string | null }) => `${skill}:${row.meaningId ?? row.pronunciationId}`;

export function practiceSummary(input: {
  counted: EvaluatedTask[];
  drafts: EvidenceRowDraft[];
  before: Map<string, EvidenceRow[]>;
  labels: Labels;
  sessionMeanings: Set<string>;
}) {
  const { counted, drafts, before, labels, sessionMeanings } = input;
  const groups = emptyGroups<PracticeGroup, ReturnType<typeof item> & { skill: Skill; hadIssue: boolean }>(Object.values(PRACTICE_GROUP));
  const reasons = new Set<string>();
  let excluded = 0;

  const withEvidence = new Set(drafts.map((d) => d.taskId));
  for (const evaluated of counted) {
    if (withEvidence.has(evaluated.task.id)) continue;
    excluded += 1;
    if (evaluated.targets.some((t) => t.outcome === OUTCOME.UNAVAILABLE)) reasons.add(RECORDING_UNAVAILABLE);
  }

  for (const draft of drafts) {
    const noise = draft.reasons.filter((r) => NOT_FROM_ANSWER.includes(r));
    if (draft.validity !== VALIDITY.VALID || noise.length > 0) {
      excluded += 1;
      noise.forEach((r) => reasons.add(r));
      continue;
    }
    const label = labels.ofTarget(draft, sessionMeanings);
    if (!label) continue;
    groups[practiceGroupOf(draft)].push({
      ...item(label.meaningId, labels),
      skill: draft.skill,
      hadIssue: openIssue(before.get(scopeKey(draft.skill, draft)) ?? []) !== null,
    });
  }
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  return { total, excluded: { count: excluded, reasons: [...reasons].sort() }, groups };
}

// --- Random / Weak: skill changes ------------------------------------------------------------------

const RANK: Record<SkillStatus, number> = { [SKILL_STATUS.NOT_VERIFIED]: 0, [SKILL_STATUS.DEMONSTRATED]: 1, [SKILL_STATUS.VERIFIED]: 2 };

export interface ChangeItem {
  meaningId: string;
  wordId: string | null;
  lemma: string;
  gloss: string;
  skill: Skill;
  from: SkillStatus;
  to: SkillStatus;
  confirmableAt?: string;
}

/** Rows that can move a skill, exactly as `ProgressRepository.evidence` reads them back. */
const statefulRows = (drafts: EvidenceRowDraft[], sessionId: string, now: Date) =>
  drafts
    .filter((d) => d.validity === VALIDITY.VALID && d.reasons.every((r) => SKILL_STATE_REASONS.includes(r)))
    .map((d) => ({ key: scopeKey(d.skill, d), draft: d, row: { sessionId, passed: d.passed, committedAt: now, reasons: d.reasons } as EvidenceRow }));

export function skillChanges(input: {
  drafts: EvidenceRowDraft[];
  before: Map<string, EvidenceRow[]>;
  sessionId: string;
  now: Date;
  labels: Labels;
  sessionMeanings: Set<string>;
}) {
  const { drafts, before, sessionId, now, labels, sessionMeanings } = input;
  const groups = emptyGroups<SkillChange, ChangeItem>(Object.values(SKILL_CHANGE));
  const added = Map.groupBy(statefulRows(drafts, sessionId, now), (r) => r.key);

  for (const [key, rows] of added) {
    const { draft } = rows[0];
    const label = labels.ofTarget(draft, sessionMeanings);
    if (!label) continue;
    const old = before.get(key) ?? [];
    const all = [...old, ...rows.map((r) => r.row)];
    const [from, to] = [deriveSkillStatus(old).status, deriveSkillStatus(all).status];
    const [issueBefore, issueAfter] = [openIssue(old), openIssue(all)];
    const base: ChangeItem = { ...item(label.meaningId, labels), skill: draft.skill, from, to };

    if (RANK[to] > RANK[from]) groups[SKILL_CHANGE.LEVELED_UP].push(base);
    if (issueBefore && !issueAfter) groups[SKILL_CHANGE.CLEARED].push(base);
    const sameIssue = issueBefore && issueAfter && issueAfter.at.getTime() === issueBefore.at.getTime();
    if (sameIssue && rows.some((r) => isCleanPass(r.row))) {
      groups[SKILL_CHANGE.PENDING_CONFIRM].push({ ...base, confirmableAt: addHours(issueBefore.at, POLICY.memory.recoveryHours).toISOString() });
    }
    const raisedNow = issueAfter && issueAfter.at.getTime() === now.getTime();
    if (raisedNow && issueAfter.issue === SKILL_ISSUE.FAILED) groups[SKILL_CHANGE.REGRESSED].push(base);
  }
  return groups;
}

/** Practice that served as the due review (`applyNonDaily`'s first branch): a due word recalled unaided and unprimed. */
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
      return state !== undefined && state.nextReviewAt <= now && m.signal === MEMORY_SIGNAL.UNAIDED_RECALL && !m.isPrimed;
    })
    .map((m) => m.meaningId);
  return order(ids).map((meaningId) => ({ ...item(meaningId, labels), nextReviewAt: iso(newStates.get(meaningId)?.nextReviewAt) }));
}
