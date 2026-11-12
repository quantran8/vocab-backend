import { describe, expect, it } from 'vitest';
import { utcDay, utcWeekStart } from '../../../common/constants/time';
import { eligibleTier, nextTier, tierView, unlockedBetween } from './tier';

describe('lifetime tier', () => {
  it('needs both the LP and the active-day threshold (spec §13.2)', () => {
    expect(eligibleTier(12_450, 86)).toBe(3);
    expect(eligibleTier(12_450, 300)).toBe(6);
    expect(eligibleTier(20_000, 364)).toBe(6);
    expect(eligibleTier(20_000, 365)).toBe(7);
    expect(eligibleTier(39, 400)).toBe(0);
    expect(eligibleTier(100_000, 0)).toBe(0);
  });

  it('lists every level a jump crosses and nothing past the top', () => {
    expect(unlockedBetween(0, 3).map((l) => l.key)).toEqual(['first_steps', 'in_motion', 'building_up']);
    expect(unlockedBetween(3, 3)).toEqual([]);
    expect(nextTier(7)).toBeNull();
  });

  it('reports what is still missing on each axis separately', () => {
    expect(tierView({ lifetimeLP: 12_450, lifetimeActiveDays: 86, tierLevel: 3 }).nextTier)
      .toMatchObject({ level: 4, key: 'steady_effort', remainingLP: 0, remainingActiveDays: 4 });
    expect(tierView({ lifetimeLP: 0, lifetimeActiveDays: 0, tierLevel: 0 })).toMatchObject({ level: 0, key: null });
  });

  it('puts Sunday 23:59:59 UTC in the old week and Monday 00:00 UTC in the new one', () => {
    expect(utcDay(utcWeekStart(new Date('2026-11-15T23:59:59Z')))).toBe('2026-11-09');
    expect(utcDay(utcWeekStart(new Date('2026-11-16T00:00:00Z')))).toBe('2026-11-16');
    expect(utcDay(utcWeekStart(new Date('2026-11-09T07:00:00+07:00')))).toBe('2026-11-09');
  });
});
