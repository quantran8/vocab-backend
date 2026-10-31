import { z } from 'zod';
import {
  ASSESSMENT_INTENT, AssessmentIntent, CEFR_LEVELS, CefrLevel, PROMPT_TYPE, PromptType, Template, TEMPLATE, VARIANT, Variant,
} from '../../common/constants/domain';
import { resolveAudioUrl } from './asset-url';
import { ResolveContext, ResolvedTask, ServerEvaluation, TargetRef } from './task.types';
import { findTaskProblem } from './validate-task';

/** Symbolic authoring shape of practice_items.source_content (§2.4). */
export const curatedContentSchema = z.looseObject({
  promptVariants: z.object({
    text: z.object({ text: z.string().min(1).optional(), localized: z.boolean().optional() }).optional(),
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
  [VARIANT.gloss]: ASSESSMENT_INTENT.meaningRecognition,
  [VARIANT.reverseGloss]: ASSESSMENT_INTENT.meaningRecognition,
  [VARIANT.meaningClash]: ASSESSMENT_INTENT.meaningRecognition,
  [VARIANT.phoneticChoice]: ASSESSMENT_INTENT.soundDiscrimination,
  [VARIANT.stressChoice]: ASSESSMENT_INTENT.soundDiscrimination,
  [VARIANT.singleBlank]: ASSESSMENT_INTENT.meaningRecognition,
  [VARIANT.contextMeaning]: ASSESSMENT_INTENT.meaningRecognition,
  [VARIANT.meaningRecall]: ASSESSMENT_INTENT.meaningRecall,
  [VARIANT.spellingRecall]: ASSESSMENT_INTENT.meaningRecall,
  [VARIANT.transcription]: ASSESSMENT_INTENT.transcription,
  [VARIANT.fixSpelling]: ASSESSMENT_INTENT.spellingRepair,
  [VARIANT.scriptedPronunciation]: ASSESSMENT_INTENT.pronunciation,
  [VARIANT.meaningPairs]: ASSESSMENT_INTENT.pairing,
  [VARIANT.wordPairs]: ASSESSMENT_INTENT.pairing,
};

export const SEMANTIC_INTENTS: AssessmentIntent[] = [ASSESSMENT_INTENT.meaningRecognition, ASSESSMENT_INTENT.meaningRecall];

export const intentOf = (variant: string | null) => INTENT_BY_VARIANT[variant as Variant];

const cefrRank = (level: string) => CEFR_LEVELS.indexOf(level as CefrLevel);

/** D23: contextual items need an editorial level at or below the learner's proficiency. */
export function isContextEligible(contextLevel: string | null, proficiency: string | null, isContextual: boolean) {
  if (!isContextual) return true;
  if (!contextLevel || !proficiency) return false;
  return cefrRank(contextLevel) <= cefrRank(proficiency);
}

export const isContextualVariant = (variant: string | null) =>
  variant === VARIANT.meaningClash || variant === VARIANT.contextMeaning || variant === VARIANT.singleBlank;

const NON_CLIENT_EVAL_KEYS = ['pairTargets'];

export function resolveCurated(item: CuratedItem, promptType: PromptType, ctx: ResolveContext): ResolvedTask | null {
  const content = curatedContentSchema.safeParse(item.sourceContent);
  const intent = intentOf(item.variant);
  if (!content.success || !intent) return null;
  const { promptVariants, ...authoredBody } = content.data;
  const localized = item.localizedContent;

  let prompt: ResolvedTask['clientPayload']['prompt'] | null = null;
  let promptIsTargetAudio = false;
  if (promptType === PROMPT_TYPE.text && promptVariants.text) {
    const text = promptVariants.text.localized ? (localized.prompt as string | undefined) : promptVariants.text.text;
    prompt = text ? { type: PROMPT_TYPE.text, text } : null;
  } else if (promptType === PROMPT_TYPE.audio && promptVariants.audio && ctx.audioPlayback) {
    const url = resolveAudioUrl(promptVariants.audio.url, ctx.allowPlaceholderAudio);
    prompt = url ? { type: PROMPT_TYPE.audio, audio: { url, locale: promptVariants.audio.locale } } : null;
    promptIsTargetAudio = promptVariants.audio.isTargetAudio;
  }
  if (!prompt) return null;

  // Spelled-out English audio is transcription, not Meaning-cued recall (C50).
  if (intent === ASSESSMENT_INTENT.meaningRecall && promptIsTargetAudio) return null;

  const { prompt: _ignored, ...localizedBody } = localized;
  const evaluation = item.sourceEvaluation as Record<string, unknown>;
  const clientEvaluation = Object.fromEntries(Object.entries(evaluation).filter(([key]) => !NON_CLIENT_EVAL_KEYS.includes(key)));
  const isRecording = item.template === TEMPLATE.recording;
  const accepted = evaluation.acceptedResponses as string[] | undefined;

  const task: ResolvedTask = {
    template: item.template as Template,
    variant: item.variant as Variant,
    curatedItemId: item.id,
    clientPayload: {
      template: item.template as Template,
      variant: item.variant as Variant,
      prompt,
      ...authoredBody,
      ...localizedBody,
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
