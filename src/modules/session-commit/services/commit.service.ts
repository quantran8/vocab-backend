import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { SESSION_MODE, SESSION_STATUS } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { newId } from '../../../common/ids';
import { Tx } from '../../../db/db';
import { CheckpointService } from '../../checkpoint/services/checkpoint.service';
import { MemoryDraft } from '../../memory-srs/memory-reducer';
import { applyDailyDue, applyNonDaily, initialState, SrsState } from '../../memory-srs/srs';
import { CommitBody } from '../../practice-evaluator/events';
import { canonicalHash } from '../domain/canonical';
import { CommitRepository, ProgressRow } from '../repositories/commit.repository';
import { evaluateBatch, EvaluatedTask, evidenceDrafts, memoryDrafts, sessionResult, TargetRow } from '../domain/commit-evaluator';

@Injectable()
export class CommitService {
  constructor(
    private readonly repository: CommitRepository,
    private readonly clock: Clock,
    private readonly checkpoints: CheckpointService,
  ) {}

  commit(userId: string, sessionId: string, body: CommitBody) {
    const requestHash = canonicalHash(body);
    return this.repository.transaction((tx) => this.run(tx, userId, sessionId, body, requestHash));
  }

  async status(userId: string, sessionId: string) {
    const session = await this.repository.findStatus(sessionId);
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

  // Round trips are the commit's cost: lock, one read, one write (plus the challenge update for checkpoint, and challenge generation after Daily new words).
  private async run(tx: Tx, userId: string, sessionId: string, body: CommitBody, requestHash: string) {
    await this.repository.lockUser(tx, userId);
    const now = this.clock.now();
    const session = await this.repository.loadSession(tx, userId, sessionId, now);

    if (!session) throw new ApiError('NOT_FOUND', 'Session not found');
    if (session.userId !== userId) throw new ApiError('SESSION_NOT_OWNED');
    if (session.status === SESSION_STATUS.COMMITTED) {
      if (session.commitRequestSha256 === requestHash) return session.commitResponse;
      throw new ApiError('SESSION_PAYLOAD_CONFLICT');
    }
    if (session.status === SESSION_STATUS.EXPIRED || session.expiresAt <= now) throw new ApiError('SESSION_EXPIRED');

    const { tasks, targets, steps } = session;
    const receiptMap = new Map(session.receipts.map((r) => [r.id, r]));
    const evaluated = evaluateBatch(body, tasks, targets, steps, receiptMap);
    const memory = memoryDrafts(evaluated, targets);

    const newMeaningIds = steps.map((s) => s.meaningId);
    const progress = session.progress;

    // First commit wins; a stale concurrent plan is rejected whole, never merged (C14).
    if (newMeaningIds.some((id) => progress.has(id))) throw new ApiError('SESSION_STALE', 'A Meaning was already learned');

    if (session.mode === SESSION_MODE.CHECKPOINT_CHALLENGE) {
      await this.completeChallenge(tx, { id: sessionId, userId, scopeSnapshot: session.scopeSnapshot });
    }

    const newStates = this.applySrs(session.mode, memory, newMeaningIds, progress, now);
    const summary = {
      newWordGoalSlots: steps.length,
      reviewedMeanings: session.mode === SESSION_MODE.DAILY ? memory.length - steps.length : 0,
      practiceTasks: tasks.length,
    };
    const response = { sessionId, status: SESSION_STATUS.COMMITTED, committedAt: now.toISOString(), summary };

    await this.write(tx, { userId, sessionId, now, requestHash, response, evaluated, memory, newStates, newMeaningIds, targets, receiptMap });
    if (newMeaningIds.length > 0) await this.checkpoints.generateFor(tx, userId);
    return response;
  }

  private async completeChallenge(tx: Tx, session: { id: string; userId: string; scopeSnapshot: { challengeId?: string } }) {
    const { challengeId } = session.scopeSnapshot;
    if (!challengeId) throw new ApiError('TASK_DATA_INVALID', 'Checkpoint session has no challenge');
    if (!(await this.repository.completeChallenge(tx, challengeId, session.userId, session.id))) throw new ApiError('SESSION_STALE', 'Challenge already completed');
  }

  private applySrs(mode: string, memory: MemoryDraft[], newMeaningIds: string[], progress: Map<string, ProgressRow>, now: Date) {
    const observations = new Map(memory.map((m) => [m.meaningId, m]));
    const states = new Map<string, SrsState>();
    for (const id of newMeaningIds) states.set(id, initialState(observations.get(id), now));
    for (const observation of memory) {
      const current = progress.get(observation.meaningId);
      if (!current) continue;
      const apply = mode === SESSION_MODE.DAILY ? applyDailyDue : applyNonDaily;
      states.set(observation.meaningId, apply(current, observation, now));
    }
    return states;
  }

  private async write(tx: Tx, input: {
    userId: string; sessionId: string; now: Date; requestHash: string; response: object;
    evaluated: EvaluatedTask[]; memory: MemoryDraft[]; newStates: Map<string, SrsState>; newMeaningIds: string[];
    targets: TargetRow[]; receiptMap: Map<string, { assessedAt: Date; accuracyScore: number | null }>;
  }) {
    const { userId, sessionId, now, requestHash, response, evaluated, memory, newStates, newMeaningIds, targets, receiptMap } = input;
    const learnedHere = new Set(newMeaningIds);
    const data = JSON.stringify({
      rawEvents: evaluated.map((e) => ({ taskId: e.task.id, events: e.rawEvents })),
      result: sessionResult(evaluated, targets, receiptMap),
      evidence: evidenceDrafts(evaluated, targets).map((d) => ({
        id: newId(), task_id: d.taskId, target_ordinal: d.targetOrdinal, skill: d.skill, reasons: d.reasons,
        validity: d.validity, passed: d.passed, meaning_id: d.meaningId, pronunciation_id: d.pronunciationId,
        assessed_at: (d.receiptId && receiptMap.get(d.receiptId)?.assessedAt) || now,
        assessment_receipt_id: d.receiptId ?? null, evaluator_version: d.evaluatorVersion,
      })),
      memory: memory.map((m) => ({ meaning_id: m.meaningId, signal: m.signal, is_primed: m.isPrimed, source_task_ids: m.sourceTaskIds })),
      progress: [...newStates].map(([meaningId, state]) => ({
        meaning_id: meaningId,
        learned_at: state.learnedAt,
        learned_session_id: learnedHere.has(meaningId) ? sessionId : null,
        last_reviewed_at: state.lastReviewedAt,
        next_review_at: state.nextReviewAt,
        interval_hours: state.intervalHours,
        unaided_streak: state.unaidedStreak,
        lapse_count: state.lapseCount,
        recognition_grace_used: state.recognitionGraceUsed,
      })),
      consumed: evaluated.flatMap((e) => e.receiptId ?? []),
    });
    await this.repository.writeCommit(tx, { userId, sessionId, now, requestHash, response, data });
  }
}
