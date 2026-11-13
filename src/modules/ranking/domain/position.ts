import { RANKING_POSITION_KIND } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';

const { histogram: BUCKETS, exactRankLimit } = POLICY.ranking;

export const bucketFloor = (points: number) => (points < BUCKETS.fineUntil
  ? Math.floor(points / BUCKETS.fineStep) * BUCKETS.fineStep
  : Math.floor(points / BUCKETS.coarseStep) * BUCKETS.coarseStep);

/** "Top N%" from the cached histogram: everyone in higher buckets plus half of the learner's own bucket. */
export function estimateTopPercent(histogram: Record<string, number>, totalListed: number, points: number) {
  if (totalListed <= 0) return null;
  const own = bucketFloor(points);
  const above = Object.entries(histogram).reduce((sum, [floor, n]) => {
    const f = Number(floor);
    return sum + (f > own ? n : f === own ? n / 2 : 0);
  }, 0);
  return Math.min(100, Math.max(1, Math.ceil(((above + 1) / totalListed) * 100)));
}

export interface PositionInput {
  listed: boolean;
  /** Listed learners with more weekly LP, counted up to exactRankLimit. */
  above: number;
  points: number;
  stats: { totalListed: number; histogram: Record<string, number> } | null;
}

/** Exact rank inside the top 1 000; outside it an estimated percentile for the upper half and nothing below (spec §4.1). */
export function position({ listed, above, points, stats }: PositionInput) {
  if (!listed) return null;
  if (above < exactRankLimit) return { kind: RANKING_POSITION_KIND.RANK, rank: above + 1, percentile: null, estimated: false };
  const top = stats && estimateTopPercent(stats.histogram, stats.totalListed, points);
  return top !== null && top <= 50
    ? { kind: RANKING_POSITION_KIND.PERCENTILE, rank: null, percentile: top, estimated: true }
    : { kind: RANKING_POSITION_KIND.UNRANKED, rank: null, percentile: null, estimated: true };
}
