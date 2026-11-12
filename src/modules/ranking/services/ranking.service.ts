import { Injectable } from '@nestjs/common';
import { AVATAR_KEYS, AvatarKey, LEADERBOARD_VIEW, REPORT_REASONS, ReportReason } from '../../../common/constants/domain';
import { addDays, DAYS_PER_WEEK, startOfUtcDay, utcDay, utcWeekStart } from '../../../common/constants/time';
import { Clock } from '../../../common/clock';
import { ApiError } from '../../../common/http/api-error';
import { AppConfig } from '../../../config/app-config';
import { POLICY } from '../../../config/policy';
import { tierBadge, TIER_LEVELS, tierView } from '../../learning-points/domain/tier';
import { position } from '../domain/position';
import { canonicalUsername, usernameChangeAvailableAt, usernameProblem } from '../domain/username';
import { BoardRow, RankingRepository } from '../repositories/ranking.repository';
import { isUsernameTaken } from '../repositories/username-collision';

const boardView = (rows: BoardRow[]) => rows.map(({ tierLevel, ...row }) => ({ ...row, lifetimeTier: tierBadge(tierLevel) }));

@Injectable()
export class RankingService {
  constructor(private readonly repository: RankingRepository, private readonly config: AppConfig, private readonly clock: Clock) {}

  private week(now = this.clock.now()) {
    const start = utcWeekStart(now);
    return { start, key: utcDay(start), endsAt: addDays(start, DAYS_PER_WEEK) };
  }

  private requireEnabled() {
    if (!this.config.rankingEnabled) throw new ApiError('RANKING_DISABLED', 'The leaderboard is not open yet');
  }

  meta() {
    const week = this.week();
    return {
      weekStart: week.key,
      weekEndsAt: week.endsAt.toISOString(),
      rankingEnabled: this.config.rankingEnabled,
      rankingPolicyVersion: POLICY.ranking.version,
      tierPolicyVersion: POLICY.tier.version,
      lpPolicyVersion: POLICY.lp.version,
      tiers: TIER_LEVELS.map((l) => ({ level: l.level, key: l.key, minLifetimeLP: l.minLifetimeLP, minLifetimeActiveDays: l.minActiveDays })),
      minQualifiedDayLP: POLICY.lp.minQualifiedDayLP,
      avatarKeys: AVATAR_KEYS,
      reportReasons: REPORT_REASONS,
      usernameChangeDays: POLICY.ranking.usernameChangeDays,
    };
  }

  async myRanking(userId: string) {
    const week = this.week();
    const me = await this.repository.findMyWeek(userId, week.key);
    if (!me) throw new ApiError('NOT_FOUND', 'User not found');
    const listed = this.config.rankingEnabled && me.listed && me.weeklyLP > 0;
    return {
      weekStart: week.key,
      weekEndsAt: week.endsAt.toISOString(),
      weeklyLP: me.weeklyLP,
      listed,
      position: position({ listed, above: me.above, points: me.weeklyLP, stats: me.stats }),
      tier: tierView(me),
      rankingPolicyVersion: POLICY.ranking.version,
      tierPolicyVersion: POLICY.tier.version,
    };
  }

  async tier(userId: string) {
    const user = await this.repository.findTier(userId);
    if (!user) throw new ApiError('NOT_FOUND', 'User not found');
    const totals = user.effortTotals;
    return {
      ...tierView({ lifetimeLP: totals?.lifetimeLp ?? 0, lifetimeActiveDays: totals?.lifetimeActiveDays ?? 0, tierLevel: totals?.tierLevel ?? 0 }),
      minQualifiedDayLP: POLICY.lp.minQualifiedDayLP,
      milestones: user.tierUnlocks.map((u) => ({ level: u.tierLevel, key: u.tierKey, unlockedAt: u.unlockedAt, source: u.source })),
      tierPolicyVersion: POLICY.tier.version,
    };
  }

  async leaderboard(userId: string, view: string) {
    this.requireEnabled();
    const week = this.week();
    const rows = view === LEADERBOARD_VIEW.AROUND
      ? await this.repository.around(week.key, userId)
      : await this.repository.top(week.key, userId);
    return { weekStart: week.key, weekEndsAt: week.endsAt.toISOString(), view, rows: boardView(rows) };
  }

  /** The current week live, then each closed week newest first; a week without LP reads 0. */
  async history(userId: string, weeks: number) {
    const current = this.week();
    const from = addDays(current.start, -weeks * DAYS_PER_WEEK);
    const rows = await this.repository.history(userId, utcDay(from));
    const entry = (start: Date) => {
      const key = utcDay(start);
      const row = rows.get(key);
      return { weekStart: key, weeklyLP: row?.weeklyLP ?? 0, rank: row?.rank ?? null };
    };
    return {
      currentWeek: { weekStart: current.key, weeklyLP: rows.get(current.key)?.weeklyLP ?? 0 },
      weeks: Array.from({ length: weeks }, (_, i) => entry(addDays(current.start, -(i + 1) * DAYS_PER_WEEK))),
    };
  }

  async report(userId: string, body: { username: string; reason: ReportReason }) {
    this.requireEnabled();
    const now = this.clock.now();
    const week = this.week(now);
    const result = await this.repository.report({
      reporterId: userId, username: canonicalUsername(body.username), reason: body.reason,
      week: week.key, previousWeek: utcDay(addDays(week.start, -DAYS_PER_WEEK)), dayStart: startOfUtcDay(now), now,
    });
    if (!result.targetId) throw new ApiError('NOT_FOUND', 'No such learner on the board');
    if (result.targetId === userId) throw new ApiError('VALIDATION_FAILED', 'You cannot report yourself');
    if (result.today >= POLICY.ranking.reportsPerUtcDay) throw new ApiError('REPORT_LIMIT_REACHED');
    return { received: true };
  }

  async updateProfile(userId: string, body: { username?: string; avatarKey?: string }) {
    const now = this.clock.now();
    const current = await this.repository.findIdentity(userId);
    if (!current) throw new ApiError('NOT_FOUND', 'User not found');
    const patch: Parameters<RankingRepository['updateProfile']>[1] = {};

    if (body.avatarKey !== undefined) {
      if (!AVATAR_KEYS.includes(body.avatarKey as AvatarKey)) throw new ApiError('AVATAR_INVALID');
      patch.avatarKey = body.avatarKey as AvatarKey;
    }
    if (body.username !== undefined) {
      const username = canonicalUsername(body.username);
      const problem = usernameProblem(username);
      if (problem) throw new ApiError(problem);
      if (username !== current.username) {
        const availableAt = usernameChangeAvailableAt(current, now);
        if (availableAt) throw new ApiError('USERNAME_CHANGE_TOO_SOON', undefined, { availableAt: availableAt.toISOString() });
        Object.assign(patch, { username, usernameGenerated: false, usernameChangedAt: now });
      }
    }

    const row = Object.keys(patch).length === 0 ? current : await this.repository.updateProfile(userId, patch).catch((error: unknown) => {
      if (isUsernameTaken(error)) throw new ApiError('USERNAME_TAKEN');
      throw error;
    });
    return { username: row.username, avatarKey: row.avatarKey, usernameChangeAvailableAt: usernameChangeAvailableAt(row, now) };
  }

  async introSeen(userId: string) {
    await this.repository.markIntroSeen(userId);
    return { rankingIntroSeen: true };
  }
}
