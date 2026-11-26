import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../../common/auth/auth.decorators';
import { HISTORY_PERIOD, HISTORY_PERIODS, JOURNEY_TOPIC_FILTER } from '../../../common/constants/domain';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { LearningHistoryService } from '../services/learning-history.service';

const querySchema = z.object({ period: z.enum(HISTORY_PERIODS).default(HISTORY_PERIOD.WEEK) });
const wordsSchema = querySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  topicId: z.union([z.uuid(), z.literal(JOURNEY_TOPIC_FILTER.NONE)]).optional(),
});

@Controller('v1/me/learning-journey')
export class LearningHistoryController {
  constructor(private readonly history: LearningHistoryService) {}

  @Get()
  get(@CurrentUser() user: AuthUser, @Query(new ZodPipe(querySchema)) query: z.infer<typeof querySchema>) {
    return this.history.history(user.id, query.period);
  }

  @Get('words')
  words(@CurrentUser() user: AuthUser, @Query(new ZodPipe(wordsSchema)) query: z.infer<typeof wordsSchema>) {
    return this.history.words(user.id, query.period, query.limit, query.offset, query.topicId);
  }
}
