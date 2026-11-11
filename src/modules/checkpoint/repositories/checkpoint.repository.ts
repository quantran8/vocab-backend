import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq } from 'drizzle-orm';
import { CHECKPOINT_STATE } from '../../../common/constants/domain';
import { DB, Db } from '../../../db/db';
import { checkpointChallengeMeanings, checkpointChallenges } from '../../../db/schema';

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
}
