import { z } from 'zod';
import { CEFR_LEVELS, EDITORIAL_STATE, LEARNING_LANGUAGE, PARTS_OF_SPEECH, TEMPLATES, VARIANTS } from '../../common/constants/domain';

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
