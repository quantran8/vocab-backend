import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Clock } from '../../../common/clock';
import { addDays, addHours, addMinutes, DAYS_PER_WEEK, HOURS_PER_DAY, utcDay, utcWeekStart } from '../../../common/constants/time';
import { AppConfig } from '../../../config/app-config';
import { POLICY } from '../../../config/policy';
import { ChallengeRepository } from '../../challenge/repositories/challenge.repository';
import { EffortRepository } from '../../learning-points/repositories/effort.repository';
import { RankingRepository } from '../../ranking/repositories/ranking.repository';
import { MaintenanceRepository } from '../repositories/maintenance.repository';

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly repository: MaintenanceRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly challenges: ChallengeRepository,
    private readonly ranking: RankingRepository,
    private readonly effort: EffortRepository,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    if (!this.config.enableCron) return;
    const expired = await this.cleanup();
    this.logger.log(`expired=${expired}`);
  }

  async cleanup() {
    const now = this.clock.now();
    const expired = await this.repository.expireIssuedSessions(now);
    await this.repository.purge(now, addHours(now, -POLICY.session.retentionHours));
    await this.repository.purgeDeletedIdentities(addHours(now, -POLICY.account.deletedIdentityRetentionHours));
    await this.challenges.expireRuns(now);
    await this.challenges.purgeRuns(addHours(now, -POLICY.challenge.eventsRetentionDays * HOURS_PER_DAY));
    await this.ranking.purgeScores(utcDay(addDays(utcWeekStart(now), -(POLICY.ranking.historyWeeks + 1) * DAYS_PER_WEEK)));
    return expired;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async rankStats() {
    if (!this.config.enableCron) return;
    await this.refreshRankStats();
  }

  refreshRankStats() {
    const now = this.clock.now();
    return this.ranking.refreshStats(utcDay(utcWeekStart(now)), now);
  }

  // Monday 00:10 UTC; the delay lets a commit that started before midnight land first. Hourly retries catch a missed run.
  @Cron('10 * * * *', { timeZone: 'UTC' })
  async weekClose() {
    if (!this.config.enableCron) return;
    const closed = await this.closeWeeks();
    if (closed > 0) this.logger.log(`ranking weeks closed=${closed}`);
  }

  closeWeeks() {
    const now = this.clock.now();
    const closableBefore = utcWeekStart(addMinutes(now, -POLICY.ranking.weekCloseDelayMinutes));
    return this.ranking.closeWeeks(utcDay(closableBefore), now);
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { timeZone: 'UTC' })
  async daily() {
    if (!this.config.enableCron) return;
    const now = this.clock.now();
    const raised = await this.effort.raiseTiers(now);
    const mismatches = await this.effort.reconcile(now);
    if (raised > 0) this.logger.log(`tiers raised by policy=${raised}`);
    if (mismatches.totals + mismatches.days + mismatches.weeks > 0) this.logger.warn(`LP aggregates differ from ledger: ${JSON.stringify(mismatches)}`);
  }
}
