import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Clock } from '../../../common/clock';
import { DEFAULT_ACCENT, EVALUATOR_VERSION, PLAN_VERSION, SESSION_MODE, SESSION_MODES, SCHEDULER_VERSION, SKILL, Skill, SKILLS, TASK_PHASE, WithheldReason } from '../../../common/constants/domain';
import { addHours, HOURS_PER_DAY } from '../../../common/constants/time';
import { ApiError } from '../../../common/http/api-error';
import { newId } from '../../../common/ids';
import { AppConfig } from '../../../config/app-config';
import { POLICY } from '../../../config/policy';
import { copyFor } from '../../practice-resolver/locale-copy';
import { applyOverride } from '../../practice-resolver/meaning-override';
import { effectiveNewWords, reviewsPerSession, withheldReason } from '../../review-load/domain/review-load';
import { MeaningSnapshot } from '../../practice-resolver/task.types';
import { Rng, shuffle } from '../domain/interleave';
import { buildPlan, PlannedLearn, PlannedStep, PlannedTask } from '../domain/plan-builder';
import { Learner, PlannerRepository, PracticeFilter, SourceTopic } from '../repositories/planner.repository';
import { SessionPlan } from '../domain/session-plan';

export const planRequestSchema = z
  .strictObject({
    mode: z.enum(SESSION_MODES),
    capabilities: z.strictObject({ audioPlayback: z.boolean(), microphone: z.boolean() }),
    challengeId: z.uuid().optional(),
    // `skill` is the single-skill form older clients send.
    skill: z.enum(SKILLS).optional(),
    skills: z.array(z.enum(SKILLS)).min(1).refine((s) => new Set(s).size === s.length, 'skills must be unique').optional(),
    // Daily with due reviews only (§7.3).
    reviewOnly: z.boolean().optional(),
    // Daily: offer "I know this" before each new word.
    knownCheck: z.boolean().optional(),
    filter: z.union([
      z.strictObject({ collectionId: z.uuid() }),
      z.strictObject({ topicIds: z.array(z.uuid()).min(1).max(100) }),
      z.strictObject({ customOnly: z.literal(true) }),
    ]).optional(),
  })
  .refine(({ skill, skills }) => !(skill && skills), { path: ['skills'], message: 'send skill or skills, not both' })
  .refine(({ mode, skill, skills }) => !(skill || skills) || mode === SESSION_MODE.RANDOM_PRACTICE, {
    path: ['skills'],
    message: 'skills require random_practice',
  })
  .refine(({ mode, reviewOnly }) => !reviewOnly || mode === SESSION_MODE.DAILY, { path: ['reviewOnly'], message: 'reviewOnly requires daily' })
  .refine(({ mode, knownCheck }) => !knownCheck || mode === SESSION_MODE.DAILY, { path: ['knownCheck'], message: 'knownCheck requires daily' })
  .refine(({ mode, filter }) => !filter || mode === SESSION_MODE.RANDOM_PRACTICE, { path: ['filter'], message: 'filter requires random_practice' });
export type PlanRequest = z.infer<typeof planRequestSchema>;

const { practiceTaskCap, ttlHours, distractorPoolSize } = POLICY.session;

const requestedSkills = ({ skill, skills }: PlanRequest): Skill[] | undefined => skills ?? (skill ? [skill] : undefined);

const canTrain = (skill: Skill, { capabilities }: PlanRequest) =>
  !(skill === SKILL.SPEAKING && !capabilities.microphone) && !(skill === SKILL.LISTENING && !capabilities.audioPlayback);

@Injectable()
export class PlannerService {
  private rng: Rng = Math.random;

