import { Inject, Injectable } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import { CONTENT_PROVENANCE, ContentProvenance, LP_AWARD_TYPE, TIER_UNLOCK_SOURCE } from '../../../common/constants/domain';
import { addHours, HOURS_PER_DAY, utcDay, utcWeekStart } from '../../../common/constants/time';
import { newId } from '../../../common/ids';
import { POLICY } from '../../../config/policy';
import { DB, Db, toDate, Tx } from '../../../db/db';
import { AwardDraft, PriorAward } from '../domain/lp-awards';
import { TIER_LEVELS } from '../domain/tier';

const LEVELS_JSON = JSON.stringify(TIER_LEVELS.map((l) => ({ level: l.level, key: l.key, min_lp: l.minLifetimeLP, min_days: l.minActiveDays })));
const levelsSql = sql`jsonb_to_recordset(${LEVELS_JSON}::jsonb) AS l(level int, key text, min_lp bigint, min_days int)`;

export type RawLpContext = {
  lpPrior: { type: PriorAward['type']; meaningId: string; awardedAt: string; day: string; points: number; provenance: ContentProvenance }[];
  lpCustom: string[];
};

/**
 * Columns for the commit's single read: what the award rules need beyond the session. `meaningIds` is a subquery
 * of this session's Meanings. Read under the user lock, so the daily caps cannot race.
 */
export function lpContextColumnsSql(userId: string, meaningIds: SQL, now: Date) {
  const windowFrom = addHours(now, -POLICY.lp.dueAwardWindowDays * HOURS_PER_DAY);
  return sql`
    COALESCE((SELECT json_agg(json_build_object('type', a.award_type, 'meaningId', a.meaning_id, 'awardedAt', a.awarded_at,
        'day', a.scoring_day, 'points', a.points, 'provenance', a.content_provenance))
      FROM learning_point_awards a
      WHERE a.user_id = ${userId}::uuid
        AND (a.scoring_day = ${utcDay(now)}::date
          OR (a.meaning_id IN (${meaningIds})
            AND (a.awarded_at > ${windowFrom}::timestamptz OR a.award_type = ${LP_AWARD_TYPE.NEW_MEANING_COMPLETED})))), '[]'::json) AS "lpPrior",
    COALESCE((SELECT json_agg(m.id) FROM meanings m
      WHERE m.id IN (${meaningIds}) AND m.owner_user_id = ${userId}::uuid), '[]'::json) AS "lpCustom"`;
}

export const parseLpContext = (row: RawLpContext) => ({
  prior: row.lpPrior.map((a): PriorAward => ({ ...a, awardedAt: toDate(a.awardedAt) })),
  provenance: new Map<string, ContentProvenance>(row.lpCustom.map((id) => [id, CONTENT_PROVENANCE.CUSTOM_OWNED])),
});

export interface EffortResult {
  earned: number;
  breakdown: { newMeaningLP: number; dueReviewLP: number; extraPracticeLP: number };
  lifetimeLP: number;
  lifetimeActiveDays: number;
  oldLevel: number;
  level: number;
  weeklyLP: number;
  canList: boolean;
}

