import { ASSESSMENT_INTENT, PROMPT_TYPE, PromptType, SESSION_MODE, SessionMode, TASK_PHASE, TaskPhase, TEMPLATE, VARIANT } from '../../../common/constants/domain';
import { newId } from '../../../common/ids';
import { POLICY } from '../../../config/policy';
import { normalizeAnswer } from '../../practice-evaluator/normalizer';
import { CuratedItem, intentOf, isContextEligible, isContextualVariant, resolveCurated, SEMANTIC_INTENTS } from '../../practice-resolver/curated';
import {
  buildFlyReorder, buildMatch, buildRecording, buildSelectGloss, buildSelectReverse, buildTranscription, buildTypingRecall,
  playablePronunciation, pronunciationFor,
} from '../../practice-resolver/generated';
import { DistractorView, MeaningSnapshot, ResolveContext, ResolvedTask } from '../../practice-resolver/task.types';
import { evidenceClassOf } from '../../memory-srs/evidence-weight';
import { pickWeighted, planNewMeanings, Rng, shuffle, TaskSlot } from './interleave';

export interface PlanInput {
  mode: SessionMode;
  newTargets: MeaningSnapshot[];
  reviewTargets: MeaningSnapshot[];
  pool: DistractorView[];
  curated: CuratedItem[];
  proficiency: string | null;
  // Daily: put an optional recall before each Learn card ("I know this").
  knownCheck?: boolean;
  // Daily: the learner opted in to recordings; they train speaking only and never move memory.
  speaking?: boolean;
  ctx: ResolveContext;
  rng: Rng;
}

export interface PlannedLearn {
  kind: 'learn';
  id: string;
  ordinal: number;
  meaningId: string;
  card: Record<string, unknown>;
  firstRecallTaskId: string;
  knownCheckTaskId?: string;
  /** New-practice tasks that test only this Meaning; a learner who passed the known check may skip them. */
  skippableTaskIds?: string[];
}

export interface PlannedTask {
  kind: 'task';
  id: string;
  ordinal: number;
  phase: TaskPhase;
  task: ResolvedTask;
}

export type PlannedStep = PlannedLearn | PlannedTask;

const PHASE_BY_MODE: Record<SessionMode, TaskPhase> = {
  [SESSION_MODE.DAILY]: TASK_PHASE.DUE_REVIEW,
  [SESSION_MODE.CHECKPOINT_CHALLENGE]: TASK_PHASE.CHECKPOINT_CHALLENGE,
  [SESSION_MODE.RANDOM_PRACTICE]: TASK_PHASE.RANDOM_PRACTICE,
  [SESSION_MODE.WEAK_WORDS_PRACTICE]: TASK_PHASE.WEAK_WORDS_PRACTICE,
  [SESSION_MODE.SPEAKING_PRACTICE]: TASK_PHASE.SPEAKING_PRACTICE,
};

const { semanticWeight, skillWeight, skillBonusChance, audioChance, matchChance, classPickWeight, dailySpeakingCap } = POLICY.review;

function buildCard(target: MeaningSnapshot, ctx: ResolveContext) {
  const pronunciation = pronunciationFor(target, ctx.accent);
  const playable = playablePronunciation(target, ctx);
  return {
    wordId: target.wordId,
    meaningId: target.meaningId,
    word: target.lemma,
    partOfSpeech: target.partOfSpeech,
    meaning: target.meaningText,
    definition: target.definitionText,
    ipa: pronunciation?.ipa,
    ...(playable && { audio: { url: playable.audioUrl, locale: playable.accentLocale } }),
    examples: target.examples.map(({ text, translation }) => ({ text, translation })),
  };
}

const curatedFor = (input: PlanInput, target: MeaningSnapshot) => {
  const pronunciationIds = new Set(target.pronunciations.map((p) => p.id));
  return input.curated.filter(
    (item) =>
      isContextEligible(item.contextCefrLevel, input.proficiency, isContextualVariant(item.variant)) &&
      item.targets.some((t) => t.meaningId === target.meaningId || (t.pronunciationId && pronunciationIds.has(t.pronunciationId))),
  );
};

const curatedTasks = (input: PlanInput, target: MeaningSnapshot, semantic: boolean) =>
  curatedFor(input, target)
    .filter((item) => SEMANTIC_INTENTS.includes(intentOf(item.variant)!) === semantic)
    .flatMap((item) => [resolveCurated(item, PROMPT_TYPE.TEXT, input.ctx), resolveCurated(item, PROMPT_TYPE.AUDIO, input.ctx)]);

const weighted = (tasks: (ResolvedTask | null)[], weight: number) =>
  tasks.filter((task): task is ResolvedTask => task !== null).map((value) => ({ value, weight }));

