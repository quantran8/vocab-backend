import {
  ENTITLEMENT_STATUS, PLAN_TIER,
  type EntitlementSource, type EntitlementStatus, type PlanTier,
} from '../../../common/constants/domain';

export interface EntitlementRow {
  source: EntitlementSource;
  status: EntitlementStatus;
  expiresAt: Date;
  productId: string | null;
  autoRenew: boolean | null;
}

export interface FreeLimits {
  maxTopics: number;
  maxNewWords: number;
  newWordsUsed: number;
}

export interface PlanView {
  tier: PlanTier;
  premiumUntil: Date | null;
  source: EntitlementSource | null;
  productId: string | null;
  autoRenew: boolean | null;
  /** Present only while the free tier limits this learner. */
  limits: FreeLimits | null;
}

const grants = (row: EntitlementRow, now: Date) =>
  (row.status === ENTITLEMENT_STATUS.ACTIVE || row.status === ENTITLEMENT_STATUS.GRACE) && row.expiresAt > now;

/** The entitlement that keeps Premium the longest, or null when none grants it now. */
export function currentEntitlement(rows: EntitlementRow[], now: Date): EntitlementRow | null {
  return rows.filter((r) => grants(r, now)).reduce<EntitlementRow | null>((best, r) => (!best || r.expiresAt > best.expiresAt ? r : best), null);
}

export function planView(rows: EntitlementRow[], now: Date, free: { enabled: boolean; maxTopics: number; maxNewWords: number; newWordsUsed: number }): PlanView {
  const current = currentEntitlement(rows, now);
  if (current) {
    return { tier: PLAN_TIER.PREMIUM, premiumUntil: current.expiresAt, source: current.source, productId: current.productId, autoRenew: current.autoRenew, limits: null };
  }
  const limits = free.enabled ? { maxTopics: free.maxTopics, maxNewWords: free.maxNewWords, newWordsUsed: free.newWordsUsed } : null;
  return { tier: PLAN_TIER.FREE, premiumUntil: null, source: null, productId: null, autoRenew: null, limits };
}

/** New words the free tier still allows, or null when nothing limits them. */
export const freeRemaining = (plan: PlanView): number | null =>
  plan.limits ? Math.max(plan.limits.maxNewWords - plan.limits.newWordsUsed, 0) : null;

/** A redeem code adds its days after any redeemed time still left, never on top of a subscription that renews itself. */
export function redeemExpiry(redeemedUntil: Date | null, durationDays: number, now: Date): Date {
  const start = redeemedUntil && redeemedUntil > now ? redeemedUntil : now;
  return new Date(start.getTime() + durationDays * 24 * 3600 * 1000);
}

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, '');
