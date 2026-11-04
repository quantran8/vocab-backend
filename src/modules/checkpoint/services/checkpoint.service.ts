import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { POLICY } from '../../../config/policy';
import { Tx } from '../../../db/db';
import { CheckpointRepository } from '../repositories/checkpoint.repository';

@Injectable()
export class CheckpointService {
  constructor(private readonly repository: CheckpointRepository) {}

  list(userId: string) {
    return this.repository.listAvailable(userId);
  }

  /** Runs inside the commit transaction, so the commit's user lock serialises sequence numbers. */
  async generateFor(tx: Tx, userId: string) {
    const size = POLICY.checkpoint.sessionsPerChallenge;
    const rows = await this.repository.pendingSessions(tx, userId);
    if (rows.length < size) return 0;

    const challenges = Array.from({ length: Math.floor(rows.length / size) }, (_, i) => ({
      id: newId(),
      userId,
      sequence: rows[0].lastSequence + i + 1,
      meaningIds: rows.slice(i * size, (i + 1) * size).flatMap((r) => r.meaningIds),
    }));
    await this.repository.insertChallenges(tx, challenges);
    return challenges.length;
  }
}
