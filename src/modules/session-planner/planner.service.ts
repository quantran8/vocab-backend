import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Clock } from '../../common/clock';
import { DEFAULT_ACCENT, EVALUATOR_VERSION, PLAN_VERSION, SESSION_MODE, SESSION_MODES, SCHEDULER_VERSION } from '../../common/constants/domain';
import { addHours, HOURS_PER_DAY } from '../../common/constants/time';
import { ApiError } from '../../common/http/api-error';
import { newId } from '../../common/ids';
import { AppConfig } from '../../config/app-config';
import { POLICY } from '../../config/policy';
import { DB, Db } from '../../db/db';
import { learningSessions } from '../../db/schema';
import { MeaningSnapshot } from '../practice-resolver/task.types';
import { Rng, shuffle } from './interleave';
import { buildPlan, PlannedLearn, PlannedStep, PlannedTask } from './plan-builder';
import { PlannerRepository } from './planner.repository';
import { SessionPlan } from './session-plan';

export const planRequestSchema = z.strictObject({
  mode: z.enum(SESSION_MODES),
  capabilities: z.strictObject({ audioPlayback: z.boolean(), microphone: z.boolean() }),
  challengeId: z.uuid().optional(),
});
export type PlanRequest = z.infer<typeof planRequestSchema>;

const { reviewCap, practiceTaskCap, ttlHours, distractorPoolSize } = POLICY.session;

@Injectable()
export class PlannerService {
  private rng: Rng = Math.random;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repository: PlannerRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  setRng(rng: Rng) {
    this.rng = rng;
  }

  async plan(userId: string, request: PlanRequest) {
    const now = this.clock.now();
    const learner = await this.repository.loadLearner(userId);
    const settings = learner.settings!;
    const locale = settings.explanationLocale;

    const { reviewTargets, newTargets, challengeId } = await this.selectTargets(userId, request, learner, now);
    if (reviewTargets.length + newTargets.length === 0) return { sessionId: null, mode: request.mode, steps: [] };

    const targets = [...reviewTargets, ...newTargets];
    const [pool, curated] = await Promise.all([
      this.repository.distractorPool(locale, distractorPoolSize),
      this.repository.curatedItems(
        targets.map((t) => t.meaningId),
        targets.flatMap((t) => t.pronunciations.map((p) => p.id)),
        locale,
      ),
    ]);

    const steps = buildPlan({
      mode: request.mode,
      reviewTargets,
      newTargets,
      pool,
      curated,
      proficiency: learner.proficiencyLevel,
      rng: this.rng,
      ctx: {
        locale,
        accent: DEFAULT_ACCENT,
        audioPlayback: request.capabilities.audioPlayback,
        allowPlaceholderAudio: this.config.allowPlaceholderAudio,
      },
    });
    if (steps.length === 0) return { sessionId: null, mode: request.mode, steps: [] };

    const sessionId = newId();
    const expiresAt = addHours(now, ttlHours);
    await this.persist(userId, sessionId, request, steps, now, expiresAt, {
      locale,
      topicIds: learner.activeTopics.map((t) => t.topicId),
      capabilities: request.capabilities,
      ...(challengeId && { challengeId }),
    });
    return { sessionId, mode: request.mode, expiresAt, steps: steps.map(toClientStep) };
  }

  private async selectTargets(
    userId: string,
    { mode, challengeId }: PlanRequest,
    learner: Awaited<ReturnType<PlannerRepository['loadLearner']>>,
    now: Date,
  ): Promise<{ reviewTargets: MeaningSnapshot[]; newTargets: MeaningSnapshot[]; challengeId?: string }> {
    const settings = learner.settings!;
    const locale = settings.explanationLocale;

    if (mode === SESSION_MODE.DAILY) {
      const [reviewTargets, newTargets] = await Promise.all([
        this.repository.dueTargets(userId, locale, now, reviewCap),
        this.repository.newTargets(userId, locale, learner.proficiencyLevel, settings.dailyNewWordGoal),
      ]);
      return { reviewTargets, newTargets };
    }
    if (mode === SESSION_MODE.RANDOM_PRACTICE) {
      const pool = await this.repository.randomTargets(userId, locale, practiceTaskCap * POLICY.review.candidateMultiplier);
      return { reviewTargets: shuffle(pool, this.rng).slice(0, practiceTaskCap), newTargets: [] };
    }
    if (mode === SESSION_MODE.WEAK_WORDS_PRACTICE) {
      const since = addHours(now, -POLICY.weak.lookbackDays * HOURS_PER_DAY);
      const reviewTargets = await this.repository.weakTargets(userId, locale, since, POLICY.weak.minAttempts, practiceTaskCap);
      return { reviewTargets, newTargets: [] };
    }
    const challenge = await this.repository.oldestChallenge(userId, challengeId);
    if (!challenge) throw new ApiError('NOT_FOUND', 'No available checkpoint challenge');
    return { reviewTargets: await this.repository.challengeTargets(challenge.id, locale), newTargets: [], challengeId: challenge.id };
  }

  private async persist(userId: string, sessionId: string, { mode }: PlanRequest, steps: PlannedStep[], issuedAt: Date, expiresAt: Date, scope: { challengeId?: string; [key: string]: unknown }) {
    await this.db.insert(learningSessions).values({
      id: sessionId,
      userId,
      mode,
      planVersion: PLAN_VERSION,
      issuedAt,
      expiresAt,
      scopeSnapshot: scope,
      policyVersions: { policy: POLICY.version, scheduler: SCHEDULER_VERSION, evaluator: EVALUATOR_VERSION },
      plan: toSessionPlan(steps),
    });
  }
}

function toSessionPlan(steps: PlannedStep[]): SessionPlan {
  return {
    tasks: steps.filter((s): s is PlannedTask => s.kind === 'task').map(({ id, ordinal, phase, task }) => ({
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
    })),
    learnSteps: steps.filter((s): s is PlannedLearn => s.kind === 'learn').map(({ id, ordinal, meaningId, card, firstRecallTaskId }) => ({
      id, meaningId, ordinal, clientCard: card, firstRecallTaskId,
    })),
  };
}

function toClientStep(step: PlannedStep) {
  if (step.kind === 'learn') return { type: 'learn', id: step.id, card: step.card };
  return { type: 'practice', phase: step.phase, task: { id: step.id, ...step.task.clientPayload } };
}
