import { TierKey } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';

export interface TierLevel { level: number; key: TierKey; minLifetimeLP: number; minActiveDays: number }

export const TIER_LEVELS: readonly TierLevel[] = POLICY.tier.levels;

/** Highest level whose LP and active-day thresholds are both met; 0 means no Tier yet. */
export function eligibleTier(lifetimeLP: number, activeDays: number, levels: readonly TierLevel[] = TIER_LEVELS) {
  return levels.reduce((best, l) => (l.minLifetimeLP <= lifetimeLP && l.minActiveDays <= activeDays ? Math.max(best, l.level) : best), 0);
}

export const tierKey = (level: number, levels: readonly TierLevel[] = TIER_LEVELS) => levels.find((l) => l.level === level)?.key ?? null;

export function nextTier(level: number, levels: readonly TierLevel[] = TIER_LEVELS) {
  const next = levels.find((l) => l.level === level + 1);
  return next ? { level: next.level, key: next.key, minLifetimeLP: next.minLifetimeLP, minLifetimeActiveDays: next.minActiveDays } : null;
}

export const unlockedBetween = (from: number, to: number, levels: readonly TierLevel[] = TIER_LEVELS) =>
  levels.filter((l) => l.level > from && l.level <= to);

export interface EffortTotals { lifetimeLP: number; lifetimeActiveDays: number; tierLevel: number }

/** Two independent progress bars; never a blended percentage (spec §3.5). */
export function tierView(totals: EffortTotals) {
  const next = nextTier(totals.tierLevel);
  return {
    level: totals.tierLevel,
    key: tierKey(totals.tierLevel),
    lifetimeLP: totals.lifetimeLP,
    lifetimeActiveDays: totals.lifetimeActiveDays,
    nextTier: next && {
      ...next,
      remainingLP: Math.max(0, next.minLifetimeLP - totals.lifetimeLP),
      remainingActiveDays: Math.max(0, next.minLifetimeActiveDays - totals.lifetimeActiveDays),
    },
  };
}

export const tierBadge = (level: number) => ({ level, key: tierKey(level) });
