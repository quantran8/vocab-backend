import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { Clock } from '../../common/clock';
import { SCHEDULER_VERSION, SESSION_MODE, SESSION_STATUS, WEEKLY_STATE } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { newId } from '../../common/ids';
import { POLICY } from '../../config/policy';
import { DB, Db, Tx } from '../../db/db';
import {
  appUsers, learningSessions, memoryObservations, practiceTargetResults, practiceTaskResults, sessionLearnSteps, sessionTasks,
  sessionTaskTargets, skillEvidence, speechAssessmentReceipts, userMeaningProgress, weeklyChallenges,
} from '../../db/schema';
import { MemoryDraft } from '../memory-srs/memory-reducer';
import { applyDailyDue, applyNonDaily, initialState, SrsState } from '../memory-srs/srs';
import { CommitBody } from '../practice-evaluator/events';
import { canonicalHash } from './canonical';
import { evaluateBatch, EvaluatedTask, evidenceDrafts, memoryDrafts } from './commit-evaluator';

interface ProgressRow extends SrsState { meaningId: string }

@Injectable()
export class CommitService {
  constructor(@Inject(DB) private readonly db: Db, private readonly clock: Clock) {}

  commit(userId: string, sessionId: string, body: CommitBody) {
    const requestHash = canonicalHash(body);
    return this.db.transaction(async (tx) => {
      // Bounds each statement, including waits on row locks, like the old interactive-transaction timeout.
      await tx.execute(sql`SELECT set_config('statement_timeout', ${String(POLICY.session.commitTimeoutMs)}, true)`);
      return this.run(tx, userId, sessionId, body, requestHash);
    });
  }

