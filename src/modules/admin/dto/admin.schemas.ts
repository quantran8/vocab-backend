import { z } from 'zod';
import { CEFR_LEVELS, CONTENT_STATUS, EDITORIAL_STATE, ITEM_STATUS, LEARNING_LANGUAGE, PARTS_OF_SPEECH, TEMPLATES, VARIANTS, ASSIGNABLE_ROLES } from '../../../common/constants/domain';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { hasLocaleCopy } from '../../practice-resolver/locale-copy';
import { hasValidHighlight } from '../services/publication.service';

const locale = z.string().min(2).max(32);
const editorial = z.enum(Object.values(EDITORIAL_STATE));

export const createWordSchema = z.strictObject({
  language: z.string().max(16).default(LEARNING_LANGUAGE),
  lemma: z.string().trim().min(1),
  homographKey: z.string().optional(),
  types: z.array(
    z.strictObject({
      partOfSpeech: z.enum(PARTS_OF_SPEECH),
      pronunciations: z.array(
        z.strictObject({ accentLocale: locale, ipa: z.string().optional(), audioAssetKey: z.string().optional() }),
      ).default([]),
      meanings: z.array(
        z.strictObject({
          cefrLevel: z.enum(CEFR_LEVELS).optional(),
          coreDefinition: z.string().optional(),
          examples: z.array(z.strictObject({ sourceText: z.string().min(1), targetLocator: z.record(z.string(), z.unknown()) })).default([]),
        }),
      ).min(1),
    }),
  ).min(1),
});
export type CreateWord = z.infer<typeof createWordSchema>;

export const meaningLocaleSchema = z.strictObject({
  meaningText: z.string().trim().min(1),
  definitionText: z.string().trim().min(1),
  editorialState: editorial.default(EDITORIAL_STATE.DRAFT),
  exampleTranslations: z.array(z.strictObject({ exampleId: z.uuid(), translationText: z.string().trim().min(1) })).default([]),
});
export type MeaningLocale = z.infer<typeof meaningLocaleSchema>;

export const createItemSchema = z.strictObject({
  template: z.enum(TEMPLATES),
  variant: z.enum(VARIANTS),
  contextCefrLevel: z.enum(CEFR_LEVELS).optional(),
  sourceContent: z.record(z.string(), z.unknown()),
  sourceEvaluation: z.record(z.string(), z.unknown()),
  supersedesItemId: z.uuid().optional(),
  targets: z.array(
    z.strictObject({ meaningId: z.uuid().optional(), pronunciationId: z.uuid().optional() })
      .refine((t) => t.meaningId || t.pronunciationId, 'Target needs meaningId or pronunciationId'),
  ).min(1),
});
export type CreateItem = z.infer<typeof createItemSchema>;

export const itemLocaleSchema = z.strictObject({
  localizedContent: z.record(z.string(), z.unknown()).default({}),
  contextualExplain: z.string().optional(),
  editorialState: editorial.default(EDITORIAL_STATE.DRAFT),
});
export type ItemLocale = z.infer<typeof itemLocaleSchema>;

export const localePipe = new ZodPipe(z.string().refine(hasLocaleCopy, 'Unsupported locale'), 'VALIDATION_FAILED');

const notEmpty = (value: object) => Object.keys(value).length > 0;
const NOTHING_TO_UPDATE = 'Nothing to update';
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const slug = z.string().regex(SLUG, 'Use lowercase letters, digits and hyphens');
const page = { limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) };
const searchText = z.string().trim().min(1).max(100).optional();

export const listWordsSchema = z.object({ ...page, q: searchText, language: z.string().max(16).optional() });
export type ListWords = z.infer<typeof listWordsSchema>;
export const patchWordSchema = z.strictObject({ lemma: z.string().trim().min(1).optional(), homographKey: z.string().trim().min(1).nullable().optional() })
  .refine(notEmpty, NOTHING_TO_UPDATE);
export type PatchWord = z.infer<typeof patchWordSchema>;

export const pronunciationSchema = z.strictObject({ accentLocale: locale, ipa: z.string().trim().min(1).optional(), audioAssetKey: z.string().trim().min(1).optional() });
export type PronunciationBody = z.infer<typeof pronunciationSchema>;
export const patchPronunciationSchema = z.strictObject({
  accentLocale: locale.optional(), ipa: z.string().trim().min(1).nullable().optional(), audioAssetKey: z.string().trim().min(1).nullable().optional(),
}).refine(notEmpty, NOTHING_TO_UPDATE);
export type PatchPronunciation = z.infer<typeof patchPronunciationSchema>;

