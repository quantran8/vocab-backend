import { Body, Controller, Delete, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { AuthUser, CurrentUser } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { ackSchema, overrideSchema } from '../dto/review-load.schemas';
import { ReviewLoadService } from '../services/review-load.service';

@Controller('v1/me')
export class ReviewLoadController {
  constructor(private readonly service: ReviewLoadService) {}

  @Put('new-word-override')
  setOverride(@CurrentUser() user: AuthUser, @Body(new ZodPipe(overrideSchema)) body: z.infer<typeof overrideSchema>) {
    return this.service.setOverride(user.id, body);
  }

  @Delete('new-word-override')
  clearOverride(@CurrentUser() user: AuthUser) {
    return this.service.clearOverride(user.id);
  }

  @Post('review-load/ack')
  @HttpCode(200)
  ack(@CurrentUser() user: AuthUser, @Body(new ZodPipe(ackSchema)) body: z.infer<typeof ackSchema>) {
    return this.service.ack(user.id, body);
  }

  @Put('review-pauses/:collectionId')
  pause(@CurrentUser() user: AuthUser, @Param('collectionId', ParseUUIDPipe) collectionId: string) {
    return this.service.pause(user.id, collectionId);
  }

  @Delete('review-pauses/:collectionId')
  unpause(@CurrentUser() user: AuthUser, @Param('collectionId', ParseUUIDPipe) collectionId: string) {
    return this.service.unpause(user.id, collectionId);
  }
}
