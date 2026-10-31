import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { Clock } from '../../common/clock';
import { SESSION_STATUS } from '../../common/constants/domain';
import { addHours } from '../../common/constants/time';
import { AppConfig } from '../../config/app-config';
import { POLICY } from '../../config/policy';
import { DB, Db } from '../../db/db';
import { learningSessions, sessionLearnSteps, sessionTasks, sessionTaskTargets, speechAssessmentReceipts } from '../../db/schema';
import { WeeklyService } from '../weekly/weekly.service';

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly weekly: WeeklyService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    if (!this.config.enableCron) return;
    const expired = await this.cleanup();
    const challenges = await this.weekly.generateDue();
    this.logger.log(`expired=${expired} challenges=${challenges}`);
  }

  async cleanup() {
    const now = this.clock.now();
    const { rowCount } = await this.db
      .update(learningSessions)
      .set({ status: SESSION_STATUS.expired })
      .where(and(eq(learningSessions.status, SESSION_STATUS.issued), lte(learningSessions.expiresAt, now)));

    const purged = this.db
      .select({ id: learningSessions.id })
      .from(learningSessions)
      .where(and(
        eq(learningSessions.status, SESSION_STATUS.expired),
        lte(learningSessions.expiresAt, addHours(now, -POLICY.session.retentionHours)),
      ));
    // Consumed receipts stay: skill_evidence references them.
    await this.db.transaction(async (tx) => {
      await tx.delete(speechAssessmentReceipts).where(or(
        and(isNull(speechAssessmentReceipts.consumedAt), lte(speechAssessmentReceipts.expiresAt, now)),
        inArray(speechAssessmentReceipts.sessionId, purged),
      ));
      await tx.delete(sessionLearnSteps).where(inArray(sessionLearnSteps.sessionId, purged));
      await tx.delete(sessionTaskTargets).where(inArray(sessionTaskTargets.sessionId, purged));
      await tx.delete(sessionTasks).where(inArray(sessionTasks.sessionId, purged));
    });
    return rowCount ?? 0;
  }
}
