import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { ZodPipe } from '../../common/http/zod.pipe';
import { AddRequest, addSchema, LookupRequest, lookupSchema, OverrideRequest, overrideSchema } from './custom-words.schemas';
import { CustomWordsService } from './custom-words.service';

@Controller('v1/custom-words')
export class CustomWordsController {
  constructor(private readonly customWords: CustomWordsService) {}

  @Post('lookup')
  @HttpCode(200)
  lookup(@CurrentUser() user: AuthUser, @Body(new ZodPipe(lookupSchema)) body: LookupRequest) {
    return this.customWords.lookup(user.id, body);
  }

  @Post()
  add(@CurrentUser() user: AuthUser, @Body(new ZodPipe(addSchema)) body: AddRequest) {
    return this.customWords.add(user.id, body);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.customWords.list(user.id);
  }

  @Put(':meaningId/override')
  setOverride(
    @CurrentUser() user: AuthUser,
    @Param('meaningId', ParseUUIDPipe) meaningId: string,
    @Body(new ZodPipe(overrideSchema)) body: OverrideRequest,
  ) {
    return this.customWords.setOverride(user.id, meaningId, body);
  }

  @Delete(':meaningId/override')
  clearOverride(@CurrentUser() user: AuthUser, @Param('meaningId', ParseUUIDPipe) meaningId: string) {
    return this.customWords.clearOverride(user.id, meaningId);
  }

  @Delete(':meaningId')
  remove(@CurrentUser() user: AuthUser, @Param('meaningId', ParseUUIDPipe) meaningId: string) {
    return this.customWords.remove(user.id, meaningId);
  }
}
