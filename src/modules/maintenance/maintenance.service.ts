import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { Clock } from '../../common/clock';
import { SESSION_STATUS } from '../../common/constants/domain';
import { addHours } from '../../common/constants/time';
import { AppConfig } from '../../config/app-config';
import { POLICY } from '../../config/policy';
import { DB, Db } from '../../db/db';
import { deletedIdentities, learningSessions, speechAssessmentReceipts } from '../../db/schema';

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    if (!this.config.enableCron) return;
    const expired = await this.cleanup();
    this.logger.log(`expired=${expired}`);
  }

  async cleanup() {
    const now = this.clock.now();
    const { rowCount } = await this.db
      .update(learningSessions)
      .set({ status: SESSION_STATUS.EXPIRED })
      .where(and(eq(learningSessions.status, SESSION_STATUS.ISSUED), lte(learningSessions.expiresAt, now)));

    const cutoff = addHours(now, -POLICY.session.retentionHours);
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
    await this.db.delete(deletedIdentities).where(lte(deletedIdentities.deletedAt, addHours(now, -POLICY.account.deletedIdentityRetentionHours)));
    return rowCount ?? 0;
  }
}
