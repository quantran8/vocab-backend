import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { CHECKPOINT_STATE } from '../../../common/constants/domain';
import { DB, Db, Tx } from '../../../db/db';
import { checkpointChallengeMeanings, checkpointChallenges } from '../../../db/schema';

export type PendingSession = { lastSequence: number; meaningIds: string[] };
export type NewChallenge = { id: string; userId: string; sequence: number; meaningIds: string[] };

@Injectable()
export class CheckpointRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  listAvailable(userId: string) {
    return this.db
      .select({
        id: checkpointChallenges.id,
        sequence: checkpointChallenges.sequence,
        state: checkpointChallenges.state,
        createdAt: checkpointChallenges.createdAt,
        meaningCount: count(checkpointChallengeMeanings.meaningId),
      })
      .from(checkpointChallenges)
      .leftJoin(checkpointChallengeMeanings, eq(checkpointChallengeMeanings.challengeId, checkpointChallenges.id))
      .where(and(eq(checkpointChallenges.userId, userId), eq(checkpointChallenges.state, CHECKPOINT_STATE.AVAILABLE)))
      .groupBy(checkpointChallenges.id)
      .orderBy(asc(checkpointChallenges.sequence));
  }

  /** Learned sessions not yet in any challenge, oldest first. */
  async pendingSessions(tx: Tx, userId: string) {
    const { rows } = await tx.execute<PendingSession>(sql`
      SELECT (SELECT COALESCE(max(sequence), 0)::int FROM checkpoint_challenges WHERE user_id = ${userId}::uuid) AS "lastSequence",
             array_agg(p.meaning_id::text) AS "meaningIds"
      FROM user_meaning_progress p
      WHERE p.user_id = ${userId}::uuid AND p.learned_session_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM checkpoint_challenge_meanings m
          JOIN checkpoint_challenges c ON c.id = m.challenge_id
          WHERE c.user_id = p.user_id AND m.meaning_id = p.meaning_id)
      GROUP BY p.learned_session_id
      ORDER BY min(p.learned_at), p.learned_session_id`);
    return rows;
  }

  async insertChallenges(tx: Tx, challenges: NewChallenge[]) {
    await tx.insert(checkpointChallenges).values(challenges.map(({ id, userId, sequence }) => ({ id, userId, sequence })));
    await tx.insert(checkpointChallengeMeanings).values(
      challenges.flatMap(({ id, meaningIds }) => meaningIds.map((meaningId) => ({ challengeId: id, meaningId }))),
    );
  }
}