function semanticCandidates(target: MeaningSnapshot, input: PlanInput) {
  const { pool, ctx, rng } = input;
  return weighted(
    [
      buildSelectGloss(target, pool, PROMPT_TYPE.TEXT, ctx, rng),
      buildSelectGloss(target, pool, PROMPT_TYPE.AUDIO, ctx, rng),
      buildTypingRecall(target, ctx),
      buildFlyReorder(target, ctx, rng),
      ...curatedTasks(input, target, true),
    ],
    semanticWeight,
  );
}

/** Daily: one meaning task per due word, weighted by evidence class. */
function dailyCandidates(target: MeaningSnapshot, input: PlanInput) {
  return semanticCandidates(target, input).flatMap(({ value }) => {
    const cls = evidenceClassOf(value.variant);
    return cls ? [{ value, weight: classPickWeight[cls] }] : [];
  });
}

const recallOnly = <T extends { value: ResolvedTask }>(candidates: T[]) =>
  candidates.filter(({ value }) => value.serverEvaluation.intent === ASSESSMENT_INTENT.MEANING_RECALL);

function skillCandidates(target: MeaningSnapshot, input: PlanInput) {
  const { ctx } = input;
  return weighted(
    [
      buildRecording(target, ctx, { meaningCue: true }),
      buildTranscription(target, ctx),
      ...curatedTasks(input, target, false),
    ],
    skillWeight,
  );
}

const pickModality = (rng: Rng): PromptType => (rng() < audioChance ? PROMPT_TYPE.AUDIO : PROMPT_TYPE.TEXT);

function reviewTasks(input: PlanInput): ResolvedTask[] {
  const { mode, reviewTargets, rng, ctx } = input;
  // Weakest first, as the planner ordered them.
  if (mode === SESSION_MODE.SPEAKING_PRACTICE) return reviewTargets.flatMap((target) => buildRecording(target, ctx, { meaningCue: true }) ?? []);
  const tasks: ResolvedTask[] = [];
  for (const target of reviewTargets) {
    if (mode === SESSION_MODE.DAILY) {
      const task = pickWeighted(dailyCandidates(target, input), rng);
      if (task) tasks.push(task);
      continue;
    }
    const semantic = semanticCandidates(target, input);
    const primary = pickWeighted(mode === SESSION_MODE.CHECKPOINT_CHALLENGE ? recallOnly(semantic) : semantic, rng);
    if (!primary) continue;
    tasks.push(primary);
    if (rng() >= skillBonusChance) continue;
    const bonus = pickWeighted(skillCandidates(target, input), rng);
    if (bonus) tasks.push(bonus);
  }
  if (mode !== SESSION_MODE.DAILY && mode !== SESSION_MODE.CHECKPOINT_CHALLENGE && rng() < matchChance) {
    const match = buildMatch(shuffle(reviewTargets, rng).slice(0, POLICY.newLearning.matchPairCount), ctx, rng);
    if (match) tasks.push(match);
  }
  return shuffle(tasks, rng);
}

// Each recording goes after its word's meaning task: it shows the word, so it would prime a recall.
function withRecordings(tasks: ResolvedTask[], input: PlanInput) {
  const { reviewTargets, ctx, rng } = input;
  const recordings = shuffle(reviewTargets, rng)
    .flatMap((target) => {
      const recording = buildRecording(target, ctx, { meaningCue: true });
      return recording ? [{ meaningId: target.meaningId, recording }] : [];
    })
    .slice(0, dailySpeakingCap);
  const result = [...tasks];
  for (const { meaningId, recording } of recordings) {
    const after = result.findIndex((task) => task.targets.some((t) => t.meaningId === meaningId));
    result.splice(after + 1 + Math.floor(rng() * (result.length - after)), 0, recording);
  }
  return result;
}

function buildGloss(target: MeaningSnapshot, { pool, ctx, rng }: PlanInput) {
  return (
    buildSelectGloss(target, pool, pickModality(rng), ctx, rng) ?? buildSelectGloss(target, pool, PROMPT_TYPE.TEXT, ctx, rng)
  );
}

function buildNewSlot(slot: TaskSlot, target: MeaningSnapshot, input: PlanInput) {
  const { pool, ctx, rng } = input;
  if (slot.template === TEMPLATE.RECORDING) {
    // The Learn card just showed the word, so a meaning cue would test nothing.
    return buildRecording(target, ctx, { meaningCue: false });
  }
  if (slot.isFirstRecall) {
    const fly = slot.template === TEMPLATE.FLY_REORDER ? buildFlyReorder(target, ctx, rng) : null;
    return fly ?? buildTypingRecall(target, ctx);
  }
  return slot.variant === VARIANT.REVERSE_GLOSS ? buildSelectReverse(target, pool, ctx, rng) : buildGloss(target, input);
}

