import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly, AuthUser, CurrentUser, FullAdminOnly } from '../../../common/auth/auth.decorators';
import {
  ADMIN_ROLES, AI_MEANING_SCOPE, ASSIGNABLE_ROLES, CEFR_LEVELS, CONTENT_STATUS, EDITORIAL_STATE, ITEM_STATUS, MEANING_ORIGIN, PARTS_OF_SPEECH, TEMPLATE_VARIANTS,
} from '../../../common/constants/domain';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { SUPPORTED_LOCALES } from '../../practice-resolver/locale-copy';
import {
  CatalogLocale, catalogLocaleSchema, CreateCatalogEntry, createCatalogEntrySchema, ExampleBody, exampleSchema, listCatalogSchema, ListItems, listItemsSchema,
  ListMeanings, listMeaningsSchema, listUsersSchema, ListWords, listWordsSchema, localePipe, MeaningBody, meaningSchema, PatchCatalogEntry, patchCatalogEntrySchema,
  PatchItem, patchItemSchema, PatchMeaning, patchMeaningSchema, PatchPronunciation, patchPronunciationSchema, PatchWord, patchWordSchema, PronunciationBody,
  pronunciationSchema, SetRole, setRoleSchema, TopicMeaningIds, topicMeaningIdsSchema, WordTypeBody, wordTypeSchema,
} from '../dto/admin.schemas';
import { AdminCatalogService } from '../services/admin-catalog.service';
import { AdminPracticeItemsService } from '../services/admin-practice-items.service';
import { AdminUsersService } from '../services/admin-users.service';
import { AdminWordsService } from '../services/admin-words.service';

const NO_CONTENT = 204;
const uuid = new ParseUUIDPipe();

@AdminOnly()
@Controller('admin')
export class AdminWordsController {
  constructor(private readonly words: AdminWordsService) {}

  @Get('meta')
  meta() {
    return {
      locales: SUPPORTED_LOCALES,
      cefrLevels: CEFR_LEVELS,
      partsOfSpeech: PARTS_OF_SPEECH,
      templateVariants: TEMPLATE_VARIANTS,
      editorialStates: Object.values(EDITORIAL_STATE),
      itemStatuses: Object.values(ITEM_STATUS),
      contentStatuses: Object.values(CONTENT_STATUS),
      meaningOrigins: Object.values(MEANING_ORIGIN),
      aiMeaningScopes: Object.values(AI_MEANING_SCOPE),
      adminRoles: ADMIN_ROLES,
      assignableRoles: ASSIGNABLE_ROLES,
    };
  }

  @Get('words')
  listWords(@Query(new ZodPipe(listWordsSchema)) query: ListWords) {
    return this.words.listWords(query);
  }

  @Get('words/:id')
  getWord(@Param('id', uuid) id: string) {
    return this.words.getWord(id);
  }

  @Patch('words/:id')
  patchWord(@Param('id', uuid) id: string, @Body(new ZodPipe(patchWordSchema)) body: PatchWord) {
    return this.words.patchWord(id, body);
  }

  @Delete('words/:id')
  @HttpCode(NO_CONTENT)
  deleteWord(@Param('id', uuid) id: string) {
    return this.words.deleteWord(id);
  }

  @Post('words/:id/types')
  createType(@Param('id', uuid) id: string, @Body(new ZodPipe(wordTypeSchema)) body: WordTypeBody) {
    return this.words.createType(id, body);
  }

  @Delete('word-types/:id')
  @HttpCode(NO_CONTENT)
  deleteType(@Param('id', uuid) id: string) {
    return this.words.deleteType(id);
  }

  @Post('word-types/:id/pronunciations')
  createPronunciation(@Param('id', uuid) id: string, @Body(new ZodPipe(pronunciationSchema)) body: PronunciationBody) {
    return this.words.createPronunciation(id, body);
  }

