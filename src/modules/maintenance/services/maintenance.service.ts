import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Clock } from '../../../common/clock';
import { addHours } from '../../../common/constants/time';
import { AppConfig } from '../../../config/app-config';
import { POLICY } from '../../../config/policy';
import { MaintenanceRepository } from '../repositories/maintenance.repository';

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly repository: MaintenanceRepository,
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
    const expired = await this.repository.expireIssuedSessions(now);
    await this.repository.purge(now, addHours(now, -POLICY.session.retentionHours));
    await this.repository.purgeDeletedIdentities(addHours(now, -POLICY.account.deletedIdentityRetentionHours));
    return expired;
  }
}
