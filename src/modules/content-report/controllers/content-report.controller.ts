import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AdminOnly, AuthUser, CurrentUser } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { ListReports, listReportsSchema, SubmitReport, submitReportSchema, transitionSchema } from '../dto/content-report.schemas';
import { ContentReportService } from '../services/content-report.service';
import { z } from 'zod';

const HTTP_OK = 200;

@Controller('v1/me/content-reports')
export class ContentReportController {
  constructor(private readonly reports: ContentReportService) {}

  // 201 for a new report; 200 when it replays a retry or points at an open duplicate.
  @Post()
  async submit(@CurrentUser() user: AuthUser, @Body(new ZodPipe(submitReportSchema)) body: SubmitReport, @Res({ passthrough: true }) reply: FastifyReply) {
    const { replayed, ...result } = await this.reports.submit(user.id, body);
    if (replayed || result.duplicate) reply.code(HTTP_OK);
    return result;
  }
}

@AdminOnly()
@Controller('admin/content-reports')
export class AdminContentReportController {
  constructor(private readonly reports: ContentReportService) {}

  @Get()
  list(@Query(new ZodPipe(listReportsSchema)) query: ListReports) {
    return this.reports.list(query);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.reports.detail(id);
  }

  @Post(':id/status')
  @HttpCode(HTTP_OK)
  transition(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(transitionSchema)) body: z.infer<typeof transitionSchema>) {
    return this.reports.transition(actor, id, body.status, body.note);
  }
}