  @Patch('pronunciations/:id')
  patchPronunciation(@Param('id', uuid) id: string, @Body(new ZodPipe(patchPronunciationSchema)) body: PatchPronunciation) {
    return this.words.patchPronunciation(id, body);
  }

  @Delete('pronunciations/:id')
  @HttpCode(NO_CONTENT)
  deletePronunciation(@Param('id', uuid) id: string) {
    return this.words.deletePronunciation(id);
  }

  @Get('meanings')
  listMeanings(@Query(new ZodPipe(listMeaningsSchema)) query: ListMeanings) {
    return this.words.listMeanings(query);
  }

  @Post('word-types/:id/meanings')
  createMeaning(@Param('id', uuid) id: string, @Body(new ZodPipe(meaningSchema)) body: MeaningBody) {
    return this.words.createMeaning(id, body);
  }

  @Patch('meanings/:id')
  patchMeaning(@Param('id', uuid) id: string, @Body(new ZodPipe(patchMeaningSchema)) body: PatchMeaning) {
    return this.words.patchMeaning(id, body);
  }

  @Delete('meanings/:id')
  @HttpCode(NO_CONTENT)
  deleteMeaning(@Param('id', uuid) id: string) {
    return this.words.deleteMeaning(id);
  }

  @Delete('meanings/:id/locales/:locale')
  @HttpCode(NO_CONTENT)
  deleteMeaningLocale(@Param('id', uuid) id: string, @Param('locale', localePipe) locale: string) {
    return this.words.deleteMeaningLocale(id, locale);
  }

  @Get('meanings/:id/publications')
  meaningPublications(@Param('id', uuid) id: string) {
    return this.words.meaningPublications(id);
  }

  @Post('meanings/:id/examples')
  createExample(@Param('id', uuid) id: string, @Body(new ZodPipe(exampleSchema)) body: ExampleBody) {
    return this.words.createExample(id, body);
  }

  @Patch('examples/:id')
  patchExample(@Param('id', uuid) id: string, @Body(new ZodPipe(exampleSchema)) body: ExampleBody) {
    return this.words.patchExample(id, body);
  }

  @Delete('examples/:id')
  @HttpCode(NO_CONTENT)
  deleteExample(@Param('id', uuid) id: string) {
    return this.words.deleteExample(id);
  }
}

@AdminOnly()
@Controller('admin/practice-items')
export class AdminPracticeItemsController {
  constructor(private readonly items: AdminPracticeItemsService) {}

  @Get()
  list(@Query(new ZodPipe(listItemsSchema)) query: ListItems) {
    return this.items.list(query);
  }

  @Get(':id')
  get(@Param('id', uuid) id: string) {
    return this.items.get(id);
  }

  @Patch(':id')
  patch(@Param('id', uuid) id: string, @Body(new ZodPipe(patchItemSchema)) body: PatchItem) {
    return this.items.patch(id, body);
  }

  @Delete(':id')
  @HttpCode(NO_CONTENT)
  remove(@Param('id', uuid) id: string) {
    return this.items.remove(id);
  }

  @Post(':id/retire')
  @HttpCode(200)
  retire(@Param('id', uuid) id: string) {
    return this.items.retire(id);
  }
}

@AdminOnly()
@Controller('admin')
export class AdminCatalogController {
  constructor(private readonly catalog: AdminCatalogService) {}

  @Get('collections')
  listCollections(@Query(new ZodPipe(listCatalogSchema)) query: z.infer<typeof listCatalogSchema>) {
    return this.catalog.listCollections(query.limit, query.offset);
  }

  @Post('collections')
  createCollection(@Body(new ZodPipe(createCatalogEntrySchema)) body: CreateCatalogEntry) {
    return this.catalog.createCollection(body);
  }

  @Get('collections/:id')
  getCollection(@Param('id', uuid) id: string) {
    return this.catalog.getCollection(id);
  }

