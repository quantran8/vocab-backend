import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly, AuthUser, CurrentUser } from '../../common/auth/auth.decorators';
import { AI_MEANING_SCOPE } from '../../common/constants/domain';
import { ZodPipe } from '../../common/http/zod.pipe';
import {
  CreateItem, createItemSchema, CreateWord, createWordSchema, ItemLocale, itemLocaleSchema, MeaningLocale, meaningLocaleSchema,
} from './admin.schemas';
import { AdminService } from './admin.service';
import { PublicationService } from './publication.service';

const aiMeaningsSchema = z.object({
  scope: z.enum(Object.values(AI_MEANING_SCOPE)).default(AI_MEANING_SCOPE.ALL),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

@AdminOnly()
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService, private readonly publications: PublicationService) {}

  @Post('words')
  createWord(@Body(new ZodPipe(createWordSchema)) body: CreateWord) {
    return this.admin.createWord(body);
  }

  @Get('ai-meanings')
  aiMeanings(@Query(new ZodPipe(aiMeaningsSchema)) query: z.infer<typeof aiMeaningsSchema>) {
    return this.admin.aiMeanings(query.scope, query.limit, query.offset);
  }

  @Post('ai-meanings/:id/approve')
  @HttpCode(200)
  approveAiMeaning(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.admin.approveAiMeaning(id, user.id);
  }

  @Put('meanings/:id/locales/:locale')
  meaningLocale(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('locale') locale: string,
    @Body(new ZodPipe(meaningLocaleSchema)) body: MeaningLocale,
  ) {
    return this.admin.putMeaningLocale(id, locale, body);
  }

  @Post('meanings/:id/publish')
  @HttpCode(200)
  publish(@Param('id', ParseUUIDPipe) id: string, @Query('locale') locale: string) {
    return this.publications.publish(id, locale);
  }

  @Post('meanings/:id/recall')
  @HttpCode(200)
  recall(@Param('id', ParseUUIDPipe) id: string, @Query('locale') locale: string) {
    return this.publications.recall(id, locale);
  }

  @Post('practice-items')
  createItem(@Body(new ZodPipe(createItemSchema)) body: CreateItem) {
    return this.admin.createItem(body);
  }

  @Put('practice-items/:id/locales/:locale')
  itemLocale(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('locale') locale: string,
    @Body(new ZodPipe(itemLocaleSchema)) body: ItemLocale,
  ) {
    return this.admin.putItemLocale(id, locale, body);
  }

  @Post('practice-items/:id/publish')
  @HttpCode(200)
  publishItem(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.publishItem(id);
  }
}
