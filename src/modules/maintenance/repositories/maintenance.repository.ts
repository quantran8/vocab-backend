import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { SESSION_STATUS } from '../../../common/constants/domain';
import { DB, Db } from '../../../db/db';
import { deletedIdentities, learningSessions, speechAssessmentReceipts } from '../../../db/schema';

@Injectable()
export class MaintenanceRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async expireIssuedSessions(now: Date) {
    const { rowCount } = await this.db
      .update(learningSessions)
      .set({ status: SESSION_STATUS.EXPIRED })
      .where(and(eq(learningSessions.status, SESSION_STATUS.ISSUED), lte(learningSessions.expiresAt, now)));
    return rowCount ?? 0;
  }

  async purge(now: Date, cutoff: Date) {
    const expiredBeforeCutoff = and(eq(learningSessions.status, SESSION_STATUS.EXPIRED), lte(learningSessions.expiresAt, cutoff));
    const purged = this.db.select({ id: learningSessions.id }).from(learningSessions).where(expiredBeforeCutoff);
    // Consumed receipts stay: skill_evidence references them.
    await this.db.transaction(async (tx) => {
      await tx.delete(speechAssessmentReceipts).where(or(
        and(isNull(speechAssessmentReceipts.consumedAt), lte(speechAssessmentReceipts.expiresAt, now)),
        inArray(speechAssessmentReceipts.sessionId, purged),
      ));
      // result, memory_observations and skill_evidence stay: they are the learning history.
      await tx
        .update(learningSessions)
        .set({ plan: null, rawEvents: null })
        .where(and(
          isNotNull(learningSessions.plan),
          or(expiredBeforeCutoff, and(eq(learningSessions.status, SESSION_STATUS.COMMITTED), lte(learningSessions.committedAt, cutoff))),
        ));
    });
  }

  async purgeDeletedIdentities(cutoff: Date) {
    await this.db.delete(deletedIdentities).where(lte(deletedIdentities.deletedAt, cutoff));
  }
}