  @Patch('collections/:id')
  patchCollection(@Param('id', uuid) id: string, @Body(new ZodPipe(patchCatalogEntrySchema)) body: PatchCatalogEntry) {
    return this.catalog.patchCollection(id, body);
  }

  @Delete('collections/:id')
  @HttpCode(NO_CONTENT)
  deleteCollection(@Param('id', uuid) id: string) {
    return this.catalog.deleteCollection(id);
  }

  @Put('collections/:id/locales/:locale')
  putCollectionLocale(@Param('id', uuid) id: string, @Param('locale', localePipe) locale: string, @Body(new ZodPipe(catalogLocaleSchema)) body: CatalogLocale) {
    return this.catalog.putCollectionLocale(id, locale, body);
  }

  @Delete('collections/:id/locales/:locale')
  @HttpCode(NO_CONTENT)
  deleteCollectionLocale(@Param('id', uuid) id: string, @Param('locale', localePipe) locale: string) {
    return this.catalog.deleteCollectionLocale(id, locale);
  }

  @Post('collections/:id/topics')
  createTopic(@Param('id', uuid) id: string, @Body(new ZodPipe(createCatalogEntrySchema)) body: CreateCatalogEntry) {
    return this.catalog.createTopic(id, body);
  }

  @Get('topics/:id')
  getTopic(@Param('id', uuid) id: string) {
    return this.catalog.getTopic(id);
  }

  @Patch('topics/:id')
  patchTopic(@Param('id', uuid) id: string, @Body(new ZodPipe(patchCatalogEntrySchema)) body: PatchCatalogEntry) {
    return this.catalog.patchTopic(id, body);
  }

  @Delete('topics/:id')
  @HttpCode(NO_CONTENT)
  deleteTopic(@Param('id', uuid) id: string) {
    return this.catalog.deleteTopic(id);
  }

  @Put('topics/:id/locales/:locale')
  putTopicLocale(@Param('id', uuid) id: string, @Param('locale', localePipe) locale: string, @Body(new ZodPipe(catalogLocaleSchema)) body: CatalogLocale) {
    return this.catalog.putTopicLocale(id, locale, body);
  }

  @Delete('topics/:id/locales/:locale')
  @HttpCode(NO_CONTENT)
  deleteTopicLocale(@Param('id', uuid) id: string, @Param('locale', localePipe) locale: string) {
    return this.catalog.deleteTopicLocale(id, locale);
  }

  @Get('topics/:id/meanings')
  listTopicMeanings(@Param('id', uuid) id: string) {
    return this.catalog.listTopicMeanings(id);
  }

  @Post('topics/:id/meanings')
  addTopicMeanings(@Param('id', uuid) id: string, @Body(new ZodPipe(topicMeaningIdsSchema)) body: TopicMeaningIds) {
    return this.catalog.addTopicMeanings(id, body.meaningIds);
  }

  @Put('topics/:id/meanings/order')
  reorderTopicMeanings(@Param('id', uuid) id: string, @Body(new ZodPipe(topicMeaningIdsSchema)) body: TopicMeaningIds) {
    return this.catalog.reorderTopicMeanings(id, body.meaningIds);
  }

  @Delete('topics/:id/meanings/:meaningId')
  @HttpCode(NO_CONTENT)
  removeTopicMeaning(@Param('id', uuid) id: string, @Param('meaningId', uuid) meaningId: string) {
    return this.catalog.removeTopicMeaning(id, meaningId);
  }
}

@AdminOnly()
@FullAdminOnly()
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list(@Query(new ZodPipe(listUsersSchema)) query: z.infer<typeof listUsersSchema>) {
    return this.users.list(query.page, query.perPage);
  }

  @Put(':id/role')
  setRole(@CurrentUser() actor: AuthUser, @Param('id', uuid) id: string, @Body(new ZodPipe(setRoleSchema)) body: SetRole) {
    return this.users.setRole(actor, id, body.role);
  }
}