  async status(userId: string, sessionId: string) {
    const [session] = await this.db
      .select({
        userId: learningSessions.userId,
        status: learningSessions.status,
        committedAt: learningSessions.committedAt,
        expiresAt: learningSessions.expiresAt,
        commitResponse: learningSessions.commitResponse,
      })
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId));
    if (!session) throw new ApiError('NOT_FOUND', 'Session not found');
    if (session.userId !== userId) throw new ApiError('SESSION_NOT_OWNED');
    return {
      sessionId,
      status: session.status,
      committedAt: session.committedAt,
      expiresAt: session.expiresAt,
      response: session.commitResponse,
    };
  }

  private async run(tx: Tx, userId: string, sessionId: string, body: CommitBody, requestHash: string) {
    // Fixed lock order (user, then session) prevents deadlocks between a user's commits.
    await tx.select({ id: appUsers.id }).from(appUsers).where(eq(appUsers.id, userId)).for('update');
    const [session] = await tx
      .select({
        id: learningSessions.id,
        userId: learningSessions.userId,
        mode: learningSessions.mode,
        status: learningSessions.status,
        expiresAt: learningSessions.expiresAt,
        scopeSnapshot: learningSessions.scopeSnapshot,
        commitRequestSha256: learningSessions.commitRequestSha256,
        commitResponse: learningSessions.commitResponse,
      })
      .from(learningSessions)
      .where(eq(learningSessions.id, sessionId))
      .for('update');

    if (!session) throw new ApiError('NOT_FOUND', 'Session not found');
    if (session.userId !== userId) throw new ApiError('SESSION_NOT_OWNED');
    if (session.status === SESSION_STATUS.committed) {
      if (session.commitRequestSha256 === requestHash) return session.commitResponse;
      throw new ApiError('SESSION_PAYLOAD_CONFLICT');
    }

    const now = this.clock.now();
    if (session.status === SESSION_STATUS.expired || session.expiresAt <= now) throw new ApiError('SESSION_EXPIRED');

    // Sequential: a transaction owns one connection, so concurrent queries would only queue on it.
    const tasks = await tx
      .select({
        id: sessionTasks.id,
        ordinal: sessionTasks.ordinal,
        phase: sessionTasks.phase,
        template: sessionTasks.template,
        clientPayload: sessionTasks.clientPayload,
        serverEvaluation: sessionTasks.serverEvaluation,
        evaluatorVersion: sessionTasks.evaluatorVersion,
      })
      .from(sessionTasks)
      .where(eq(sessionTasks.sessionId, sessionId))
      .orderBy(asc(sessionTasks.ordinal));
    const targets = await tx
      .select({
        taskId: sessionTaskTargets.taskId,
        ordinal: sessionTaskTargets.ordinal,
        meaningId: sessionTaskTargets.meaningId,
        pronunciationId: sessionTaskTargets.pronunciationId,
      })
      .from(sessionTaskTargets)
      .where(eq(sessionTaskTargets.sessionId, sessionId));
    const steps = await tx
      .select({ id: sessionLearnSteps.id, meaningId: sessionLearnSteps.meaningId, firstRecallTaskId: sessionLearnSteps.firstRecallTaskId })
      .from(sessionLearnSteps)
      .where(eq(sessionLearnSteps.sessionId, sessionId));
    const receipts = await tx
      .select({
        id: speechAssessmentReceipts.id,
        taskId: speechAssessmentReceipts.taskId,
        validity: speechAssessmentReceipts.validity,
        passed: speechAssessmentReceipts.passed,
        assessedAt: speechAssessmentReceipts.assessedAt,
      })
      .from(speechAssessmentReceipts)
      .where(and(
        eq(speechAssessmentReceipts.sessionId, sessionId),
        isNull(speechAssessmentReceipts.consumedAt),
        gt(speechAssessmentReceipts.expiresAt, now),
      ));

    const receiptMap = new Map(receipts.map((r) => [r.id, r]));
    const evaluated = evaluateBatch(body, tasks, targets, steps, receiptMap);
    const memory = memoryDrafts(evaluated, targets);

    const newMeaningIds = steps.map((s) => s.meaningId);
    const meaningIds = [...new Set([...newMeaningIds, ...memory.map((m) => m.meaningId)])];
    const progress = await this.lockProgress(tx, userId, meaningIds);

    // First commit wins; a stale concurrent plan is rejected whole, never merged (C14).
    if (newMeaningIds.some((id) => progress.has(id))) throw new ApiError('SESSION_STALE', 'A Meaning was already learned');

    if (session.mode === SESSION_MODE.weeklyChallenge) {
      await this.completeChallenge(tx, session);
    }

    const newStates = this.applySrs(session.mode, memory, newMeaningIds, progress, now);
    const summary = {
      newWordGoalSlots: steps.length,
      reviewedMeanings: session.mode === SESSION_MODE.daily ? memory.length - steps.length : 0,
      practiceTasks: tasks.length,
    };
    const response = { sessionId, status: SESSION_STATUS.committed, committedAt: now.toISOString(), summary };

    await this.writeResults(tx, userId, sessionId, evaluated, now);
    await this.writeEvidence(tx, userId, sessionId, evidenceDrafts(evaluated, targets), receiptMap, now);
    await this.writeProgress(tx, userId, newStates);
    if (memory.length > 0) {
      await tx.insert(memoryObservations).values(memory.map((m) => ({ ...m, sessionId, userId, observedAt: now })));
    }
    const consumed = evaluated.flatMap((e) => e.receiptId ?? []);
    if (consumed.length > 0) {
      await tx.update(speechAssessmentReceipts).set({ consumedAt: now }).where(inArray(speechAssessmentReceipts.id, consumed));
    }
    await tx
      .update(learningSessions)
      .set({ status: SESSION_STATUS.committed, committedAt: now, commitRequestSha256: requestHash, commitResponse: response })
      .where(eq(learningSessions.id, sessionId));
    return response;
  }

  private async lockProgress(tx: Tx, userId: string, meaningIds: string[]) {
    if (meaningIds.length === 0) return new Map<string, ProgressRow>();
    const rows = await tx
      .select({
        meaningId: userMeaningProgress.meaningId,
        learnedAt: userMeaningProgress.learnedAt,
        lastReviewedAt: userMeaningProgress.lastReviewedAt,
        nextReviewAt: userMeaningProgress.nextReviewAt,
        intervalHours: userMeaningProgress.intervalHours,
        unaidedStreak: userMeaningProgress.unaidedStreak,
        lapseCount: userMeaningProgress.lapseCount,
        recognitionGraceUsed: userMeaningProgress.recognitionGraceUsed,
      })
      .from(userMeaningProgress)
      .where(and(eq(userMeaningProgress.userId, userId), inArray(userMeaningProgress.meaningId, meaningIds)))
      .for('update');
    return new Map<string, ProgressRow>(rows.map((r) => [r.meaningId, r]));
  }

  private async completeChallenge(tx: Tx, session: { id: string; userId: string; scopeSnapshot: { challengeId?: string } }) {
    const { challengeId } = session.scopeSnapshot;
    if (!challengeId) throw new ApiError('TASK_DATA_INVALID', 'Weekly session has no challenge');
    const completed = await tx
      .update(weeklyChallenges)
      .set({ state: WEEKLY_STATE.completed, completedSessionId: session.id })
      .where(and(eq(weeklyChallenges.id, challengeId), eq(weeklyChallenges.userId, session.userId), eq(weeklyChallenges.state, WEEKLY_STATE.available)))
      .returning({ id: weeklyChallenges.id });
    if (completed.length === 0) throw new ApiError('SESSION_STALE', 'Challenge already completed');
  }

  private applySrs(mode: string, memory: MemoryDraft[], newMeaningIds: string[], progress: Map<string, ProgressRow>, now: Date) {
    const observations = new Map(memory.map((m) => [m.meaningId, m]));
    const states = new Map<string, SrsState>();
    for (const id of newMeaningIds) states.set(id, initialState(observations.get(id), now));
    for (const observation of memory) {
      const current = progress.get(observation.meaningId);
      if (!current) continue;
      const apply = mode === SESSION_MODE.daily ? applyDailyDue : applyNonDaily;
      states.set(observation.meaningId, apply(current, observation, now));
    }
    return states;
  }

  private async writeResults(tx: Tx, userId: string, sessionId: string, evaluated: EvaluatedTask[], committedAt: Date) {
    if (evaluated.length === 0) return;
    await tx.insert(practiceTaskResults).values(
      evaluated.map((e) => ({
        sessionId,
        taskId: e.task.id,
        userId,
        rawEvents: e.rawEvents,
        normalizedResult: { deliveryMode: e.deliveryMode, targets: e.targets },
        committedAt,
      })),
    );
    const targetRows = evaluated.flatMap((e) =>
      e.targets.map((t) => ({
        sessionId,
        taskId: e.task.id,
        targetOrdinal: t.ordinal,
        outcome: t.outcome,
        firstAttemptCorrect: t.firstAttemptCorrect,
        attemptCount: t.attemptCount,
        hintCount: t.hintCount,
        deliveryMode: e.deliveryMode,
      })),
    );
    if (targetRows.length > 0) await tx.insert(practiceTargetResults).values(targetRows);
  }

  private async writeEvidence(
    tx: Tx,
    userId: string,
    sessionId: string,
    drafts: ReturnType<typeof evidenceDrafts>,
    receipts: Map<string, { assessedAt: Date }>,
    committedAt: Date,
  ) {
    if (drafts.length === 0) return;
    await tx.insert(skillEvidence).values(
      drafts.map(({ receiptId, ...draft }) => ({
        ...draft,
        id: newId(),
        userId,
        sessionId,
        assessmentReceiptId: receiptId,
        assessedAt: (receiptId && receipts.get(receiptId)?.assessedAt) || committedAt,
        committedAt,
      })),
    );
  }

  // One statement for all rows; learned_at is deliberately never overwritten.
  private async writeProgress(tx: Tx, userId: string, states: Map<string, SrsState>) {
    if (states.size === 0) return;
    const rows = JSON.stringify(
      [...states].map(([meaningId, state]) => ({
        meaning_id: meaningId,
        learned_at: state.learnedAt,
        last_reviewed_at: state.lastReviewedAt,
        next_review_at: state.nextReviewAt,
        interval_hours: state.intervalHours,
        unaided_streak: state.unaidedStreak,
        lapse_count: state.lapseCount,
        recognition_grace_used: state.recognitionGraceUsed,
      })),
    );
    await tx.execute(sql`
      INSERT INTO user_meaning_progress (
        user_id, meaning_id, learned_at, last_reviewed_at, next_review_at, interval_hours,
        unaided_streak, lapse_count, recognition_grace_used, scheduler_version)
      SELECT ${userId}::uuid, x.meaning_id, x.learned_at, x.last_reviewed_at, x.next_review_at, x.interval_hours,
             x.unaided_streak, x.lapse_count, x.recognition_grace_used, ${SCHEDULER_VERSION}::varchar
      FROM jsonb_to_recordset(${rows}::jsonb) AS x(
        meaning_id uuid, learned_at timestamptz, last_reviewed_at timestamptz, next_review_at timestamptz,
        interval_hours numeric, unaided_streak int, lapse_count int, recognition_grace_used boolean)
      ON CONFLICT (user_id, meaning_id) DO UPDATE SET
        last_reviewed_at = EXCLUDED.last_reviewed_at,
        next_review_at = EXCLUDED.next_review_at,
        interval_hours = EXCLUDED.interval_hours,
        unaided_streak = EXCLUDED.unaided_streak,
        lapse_count = EXCLUDED.lapse_count,
        recognition_grace_used = EXCLUDED.recognition_grace_used,
        scheduler_version = EXCLUDED.scheduler_version,
        version = user_meaning_progress.version + 1`);
  }
}
