import { sql } from 'drizzle-orm';

// Run in the same transaction as any change to leaderboard_visible or ranking_eligible (spec §8.4). Closed weeks stay as snapshotted.
export const syncListedSql = (userId: string) => sql`
  UPDATE weekly_lp_scores w SET listed = s.leaderboard_visible AND u.ranking_eligible
  FROM app_user u JOIN user_settings s ON s.user_id = u.id
  WHERE u.id = ${userId}::uuid AND w.user_id = u.id
    AND NOT EXISTS (SELECT 1 FROM weekly_rank_snapshots r WHERE r.week_start = w.week_start AND r.user_id = w.user_id)`;
