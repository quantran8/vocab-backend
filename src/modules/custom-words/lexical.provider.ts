import { z } from 'zod';
import { CEFR_LEVELS, PARTS_OF_SPEECH } from '../../common/constants/domain';
import { ExampleView } from '../practice-resolver/task.types';

// Provider-neutral contract. Kept free of length rules: structured-output schemas reject them.
export const generatedSchema = z.object({
  isValidWord: z.boolean(),
  lemma: z.string(),
  duplicateOfIndex: z.number().int().nullable(),
  senses: z.array(z.object({
    partOfSpeech: z.enum(PARTS_OF_SPEECH),
    ipa: z.string(),
    cefrLevel: z.enum(CEFR_LEVELS),
    meaningText: z.string(),
    definitionText: z.string(),
    examples: z.array(z.object({ text: z.string(), translation: z.string(), target: z.string() })),
  })),
});
export type GeneratedWord = z.infer<typeof generatedSchema>;

export const translatedSchema = z.object({
  meanings: z.array(z.object({ meaningText: z.string(), definitionText: z.string(), exampleTranslations: z.array(z.string()) })),
});
export type TranslatedMeaning = z.infer<typeof translatedSchema>['meanings'][number];

export interface GenerateRequest {
  text: string;
  locale: string;
  maxSenses: number;
  context?: string;
  existingMeanings?: string[];
}

export interface SourceMeaning {
  lemma: string;
  partOfSpeech: string;
  meaningText: string;
  definitionText: string;
  examples: string[];
}

export abstract class LexicalProvider {
  abstract readonly model: string;
  abstract generate(request: GenerateRequest): Promise<GeneratedWord>;
  /** One result per source, in order. */
  abstract translate(sources: SourceMeaning[], locale: string): Promise<TranslatedMeaning[]>;
}

export interface DraftSense extends Omit<GeneratedWord['senses'][number], 'examples'> {
  examples: ExampleView[];
}
export interface WordDraftPayload {
  isValidWord: boolean;
  lemma: string;
  duplicateOfMeaningId: string | null;
  senses: DraftSense[];
}
export interface TranslationDraftPayload {
  meaningText: string;
  definitionText: string;
  examples: { text: string; translation: string }[];
}
