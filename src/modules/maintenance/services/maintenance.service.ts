import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Clock } from '../../../common/clock';
import { addHours, HOURS_PER_DAY } from '../../../common/constants/time';
import { AppConfig } from '../../../config/app-config';
import { POLICY } from '../../../config/policy';
import { ChallengeRepository } from '../../challenge/repositories/challenge.repository';
import { MaintenanceRepository } from '../repositories/maintenance.repository';

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly repository: MaintenanceRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly challenges: ChallengeRepository,
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
    return expired;
  }
}
