import {
  ASSESSMENT_INTENT, AssessmentIntent, PROMPT_TYPE, PromptType, TEMPLATE, Template, VARIANT, Variant,
} from '../../common/constants/domain';
import { POLICY } from '../../config/policy';
import { splitGraphemes } from '../practice-evaluator/normalizer';
import { Rng, shuffle } from '../session-planner/domain/interleave';
import { resolveAudioUrl } from './asset-url';
import { copyFor } from './locale-copy';
import {
  ClientPayload, DistractorView, MeaningSnapshot, Prompt, PronunciationView, ResolveContext, ResolvedTask, ServerEvaluation,
} from './task.types';
import { findTaskProblem } from './validate-task';

const AZURE_ASSESSMENT = { kind: 'azurePronunciation' } as const;

const textPrompt = (text: string): Prompt => ({ type: PROMPT_TYPE.TEXT, text });
const audioPrompt = (url: string, locale: string): Prompt => ({ type: PROMPT_TYPE.AUDIO, audio: { url, locale } });

export const pronunciationFor = (snapshot: MeaningSnapshot, accent: string) =>
  snapshot.pronunciations.find((p) => p.accentLocale === accent) ?? null;

interface PlayablePronunciation extends PronunciationView { audioUrl: string }

export function playablePronunciation(snapshot: MeaningSnapshot, ctx: ResolveContext): PlayablePronunciation | null {
  const pronunciation = pronunciationFor(snapshot, ctx.accent);
  const audioUrl = ctx.audioPlayback ? resolveAudioUrl(pronunciation?.audioUrl, ctx.allowPlaceholderAudio) : null;
  return pronunciation && audioUrl ? { ...pronunciation, audioUrl } : null;
}

interface Parts {
  template: Template;
  variant: Variant;
  intent: AssessmentIntent;
  prompt: Prompt;
  body: Record<string, unknown>;
  evaluation?: Record<string, unknown>;
  key: Partial<ServerEvaluation>;
  answerTexts: string[];
  targets: ResolvedTask['targets'];
  promptIsTargetAudio?: boolean;
}

function assemble(parts: Parts): ResolvedTask | null {
  const clientPayload = {
    template: parts.template,
    variant: parts.variant,
    prompt: parts.prompt,
    maxRetries: POLICY.practice.maxRetries[parts.template],
    ...parts.body,
    ...(parts.evaluation && { evaluation: parts.evaluation }),
  } as ClientPayload;
  const task: ResolvedTask = {
    template: parts.template,
    variant: parts.variant,
    curatedItemId: null,
    clientPayload,
    serverEvaluation: {
      intent: parts.intent,
      promptIsTargetAudio: parts.promptIsTargetAudio ?? false,
      qualityQualified: true,
      isPrimed: false,
      answerTexts: parts.answerTexts,
      ...parts.key,
    },
    targets: parts.targets,
  };
  return findTaskProblem(task) ? null : task;
}

function buildOptions(correct: string, wrong: string[], rng: Rng) {
  const labels = shuffle([correct, ...wrong], rng);
  return { options: labels.map((text, index) => ({ id: index + 1, text })), correctOptionId: labels.indexOf(correct) + 1 };
}

// Rejects same-Word and same-label candidates (C08) rather than risking an ambiguous question.
function pickDistractors(values: string[], correct: string, rng: Rng) {
  const seen = new Set([correct]);
  const unique = shuffle(values, rng).filter((value) => !seen.has(value) && seen.add(value));
  const wanted = POLICY.newLearning.selectOptionCount - 1;
  return unique.length > 0 ? unique.slice(0, wanted) : null;
}

const othersOf = (target: MeaningSnapshot, pool: DistractorView[]) => pool.filter((d) => d.wordId !== target.wordId);

export function buildSelectGloss(target: MeaningSnapshot, pool: DistractorView[], promptType: PromptType, ctx: ResolveContext, rng: Rng) {
  const wrong = pickDistractors(othersOf(target, pool).map((d) => d.meaningText), target.meaningText, rng);
  if (!wrong) return null;
  const { options, correctOptionId } = buildOptions(target.meaningText, wrong, rng);
  const pronunciation = promptType === PROMPT_TYPE.AUDIO ? playablePronunciation(target, ctx) : null;
  if (promptType === PROMPT_TYPE.AUDIO && !pronunciation) return null;

  return assemble({
    template: TEMPLATE.SELECT,
    variant: VARIANT.GLOSS,
    intent: ASSESSMENT_INTENT.MEANING_RECOGNITION,
    prompt: pronunciation ? audioPrompt(pronunciation.audioUrl, pronunciation.accentLocale) : textPrompt(target.lemma),
    body: { question: copyFor(ctx.locale, pronunciation ? 'select.gloss.audio.question' : 'select.gloss.question'), options },
    evaluation: { correctOptionId },
    key: { correctOptionId },
    answerTexts: [target.lemma],
    promptIsTargetAudio: Boolean(pronunciation),
    targets: [{ meaningId: target.meaningId, pronunciationId: pronunciation?.id ?? null }],
  });
}

