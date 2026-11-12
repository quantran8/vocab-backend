import {
  NEW_WORD_OVERRIDE_MODE, NEW_WORD_REASON, SCOPE_STATUS,
  type NewWordOverrideMode, type NewWordReason, type ScopeStatus, type WithheldReason,
} from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';

export interface NewWordOverride {
  value: number;
  mode: NewWordOverrideMode;
  until: Date | null;
}

export interface NewWordBudgetInput {
  goal: number;
  override: NewWordOverride | null;
  autoBalance: boolean;
  backlog: number;
  remaining: number;
  pendingCustom: number;
  reviewOnly?: boolean;
  now: Date;
}

export interface NewWordBudget {
  /** New words per session after every limit. */
  value: number;
  /** The learner's choice before scope limits; sizes the "low" scope status. */
  chosen: number;
  reason: NewWordReason;
}

const { backlogStatusThreshold, autoBalanceFloor, backlogPromptThreshold, backlogRepromptMultiplier, scopeLowWeeks } = POLICY.reviewLoad;

/** Reviews a daily session holds: the learner's choice, else the new-word goal, never below the minimum. */
export function reviewsPerSession(chosen: number | null, dailyNewWordGoal: number): number {
  return chosen ?? Math.max(dailyNewWordGoal, POLICY.session.reviewsPerSession.min);
}

export function activeOverride(override: NewWordOverride | null, now: Date): NewWordOverride | null {
  if (!override) return null;
  if (override.mode === NEW_WORD_OVERRIDE_MODE.UNTIL_DATE && (!override.until || override.until <= now)) return null;
  return override;
}

export function autoBalanced(goal: number, backlog: number): number {
  if (backlog <= backlogStatusThreshold) return goal;
  return Math.max(Math.min(goal, autoBalanceFloor), Math.round((goal * backlogStatusThreshold) / backlog));
}

/** E: override, then auto-balance, then goal; capped by what scope and custom words still hold. */
export function effectiveNewWords(input: NewWordBudgetInput): NewWordBudget {
  if (input.reviewOnly) return { value: 0, chosen: 0, reason: NEW_WORD_REASON.REVIEW_ONLY };
  const override = activeOverride(input.override, input.now);
  let chosen = input.goal;
  let reason: NewWordReason = NEW_WORD_REASON.GOAL;
  if (override) {
    chosen = Math.min(override.value, input.goal);
    reason = NEW_WORD_REASON.USER_OVERRIDE;
  } else if (input.autoBalance) {
    const balanced = autoBalanced(input.goal, input.backlog);
    if (balanced < input.goal) {
      chosen = balanced;
      reason = NEW_WORD_REASON.AUTO_BALANCED;
    }
  }
  const available = input.remaining + input.pendingCustom;
  if (available === 0) return { value: 0, chosen, reason: NEW_WORD_REASON.SCOPE_EXHAUSTED };
  if (available < chosen) return { value: available, chosen, reason: NEW_WORD_REASON.SCOPE_LIMITED };
  return { value: chosen, chosen, reason };
}

export function scopeStatus(remaining: number, chosen: number, weeklySessionGoal: number): { status: ScopeStatus; sessionsLeftEstimate: number | null } {
  const sessionsLeftEstimate = chosen > 0 ? Math.ceil(remaining / chosen) : null;
  if (remaining === 0) return { status: SCOPE_STATUS.EXHAUSTED, sessionsLeftEstimate };
  const low = remaining < chosen * weeklySessionGoal * scopeLowWeeks;
  return { status: low ? SCOPE_STATUS.LOW : SCOPE_STATUS.OK, sessionsLeftEstimate };
}

export function shouldPromptChoice(backlog: number, lastPromptedBacklog: number | null): boolean {
  if (backlog < backlogPromptThreshold) return false;
  return lastPromptedBacklog === null || backlog >= lastPromptedBacklog * backlogRepromptMultiplier;
}

/** Null only when the plan issued every new word the goal asked for. */
export function withheldReason(requested: number, issued: number, budget: NewWordBudget): WithheldReason | null {
  if (issued >= requested) return null;
  if (budget.reason !== NEW_WORD_REASON.GOAL) return budget.reason as WithheldReason;
  // The budget allowed more but planning issued fewer (one meaning per word, unlearnable cards).
  return NEW_WORD_REASON.SCOPE_LIMITED;
}
