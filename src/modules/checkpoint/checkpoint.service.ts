import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { CHECKPOINT_STATE } from '../../common/constants/domain';
import { newId } from '../../common/ids';
import { POLICY } from '../../config/policy';
import { DB, Db, Tx } from '../../db/db';
import { checkpointChallengeMeanings, checkpointChallenges } from '../../db/schema';

type PendingSession = { lastSequence: number; meaningIds: string[] };

@Injectable()
export class CheckpointService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(userId: string) {
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

  /** Runs inside the commit transaction, so the commit's user lock serialises sequence numbers. */
  async generateFor(tx: Tx, userId: string) {
    const size = POLICY.checkpoint.sessionsPerChallenge;
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
    if (rows.length < size) return 0;

    const challenges = Array.from({ length: Math.floor(rows.length / size) }, (_, i) => ({
      id: newId(),
      userId,
      sequence: rows[0].lastSequence + i + 1,
      meaningIds: rows.slice(i * size, (i + 1) * size).flatMap((r) => r.meaningIds),
    }));
    await tx.insert(checkpointChallenges).values(challenges.map(({ id, userId: owner, sequence }) => ({ id, userId: owner, sequence })));
    await tx.insert(checkpointChallengeMeanings).values(
      challenges.flatMap(({ id, meaningIds }) => meaningIds.map((meaningId) => ({ challengeId: id, meaningId }))),
    );
    return challenges.length;
  }
}