// C29/C30: a Meaning lacking any mandatory group is dropped before issue. Recording is optional, so it is not one.
const canLearn = (target: MeaningSnapshot, { pool, ctx, rng }: PlanInput) =>
  Boolean(
    buildSelectGloss(target, pool, PROMPT_TYPE.TEXT, ctx, rng) &&
      buildSelectReverse(target, pool, ctx, rng) &&
      buildTypingRecall(target, ctx),
  );

const visibleText = ({ task }: PlannedTask) => {
  const { evaluation: _evaluation, ...shown } = task.clientPayload as Record<string, unknown>;
  return normalizeAnswer(JSON.stringify(shown));
};

const previousShowsAnswer = (step: PlannedStep, answers: string[]) =>
  step.kind === 'task'
    ? answers.some((a) => visibleText(step).includes(normalizeAnswer(a)))
    : answers.some((a) => normalizeAnswer(String(step.card.word)) === normalizeAnswer(a));

function markPriming(steps: PlannedStep[]) {
  steps.forEach((step, index) => {
    if (step.kind !== 'task' || step.task.serverEvaluation.intent !== ASSESSMENT_INTENT.MEANING_RECALL) return;
    const window = steps.slice(Math.max(0, index - POLICY.priming.windowTasks), index);
    step.task.serverEvaluation.isPrimed = window.some((previous) => previousShowsAnswer(previous, step.task.serverEvaluation.answerTexts));
  });
}

export function buildPlan(input: PlanInput): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const addTask = (task: ResolvedTask, phase: TaskPhase) => {
    const planned: PlannedTask = { kind: 'task', id: newId(), ordinal: steps.length, phase, task };
    steps.push(planned);
    return planned;
  };

  const review = reviewTasks(input);
  const speaking = input.mode === SESSION_MODE.DAILY && input.speaking === true;
  for (const task of speaking ? withRecordings(review, input) : review) addTask(task, PHASE_BY_MODE[input.mode]);

  const learnable = input.newTargets.filter((target) => canLearn(target, input));
  const learnSteps = new Map<number, PlannedLearn>();
  for (const slot of planNewMeanings(learnable.length, input.rng, speaking)) {
    const target = learnable[slot.meaningIndex];
    if (slot.kind === 'learn') {
      // Placed right before the card, so nothing has shown the answer yet.
      const check = input.knownCheck ? buildTypingRecall(target, input.ctx) : null;
      const knownCheckTaskId = check ? addTask(check, TASK_PHASE.KNOWN_CHECK).id : undefined;
      const learn: PlannedLearn = {
        kind: 'learn', id: newId(), ordinal: steps.length, meaningId: target.meaningId,
        card: buildCard(target, input.ctx), firstRecallTaskId: '',
        ...(knownCheckTaskId && { knownCheckTaskId }),
      };
      steps.push(learn);
      learnSteps.set(slot.meaningIndex, learn);
      continue;
    }
    const built = buildNewSlot(slot, target, input);
    if (!built) continue;
    const planned = addTask(built, TASK_PHASE.NEW_PRACTICE);
    if (slot.isFirstRecall) {
      planned.task.serverEvaluation.isFirstRecall = true;
      learnSteps.get(slot.meaningIndex)!.firstRecallTaskId = planned.id;
    }
  }
  if (input.knownCheck) markSkippable(steps, learnable);
  markPriming(steps);
  return steps;
}

function markSkippable(steps: PlannedStep[], learnable: MeaningSnapshot[]) {
  const owners = new Map<string, Set<string>>();
  for (const target of learnable) {
    for (const id of [target.meaningId, ...target.pronunciations.map((p) => p.id)]) {
      owners.set(id, (owners.get(id) ?? new Set()).add(target.meaningId));
    }
  }
  const skippable = new Map<string, string[]>();
  for (const step of steps) {
    if (step.kind !== 'task' || step.phase !== TASK_PHASE.NEW_PRACTICE) continue;
    const meanings = new Set(step.task.targets.flatMap((t) => [...(owners.get(t.meaningId ?? t.pronunciationId ?? '') ?? [])]));
    // Only a task about one Meaning can go; a match pairs several and stays for the others.
    if (meanings.size !== 1) continue;
    const [meaningId] = meanings;
    skippable.set(meaningId, [...(skippable.get(meaningId) ?? []), step.id]);
  }
  for (const step of steps) {
    if (step.kind === 'learn' && step.knownCheckTaskId) step.skippableTaskIds = skippable.get(step.meaningId) ?? [];
  }
}
