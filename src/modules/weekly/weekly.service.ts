import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { Clock } from '../../common/clock';
import { WEEKLY_STATE } from '../../common/constants/domain';
import { addHours, HOURS_PER_WEEK } from '../../common/constants/time';
import { newId } from '../../common/ids';
import { DB, Db, toDate } from '../../db/db';
import { weeklyChallengeMeanings, weeklyChallenges } from '../../db/schema';

const SECONDS_PER_CYCLE = HOURS_PER_WEEK * 3_600;

type CycleRow = { userId: string; cycleStartAt: string; meaningIds: string[] };

@Injectable()
export class WeeklyService {
  constructor(@Inject(DB) private readonly db: Db, private readonly clock: Clock) {}

  list(userId: string) {
    return this.db
      .select({
        id: weeklyChallenges.id,
        cycleStartAt: weeklyChallenges.cycleStartAt,
        cycleEndAt: weeklyChallenges.cycleEndAt,
        state: weeklyChallenges.state,
        meaningCount: count(weeklyChallengeMeanings.meaningId),
      })
      .from(weeklyChallenges)
      .leftJoin(weeklyChallengeMeanings, eq(weeklyChallengeMeanings.challengeId, weeklyChallenges.id))
      .where(and(eq(weeklyChallenges.userId, userId), eq(weeklyChallenges.state, WEEKLY_STATE.available)))
      .groupBy(weeklyChallenges.id)
      .orderBy(asc(weeklyChallenges.cycleStartAt));
  }

  /** Snapshots every finished cycle that has learned Meanings and no challenge yet; idempotent. */
  async generateDue() {
    const now = this.clock.now();
    const { rows } = await this.db.execute<CycleRow>(sql`
      -- Millisecond precision: JS Dates cannot round-trip microseconds, which would defeat NOT EXISTS.
      WITH learned AS (
        SELECT p.user_id, p.meaning_id,
               date_trunc('milliseconds', s.weekly_anchor_at + make_interval(secs => ${SECONDS_PER_CYCLE}::double precision
                 * floor(extract(epoch FROM p.learned_at - s.weekly_anchor_at) / ${SECONDS_PER_CYCLE}::double precision))) AS cycle_start_at
        FROM user_meaning_progress p
        JOIN user_settings s ON s.user_id = p.user_id
      )
      SELECT l.user_id AS "userId", l.cycle_start_at AS "cycleStartAt", array_agg(l.meaning_id::text) AS "meaningIds"
      FROM learned l
      WHERE l.cycle_start_at + make_interval(secs => ${SECONDS_PER_CYCLE}::double precision) <= ${now}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM weekly_challenges w
          WHERE w.user_id = l.user_id AND w.cycle_start_at = l.cycle_start_at)
      GROUP BY l.user_id, l.cycle_start_at`);
    if (rows.length === 0) return 0;

    const challenges = rows.map(({ cycleStartAt, ...c }) => ({ ...c, cycleStartAt: toDate(cycleStartAt), id: newId() }));
    await this.db.transaction(async (tx) => {
      await tx.insert(weeklyChallenges).values(
        challenges.map(({ id, userId, cycleStartAt }) => ({ id, userId, cycleStartAt, cycleEndAt: addHours(cycleStartAt, HOURS_PER_WEEK) })),
      );
      await tx.insert(weeklyChallengeMeanings).values(
        challenges.flatMap(({ id, meaningIds }) => meaningIds.map((meaningId) => ({ challengeId: id, meaningId }))),
      );
    });
    return challenges.length;
  }
}
