import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { CommitRunBody, commitRunSchema, LevelParams, levelParamsSchema } from '../dto/challenge.schemas';
import { ChallengeMapService } from '../services/challenge-map.service';
import { ChallengeRunService } from '../services/challenge-run.service';

@Controller('v1')
export class ChallengeController {
  constructor(private readonly maps: ChallengeMapService, private readonly runs: ChallengeRunService) {}

  @Get('me/challenge-map')
  map(@CurrentUser() user: AuthUser) {
    return this.maps.map(user.id);
  }

  @Post('challenge/chapters/:chapterNo/levels/:levelNo/runs')
  issue(@CurrentUser() user: AuthUser, @Param(new ZodPipe(levelParamsSchema)) params: LevelParams) {
    return this.runs.issue(user.id, params.chapterNo, params.levelNo);
  }

  @Post('challenge/runs/:runId/start')
  @HttpCode(200)
  start(@CurrentUser() user: AuthUser, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.runs.start(user.id, runId);
  }

  @Post('challenge/runs/:runId/commit')
  @HttpCode(200)
  commit(
    @CurrentUser() user: AuthUser,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body(new ZodPipe(commitRunSchema, 'CHALLENGE_INVALID_EVENTS')) body: CommitRunBody,
  ) {
    return this.runs.commit(user.id, runId, body);
  }

  @Post('challenge/runs/:runId/quit')
  @HttpCode(200)
  quit(@CurrentUser() user: AuthUser, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.runs.quit(user.id, runId);
  }

  @Get('challenge/runs/:runId/status')
  status(@CurrentUser() user: AuthUser, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.runs.status(user.id, runId);
  }
}
