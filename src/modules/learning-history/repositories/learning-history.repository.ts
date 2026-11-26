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
  days: HistoryDayRow[]; points: HistoryPointRow[]; recentWords: { wordId: string; lemma: string }[];
};

export type JourneyWordRow = { wordId: string; lemma: string; meaningTexts: string[]; learnedOn: string };

/** Home names this many of the week's newest words. */
const RECENT_WORDS = 3;

const { monthlyBucketsUpToMonths, quarterlyBucketsUpToMonths } = POLICY.learningHistory;
const iso = (column: ReturnType<typeof sql>) => sql`to_char(${column}, 'YYYY-MM-DD')`;

/**
 * The learner's zone and goal (`cfg`), each Word's first learning (`firsts`), committed sessions (`sess`) and the
 * period's local-day bounds (`span`). Shared so every journey figure counts the same way.
 */
const periodCtes = (userId: string, period: HistoryPeriod, now: Date) => sql`
      cfg AS (
        SELECT time_zone AS tz, weekly_session_goal::int AS goal, (${now}::timestamptz AT TIME ZONE time_zone)::date AS today
        FROM user_settings WHERE user_id = ${userId}::uuid
      ), firsts AS (
        -- A Word counts once, when its first Meaning was learned; learned_at is never rewritten.
        SELECT wt.word_id, min(p.learned_at) AS at, (min(p.learned_at) AT TIME ZONE cfg.tz)::date AS day
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
      )`;

@Injectable()
export class LearningHistoryRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // One statement for the whole screen. Dates are the learner's local calendar days (user_settings.time_zone).
  async history(userId: string, period: HistoryPeriod, now: Date) {
    const { rows: [row] } = await this.db.execute<HistoryRow>(sql`
      WITH ${periodCtes(userId, period, now)}, grain AS (
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
        (SELECT COALESCE(json_agg(json_build_object('wordId', r.word_id, 'lemma', w.lemma) ORDER BY r.at DESC, r.word_id), '[]'::json)
         FROM (SELECT word_id, at FROM firsts WHERE day >= g.week_start ORDER BY at DESC, word_id LIMIT ${RECENT_WORDS}::int) r
         JOIN words w ON w.id = r.word_id) AS "recentWords",
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

  /**
   * Words first learned in the period, newest first, with the meanings of each learned in that period (as the
   * learner reads them, their own edit included). One statement; `total` counts the whole period.
   */
  async words(userId: string, period: HistoryPeriod, now: Date, limit: number, offset: number) {
    const { rows: [row] } = await this.db.execute<{ total: number; items: JourneyWordRow[] | null }>(sql`
      WITH ${periodCtes(userId, period, now)}, picked AS (
        SELECT f.word_id, f.at, f.day FROM firsts f, span
        WHERE f.day >= span.period_start AND f.day < span.period_end
        ORDER BY f.at DESC, f.word_id
        LIMIT ${limit}::int OFFSET ${offset}::int
      )
      SELECT
        (SELECT count(*)::int FROM firsts f, span WHERE f.day >= span.period_start AND f.day < span.period_end) AS total,
        (SELECT json_agg(json_build_object(
            'wordId', pk.word_id, 'lemma', w.lemma, 'learnedOn', ${iso(sql`pk.day`)},
            'meaningTexts', (
              SELECT COALESCE(json_agg(x.text ORDER BY x.at, x.id) FILTER (WHERE x.text IS NOT NULL), '[]'::json)
              FROM (
                SELECT p.meaning_id AS id, p.learned_at AS at,
                  COALESCE(o.content ->> 'meaningText', mp.snapshot ->> 'meaningText') AS text
                FROM user_meaning_progress p
                JOIN meanings m ON m.id = p.meaning_id
                JOIN word_types wt ON wt.id = m.type_id AND wt.word_id = pk.word_id
                JOIN user_settings us ON us.user_id = p.user_id
                LEFT JOIN active_meaning_publications a ON a.meaning_id = p.meaning_id AND a.locale = us.explanation_locale
                LEFT JOIN meaning_publications mp ON mp.id = a.publication_id
                LEFT JOIN user_meaning_overrides o ON o.user_id = p.user_id AND o.meaning_id = p.meaning_id AND o.locale = us.explanation_locale
                WHERE p.user_id = ${userId}::uuid AND p.learned_at <= ${now}::timestamptz
                  AND (p.learned_at AT TIME ZONE span.tz)::date >= span.period_start
                  AND (p.learned_at AT TIME ZONE span.tz)::date < span.period_end
              ) x)
          ) ORDER BY pk.at DESC, pk.word_id)
         FROM picked pk JOIN words w ON w.id = pk.word_id) AS items
      FROM span`);
    return { total: row?.total ?? 0, items: row?.items ?? [] };
  }
}
