import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { HISTORY_BUCKET, HISTORY_PERIOD, HistoryBucket, HistoryPeriod, SESSION_MODE, SESSION_STATUS } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';
import { DB, Db } from '../../../db/db';

export type HistoryDayRow = { date: string; sessions: number; newWords: number };
export type HistoryPointRow = { date: string; cumulativeWords: number };
export type HistoryRow = {
  timeZone: string; weeklySessionGoal: number; today: string; firstDay: string | null;
  weekStart: string; weekEnd: string; periodStart: string; periodEnd: string; bucket: HistoryBucket;
  wordsAtStart: number; wordsAtEnd: number; activeDays: number; completedSessions: number; reviewedMeanings: number;
  days: HistoryDayRow[]; points: HistoryPointRow[];
};

const { monthlyBucketsUpToMonths, quarterlyBucketsUpToMonths } = POLICY.learningHistory;
const iso = (column: ReturnType<typeof sql>) => sql`to_char(${column}, 'YYYY-MM-DD')`;

@Injectable()
export class LearningHistoryRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // One statement for the whole screen. Dates are the learner's local calendar days (user_settings.time_zone).
  async history(userId: string, period: HistoryPeriod, now: Date) {
    const { rows: [row] } = await this.db.execute<HistoryRow>(sql`
      WITH cfg AS (
        SELECT time_zone AS tz, weekly_session_goal::int AS goal, (${now}::timestamptz AT TIME ZONE time_zone)::date AS today
        FROM user_settings WHERE user_id = ${userId}::uuid
      ), firsts AS (
        -- A Word counts once, when its first Meaning was learned; learned_at is never rewritten.
        SELECT (min(p.learned_at) AT TIME ZONE cfg.tz)::date AS day
        FROM cfg, user_meaning_progress p JOIN meanings m ON m.id = p.meaning_id JOIN word_types wt ON wt.id = m.type_id
        WHERE p.user_id = ${userId}::uuid AND p.learned_at <= ${now}::timestamptz
        GROUP BY wt.word_id, cfg.tz
      ), sess AS (
        SELECT s.id, (s.committed_at AT TIME ZONE cfg.tz)::date AS day
        FROM cfg, learning_sessions s
        WHERE s.user_id = ${userId}::uuid AND s.status = ${SESSION_STATUS.COMMITTED}
          AND s.mode <> ${SESSION_MODE.CHECKPOINT_CHALLENGE} AND s.committed_at <= ${now}::timestamptz
      ), origin AS (
        SELECT cfg.*, LEAST((SELECT min(day) FROM firsts), (SELECT min(day) FROM sess)) AS first_day FROM cfg
      ), span AS (
        SELECT o.*, date_trunc('week', o.today)::date AS week_start,
          CASE WHEN ${period}::text <> ${HISTORY_PERIOD.ALL} THEN ${HISTORY_BUCKET.DAY}::text
               WHEN o.first_day IS NULL OR o.first_day > o.today - make_interval(months => ${monthlyBucketsUpToMonths}::int) THEN ${HISTORY_BUCKET.MONTH}::text
               WHEN o.first_day > o.today - make_interval(months => ${quarterlyBucketsUpToMonths}::int) THEN ${HISTORY_BUCKET.QUARTER}::text
               ELSE ${HISTORY_BUCKET.YEAR}::text END AS unit,
          CASE ${period}::text
            WHEN ${HISTORY_PERIOD.WEEK} THEN date_trunc('week', o.today)::date
            WHEN ${HISTORY_PERIOD.MONTH} THEN date_trunc('month', o.today)::date
            ELSE COALESCE(o.first_day, o.today) END AS period_start,
          CASE ${period}::text
            WHEN ${HISTORY_PERIOD.WEEK} THEN date_trunc('week', o.today)::date + 7
            WHEN ${HISTORY_PERIOD.MONTH} THEN (date_trunc('month', o.today) + interval '1 month')::date
            ELSE o.today + 1 END AS period_end
        FROM origin o
      ), grain AS (
        SELECT span.*, CASE span.unit
          WHEN ${HISTORY_BUCKET.DAY} THEN interval '1 day' WHEN ${HISTORY_BUCKET.MONTH} THEN interval '1 month'
          WHEN ${HISTORY_BUCKET.QUARTER} THEN interval '3 months' ELSE interval '1 year' END AS step
        FROM span
      ), buckets AS (
        SELECT b::date AS start_day, (b + g.step)::date AS end_day
        FROM grain g, generate_series(date_trunc(g.unit, g.period_start::timestamp), g.today::timestamp, g.step) b
      )
      SELECT
        g.tz AS "timeZone", g.goal AS "weeklySessionGoal", ${iso(sql`g.today`)} AS today, ${iso(sql`g.first_day`)} AS "firstDay",
        ${iso(sql`g.week_start`)} AS "weekStart", ${iso(sql`g.week_start + 7`)} AS "weekEnd",
        ${iso(sql`g.period_start`)} AS "periodStart", ${iso(sql`g.period_end`)} AS "periodEnd", g.unit AS bucket,
        (SELECT count(*)::int FROM firsts WHERE day < g.period_start) AS "wordsAtStart",
        (SELECT count(*)::int FROM firsts) AS "wordsAtEnd",
        (SELECT count(DISTINCT day)::int FROM sess WHERE day >= g.period_start AND day < g.period_end) AS "activeDays",
        (SELECT count(*)::int FROM sess WHERE day >= g.period_start AND day < g.period_end) AS "completedSessions",
        -- A review is a Meaning with evidence in a session that did not learn it; one per session.
        (SELECT count(*)::int FROM memory_observations mo JOIN sess ON sess.id = mo.session_id
         WHERE mo.user_id = ${userId}::uuid AND sess.day >= g.period_start AND sess.day < g.period_end
           AND NOT EXISTS (SELECT 1 FROM user_meaning_progress p
             WHERE p.user_id = mo.user_id AND p.meaning_id = mo.meaning_id AND p.learned_session_id = mo.session_id)) AS "reviewedMeanings",
        (SELECT json_agg(json_build_object('date', ${iso(sql`d`)},
            'sessions', (SELECT count(*) FROM sess WHERE sess.day = d::date),
            'newWords', (SELECT count(*) FROM firsts WHERE firsts.day = d::date)) ORDER BY d)
         FROM generate_series(g.week_start::timestamp, g.week_start::timestamp + interval '6 days', interval '1 day') d) AS days,
        (SELECT json_agg(json_build_object('date', ${iso(sql`LEAST(b.end_day - 1, g.today)`)},
            'cumulativeWords', (SELECT count(*) FROM firsts WHERE firsts.day < b.end_day)) ORDER BY b.start_day)
         FROM buckets b) AS points
      FROM grain g`);
    return row;
  }
}
