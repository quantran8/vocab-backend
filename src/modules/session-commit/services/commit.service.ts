import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { MEMORY_SIGNAL, SESSION_MODE, SESSION_STATUS } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { newId } from '../../../common/ids';
import { Tx } from '../../../db/db';
import { reviewResult } from '../../journey/domain/journey';
import { MemoryDraft } from '../../memory-srs/memory-reducer';
import { applyDailyDue, applyNonDaily, initialKnownState, initialState, SrsState } from '../../memory-srs/srs';
import { CommitBody } from '../../practice-evaluator/events';
import { AppConfig } from '../../../config/app-config';
import { POLICY } from '../../../config/policy';
import { lpAwards } from '../../learning-points/domain/lp-awards';
import { nextTier, tierKey, unlockedBetween } from '../../learning-points/domain/tier';
import { EffortRepository, EffortResult } from '../../learning-points/repositories/effort.repository';
import { canonicalHash } from '../domain/canonical';
import { CommitRepository, ProgressRow } from '../repositories/commit.repository';
import { countedTasks, evaluateBatch, EvaluatedTask, evidenceDrafts, memoryDrafts, sessionResult, TargetRow } from '../domain/commit-evaluator';

// A word marked known with no check has no recall to judge; only a miss in a shared task undoes it.
const SLIP_SIGNALS: string[] = [MEMORY_SIGNAL.FAILED_RECALL, MEMORY_SIGNAL.FAILED_RECOGNITION, MEMORY_SIGNAL.ASSISTED_RECALL];

@Injectable()
export class CommitService {
  constructor(
    private readonly repository: CommitRepository,
    private readonly effort: EffortRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
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

  // Round trips are the commit's cost: lock, one read, the LP write, one write, the backlog settle (plus the challenge update for a legacy checkpoint session).
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
    const { evaluated, known, declared } = evaluateBatch(body, tasks, targets, steps, receiptMap);
    const counted = countedTasks(evaluated, targets, known);
    const memory = memoryDrafts(counted, targets);

    const newMeaningIds = steps.map((s) => s.meaningId);
    const progress = session.progress;

    // First commit wins; a stale concurrent plan is rejected whole, never merged (C14).
    if (newMeaningIds.some((id) => progress.has(id))) throw new ApiError('SESSION_STALE', 'A Meaning was already learned');

    if (session.mode === SESSION_MODE.CHECKPOINT_CHALLENGE) {
      await this.completeChallenge(tx, { id: sessionId, userId, scopeSnapshot: session.scopeSnapshot });
    }

    // LP is judged on the SRS state before this commit (spec §2.1), so it runs ahead of applySrs's write.
    const awards = lpAwards({ mode: session.mode, now, issuedAt: session.issuedAt, evaluated, targets, newMeaningIds, known, progress, ...session.lp });
    const effort = await this.effort.record(tx, { userId, sessionId, awards, now });

    const newStates = this.applySrs(session.mode, memory, newMeaningIds, known, declared, progress, now);
    const learnedHere = new Set(newMeaningIds);
    const summary = {
      newWordGoalSlots: steps.length,
      knownMeanings: known.size,
      reviewedMeanings: session.mode === SESSION_MODE.DAILY ? memory.filter((m) => !learnedHere.has(m.meaningId)).length : 0,
      practiceTasks: tasks.length,
      // No pass mark: the counts only show what came back unaided; SRS already took every answer.
      ...(session.mode === SESSION_MODE.CHECKPOINT_CHALLENGE && {
        checkpoint: reviewResult(memory.length, memory.filter((m) => m.signal === MEMORY_SIGNAL.UNAIDED_RECALL).length),
      }),
    };
    const response = { sessionId, status: SESSION_STATUS.COMMITTED, committedAt: now.toISOString(), summary, ...this.effortResponse(effort, now) };
    const viaTopics = new Map(steps.map((s) => [s.meaningId, s.viaTopicId ?? null]));
    const withScopeEvents = session.mode === SESSION_MODE.DAILY && steps.length > 0;

    const stored = await this.write(tx, { userId, sessionId, now, requestHash, response, evaluated, counted, memory, newStates, newMeaningIds, viaTopics, targets, receiptMap, withScopeEvents });
    await this.repository.settleBacklog(tx, userId, now);
    return stored;
  }

