import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly, AuthUser, CurrentUser, FullAdminOnly } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { eligibilitySchema, listReportsSchema, resolveReportSchema } from '../../ranking/dto/ranking.schemas';
import { AdminRankingService } from '../services/admin-ranking.service';

const uuid = new ParseUUIDPipe();

@AdminOnly()
@FullAdminOnly()
@Controller('admin')
export class AdminRankingController {
  constructor(private readonly ranking: AdminRankingService) {}

  @Get('ranking/reports')
  reports(@Query(new ZodPipe(listReportsSchema)) query: z.infer<typeof listReportsSchema>) {
    return this.ranking.listReports(query.status, query.page, query.perPage);
  }

  @Post('ranking/reports/:id/resolve')
  @HttpCode(200)
  resolve(@CurrentUser() actor: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(resolveReportSchema)) body: z.infer<typeof resolveReportSchema>) {
    return this.ranking.resolveReport(actor, id, body.resolution);
  }

  @Post('users/:id/username/reset')
  @HttpCode(200)
  resetUsername(@CurrentUser() actor: AuthUser, @Param('id', uuid) id: string) {
    return this.ranking.resetUsername(actor, id);
  }

  @Put('users/:id/ranking-eligibility')
  eligibility(@CurrentUser() actor: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(eligibilitySchema)) body: z.infer<typeof eligibilitySchema>) {
    return this.ranking.setEligibility(actor, id, body.eligible, body.reason);
  }
}
