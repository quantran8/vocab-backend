import { NEW_WORD_OVERRIDE_MODE, NEW_WORD_REASON, SCOPE_STATUS } from '../../../common/constants/domain';
import { autoBalanced, effectiveNewWords, scopeStatus, shouldPromptChoice, withheldReason, type NewWordBudgetInput } from './review-load';

const now = new Date('2026-11-11T00:00:00Z');
const base: NewWordBudgetInput = { goal: 5, override: null, autoBalance: false, backlog: 0, remaining: 100, pendingCustom: 0, now };

describe('autoBalanced', () => {
  it.each([[0, 5], [10, 5], [20, 3], [50, 2], [500, 2]])('goal 5, backlog %i gives %i', (backlog, expected) => {
    expect(autoBalanced(5, backlog)).toBe(expected);
  });
  it('never goes below the goal when the goal is under the floor', () => {
    expect(autoBalanced(1, 500)).toBe(1);
  });
});

describe('effectiveNewWords', () => {
  it('keeps the goal whatever the backlog without override or auto-balance', () => {
    expect(effectiveNewWords({ ...base, backlog: 300 })).toEqual({ value: 5, chosen: 5, reason: NEW_WORD_REASON.GOAL });
  });
  it('applies auto-balance only when enabled', () => {
    expect(effectiveNewWords({ ...base, autoBalance: true, backlog: 20 })).toMatchObject({ value: 3, reason: NEW_WORD_REASON.AUTO_BALANCED });
    expect(effectiveNewWords({ ...base, autoBalance: true, backlog: 5 })).toMatchObject({ value: 5, reason: NEW_WORD_REASON.GOAL });
  });
  it('prefers an active override over auto-balance', () => {
    const override = { value: 4, mode: NEW_WORD_OVERRIDE_MODE.UNTIL_BACKLOG_CLEAR, until: null };
    expect(effectiveNewWords({ ...base, autoBalance: true, backlog: 50, override })).toMatchObject({ value: 4, reason: NEW_WORD_REASON.USER_OVERRIDE });
  });
  it('ignores an expired until_date override', () => {
    const override = { value: 1, mode: NEW_WORD_OVERRIDE_MODE.UNTIL_DATE, until: new Date(now.getTime() - 1) };
    expect(effectiveNewWords({ ...base, override })).toMatchObject({ value: 5, reason: NEW_WORD_REASON.GOAL });
  });
  it('caps by scope and custom words', () => {
    expect(effectiveNewWords({ ...base, remaining: 2, pendingCustom: 1 })).toEqual({ value: 3, chosen: 5, reason: NEW_WORD_REASON.SCOPE_LIMITED });
    expect(effectiveNewWords({ ...base, remaining: 0 })).toMatchObject({ value: 0, reason: NEW_WORD_REASON.SCOPE_EXHAUSTED });
    expect(effectiveNewWords({ ...base, remaining: 0, pendingCustom: 7 })).toMatchObject({ value: 5, reason: NEW_WORD_REASON.GOAL });
  });
  it('issues nothing for a review-only session', () => {
    expect(effectiveNewWords({ ...base, reviewOnly: true })).toMatchObject({ value: 0, reason: NEW_WORD_REASON.REVIEW_ONLY });
  });
});

describe('scopeStatus', () => {
  it('is exhausted, low or ok', () => {
    expect(scopeStatus(0, 5, 7).status).toBe(SCOPE_STATUS.EXHAUSTED);
    expect(scopeStatus(12, 5, 7)).toEqual({ status: SCOPE_STATUS.LOW, sessionsLeftEstimate: 3 });
    expect(scopeStatus(35, 5, 7).status).toBe(SCOPE_STATUS.OK);
  });
});

describe('shouldPromptChoice', () => {
  it('prompts at the threshold, then only after the backlog doubles', () => {
    expect(shouldPromptChoice(19, null)).toBe(false);
    expect(shouldPromptChoice(20, null)).toBe(true);
    expect(shouldPromptChoice(39, 20)).toBe(false);
    expect(shouldPromptChoice(40, 20)).toBe(true);
  });
});

describe('withheldReason', () => {
  it('is null when the goal was met and names the budget reason otherwise', () => {
    expect(withheldReason(5, 5, { value: 5, chosen: 5, reason: NEW_WORD_REASON.GOAL })).toBeNull();
    expect(withheldReason(5, 2, { value: 2, chosen: 2, reason: NEW_WORD_REASON.USER_OVERRIDE })).toBe(NEW_WORD_REASON.USER_OVERRIDE);
    expect(withheldReason(5, 3, { value: 5, chosen: 5, reason: NEW_WORD_REASON.GOAL })).toBe(NEW_WORD_REASON.SCOPE_LIMITED);
  });
});
