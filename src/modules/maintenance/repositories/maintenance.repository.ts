import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
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
    await this.db.transaction(async (tx) => {
      // Nothing references a receipt once its commit is written, consumed or not.
      await tx.delete(speechAssessmentReceipts).where(or(
        lte(speechAssessmentReceipts.expiresAt, now),
        inArray(speechAssessmentReceipts.sessionId, purged),
      ));
      // result, memory_observations and user_speaking_progress stay: they are the learning history.
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
