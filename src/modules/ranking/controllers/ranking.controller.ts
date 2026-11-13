import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { historyQuerySchema, leaderboardQuerySchema, profileSchema, reportSchema } from '../dto/ranking.schemas';
import { RankingService } from '../services/ranking.service';

const ACCEPTED = 202;

@Controller('v1/me')
export class MeRankingController {
  constructor(private readonly ranking: RankingService) {}

  @Put('profile')
  profile(@CurrentUser() user: AuthUser, @Body(new ZodPipe(profileSchema)) body: z.infer<typeof profileSchema>) {
    return this.ranking.updateProfile(user.id, body);
  }

  @Post('ranking/intro-seen')
  @HttpCode(200)
  introSeen(@CurrentUser() user: AuthUser) {
    return this.ranking.introSeen(user.id);
  }

  @Get('ranking')
  myRanking(@CurrentUser() user: AuthUser) {
    return this.ranking.myRanking(user.id);
  }

  @Get('ranking/history')
  history(@CurrentUser() user: AuthUser, @Query(new ZodPipe(historyQuerySchema)) query: z.infer<typeof historyQuerySchema>) {
    return this.ranking.history(user.id, query.weeks);
  }

  @Get('tier')
  tier(@CurrentUser() user: AuthUser) {
    return this.ranking.tier(user.id);
  }
}

@Controller('v1/ranking')
export class RankingController {
  constructor(private readonly ranking: RankingService) {}

  @Get('meta')
  meta() {
    return this.ranking.meta();
  }

  @Get('leaderboard')
  leaderboard(@CurrentUser() user: AuthUser, @Query(new ZodPipe(leaderboardQuerySchema)) query: z.infer<typeof leaderboardQuerySchema>) {
    return this.ranking.leaderboard(user.id, query.view);
  }

  @Post('reports')
  @HttpCode(ACCEPTED)
  report(@CurrentUser() user: AuthUser, @Body(new ZodPipe(reportSchema)) body: z.infer<typeof reportSchema>) {
    return this.ranking.report(user.id, body);
  }
}