@Injectable()
export class EffortRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // One statement: ledger insert, then every aggregate from the rows actually inserted, so a retry adds nothing.
  // The commit holds the user row lock, so the "old" reads cannot go stale; tier_level only ever rises.
  async record(tx: Tx, input: { userId: string; sessionId: string; awards: AwardDraft[]; now: Date }): Promise<EffortResult> {
    const { userId, sessionId, awards, now } = input;
    const day = utcDay(now);
    const week = utcDay(utcWeekStart(now));
    const drafts = JSON.stringify(awards.map((a) => ({
      id: newId(), meaning_id: a.meaningId, award_type: a.type, award_key: a.awardKey, points: a.points, content_provenance: a.provenance,
    })));
    const { rows: [row] } = await tx.execute<{
      earned: number; new_lp: number; due_lp: number; extra_lp: number; lifetime_lp: string; active_days: number;
      old_level: number; level: number; week_lp: string; can_list: boolean;
    }>(sql`
      WITH input AS (
        SELECT * FROM jsonb_to_recordset(${drafts}::jsonb)
          AS x(id uuid, meaning_id uuid, award_type varchar, award_key text, points smallint, content_provenance varchar)
      ), ins AS (
        INSERT INTO learning_point_awards (id, user_id, session_id, meaning_id, award_type, award_key, points, awarded_at,
          scoring_day, week_start, lp_policy_version, content_provenance)
        SELECT x.id, ${userId}::uuid, ${sessionId}::uuid, x.meaning_id, x.award_type, x.award_key, x.points, ${now}::timestamptz,
          ${day}::date, ${week}::date, ${POLICY.lp.version}, x.content_provenance
        FROM input x
        ON CONFLICT (user_id, award_key) DO NOTHING
        RETURNING award_type, points
      ), earned AS (
        SELECT COALESCE(sum(points), 0)::int AS lp,
          COALESCE(sum(points) FILTER (WHERE award_type = ${LP_AWARD_TYPE.NEW_MEANING_COMPLETED}), 0)::int AS new_lp,
          COALESCE(sum(points) FILTER (WHERE award_type = ${LP_AWARD_TYPE.DUE_REVIEW_COMPLETED}), 0)::int AS due_lp,
          COALESCE(sum(points) FILTER (WHERE award_type = ${LP_AWARD_TYPE.EXTRA_PRACTICE_COMPLETED}), 0)::int AS extra_lp
        FROM ins
      ), old AS (
        SELECT COALESCE(t.lifetime_lp, 0) AS lp, COALESCE(t.lifetime_active_days, 0) AS days, COALESCE(t.tier_level, 0)::int AS level,
          COALESCE((SELECT earned_lp FROM user_effort_days WHERE user_id = u.id AND scoring_day = ${day}::date), 0) AS day_lp,
          COALESCE((SELECT points FROM weekly_lp_scores WHERE user_id = u.id AND week_start = ${week}::date), 0) AS week_lp,
          s.leaderboard_visible AND u.ranking_eligible AS can_list
        FROM app_user u
        JOIN user_settings s ON s.user_id = u.id
        LEFT JOIN user_effort_totals t ON t.user_id = u.id
        WHERE u.id = ${userId}::uuid
      ), next AS (
        SELECT e.lp AS earned, e.new_lp, e.due_lp, e.extra_lp, o.level AS old_level, o.can_list,
          o.lp + e.lp AS lp, o.week_lp + e.lp AS week_lp,
          -- A day counts once, when its LP first reaches the threshold.
          o.days + CASE WHEN o.day_lp < ${POLICY.lp.minQualifiedDayLP} AND o.day_lp + e.lp >= ${POLICY.lp.minQualifiedDayLP} THEN 1 ELSE 0 END AS days
        FROM old o, earned e
      ), target AS (
        SELECT n.*, CASE WHEN n.earned = 0 THEN n.old_level ELSE GREATEST(n.old_level,
          COALESCE((SELECT max(l.level) FROM ${levelsSql} WHERE l.min_lp <= n.lp AND l.min_days <= n.days), 0)) END AS level
        FROM next n
      ), effort_day AS (
        INSERT INTO user_effort_days (user_id, scoring_day, earned_lp)
        SELECT ${userId}::uuid, ${day}::date, earned FROM target WHERE earned > 0
        ON CONFLICT (user_id, scoring_day) DO UPDATE SET earned_lp = user_effort_days.earned_lp + EXCLUDED.earned_lp
      ), totals AS (
        INSERT INTO user_effort_totals (user_id, lifetime_lp, lifetime_active_days, tier_level, tier_policy_version, last_award_at, updated_at)
        SELECT ${userId}::uuid, lp, days, level, ${POLICY.tier.version}, ${now}::timestamptz, ${now}::timestamptz FROM target WHERE earned > 0
        ON CONFLICT (user_id) DO UPDATE SET
          lifetime_lp = EXCLUDED.lifetime_lp,
          lifetime_active_days = EXCLUDED.lifetime_active_days,
          tier_level = GREATEST(user_effort_totals.tier_level, EXCLUDED.tier_level),
          tier_policy_version = EXCLUDED.tier_policy_version,
          last_award_at = EXCLUDED.last_award_at,
          updated_at = EXCLUDED.updated_at
      ), unlocks AS (
        INSERT INTO user_tier_unlocks (user_id, tier_level, tier_key, unlocked_at, tier_policy_version, source)
        SELECT ${userId}::uuid, l.level, l.key, ${now}::timestamptz, ${POLICY.tier.version}, ${TIER_UNLOCK_SOURCE.LIVE}
        FROM ${levelsSql}, target t
        WHERE l.level > t.old_level AND l.level <= t.level
        ON CONFLICT DO NOTHING
      ), week AS (
        INSERT INTO weekly_lp_scores (user_id, week_start, points, last_award_at, listed)
        SELECT ${userId}::uuid, ${week}::date, earned, ${now}::timestamptz, can_list FROM target WHERE earned > 0
        ON CONFLICT (user_id, week_start) DO UPDATE SET
          points = weekly_lp_scores.points + EXCLUDED.points, last_award_at = EXCLUDED.last_award_at, listed = EXCLUDED.listed
      )
      SELECT earned, new_lp, due_lp, extra_lp, lp AS lifetime_lp, days AS active_days, old_level, level, week_lp, can_list FROM target`);
    return {
      earned: row.earned,
      breakdown: { newMeaningLP: row.new_lp, dueReviewLP: row.due_lp, extraPracticeLP: row.extra_lp },
      lifetimeLP: Number(row.lifetime_lp),
      lifetimeActiveDays: row.active_days,
      oldLevel: row.old_level,
      level: row.level,
      weeklyLP: Number(row.week_lp),
      canList: row.can_list,
    };
  }

  /** Read-only check of the aggregates against the ledger; a mismatch is logged for the correction process, never auto-rewritten. */
  async reconcile(now: Date) {
    const openWeek = utcDay(utcWeekStart(addHours(now, -7 * HOURS_PER_DAY)));
    const { rows: [row] } = await this.db.execute<{ totals: string; days: string; weeks: string }>(sql`
      WITH ledger_days AS (
        SELECT user_id, scoring_day, sum(points)::int AS lp FROM learning_point_awards GROUP BY 1, 2
      ), ledger AS (
        SELECT user_id, sum(lp)::bigint AS lp, count(*) FILTER (WHERE lp >= ${POLICY.lp.minQualifiedDayLP})::int AS days
        FROM ledger_days GROUP BY 1
      ), ledger_weeks AS (
        SELECT user_id, week_start, sum(points)::bigint AS points FROM learning_point_awards
        WHERE week_start >= ${openWeek}::date GROUP BY 1, 2
      )
      SELECT
        (SELECT count(*) FROM ledger l FULL JOIN user_effort_totals t USING (user_id)
          WHERE COALESCE(l.lp, 0) <> COALESCE(t.lifetime_lp, 0) OR COALESCE(l.days, 0) <> COALESCE(t.lifetime_active_days, 0)) AS totals,
        (SELECT count(*) FROM ledger_days l FULL JOIN user_effort_days d USING (user_id, scoring_day)
          WHERE COALESCE(l.lp, 0) <> COALESCE(d.earned_lp, 0)) AS days,
        (SELECT count(*) FROM ledger_weeks l
          FULL JOIN (SELECT * FROM weekly_lp_scores WHERE week_start >= ${openWeek}::date) w USING (user_id, week_start)
          WHERE COALESCE(l.points, 0) <> COALESCE(w.points, 0)) AS weeks`);
    return { totals: Number(row.totals), days: Number(row.days), weeks: Number(row.weeks) };
  }

  /** After a threshold drop, raises every learner the current policy qualifies. Never lowers a Tier; idempotent. */
  async raiseTiers(now: Date) {
    const { rows: [row] } = await this.db.execute<{ raised: string }>(sql`
      WITH eligible AS (
        SELECT t.user_id, t.tier_level AS old_level,
          (SELECT max(l.level) FROM ${levelsSql} WHERE l.min_lp <= t.lifetime_lp AND l.min_days <= t.lifetime_active_days) AS level
        FROM user_effort_totals t
      ), raised AS (
        UPDATE user_effort_totals t SET tier_level = e.level, tier_policy_version = ${POLICY.tier.version}, updated_at = ${now}::timestamptz
        FROM eligible e
        WHERE t.user_id = e.user_id AND e.level > t.tier_level
        RETURNING t.user_id, e.old_level, e.level
      ), unlocks AS (
        INSERT INTO user_tier_unlocks (user_id, tier_level, tier_key, unlocked_at, tier_policy_version, source)
        SELECT r.user_id, l.level, l.key, ${now}::timestamptz, ${POLICY.tier.version}, ${TIER_UNLOCK_SOURCE.POLICY_MIGRATION}
        FROM raised r, ${levelsSql}
        WHERE l.level > r.old_level AND l.level <= r.level
        ON CONFLICT DO NOTHING
      )
      SELECT count(*) AS raised FROM raised`);
    return Number(row.raised);
  }
}