  private effortResponse(effort: EffortResult, now: Date) {
    const next = nextTier(effort.level);
    return {
      lp: { earned: effort.earned, breakdown: effort.breakdown, lpPolicyVersion: POLICY.lp.version, weeklyLP: effort.weeklyLP, lifetimeLP: effort.lifetimeLP },
      tier: {
        level: effort.level,
        key: tierKey(effort.level),
        lifetimeActiveDays: effort.lifetimeActiveDays,
        tierUps: unlockedBetween(effort.oldLevel, effort.level).map((l) => ({ level: l.level, key: l.key, unlockedAt: now.toISOString() })),
        nextTier: next,
      },
      ranking: { weeklyLP: effort.weeklyLP, listed: this.config.rankingEnabled && effort.canList && effort.weeklyLP > 0 },
    };
  }

  private async completeChallenge(tx: Tx, session: { id: string; userId: string; scopeSnapshot: { challengeId?: string } }) {
    const { challengeId } = session.scopeSnapshot;
    if (!challengeId) throw new ApiError('TASK_DATA_INVALID', 'Checkpoint session has no challenge');
    if (!(await this.repository.completeChallenge(tx, challengeId, session.userId, session.id))) throw new ApiError('SESSION_STALE', 'Challenge already completed');
  }

  private applySrs(mode: string, memory: MemoryDraft[], newMeaningIds: string[], known: Set<string>, declared: Set<string>, progress: Map<string, ProgressRow>, now: Date) {
    const observations = new Map(memory.map((m) => [m.meaningId, m]));
    const states = new Map<string, SrsState>();
    for (const id of newMeaningIds) {
      // A later slip in the same session (a shared task) falls back to the normal first schedule.
      const observation = observations.get(id);
      const stillKnown = declared.has(id)
        ? !observation || SLIP_SIGNALS.every((signal) => signal !== observation.signal)
        : known.has(id) && observation?.signal === MEMORY_SIGNAL.UNAIDED_RECALL && !observation.isPrimed;
      states.set(id, stillKnown ? initialKnownState(now) : initialState(observation, now));
    }
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
    evaluated: EvaluatedTask[]; counted: EvaluatedTask[]; memory: MemoryDraft[]; newStates: Map<string, SrsState>; newMeaningIds: string[];
    viaTopics: Map<string, string | null>; withScopeEvents: boolean;
    targets: TargetRow[]; receiptMap: Map<string, { assessedAt: Date; accuracyScore: number | null }>;
  }) {
    const { userId, sessionId, now, requestHash, response, evaluated, counted, memory, newStates, newMeaningIds, viaTopics, withScopeEvents, targets, receiptMap } = input;
    const learnedHere = new Set(newMeaningIds);
    const data = JSON.stringify({
      rawEvents: evaluated.map((e) => ({ taskId: e.task.id, events: e.rawEvents })),
      result: sessionResult(evaluated, targets, receiptMap),
      evidence: evidenceDrafts(counted, targets).map((d) => ({
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
        learned_via_topic_id: learnedHere.has(meaningId) ? viaTopics.get(meaningId) ?? null : null,
        last_reviewed_at: state.lastReviewedAt,
        next_review_at: state.nextReviewAt,
        interval_hours: state.intervalHours,
        unaided_streak: state.unaidedStreak,
        lapse_count: state.lapseCount,
        recognition_grace_used: state.recognitionGraceUsed,
      })),
      consumed: evaluated.flatMap((e) => e.receiptId ?? []),
    });
    return this.repository.writeCommit(tx, { userId, sessionId, now, requestHash, response, data, withScopeEvents });
  }
}