// Stricter than POST /admin/words: a bad highlight fails here, not later at publish.
export const exampleSchema = z.strictObject({
  sourceText: z.string().trim().min(1),
  targetLocator: z.strictObject({ start: z.number().int(), end: z.number().int() }),
}).refine((e) => hasValidHighlight(e.sourceText, e.targetLocator), { path: ['targetLocator'], message: 'Highlight is outside the sentence' });
export type ExampleBody = z.infer<typeof exampleSchema>;

export const meaningSchema = z.strictObject({
  cefrLevel: z.enum(CEFR_LEVELS).optional(),
  coreDefinition: z.string().trim().min(1).optional(),
  examples: z.array(exampleSchema).default([]),
});
export type MeaningBody = z.infer<typeof meaningSchema>;
export const patchMeaningSchema = z.strictObject({ cefrLevel: z.enum(CEFR_LEVELS).nullable().optional(), coreDefinition: z.string().trim().min(1).nullable().optional() })
  .refine(notEmpty, NOTHING_TO_UPDATE);
export type PatchMeaning = z.infer<typeof patchMeaningSchema>;

export const wordTypeSchema = z.strictObject({
  partOfSpeech: z.enum(PARTS_OF_SPEECH),
  pronunciations: z.array(pronunciationSchema).default([]),
  meanings: z.array(meaningSchema).default([]),
});
export type WordTypeBody = z.infer<typeof wordTypeSchema>;

export const listMeaningsSchema = z.object({
  ...page, q: searchText, locale: z.string().refine(hasLocaleCopy, 'Unsupported locale').optional(), cefr: z.enum(CEFR_LEVELS).optional(), live: z.stringbool().optional(),
});
export type ListMeanings = z.infer<typeof listMeaningsSchema>;

export const listItemsSchema = z.object({
  ...page, template: z.enum(TEMPLATES).optional(), variant: z.enum(VARIANTS).optional(), status: z.enum(Object.values(ITEM_STATUS)).optional(), meaningId: z.uuid().optional(),
});
export type ListItems = z.infer<typeof listItemsSchema>;
export const patchItemSchema = z.strictObject({
  template: z.enum(TEMPLATES).optional(),
  variant: z.enum(VARIANTS).optional(),
  contextCefrLevel: z.enum(CEFR_LEVELS).nullable().optional(),
  sourceContent: z.record(z.string(), z.unknown()).optional(),
  sourceEvaluation: z.record(z.string(), z.unknown()).optional(),
  targets: createItemSchema.shape.targets.optional(),
}).refine(notEmpty, NOTHING_TO_UPDATE);
export type PatchItem = z.infer<typeof patchItemSchema>;

const contentStatus = z.enum(Object.values(CONTENT_STATUS));
export const listCatalogSchema = z.object(page);
export const createCatalogEntrySchema = z.strictObject({ slug, title: z.string().trim().min(1), status: contentStatus.default(CONTENT_STATUS.DRAFT) });
export type CreateCatalogEntry = z.infer<typeof createCatalogEntrySchema>;
export const patchCatalogEntrySchema = z.strictObject({ slug: slug.optional(), title: z.string().trim().min(1).optional(), status: contentStatus.optional() })
  .refine(notEmpty, NOTHING_TO_UPDATE);
export type PatchCatalogEntry = z.infer<typeof patchCatalogEntrySchema>;
export const catalogLocaleSchema = z.strictObject({ title: z.string().trim().min(1), description: z.string().trim().min(1).nullable().optional() });
export type CatalogLocale = z.infer<typeof catalogLocaleSchema>;

const uniqueIds = z.array(z.uuid()).min(1).max(1000).refine((ids) => new Set(ids).size === ids.length, 'Ids must be unique');
export const topicMeaningIdsSchema = z.strictObject({ meaningIds: uniqueIds });
export type TopicMeaningIds = z.infer<typeof topicMeaningIdsSchema>;

export const listUsersSchema = z.object({ page: z.coerce.number().int().min(1).default(1), perPage: z.coerce.number().int().min(1).max(100).default(50) });
export const setRoleSchema = z.strictObject({ role: z.enum(ASSIGNABLE_ROLES).nullable() });
export type SetRole = z.infer<typeof setRoleSchema>;
