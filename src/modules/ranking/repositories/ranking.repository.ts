import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AvatarKey, ReportReason, ReportResolution } from '../../../common/constants/domain';
import { newId } from '../../../common/ids';
import { POLICY } from '../../../config/policy';
import { DB, Db } from '../../../db/db';
import { appUsers, rankingEligibilityAudit, userReports } from '../../../db/schema';
import { syncListedSql } from './listing.sql';

const { exactRankLimit, topLimit, aroundRadius, histogram: BUCKETS } = POLICY.ranking;

export interface BoardRow { rank: number | null; username: string; avatarKey: string; weeklyLP: number; tierLevel: number; isMe: boolean }

type RawBoardRow = { rank: string | null; username: string; avatar_key: string; points: string; tier_level: number; is_me: boolean };
const boardRow = (r: RawBoardRow): BoardRow => ({
  rank: r.rank === null ? null : Number(r.rank), username: r.username, avatarKey: r.avatar_key,
  weeklyLP: Number(r.points), tierLevel: r.tier_level, isMe: r.is_me,
});

// Bounded: proving a rank scans at most exactRankLimit rows however many learners are listed.
const aboveCountSql = (week: string, points: ReturnType<typeof sql>) => sql`(
  SELECT count(*) FROM (
    SELECT 1 FROM weekly_lp_scores o WHERE o.week_start = ${week}::date AND o.listed AND o.points > ${points} LIMIT ${exactRankLimit}
  ) bounded)`;