export function buildSelectReverse(target: MeaningSnapshot, pool: DistractorView[], ctx: ResolveContext, rng: Rng) {
  const wrong = pickDistractors(othersOf(target, pool).map((d) => d.lemma), target.lemma, rng);
  if (!wrong) return null;
  const { options, correctOptionId } = buildOptions(target.lemma, wrong, rng);
  return assemble({
    template: TEMPLATE.SELECT,
    variant: VARIANT.REVERSE_GLOSS,
    intent: ASSESSMENT_INTENT.MEANING_RECOGNITION,
    prompt: textPrompt(target.meaningText),
    body: { question: copyFor(ctx.locale, 'select.reverseGloss.question'), options },
    evaluation: { correctOptionId },
    key: { correctOptionId },
    answerTexts: [target.lemma],
    targets: [{ meaningId: target.meaningId, pronunciationId: null }],
  });
}

export function buildTypingRecall(target: MeaningSnapshot, ctx: ResolveContext) {
  const acceptedResponses = [target.lemma];
  return assemble({
    template: TEMPLATE.TYPING,
    variant: VARIANT.MEANING_RECALL,
    intent: ASSESSMENT_INTENT.MEANING_RECALL,
    prompt: textPrompt(target.meaningText),
    body: { question: copyFor(ctx.locale, 'typing.clue.question') },
    evaluation: { acceptedResponses },
    key: { acceptedResponses },
    answerTexts: acceptedResponses,
    targets: [{ meaningId: target.meaningId, pronunciationId: null }],
  });
}

export function buildTranscription(target: MeaningSnapshot, ctx: ResolveContext) {
  const pronunciation = playablePronunciation(target, ctx);
  if (!pronunciation) return null;
  const acceptedResponses = [target.lemma];
  return assemble({
    template: TEMPLATE.TYPING,
    variant: VARIANT.TRANSCRIPTION,
    intent: ASSESSMENT_INTENT.TRANSCRIPTION,
    prompt: audioPrompt(pronunciation.audioUrl, pronunciation.accentLocale),
    body: { question: copyFor(ctx.locale, 'typing.transcription.question') },
    evaluation: { acceptedResponses },
    key: { acceptedResponses },
    answerTexts: acceptedResponses,
    promptIsTargetAudio: true,
    targets: [{ meaningId: null, pronunciationId: pronunciation.id }],
  });
}

const SHUFFLE_ATTEMPTS = 5;

export function buildFlyReorder(target: MeaningSnapshot, ctx: ResolveContext, rng: Rng) {
  const graphemes = splitGraphemes(target.lemma);
  if (graphemes.length < 2) return null;
  const scrambled = Array.from({ length: SHUFFLE_ATTEMPTS }, () => shuffle(graphemes, rng)).find((g) => g.join('') !== graphemes.join(''));
  if (!scrambled) return null;
  const acceptedResponses = [target.lemma];
  return assemble({
    template: TEMPLATE.FLY_REORDER,
    variant: VARIANT.SPELLING_RECALL,
    intent: ASSESSMENT_INTENT.MEANING_RECALL,
    prompt: textPrompt(target.meaningText),
    body: {
      question: copyFor(ctx.locale, 'flyReorder.clue.question'),
      tiles: scrambled.map((text, index) => ({ id: index + 1, text })),
    },
    evaluation: { acceptedResponses },
    key: { acceptedResponses },
    answerTexts: acceptedResponses,
    targets: [{ meaningId: target.meaningId, pronunciationId: null }],
  });
}

export function buildRecording(target: MeaningSnapshot, promptType: PromptType, ctx: ResolveContext) {
  const pronunciation = pronunciationFor(target, ctx.accent);
  if (!pronunciation) return null;
  const playable = promptType === PROMPT_TYPE.AUDIO ? playablePronunciation(target, ctx) : null;
  if (promptType === PROMPT_TYPE.AUDIO && !playable) return null;
  return assemble({
    template: TEMPLATE.RECORDING,
    variant: VARIANT.SCRIPTED_PRONUNCIATION,
    intent: ASSESSMENT_INTENT.PRONUNCIATION,
    prompt: playable ? audioPrompt(playable.audioUrl, playable.accentLocale) : textPrompt(target.lemma),
    body: { question: copyFor(ctx.locale, 'recording.question'), assessment: AZURE_ASSESSMENT },
    evaluation: { acceptedResponses: [target.lemma] },
    key: { referenceText: target.lemma, referenceLocale: pronunciation.accentLocale },
    answerTexts: [],
    promptIsTargetAudio: Boolean(playable),
    targets: [{ meaningId: null, pronunciationId: pronunciation.id }],
  });
}

export function buildMatch(targets: MeaningSnapshot[], ctx: ResolveContext, rng: Rng) {
  if (targets.length < 2) return null;
  const left = targets.map((t, index) => ({ id: index + 1, text: t.lemma }));
  const rightIds = new Map(targets.map((t, index) => [t.meaningId, targets.length + index + 1]));
  const right = shuffle(targets.map((t) => ({ id: rightIds.get(t.meaningId)!, text: t.meaningText })), rng);
  const correctPairs = targets.map((t, index) => ({ leftId: index + 1, rightId: rightIds.get(t.meaningId)! }));
  return assemble({
    template: TEMPLATE.MATCH,
    variant: VARIANT.MEANING_PAIRS,
    intent: ASSESSMENT_INTENT.PAIRING,
    prompt: textPrompt(copyFor(ctx.locale, 'match.title')),
    body: { pairs: { left: shuffle(left, rng), right } },
    evaluation: { correctPairs },
    key: { correctPairs, pairTargets: Object.fromEntries(targets.map((_, i) => [i + 1, i])) },
    answerTexts: [],
    targets: targets.map((t) => ({ meaningId: t.meaningId, pronunciationId: null })),
  });
}
