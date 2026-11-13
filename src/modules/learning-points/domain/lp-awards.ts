import {
  CONTENT_PROVENANCE, ContentProvenance, LP_AWARD_TYPE, LpAwardType, OUTCOME, SESSION_MODE, SessionMode, TASK_PHASE,
} from '../../../common/constants/domain';
import { addHours, HOURS_PER_DAY, utcDay } from '../../../common/constants/time';
import { POLICY } from '../../../config/policy';
import type { EvaluatedTask, TargetRow } from '../../session-commit/domain/commit-evaluator';

const LP = POLICY.lp;
const EXTRA_MODES = new Set<SessionMode>([SESSION_MODE.RANDOM_PRACTICE, SESSION_MODE.WEAK_WORDS_PRACTICE, SESSION_MODE.CHECKPOINT_CHALLENGE]);
const NOT_AN_ATTEMPT = new Set<string>([OUTCOME.UNAVAILABLE, OUTCOME.INVALID]);

export interface PriorAward { type: LpAwardType; meaningId: string; awardedAt: Date; day: string; points: number; provenance: ContentProvenance }

export interface LpAwardInput {
  mode: SessionMode;
  now: Date;
  issuedAt: Date;
  evaluated: EvaluatedTask[];
  targets: TargetRow[];
  newMeaningIds: string[];
  known: Set<string>;
  /** SRS state before this commit; a Meaning without a row was not learned yet. */
  progress: Map<string, { nextReviewAt: Date }>;
  /** Today's awards plus, for this session's Meanings, every new award and the due awards inside the rolling window. */
  prior: PriorAward[];
  provenance: Map<string, ContentProvenance>;
}

export interface AwardDraft { type: LpAwardType; meaningId: string; points: number; awardKey: string; provenance: ContentProvenance }

/** Meanings with a genuine first submit, in plan order. Known checks never count: passing one earns nothing (spec §2.2). */
export function attemptedMeanings(evaluated: EvaluatedTask[], targets: TargetRow[]) {
  const meaningOf = new Map(targets.map((t) => [`${t.taskId}:${t.ordinal}`, t.meaningId]));
  const ids = evaluated
    .filter((e) => e.task.phase !== TASK_PHASE.KNOWN_CHECK)
    .flatMap((e) => e.targets
      .filter((o) => o.attemptCount > 0 && !NOT_AN_ATTEMPT.has(o.outcome))
      .map((o) => meaningOf.get(`${e.task.id}:${o.ordinal}`)));
  return [...new Set(ids.filter((id): id is string => !!id))];
}

/** lp_effort_trial_v1 (Ranking & Tier v1.2 §2): at most one award per Meaning per session, new → due → extra. */
export function lpAwards(input: LpAwardInput): AwardDraft[] {
  const { mode, now, issuedAt, progress, prior } = input;
  const today = utcDay(now);
  const todays = prior.filter((a) => a.day === today);
  const newEver = new Set(prior.filter((a) => a.type === LP_AWARD_TYPE.NEW_MEANING_COMPLETED).map((a) => a.meaningId));
  const newToday = new Set(todays.filter((a) => a.type === LP_AWARD_TYPE.NEW_MEANING_COMPLETED).map((a) => a.meaningId));
  const extraToday = new Set(todays.filter((a) => a.type === LP_AWARD_TYPE.EXTRA_PRACTICE_COMPLETED).map((a) => a.meaningId));
  let customNewLeft = LP.maxNewCustomMeaningsPerUtcDay - todays.filter((a) =>
    a.type === LP_AWARD_TYPE.NEW_MEANING_COMPLETED && a.provenance === CONTENT_PROVENANCE.CUSTOM_OWNED).length;
  let extraLPLeft = LP.maxExtraPracticeLPPerUtcDay - todays
    .filter((a) => a.type === LP_AWARD_TYPE.EXTRA_PRACTICE_COMPLETED).reduce((sum, a) => sum + a.points, 0);

  const provenance = (id: string) => input.provenance.get(id) ?? CONTENT_PROVENANCE.CATALOG;
  const draft = (type: LpAwardType, meaningId: string, points: number, awardKey: string): AwardDraft =>
    ({ type, meaningId, points, awardKey, provenance: provenance(meaningId) });
  const attempted = attemptedMeanings(input.evaluated, input.targets);
  const learnedHere = new Set(input.newMeaningIds);
  const awards: AwardDraft[] = [];

  // evaluateBatch already requires the Learn card and a submitted first recall for every taught Meaning.
  if (mode === SESSION_MODE.DAILY) {
    const attemptedSet = new Set(attempted);
    for (const id of input.newMeaningIds) {
      if (input.known.has(id) || !attemptedSet.has(id) || newEver.has(id)) continue;
      if (provenance(id) === CONTENT_PROVENANCE.CUSTOM_OWNED) {
        if (customNewLeft <= 0) continue;
        customNewLeft -= 1;
      }
      awards.push(draft(LP_AWARD_TYPE.NEW_MEANING_COMPLETED, id, LP.newMeaningLP, `new:${id}`));
    }
  }

  const dueGapFrom = addHours(now, -LP.minDueAwardGapHours);
  const windowFrom = addHours(now, -LP.dueAwardWindowDays * HOURS_PER_DAY);
  for (const id of attempted) {
    const state = progress.get(id);
    if (learnedHere.has(id) || !state) continue;
    // Due both when planned and at commit, so a word that came due mid-session cannot be farmed for +4.
    if (state.nextReviewAt <= issuedAt && state.nextReviewAt <= now) {
      const dues = prior.filter((a) => a.meaningId === id && a.type === LP_AWARD_TYPE.DUE_REVIEW_COMPLETED);
      const cooledDown = dues.every((a) => a.awardedAt <= dueGapFrom);
      const underCap = dues.filter((a) => a.awardedAt > windowFrom).length < LP.maxDueAwardsPerMeaningRolling7d;
      if (cooledDown && underCap) {
        awards.push(draft(LP_AWARD_TYPE.DUE_REVIEW_COMPLETED, id, LP.dueReviewLP, `due:${id}:${state.nextReviewAt.toISOString()}`));
        continue;
      }
    }
    if (!EXTRA_MODES.has(mode) || newToday.has(id) || extraToday.has(id) || extraLPLeft < LP.extraPracticeLP) continue;
    extraLPLeft -= LP.extraPracticeLP;
    awards.push(draft(LP_AWARD_TYPE.EXTRA_PRACTICE_COMPLETED, id, LP.extraPracticeLP, `extra:${id}:${today}`));
  }
  return awards;
}
