import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { POLICY } from '../../../config/policy';
import { JourneyService } from '../services/journey.service';

const { journey } = POLICY;
const querySchema = z.object({
  historyLimit: z.coerce.number().int().min(0).max(journey.maxHistorySegments).default(journey.defaultHistorySegments),
  futureLimit: z.coerce.number().int().min(0).max(journey.maxFutureSegments).default(journey.defaultFutureSegments),
  before: z.coerce.number().int().min(2).optional(),
});

/** Deprecated: superseded by GET /v1/me/challenge-map; kept until old clients are retired. */
@Controller('v1/me/journey')
export class JourneyController {
  constructor(private readonly journeys: JourneyService) {}

  @Get()
  get(@CurrentUser() user: AuthUser, @Query(new ZodPipe(querySchema)) query: z.infer<typeof querySchema>) {
    return this.journeys.journey(user.id, { history: query.historyLimit, future: query.futureLimit, before: query.before });
  }
}
