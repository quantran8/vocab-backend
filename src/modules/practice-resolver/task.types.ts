import { z } from 'zod';
import { AssessmentIntent, PROMPT_TYPE, Template, Variant } from '../../common/constants/domain';
import { AnswerKey, ClientBody } from '../practice-evaluator/evaluate';

export const promptSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal(PROMPT_TYPE.text), text: z.string().trim().min(1) }),
  z.strictObject({
    type: z.literal(PROMPT_TYPE.audio),
    audio: z.strictObject({ url: z.url(), locale: z.string().min(2) }),
  }),
]);
export type Prompt = z.infer<typeof promptSchema>;

export interface PronunciationView {
  id: string;
  accentLocale: string;
  ipa: string;
  audioUrl: string | null;
}

export interface ExampleView {
  text: string;
  translation: string;
  targetLocator: Record<string, unknown>;
}

/** Shape of meaning_publications.snapshot. */
export interface MeaningSnapshot {
  wordId: string;
  lemma: string;
  typeId: string;
  partOfSpeech: string;
  meaningId: string;
  cefrLevel: string;
  meaningText: string;
  definitionText: string;
  pronunciations: PronunciationView[];
  examples: ExampleView[];
}

export type DistractorView = { wordId: string; lemma: string; meaningText: string };

export interface TargetRef {
  meaningId: string | null;
  pronunciationId: string | null;
}

export interface ServerEvaluation extends AnswerKey {
  intent: AssessmentIntent;
  promptIsTargetAudio: boolean;
  qualityQualified: boolean;
  isPrimed: boolean;
  isFirstRecall?: boolean;
  // For no-leak checks and priming; never sent to the client.
  answerTexts: string[];
  referenceText?: string;
  referenceLocale?: string;
}

export type ClientPayload = ClientBody & Record<string, unknown> & { prompt: Prompt; template: Template; variant?: Variant };

export interface ResolvedTask {
  template: Template;
  variant: Variant;
  curatedItemId: string | null;
  clientPayload: ClientPayload;
  serverEvaluation: ServerEvaluation;
  targets: TargetRef[];
}

export interface ResolveContext {
  locale: string;
  accent: string;
  audioPlayback: boolean;
  allowPlaceholderAudio: boolean;
}
