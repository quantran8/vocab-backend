import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../../common/auth/auth.decorators';
import { HISTORY_PERIOD, HISTORY_PERIODS } from '../../../common/constants/domain';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { LearningHistoryService } from '../services/learning-history.service';

const querySchema = z.object({ period: z.enum(HISTORY_PERIODS).default(HISTORY_PERIOD.WEEK) });

@Controller('v1/me/learning-journey')
export class LearningHistoryController {
  constructor(private readonly history: LearningHistoryService) {}

  @Get()
  get(@CurrentUser() user: AuthUser, @Query(new ZodPipe(querySchema)) query: z.infer<typeof querySchema>) {
    return this.history.history(user.id, query.period);
  }
}
