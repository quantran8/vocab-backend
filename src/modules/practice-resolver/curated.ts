import { z } from 'zod';
import {
  ASSESSMENT_INTENT, AssessmentIntent, CEFR_LEVELS, CefrLevel, PROMPT_TYPE, PromptType, Template, TEMPLATE, VARIANT, Variant,
} from '../../common/constants/domain';
import { POLICY } from '../../config/policy';
import { resolveAudioUrl } from './asset-url';
import { ResolveContext, ResolvedTask, ServerEvaluation, TargetRef } from './task.types';
import { findTaskProblem } from './validate-task';

/** Symbolic authoring shape of practice_items.source_content (§2.4). */
export const curatedContentSchema = z.looseObject({
  promptVariants: z.object({
    text: z.object({
      text: z.string().min(1).optional(),
      localized: z.boolean().optional(),
      highlight: z.object({ start: z.number(), end: z.number() }).optional(),
    }).optional(),
    audio: z.object({
      url: z.string().min(1),
      locale: z.string().min(2),
      // true when the clip speaks the English target, false for a localized Meaning cue.
      isTargetAudio: z.boolean(),
    }).optional(),
  }),
});

export interface CuratedItem {
  id: string;
  template: string;
  variant: string | null;
  contextCefrLevel: string | null;
  sourceContent: unknown;
  sourceEvaluation: unknown;
  localizedContent: Record<string, unknown>;
  targets: TargetRef[];
}

const INTENT_BY_VARIANT: Partial<Record<Variant, AssessmentIntent>> = {
  [VARIANT.GLOSS]: ASSESSMENT_INTENT.MEANING_RECOGNITION,
  [VARIANT.REVERSE_GLOSS]: ASSESSMENT_INTENT.MEANING_RECOGNITION,
  [VARIANT.MEANING_CLASH]: ASSESSMENT_INTENT.MEANING_RECOGNITION,
  [VARIANT.PHONETIC_CHOICE]: ASSESSMENT_INTENT.SOUND_DISCRIMINATION,
  [VARIANT.STRESS_CHOICE]: ASSESSMENT_INTENT.SOUND_DISCRIMINATION,
  [VARIANT.SINGLE_BLANK]: ASSESSMENT_INTENT.MEANING_RECOGNITION,
  [VARIANT.CONTEXT_MEANING]: ASSESSMENT_INTENT.MEANING_RECOGNITION,
  [VARIANT.MEANING_RECALL]: ASSESSMENT_INTENT.MEANING_RECALL,
  [VARIANT.SPELLING_RECALL]: ASSESSMENT_INTENT.MEANING_RECALL,
  [VARIANT.TRANSCRIPTION]: ASSESSMENT_INTENT.TRANSCRIPTION,
  [VARIANT.FIX_SPELLING]: ASSESSMENT_INTENT.SPELLING_REPAIR,
  [VARIANT.SCRIPTED_PRONUNCIATION]: ASSESSMENT_INTENT.PRONUNCIATION,
  [VARIANT.MEANING_PAIRS]: ASSESSMENT_INTENT.PAIRING,
  [VARIANT.WORD_PAIRS]: ASSESSMENT_INTENT.PAIRING,
};

export const SEMANTIC_INTENTS: AssessmentIntent[] = [ASSESSMENT_INTENT.MEANING_RECOGNITION, ASSESSMENT_INTENT.MEANING_RECALL];

export const intentOf = (variant: string | null) => INTENT_BY_VARIANT[variant as Variant];

const cefrRank = (level: string) => CEFR_LEVELS.indexOf(level as CefrLevel);

/** D23: contextual items need an editorial level at or below the learner's proficiency. */
export function isContextEligible(contextLevel: string | null, proficiency: string | null, isContextual: boolean) {
  if (!isContextual) return true;
  if (!contextLevel || !proficiency) return false;
  return cefrRank(contextLevel) <= cefrRank(proficiency);
}

export const isContextualVariant = (variant: string | null) =>
  variant === VARIANT.MEANING_CLASH || variant === VARIANT.CONTEXT_MEANING || variant === VARIANT.SINGLE_BLANK;

const NON_CLIENT_EVAL_KEYS = ['pairTargets'];

export function resolveCurated(item: CuratedItem, promptType: PromptType, ctx: ResolveContext): ResolvedTask | null {
  const content = curatedContentSchema.safeParse(item.sourceContent);
  const intent = intentOf(item.variant);
  if (!content.success || !intent) return null;
  const { promptVariants, ...authoredBody } = content.data;
  const localized = item.localizedContent;

  let prompt: ResolvedTask['clientPayload']['prompt'] | null = null;
  let promptIsTargetAudio = false;
  if (promptType === PROMPT_TYPE.TEXT && promptVariants.text) {
    const text = promptVariants.text.localized ? (localized.prompt as string | undefined) : promptVariants.text.text;
    const { highlight } = promptVariants.text;
    prompt = text ? { type: PROMPT_TYPE.TEXT, text, ...(highlight && { highlight }) } : null;
  } else if (promptType === PROMPT_TYPE.AUDIO && promptVariants.audio && ctx.audioPlayback) {
    const url = resolveAudioUrl(promptVariants.audio.url, ctx.allowPlaceholderAudio);
    prompt = url ? { type: PROMPT_TYPE.AUDIO, audio: { url, locale: promptVariants.audio.locale } } : null;
    promptIsTargetAudio = promptVariants.audio.isTargetAudio;
  }
  // A cloze sentence stands on its own: the prompt is only for a real clue, like a translation.
  const stimulusIsSentence = item.template === TEMPLATE.CLOZE_SELECT && promptType === PROMPT_TYPE.TEXT && !promptVariants.text;
  if (!prompt && !stimulusIsSentence) return null;

  // Spelled-out English audio is transcription, not Meaning-cued recall (C50).
  if (intent === ASSESSMENT_INTENT.MEANING_RECALL && promptIsTargetAudio) return null;

  const { prompt: _ignored, ...localizedBody } = localized;
  const evaluation = item.sourceEvaluation as Record<string, unknown>;
  const clientEvaluation = Object.fromEntries(Object.entries(evaluation).filter(([key]) => !NON_CLIENT_EVAL_KEYS.includes(key)));
  const isRecording = item.template === TEMPLATE.RECORDING;
  const accepted = evaluation.acceptedResponses as string[] | undefined;

  const task: ResolvedTask = {
    template: item.template as Template,
    variant: item.variant as Variant,
    curatedItemId: item.id,
    clientPayload: {
      template: item.template as Template,
      variant: item.variant as Variant,
      ...(prompt && { prompt }),
      ...authoredBody,
      ...localizedBody,
      maxRetries: POLICY.practice.maxRetries[item.template as Template],
      ...(!isRecording && { evaluation: clientEvaluation }),
    },
    serverEvaluation: {
      ...(evaluation as Partial<ServerEvaluation>),
      intent,
      promptIsTargetAudio,
      qualityQualified: true,
      isPrimed: false,
      answerTexts: accepted ?? [],
    },
    targets: item.targets,
  };
  return findTaskProblem(task) ? null : task;
}
