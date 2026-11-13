import { describe, expect, it } from 'vitest';
import { bucketFloor, estimateTopPercent, position } from './position';

describe('ranking position', () => {
  it('buckets by 10 LP below 2 000 and by 100 above', () => {
    expect(bucketFloor(0)).toBe(0);
    expect(bucketFloor(19)).toBe(10);
    expect(bucketFloor(1_999)).toBe(1_990);
    expect(bucketFloor(2_150)).toBe(2_100);
  });

  it('gives an exact rank inside the top 1 000, ties included', () => {
    expect(position({ listed: true, above: 0, points: 50, stats: null })).toMatchObject({ kind: 'rank', rank: 1 });
    expect(position({ listed: true, above: 999, points: 50, stats: null })).toMatchObject({ kind: 'rank', rank: 1000 });
    expect(position({ listed: false, above: 0, points: 50, stats: null })).toBeNull();
  });

  it('estimates a percentile in the upper half and labels nothing below it', () => {
    const histogram = { 100: 1_000, 50: 1_000, 10: 2_000 };
    expect(estimateTopPercent(histogram, 4_000, 105)).toBe(13);
    expect(position({ listed: true, above: 1_000, points: 55, stats: { totalListed: 4_000, histogram } }))
      .toMatchObject({ kind: 'percentile', percentile: 38, estimated: true });
    expect(position({ listed: true, above: 1_000, points: 12, stats: { totalListed: 4_000, histogram } }))
      .toMatchObject({ kind: 'unranked', rank: null, percentile: null });
    expect(position({ listed: true, above: 1_000, points: 12, stats: null })).toMatchObject({ kind: 'unranked' });
  });
});
