import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { CommitBody, commitBodySchema } from '../practice-evaluator/events';
import { CommitService } from './commit.service';

@Controller('v1/sessions/:sessionId')
export class SessionCommitController {
  constructor(private readonly commits: CommitService) {}

  @Post('commit')
  @HttpCode(200)
  commit(
    @CurrentUser() user: AuthUser,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodPipe(commitBodySchema, 'INVALID_SUBMISSION')) body: CommitBody,
  ) {
    return this.commits.commit(user.id, sessionId, body);
  }

  @Get('commit-status')
  status(@CurrentUser() user: AuthUser, @Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.commits.status(user.id, sessionId);
  }
}