  constructor(
    private readonly repository: PlannerRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  setRng(rng: Rng) {
    this.rng = rng;
  }

  async plan(userId: string, request: PlanRequest) {
    // A skill the device cannot train is dropped; the plan is empty only when none is left.
    const skills = requestedSkills(request)?.filter((s) => canTrain(s, request));
    if (skills?.length === 0) return empty(request.mode);
    if (request.filter && !(await this.repository.filterExists(request.filter))) {
      throw new ApiError('NOT_FOUND', 'Collection or Topic not found');
    }
    const now = this.clock.now();
    const learner = await this.repository.loadLearner(userId, now, request.mode === SESSION_MODE.DAILY);
    const { settings } = learner;
    const locale = settings.explanationLocale;

    const selected = await this.selectTargets(userId, request, learner, now, skills);
    const { challengeId, budget } = selected;
    const newWords = (issued: number) => budget && {
      requested: settings.dailyNewWordGoal,
      issued,
      withheldReason: withheldReason(settings.dailyNewWordGoal, issued, budget) as WithheldReason | null,
    };
    if (selected.reviewTargets.length + selected.newTargets.length === 0) return empty(request.mode, newWords(0));

    const reviewSnapshots = selected.reviewTargets.map((t) => t.snapshot);
    const newSnapshots = selected.newTargets.map((t) => t.snapshot);
    const targets = [...reviewSnapshots, ...newSnapshots];
    const [pool, curated, overrides] = await Promise.all([
      this.repository.distractorPool(locale, distractorPoolSize),
      this.repository.curatedItems(
        targets.map((t) => t.meaningId),
        targets.flatMap((t) => t.pronunciations.map((p) => p.id)),
        locale,
      ),
      this.repository.overrides(userId, targets.map((t) => t.meaningId), locale),
    ]);
    const edits = new Map(overrides.map((o) => [o.meaningId, o.content]));
    const reviewTargets = reviewSnapshots.map((t) => applyOverride(t, edits.get(t.meaningId)));
    const newTargets = newSnapshots.map((t) => applyOverride(t, edits.get(t.meaningId)));

    const steps = buildPlan({
      mode: request.mode,
      reviewTargets,
      newTargets,
      focusSkills: selected.focusSkills,
      pool,
      curated,
      proficiency: learner.proficiencyLevel,
      skills,
      knownCheck: request.knownCheck,
      rng: this.rng,
      ctx: {
        locale,
        accent: DEFAULT_ACCENT,
        audioPlayback: request.capabilities.audioPlayback,
        allowPlaceholderAudio: this.config.allowPlaceholderAudio,
      },
    });
    const issued = steps.filter((s) => s.kind === 'learn').length;
    if (steps.length === 0) return empty(request.mode, newWords(0));

    const labels: Labels = {
      // Recording targets a pronunciation, so its id carries the label too.
      sourceTopics: new Map(selected.reviewTargets.flatMap((t) => {
        if (!t.sourceTopic) return [];
        const topic = label(t.sourceTopic, settings.uiLocale);
        return [t.snapshot.meaningId, ...t.snapshot.pronunciations.map((p) => p.id)].map((id) => [id, topic] as const);
      })),
      viaTopics: new Map(selected.newTargets.map((t) => [t.snapshot.meaningId, t.viaTopicId])),
    };
    const plan = toSessionPlan(steps, labels);
    const sessionId = newId();
    const expiresAt = addHours(now, ttlHours);
    await this.persist(userId, sessionId, request, plan, now, expiresAt, {
      locale,
      topicIds: learner.activeTopics.map((t) => t.topicId),
      capabilities: request.capabilities,
      ...(challengeId && { challengeId }),
      ...(skills && { skills }),
      ...(request.reviewOnly && { reviewOnly: true }),
      ...(request.knownCheck && { knownCheck: true }),
      ...(request.filter && { filter: request.filter }),
    });
    const sourceTopics = new Map(plan.tasks.flatMap((t) => (t.sourceTopic ? [[t.id, t.sourceTopic] as const] : [])));
    // Daily: the reviewed words for the preview screen, only those the plan actually tests.
    const tested = new Set(plan.tasks.filter((t) => t.phase === TASK_PHASE.DUE_REVIEW)
      .flatMap((t) => t.targets.flatMap((g) => [g.meaningId, g.pronunciationId]).filter((id): id is string => id !== null)));
    const reviewWords = selected.reviewTargets
      .filter(({ snapshot }) => tested.has(snapshot.meaningId) || snapshot.pronunciations.some((p) => tested.has(p.id)))
      .map(({ snapshot, sourceTopic }) => ({
        wordId: snapshot.wordId,
        meaningId: snapshot.meaningId,
        lemma: snapshot.lemma,
        sourceTopic: sourceTopic ? label(sourceTopic, settings.uiLocale) : null,
      }));
    return {
      sessionId,
      mode: request.mode,
      expiresAt,
      ...(budget && { newWords: newWords(issued), reviewWords }),
      steps: steps.map((step) => toClientStep(step, sourceTopics)),
    };
  }

  private async selectTargets(
    userId: string,
    { mode, challengeId, reviewOnly, filter }: PlanRequest,
    learner: Learner,
    now: Date,
    skills?: Skill[],
  ): Promise<Selection> {
    const { settings } = learner;
    const locale = settings.explanationLocale;
    const asReview = (snapshots: MeaningSnapshot[]) => snapshots.map((snapshot) => ({ snapshot, sourceTopic: null }));

    if (mode === SESSION_MODE.DAILY) {
      // Nothing gates new words: the Challenge Map is optional. The learner's own choices size them (§7.5).
      const counts = learner.budget!;
      const budget = effectiveNewWords({
        goal: settings.dailyNewWordGoal,
        override: settings.override,
        autoBalance: settings.autoBalanceNewWords,
        backlog: counts.backlog,
        remaining: counts.remaining,
        pendingCustom: counts.pendingCustom,
        reviewOnly,
        now,
      });
      const [reviewTargets, newTargets] = await Promise.all([
        this.repository.dueTargets(userId, locale, settings.uiLocale, now, reviewsPerSession(settings.reviewsPerSession, settings.dailyNewWordGoal)),
        this.repository.newTargets(userId, locale, learner.proficiencyLevel, budget.value),
      ]);
      return { reviewTargets, newTargets, budget };
    }
    if (mode === SESSION_MODE.RANDOM_PRACTICE) {
      const pool = await this.repository.randomTargets(userId, locale, practiceTaskCap * POLICY.review.candidateMultiplier, skills, filter as PracticeFilter | undefined);
      return { reviewTargets: asReview(shuffle(pool, this.rng).slice(0, practiceTaskCap)), newTargets: [] };
    }
    if (mode === SESSION_MODE.WEAK_WORDS_PRACTICE) {
      const since = addHours(now, -POLICY.weak.lookbackDays * HOURS_PER_DAY);
      const rows = await this.repository.weakTargets(userId, locale, since, POLICY.weak.minAttempts, practiceTaskCap);
      return {
        reviewTargets: asReview(rows.map((r) => r.snapshot)),
        newTargets: [],
        focusSkills: new Map(rows.flatMap((r) => (r.skills ? [[r.snapshot.meaningId, r.skills] as const] : []))),
      };
    }
    const challenge = await this.repository.oldestChallenge(userId, challengeId);
    if (!challenge) throw new ApiError('NOT_FOUND', 'No available checkpoint challenge');
    return { reviewTargets: asReview(await this.repository.challengeTargets(challenge.id, locale)), newTargets: [], challengeId: challenge.id };
  }

  private async persist(userId: string, sessionId: string, { mode }: PlanRequest, plan: SessionPlan, issuedAt: Date, expiresAt: Date, scope: { challengeId?: string; [key: string]: unknown }) {
    await this.repository.insertSession({
      id: sessionId,
      userId,
      mode,
      planVersion: PLAN_VERSION,
      issuedAt,
      expiresAt,
      scopeSnapshot: scope,
      policyVersions: { policy: POLICY.version, scheduler: SCHEDULER_VERSION, evaluator: EVALUATOR_VERSION, reviewLoad: POLICY.reviewLoad.version },
      plan,
    });
  }
}

type Selection = {
  reviewTargets: { snapshot: MeaningSnapshot; sourceTopic: SourceTopic | null }[];
  newTargets: { snapshot: MeaningSnapshot; viaTopicId: string | null }[];
  challengeId?: string;
  focusSkills?: Map<string, Skill[]>;
  budget?: ReturnType<typeof effectiveNewWords>;
};

type Labels = { sourceTopics: Map<string, { id: string; name: string }>; viaTopics: Map<string, string | null> };

const label = (topic: SourceTopic, uiLocale: string) => ({ id: topic.id, name: topic.personal ? copyFor(uiLocale, 'topic.personal.name') : topic.name });

const empty = (mode: PlanRequest['mode'], newWords?: unknown) => ({ sessionId: null, mode, ...(newWords ? { newWords } : {}), steps: [] });

function toSessionPlan(steps: PlannedStep[], labels: Labels): SessionPlan {
  return {
    tasks: steps.filter((s): s is PlannedTask => s.kind === 'task').map(({ id, ordinal, phase, task }) => {
      const sourceTopic = phase === TASK_PHASE.DUE_REVIEW
        ? task.targets.map((t) => labels.sourceTopics.get(t.meaningId ?? t.pronunciationId ?? '')).find(Boolean)
        : undefined;
      return {
        id,
        ordinal,
        phase,
        template: task.template,
        variant: task.variant ?? null,
        curatedItemId: task.curatedItemId ?? null,
        clientPayload: { id, ...task.clientPayload },
        serverEvaluation: task.serverEvaluation,
        evaluatorVersion: EVALUATOR_VERSION,
        targets: task.targets.map((target, targetOrdinal) => ({ ordinal: targetOrdinal, ...target })),
        ...(sourceTopic && { sourceTopic }),
      };
    }),
    learnSteps: steps.filter((s): s is PlannedLearn => s.kind === 'learn').map(({ id, ordinal, meaningId, card, firstRecallTaskId, knownCheckTaskId, skippableTaskIds }) => ({
      id, meaningId, ordinal, clientCard: card, firstRecallTaskId, viaTopicId: labels.viaTopics.get(meaningId) ?? null,
      ...(knownCheckTaskId && { knownCheckTaskId, skippableTaskIds }),
    })),
  };
}

function toClientStep(step: PlannedStep, sourceTopics: Map<string, { id: string; name: string }>) {
  if (step.kind === 'learn') {
    return {
      type: 'learn', id: step.id, card: step.card,
      ...(step.knownCheckTaskId && { knownCheckTaskId: step.knownCheckTaskId, skippableTaskIds: step.skippableTaskIds }),
    };
  }
  const sourceTopic = sourceTopics.get(step.id);
  return { type: 'practice', phase: step.phase, ...(sourceTopic && { sourceTopic }), task: { id: step.id, ...step.task.clientPayload } };
}
