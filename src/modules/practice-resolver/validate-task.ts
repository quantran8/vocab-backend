import { z } from 'zod';
import { PROMPT_TYPE, TEMPLATE, Template, TEMPLATE_VARIANTS } from '../../common/constants/domain';
import { normalizeAnswer } from '../practice-evaluator/normalizer';
import { Prompt, promptSchema, ResolvedTask } from './task.types';

const option = z.strictObject({ id: z.number().int().nonnegative(), text: z.string().trim().min(1) });
const options = z.array(option).min(2);
const common = {
  template: z.string(),
  variant: z.string().optional(),
  prompt: promptSchema,
  question: z.string().optional(),
  maxRetries: z.number().int().nonnegative(),
};
const accepted = z.array(z.string().min(1)).min(1);

const BODY_SCHEMAS: Record<Template, z.ZodType> = {
  [TEMPLATE.SELECT]: z.strictObject({ ...common, options, evaluation: z.strictObject({ correctOptionId: z.number().int() }) }),
  [TEMPLATE.CLOZE_SELECT]: z.strictObject({
    ...common,
    prompt: promptSchema.optional(),
    sentenceParts: z.strictObject({ before: z.string(), after: z.string() }),
    options,
    evaluation: z.strictObject({ correctOptionId: z.number().int() }),
  }),
  [TEMPLATE.MATCH]: z.strictObject({
    ...common,
    pairs: z.strictObject({ left: options, right: options }),
    evaluation: z.strictObject({ correctPairs: z.array(z.strictObject({ leftId: z.number().int(), rightId: z.number().int() })).min(2) }),
  }),
  [TEMPLATE.TYPING]: z.strictObject({ ...common, evaluation: z.strictObject({ acceptedResponses: accepted }) }),
  [TEMPLATE.FLY_REORDER]: z.strictObject({ ...common, tiles: z.array(option).min(2), evaluation: z.strictObject({ acceptedResponses: accepted }) }),
  [TEMPLATE.SURGERY]: z.strictObject({
    ...common,
    word: z.string().min(1),
    evaluation: z.strictObject({ wrongGraphemeIndex: z.number().int().nonnegative(), replacement: z.string() }),
  }),
  [TEMPLATE.RECORDING]: z.strictObject({ ...common, assessment: z.strictObject({ kind: z.literal('azurePronunciation') }) }),
};

const FORBIDDEN_CLIENT_KEYS = ['wordId', 'meaningId', 'pronunciationId', 'typeId', 'source', 'targets'];

const contains = (haystack: string | undefined, needle: string) =>
  haystack !== undefined && normalizeAnswer(haystack).includes(needle);

const visibleTexts = (task: ResolvedTask) => {
  const { question, sentenceParts } = task.clientPayload as { question?: string; sentenceParts?: { before: string; after: string } };
  return [question, sentenceParts?.before, sentenceParts?.after];
};

function hasDuplicates(values: string[]) {
  return new Set(values.map(normalizeAnswer)).size !== values.length;
}

/** Returns the reason a task must not be issued, or null when valid. */
export function findTaskProblem(task: ResolvedTask): string | null {
  const { template, variant, clientPayload: payload, serverEvaluation: server } = task;

  if (!TEMPLATE_VARIANTS[template].includes(variant)) return `Variant ${variant} not valid for ${template}`;
  if (FORBIDDEN_CLIENT_KEYS.some((key) => key in payload)) return 'Client payload exposes internal ids';
  if (task.targets.length === 0) return 'Task has no target';
  if (task.targets.some((t) => !t.meaningId && !t.pronunciationId)) return 'Target has neither meaning nor pronunciation';

  const parsed = BODY_SCHEMAS[template].safeParse(payload);
  if (!parsed.success) return `Payload shape invalid: ${parsed.error.issues[0].message}`;

  if (payload.prompt?.type === PROMPT_TYPE.TEXT && payload.prompt.highlight) {
    const { start, end } = payload.prompt.highlight;
    if (start >= end || end > payload.prompt.text.length) return 'Prompt highlight out of range';
  }

  if (payload.options && hasDuplicates(payload.options.map((o) => o.text))) return 'Option labels collide';
  if (payload.pairs && (hasDuplicates(payload.pairs.left.map((o) => o.text)) || hasDuplicates(payload.pairs.right.map((o) => o.text)))) {
    return 'Pair labels collide';
  }

  if (template === TEMPLATE.FLY_REORDER) {
    const ordered = payload.tiles!.map((t) => t.text).join('');
    if (server.acceptedResponses!.some((a) => normalizeAnswer(a) === normalizeAnswer(ordered))) return 'Tiles reveal the answer order';
  }

  const isBlindAudio = payload.prompt?.type === PROMPT_TYPE.AUDIO && server.promptIsTargetAudio && template !== TEMPLATE.RECORDING;
  if (isBlindAudio) {
    const needles = server.answerTexts.map(normalizeAnswer);
    const { url } = (payload.prompt as Extract<Prompt, { type: 'audio' }>).audio;
    if (needles.some((n) => contains(url, n))) return 'Audio URL leaks the target';
    if (needles.some((n) => visibleTexts(task).some((text) => contains(text, n)))) return 'Audio task leaks the target in text';
  }
  return null;
}
