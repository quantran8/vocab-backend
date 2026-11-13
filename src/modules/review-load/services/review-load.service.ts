import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Clock } from '../../../common/clock';
import { ApiError } from '../../../common/http/api-error';
import { ackSchema, overrideSchema } from '../dto/review-load.schemas';
import { ReviewLoadRepository } from '../repositories/review-load.repository';

@Injectable()
export class ReviewLoadService {
  constructor(private readonly repository: ReviewLoadRepository, private readonly clock: Clock) {}

  async setOverride(userId: string, { value, mode, until }: z.infer<typeof overrideSchema>) {
    const now = this.clock.now();
    const untilDate = until ? new Date(until) : null;
    if (untilDate && untilDate <= now) throw new ApiError('VALIDATION_FAILED', 'until must be in the future');
    const override = await this.repository.setOverride(userId, value, mode, untilDate, now);
    if (!override) throw new ApiError('VALIDATION_FAILED', 'value must be below dailyNewWordGoal');
    return { override };
  }

  async clearOverride(userId: string) {
    await this.repository.clearOverride(userId, this.clock.now());
    return { override: null };
  }

  async ack(userId: string, { backlog }: z.infer<typeof ackSchema>) {
    await this.repository.ack(userId, backlog, this.clock.now());
    return { backlog };
  }

  async pause(userId: string, collectionId: string) {
    const pausedAt = this.clock.now();
    const result = await this.repository.pause(userId, collectionId, pausedAt);
    if (!result.found) throw new ApiError('NOT_FOUND', 'Collection not found');
    if (result.active) throw new ApiError('REVIEW_PAUSE_ACTIVE_COLLECTION', 'The active collection is always reviewed');
    return { collectionId, paused: true };
  }

  async unpause(userId: string, collectionId: string) {
    await this.repository.unpause(userId, collectionId);
    return { collectionId, paused: false };
  }
}