@Injectable()
export class RankingRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findIdentity(userId: string) {
    const [row] = await this.db
      .select({
        username: appUsers.username, usernameGenerated: appUsers.usernameGenerated, usernameChangedAt: appUsers.usernameChangedAt,
        avatarKey: appUsers.avatarKey,
      })
      .from(appUsers).where(eq(appUsers.id, userId));
    return row;
  }

  async updateProfile(userId: string, patch: { username?: string; usernameGenerated?: boolean; usernameChangedAt?: Date | null; avatarKey?: AvatarKey }) {
    const [row] = await this.db.update(appUsers).set(patch).where(eq(appUsers.id, userId))
      .returning({ username: appUsers.username, avatarKey: appUsers.avatarKey, usernameGenerated: appUsers.usernameGenerated, usernameChangedAt: appUsers.usernameChangedAt });
    return row;
  }

  async markIntroSeen(userId: string) {
    await this.db.update(appUsers).set({ rankingIntroSeen: true }).where(eq(appUsers.id, userId));
  }

  // One statement: totals, this week's score, the bounded rank count and the cached histogram.
  async findMyWeek(userId: string, week: string) {
    const { rows: [row] } = await this.db.execute<{
      lifetime_lp: string; active_days: number; tier_level: number; points: string | null; listed: boolean | null;
      above: string | null; total_listed: number | null; histogram: Record<string, number> | null;
    }>(sql`
      WITH me AS (
        SELECT COALESCE(t.lifetime_lp, 0) AS lifetime_lp, COALESCE(t.lifetime_active_days, 0) AS active_days,
          COALESCE(t.tier_level, 0)::int AS tier_level, w.points, w.listed
        FROM app_user u
        LEFT JOIN user_effort_totals t ON t.user_id = u.id
        LEFT JOIN weekly_lp_scores w ON w.user_id = u.id AND w.week_start = ${week}::date
        WHERE u.id = ${userId}::uuid
      )
      SELECT me.*, CASE WHEN me.listed THEN ${aboveCountSql(week, sql`me.points`)} END AS above, st.total_listed, st.histogram
      FROM me LEFT JOIN weekly_rank_stats st ON st.week_start = ${week}::date`);
    return row && {
      lifetimeLP: Number(row.lifetime_lp),
      lifetimeActiveDays: row.active_days,
      tierLevel: row.tier_level,
      weeklyLP: Number(row.points ?? 0),
      listed: row.listed === true,
      above: Number(row.above ?? 0),
      stats: row.total_listed === null ? null : { totalListed: row.total_listed, histogram: row.histogram ?? {} },
    };
  }

  async findTier(userId: string) {
    return this.db.query.appUsers.findFirst({
      where: eq(appUsers.id, userId),
      columns: { id: true },
      with: {
        effortTotals: { columns: { lifetimeLp: true, lifetimeActiveDays: true, tierLevel: true } },
        tierUnlocks: { columns: { tierLevel: true, tierKey: true, unlockedAt: true, source: true }, orderBy: (u) => u.tierLevel },
      },
    });
  }

  // RANK() over the top slice is exact: every learner with more points sorts inside it.
  async top(week: string, userId: string) {
    const { rows } = await this.db.execute<RawBoardRow>(sql`
      SELECT rank() OVER (ORDER BY w.points DESC) AS rank, u.username, u.avatar_key, w.points,
        COALESCE(t.tier_level, 0)::int AS tier_level, w.user_id = ${userId}::uuid AS is_me
      FROM (
        SELECT user_id, points, last_award_at FROM weekly_lp_scores
        WHERE week_start = ${week}::date AND listed
        ORDER BY points DESC, last_award_at, user_id LIMIT ${topLimit}
      ) w
      JOIN app_user u ON u.id = w.user_id
      LEFT JOIN user_effort_totals t ON t.user_id = w.user_id
      ORDER BY w.points DESC, w.last_award_at, w.user_id`);
    return rows.map(boardRow);
  }

  // Neighbours in display order (points desc, earliest to reach them first); empty unless the learner is listed.
  async around(week: string, userId: string) {
    const { rows } = await this.db.execute<RawBoardRow>(sql`
      WITH me AS (
        SELECT user_id, points, last_award_at FROM weekly_lp_scores
        WHERE user_id = ${userId}::uuid AND week_start = ${week}::date AND listed
      ), above AS (
        SELECT o.user_id, o.points, o.last_award_at FROM weekly_lp_scores o, me
        WHERE o.week_start = ${week}::date AND o.listed
          AND (o.points > me.points OR (o.points = me.points AND (o.last_award_at, o.user_id) < (me.last_award_at, me.user_id)))
        ORDER BY o.points, o.last_award_at DESC, o.user_id DESC LIMIT ${aroundRadius}
      ), below AS (
        SELECT o.user_id, o.points, o.last_award_at FROM weekly_lp_scores o, me
        WHERE o.week_start = ${week}::date AND o.listed
          AND (o.points < me.points OR (o.points = me.points AND (o.last_award_at, o.user_id) > (me.last_award_at, me.user_id)))
        ORDER BY o.points DESC, o.last_award_at, o.user_id LIMIT ${aroundRadius}
      ), board AS (
        SELECT * FROM above UNION ALL SELECT * FROM me UNION ALL SELECT * FROM below
      ), counted AS (
        SELECT b.*, ${aboveCountSql(week, sql`b.points`)} AS n FROM board b
      )
      SELECT CASE WHEN c.n < ${exactRankLimit} THEN c.n + 1 END AS rank, u.username, u.avatar_key, c.points,
        COALESCE(t.tier_level, 0)::int AS tier_level, c.user_id = ${userId}::uuid AS is_me
      FROM counted c
      JOIN app_user u ON u.id = c.user_id
      LEFT JOIN user_effort_totals t ON t.user_id = c.user_id
      ORDER BY c.points DESC, c.last_award_at, c.user_id`);
    return rows.map(boardRow);
  }

  // Closed weeks come from snapshots; a week not closed yet falls back to its live score.
  async history(userId: string, fromWeek: string) {
    const { rows } = await this.db.execute<{ week_start: string; points: string; rank: string | null }>(sql`
      SELECT week_start::text, points, rank FROM weekly_rank_snapshots
      WHERE user_id = ${userId}::uuid AND week_start >= ${fromWeek}::date
      UNION ALL
      SELECT w.week_start::text, w.points, NULL FROM weekly_lp_scores w
      WHERE w.user_id = ${userId}::uuid AND w.week_start >= ${fromWeek}::date
        AND NOT EXISTS (SELECT 1 FROM weekly_rank_snapshots s WHERE s.week_start = w.week_start AND s.user_id = w.user_id)`);
    return new Map(rows.map((r) => [r.week_start, { weeklyLP: Number(r.points), rank: r.rank === null ? null : Number(r.rank) }]));
  }

  // One statement; the caller turns the counts into the right error. A repeat of the same pair and week inserts nothing.
  async report(input: { reporterId: string; username: string; reason: ReportReason; week: string; previousWeek: string; dayStart: Date; now: Date }) {
    const { reporterId, username, reason, week, previousWeek, dayStart, now } = input;
    const { rows: [row] } = await this.db.execute<{ target_id: string | null; today: string }>(sql`
      WITH target AS (
        SELECT u.id FROM app_user u
        WHERE u.username = ${username}
          AND EXISTS (SELECT 1 FROM weekly_lp_scores w WHERE w.user_id = u.id AND w.listed AND w.week_start IN (${week}::date, ${previousWeek}::date))
      ), today AS (
        SELECT count(*) AS n FROM user_reports WHERE reporter_id = ${reporterId}::uuid AND created_at >= ${dayStart}::timestamptz
      ), ins AS (
        INSERT INTO user_reports (id, reporter_id, target_user_id, reason, week_start, created_at)
        SELECT ${newId()}::uuid, ${reporterId}::uuid, t.id, ${reason}, ${week}::date, ${now}::timestamptz
        FROM target t, today
        WHERE t.id <> ${reporterId}::uuid AND today.n < ${POLICY.ranking.reportsPerUtcDay}
        ON CONFLICT (reporter_id, target_user_id, week_start) DO NOTHING
      )
      SELECT (SELECT id FROM target) AS target_id, (SELECT n FROM today) AS today`);
    return { targetId: row.target_id, today: Number(row.today) };
  }

  async listReports(resolved: boolean, page: number, perPage: number) {
    const reporter = alias(appUsers, 'reporter');
    const target = alias(appUsers, 'target');
    return this.db
      .select({
        id: userReports.id, reason: userReports.reason, weekStart: userReports.weekStart, createdAt: userReports.createdAt,
        resolvedAt: userReports.resolvedAt, resolution: userReports.resolution,
        reporterUsername: reporter.username, targetUserId: userReports.targetUserId, targetUsername: target.username,
        targetRankingEligible: target.rankingEligible,
      })
      .from(userReports)
      .innerJoin(reporter, eq(reporter.id, userReports.reporterId))
      .innerJoin(target, eq(target.id, userReports.targetUserId))
      .where(resolved ? isNotNull(userReports.resolvedAt) : isNull(userReports.resolvedAt))
      .orderBy(resolved ? desc(userReports.resolvedAt) : userReports.createdAt)
      .limit(perPage).offset((page - 1) * perPage);
  }

  async resolveReport(id: string, actorId: string, resolution: ReportResolution, now: Date) {
    const [row] = await this.db.update(userReports)
      .set({ resolvedAt: now, resolvedBy: actorId, resolution })
      .where(and(eq(userReports.id, id), isNull(userReports.resolvedAt)))
      .returning({ id: userReports.id, resolution: userReports.resolution, resolvedAt: userReports.resolvedAt });
    return row;
  }

  async reportExists(id: string) {
    const [row] = await this.db.select({ id: userReports.id }).from(userReports).where(eq(userReports.id, id));
    return !!row;
  }

  // The learner may rename at once afterwards, so the change window restarts.
  async resetUsername(userId: string, username: string) {
    const [row] = await this.db.update(appUsers)
      .set({ username, usernameGenerated: true, usernameChangedAt: null })
      .where(eq(appUsers.id, userId))
      .returning({ id: appUsers.id, username: appUsers.username });
    return row;
  }

  async setEligibility(input: { userId: string; actorId: string; eligible: boolean; reason: string; now: Date }) {
    const { userId, actorId, eligible, reason, now } = input;
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(appUsers).set({ rankingEligible: eligible }).where(eq(appUsers.id, userId)).returning({ id: appUsers.id });
      if (!row) return undefined;
      await tx.insert(rankingEligibilityAudit).values({ userId, actorId, eligible, reason, createdAt: now });
      await tx.execute(syncListedSql(userId));
      return { id: userId, rankingEligible: eligible };
    });
  }

  async refreshStats(week: string, now: Date) {
    const bucket = sql`CASE WHEN points < ${BUCKETS.fineUntil} THEN points / ${BUCKETS.fineStep} * ${BUCKETS.fineStep}
      ELSE points / ${BUCKETS.coarseStep} * ${BUCKETS.coarseStep} END`;
    await this.db.execute(sql`
      WITH listed AS (SELECT points FROM weekly_lp_scores WHERE week_start = ${week}::date AND listed)
      INSERT INTO weekly_rank_stats (week_start, computed_at, total_listed, top1000_min_points, histogram)
      SELECT ${week}::date, ${now}::timestamptz, (SELECT count(*) FROM listed),
        (SELECT points FROM listed ORDER BY points DESC OFFSET ${exactRankLimit - 1} LIMIT 1),
        COALESCE((SELECT jsonb_object_agg(b, n) FROM (SELECT ${bucket} AS b, count(*) AS n FROM listed GROUP BY 1) h), '{}'::jsonb)
      ON CONFLICT (week_start) DO UPDATE SET
        computed_at = EXCLUDED.computed_at, total_listed = EXCLUDED.total_listed,
        top1000_min_points = EXCLUDED.top1000_min_points, histogram = EXCLUDED.histogram`);
  }

  // Closes every week before `closableBefore` that has no snapshot yet, so a missed run catches up. Idempotent.
  async closeWeeks(closableBefore: string, now: Date) {
    const { rows } = await this.db.execute<{ week_start: string }>(sql`
      INSERT INTO weekly_rank_snapshots (week_start, user_id, points, rank, listed_at_close, ranking_policy_version, closed_at)
      SELECT w.week_start, w.user_id, w.points,
        CASE WHEN w.listed THEN rank() OVER (PARTITION BY w.week_start, w.listed ORDER BY w.points DESC) END,
        w.listed, ${POLICY.ranking.version}, ${now}::timestamptz
      FROM weekly_lp_scores w
      WHERE w.week_start < ${closableBefore}::date
        AND NOT EXISTS (SELECT 1 FROM weekly_rank_snapshots s WHERE s.week_start = w.week_start)
      ON CONFLICT DO NOTHING
      RETURNING week_start::text`);
    return new Set(rows.map((r) => r.week_start)).size;
  }

  // Live scores are only needed until their week is snapshotted and out of the history window.
  async purgeScores(before: string) {
    await this.db.execute(sql`
      WITH old_scores AS (
        DELETE FROM weekly_lp_scores w
        WHERE w.week_start < ${before}::date
          AND EXISTS (SELECT 1 FROM weekly_rank_snapshots s WHERE s.week_start = w.week_start)
      )
      DELETE FROM weekly_rank_stats WHERE week_start < ${before}::date`);
  }
}
