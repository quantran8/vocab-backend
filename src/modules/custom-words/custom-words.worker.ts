import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppConfig } from '../../config/app-config';
import { CustomWordsService } from './custom-words.service';

@Injectable()
export class CustomWordsWorker {
  private readonly logger = new Logger(CustomWordsWorker.name);
  private running = false;

  constructor(private readonly customWords: CustomWordsService, private readonly config: AppConfig) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  translate() {
    return this.once(() => this.customWords.translateNextPending());
  }

  @Cron(CronExpression.EVERY_MINUTE)
  repairAudio() {
    return this.once(() => this.customWords.repairNextAudio());
  }

  // A slow provider call must not stack ticks.
  private async once(job: () => Promise<boolean>) {
    if (!this.config.enableCron || this.running) return;
    this.running = true;
    try {
      await job();
    } catch (error) {
      this.logger.warn((error as Error).message);
    } finally {
      this.running = false;
    }
  }
}
