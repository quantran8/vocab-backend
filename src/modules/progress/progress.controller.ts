import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ProgressService } from './progress.service';

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().max(64).optional(),
});

@Controller('v1')
export class ProgressController {
  constructor(private readonly progress: ProgressService) {}

  @Get('me/learn-home')
  learnHome(@CurrentUser() user: AuthUser) {
    return this.progress.learnHome(user.id);
  }

  @Get('me/words')
  words(@CurrentUser() user: AuthUser, @Query(new ZodPipe(pageSchema)) page: z.infer<typeof pageSchema>) {
    return this.progress.words(user.id, page.limit, page.offset, page.q);
  }

  @Get('me/words/stats')
  wordStats(@CurrentUser() user: AuthUser) {
    return this.progress.wordStats(user.id);
  }

  @Get('words/:wordId')
  word(@CurrentUser() user: AuthUser, @Param('wordId', ParseUUIDPipe) wordId: string) {
    return this.progress.word(user.id, wordId);
  }
}
