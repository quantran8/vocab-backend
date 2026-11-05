import { ASSESSMENT_INTENT, PROMPT_TYPE, PromptType, SESSION_MODE, SessionMode, SKILL, Skill, TASK_PHASE, TaskPhase, TEMPLATE, VARIANT } from '../../../common/constants/domain';
import { newId } from '../../../common/ids';
import { POLICY } from '../../../config/policy';
import { normalizeAnswer } from '../../practice-evaluator/normalizer';
import { CuratedItem, intentOf, isContextEligible, isContextualVariant, resolveCurated, SEMANTIC_INTENTS } from '../../practice-resolver/curated';
import {
  buildFlyReorder, buildMatch, buildRecording, buildSelectGloss, buildSelectReverse, buildTranscription, buildTypingRecall,
  playablePronunciation, pronunciationFor,
} from '../../practice-resolver/generated';
import { DistractorView, MeaningSnapshot, ResolveContext, ResolvedTask } from '../../practice-resolver/task.types';
import { pickWeighted, planNewMeanings, Rng, shuffle, TaskSlot } from './interleave';

export interface PlanInput {
  mode: SessionMode;
  newTargets: MeaningSnapshot[];
  reviewTargets: MeaningSnapshot[];
  // Weak only: skills with an open issue, by meaningId.
  focusSkills?: Map<string, Skill[]>;
  pool: DistractorView[];
  curated: CuratedItem[];
  proficiency: string | null;
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
};

const { semanticWeight, skillWeight, skillBonusChance, audioChance, matchChance } = POLICY.review;

function buildCard(target: MeaningSnapshot, ctx: ResolveContext) {
  const pronunciation = pronunciationFor(target, ctx.accent);
  const playable = playablePronunciation(target, ctx);
  return {
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

const recallOnly = <T extends { value: ResolvedTask }>(candidates: T[]) =>
  candidates.filter(({ value }) => value.serverEvaluation.intent === ASSESSMENT_INTENT.MEANING_RECALL);

function skillCandidates(target: MeaningSnapshot, input: PlanInput) {
  const { ctx } = input;
  return weighted(
    [
      buildRecording(target, PROMPT_TYPE.TEXT, ctx),
      buildRecording(target, PROMPT_TYPE.AUDIO, ctx),
      buildTranscription(target, ctx),
      ...curatedTasks(input, target, false),
    ],
    skillWeight,
  );
}

const pickModality = (rng: Rng): PromptType => (rng() < audioChance ? PROMPT_TYPE.AUDIO : PROMPT_TYPE.TEXT);

// Each task must yield direct evidence for its skill, or the issue could never clear.
function taskForSkill(skill: Skill, target: MeaningSnapshot, { pool, ctx, rng }: PlanInput) {
  switch (skill) {
    case SKILL.READING:
      return buildSelectGloss(target, pool, PROMPT_TYPE.TEXT, ctx, rng) ?? buildSelectReverse(target, pool, ctx, rng);
    case SKILL.WRITING:
      return (rng() < POLICY.newLearning.recallTypingWeight ? null : buildFlyReorder(target, ctx, rng)) ?? buildTypingRecall(target, ctx);
    case SKILL.LISTENING:
      return buildSelectGloss(target, pool, PROMPT_TYPE.AUDIO, ctx, rng);
    case SKILL.SPEAKING:
      return buildRecording(target, pickModality(rng), ctx) ?? buildRecording(target, PROMPT_TYPE.TEXT, ctx);
  }
}

function focusedTasks(input: PlanInput, focus: Map<string, Skill[]>) {
  const perTarget = input.reviewTargets.map((target) => {
    const tasks = (focus.get(target.meaningId) ?? []).flatMap((skill) => taskForSkill(skill, target, input) ?? []);
    if (tasks.length > 0) return tasks;
    const fallback = pickWeighted(semanticCandidates(target, input), input.rng);
    return fallback ? [fallback] : [];
  });
  const rounds = Math.max(0, ...perTarget.map((tasks) => tasks.length));
  // Every target gets its first skill before any target gets a second.
  const capped = Array.from({ length: rounds }, (_, round) => perTarget.flatMap((tasks) => tasks[round] ?? []))
    .flat()
    .slice(0, POLICY.session.practiceTaskCap);
  const isRecall = (task: ResolvedTask) => task.serverEvaluation.intent === ASSESSMENT_INTENT.MEANING_RECALL;
  // Recall first: a select or recording of the same word would prime it, and a primed pass clears nothing.
  return [...shuffle(capped.filter(isRecall), input.rng), ...shuffle(capped.filter((t) => !isRecall(t)), input.rng)];
}

function reviewTasks(input: PlanInput): ResolvedTask[] {
  const { mode, reviewTargets, rng, ctx, focusSkills } = input;
  if (focusSkills?.size) return focusedTasks(input, focusSkills);
  const tasks: ResolvedTask[] = [];
  for (const target of reviewTargets) {
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

function buildGloss(target: MeaningSnapshot, { pool, ctx, rng }: PlanInput) {
  return (
    buildSelectGloss(target, pool, pickModality(rng), ctx, rng) ?? buildSelectGloss(target, pool, PROMPT_TYPE.TEXT, ctx, rng)
  );
}

function buildNewSlot(slot: TaskSlot, target: MeaningSnapshot, input: PlanInput) {
  const { pool, ctx, rng } = input;
  if (slot.template === TEMPLATE.RECORDING) {
    return buildRecording(target, pickModality(rng), ctx) ?? buildRecording(target, PROMPT_TYPE.TEXT, ctx);
  }
  if (slot.isFirstRecall) {
    const fly = slot.template === TEMPLATE.FLY_REORDER ? buildFlyReorder(target, ctx, rng) : null;
    return fly ?? buildTypingRecall(target, ctx);
  }
  return slot.variant === VARIANT.REVERSE_GLOSS ? buildSelectReverse(target, pool, ctx, rng) : buildGloss(target, input);
}

// C29/C30: a Meaning lacking any mandatory group is dropped before issue.
const canLearn = (target: MeaningSnapshot, { pool, ctx, rng }: PlanInput) =>
  Boolean(
    buildSelectGloss(target, pool, PROMPT_TYPE.TEXT, ctx, rng) &&
      buildSelectReverse(target, pool, ctx, rng) &&
      buildTypingRecall(target, ctx) &&
      buildRecording(target, PROMPT_TYPE.TEXT, ctx),
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

  for (const task of reviewTasks(input)) addTask(task, PHASE_BY_MODE[input.mode]);

  const learnable = input.newTargets.filter((target) => canLearn(target, input));
  const learnSteps = new Map<number, PlannedLearn>();
  for (const slot of planNewMeanings(learnable.length, input.rng)) {
    const target = learnable[slot.meaningIndex];
    if (slot.kind === 'learn') {
      const learn: PlannedLearn = {
        kind: 'learn', id: newId(), ordinal: steps.length, meaningId: target.meaningId,
        card: buildCard(target, input.ctx), firstRecallTaskId: '',
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
  markPriming(steps);
  return steps;
}
