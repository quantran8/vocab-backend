import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { Clock } from '../../common/clock';
import { SCHEDULER_VERSION, SESSION_MODE, SESSION_STATUS, CHECKPOINT_STATE } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { newId } from '../../common/ids';
import { POLICY } from '../../config/policy';
import { DB, Db, toDate, Tx } from '../../db/db';
import { learningSessions, checkpointChallenges } from '../../db/schema';
import { CheckpointService } from '../checkpoint/checkpoint.service';
import { MemoryDraft } from '../memory-srs/memory-reducer';
import { applyDailyDue, applyNonDaily, initialState, SrsState } from '../memory-srs/srs';
import { CommitBody } from '../practice-evaluator/events';
import { SessionPlan } from '../session-planner/session-plan';
import { canonicalHash } from './canonical';
import { evaluateBatch, EvaluatedTask, evidenceDrafts, memoryDrafts, sessionResult, TargetRow } from './commit-evaluator';

interface ProgressRow extends SrsState { meaningId: string }
type SrsDates = Pick<SrsState, 'learnedAt' | 'lastReviewedAt' | 'nextReviewAt'>;

@Injectable()
export class CommitService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly clock: Clock,
    private readonly checkpoints: CheckpointService,
  ) {}

  commit(userId: string, sessionId: string, body: CommitBody) {
    const requestHash = canonicalHash(body);
    return this.db.transaction((tx) => this.run(tx, userId, sessionId, body, requestHash));
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

  // Round trips are the commit's cost: lock, one read, one write (plus the challenge update for checkpoint, and challenge generation after Daily new words).
  private async run(tx: Tx, userId: string, sessionId: string, body: CommitBody, requestHash: string) {
    // The user lock serialises a user's commits, so it must be taken before the read below snapshots progress.
    // The timeout bounds each later statement, including waits on row locks.
    await tx.execute(sql`
      SELECT set_config('statement_timeout', ${String(POLICY.session.commitTimeoutMs)}, true),
             (SELECT id FROM app_user WHERE id = ${userId}::uuid FOR UPDATE)`);
    const now = this.clock.now();
    const session = await this.loadSession(tx, userId, sessionId, now);

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

  // One statement reads the session and everything it needs. Progress rows are locked here, so no separate lock query.
  private async loadSession(tx: Tx, userId: string, sessionId: string, now: Date) {
    const { rows } = await tx.execute<{
      userId: string; mode: string; status: string; expiresAt: string; scopeSnapshot: { challengeId?: string };
      commitRequestSha256: string | null; commitResponse: unknown;
      plan: SessionPlan | null;
      receipts: { id: string; taskId: string; validity: string; passed: boolean | null; accuracyScore: number | null; assessedAt: string }[];
      progress: (Omit<ProgressRow, keyof SrsDates> & Record<keyof SrsDates, string | null>)[];
    }>(sql`
      SELECT s.user_id AS "userId", s.mode, s.status, s.expires_at AS "expiresAt", s.scope_snapshot AS "scopeSnapshot",
        s.commit_request_sha256 AS "commitRequestSha256", s.commit_response AS "commitResponse",
        s.plan,
        COALESCE((SELECT json_agg(json_build_object(
            'id', r.id, 'taskId', r.task_id, 'validity', r.validity, 'passed', r.passed,
            'accuracyScore', r.accuracy_score, 'assessedAt', r.assessed_at))
          FROM speech_assessment_receipts r
          WHERE r.session_id = s.id AND r.consumed_at IS NULL AND r.expires_at > ${now}::timestamptz), '[]'::json) AS receipts,
        COALESCE((SELECT json_agg(json_build_object(
            'meaningId', p.meaning_id, 'learnedAt', p.learned_at, 'lastReviewedAt', p.last_reviewed_at, 'nextReviewAt', p.next_review_at,
            'intervalHours', p.interval_hours, 'unaidedStreak', p.unaided_streak, 'lapseCount', p.lapse_count,
            'recognitionGraceUsed', p.recognition_grace_used))
          FROM (
            SELECT * FROM user_meaning_progress
            WHERE user_id = ${userId}::uuid AND meaning_id IN (
              SELECT (g->>'meaningId')::uuid
              FROM jsonb_array_elements(s.plan->'tasks') t, jsonb_array_elements(t->'targets') g
              WHERE g->>'meaningId' IS NOT NULL
              UNION SELECT (l->>'meaningId')::uuid FROM jsonb_array_elements(s.plan->'learnSteps') l)
            FOR UPDATE) p), '[]'::json) AS progress
      FROM learning_sessions s
      WHERE s.id = ${sessionId}::uuid
      FOR UPDATE OF s`);
    const row = rows[0];
    if (!row) return undefined;
    const date = (v: string | null) => (v === null ? null : toDate(v));
    const tasks = row.plan?.tasks ?? [];
    return {
      ...row,
      tasks,
      targets: tasks.flatMap((t) => t.targets.map((target): TargetRow => ({ taskId: t.id, ...target }))),
      steps: row.plan?.learnSteps ?? [],
      expiresAt: toDate(row.expiresAt),
      receipts: row.receipts.map((r) => ({ ...r, assessedAt: toDate(r.assessedAt) })),
      progress: new Map<string, ProgressRow>(row.progress.map((p) => [p.meaningId, {
        ...p,
        learnedAt: toDate(p.learnedAt!),
        lastReviewedAt: date(p.lastReviewedAt),
        nextReviewAt: toDate(p.nextReviewAt!),
      }])),
    };
  }

  private async completeChallenge(tx: Tx, session: { id: string; userId: string; scopeSnapshot: { challengeId?: string } }) {
    const { challengeId } = session.scopeSnapshot;
    if (!challengeId) throw new ApiError('TASK_DATA_INVALID', 'Checkpoint session has no challenge');
    const completed = await tx
      .update(checkpointChallenges)
      .set({ state: CHECKPOINT_STATE.COMPLETED, completedSessionId: session.id })
      .where(and(eq(checkpointChallenges.id, challengeId), eq(checkpointChallenges.userId, session.userId), eq(checkpointChallenges.state, CHECKPOINT_STATE.AVAILABLE)))
      .returning({ id: checkpointChallenges.id });
    if (completed.length === 0) throw new ApiError('SESSION_STALE', 'Challenge already completed');
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

  // One statement writes every commit row; FKs are checked at its end, so CTE order does not matter.
  // learned_at is deliberately never overwritten on conflict.
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
    await tx.execute(sql`
      WITH p AS (SELECT ${data}::jsonb AS d),
      evidence AS (
        INSERT INTO skill_evidence (id, user_id, session_id, task_id, target_ordinal, skill, reasons, validity, passed,
          meaning_id, pronunciation_id, assessed_at, committed_at, assessment_receipt_id, evaluator_version)
        SELECT x.id, ${userId}::uuid, ${sessionId}::uuid, x.task_id, x.target_ordinal, x.skill, x.reasons, x.validity, x.passed,
          x.meaning_id, x.pronunciation_id, x.assessed_at, ${now}::timestamptz, x.assessment_receipt_id, x.evaluator_version
        FROM p, jsonb_to_recordset(p.d->'evidence') AS x(
          id uuid, task_id uuid, target_ordinal smallint, skill varchar, reasons jsonb, validity varchar, passed boolean,
          meaning_id uuid, pronunciation_id uuid, assessed_at timestamptz, assessment_receipt_id uuid, evaluator_version varchar)
      ), observations AS (
        INSERT INTO memory_observations (session_id, user_id, meaning_id, signal, is_primed, source_task_ids, observed_at)
        SELECT ${sessionId}::uuid, ${userId}::uuid, x.meaning_id, x.signal, x.is_primed, x.source_task_ids, ${now}::timestamptz
        FROM p, jsonb_to_recordset(p.d->'memory') AS x(meaning_id uuid, signal varchar, is_primed boolean, source_task_ids jsonb)
      ), progress AS (
        INSERT INTO user_meaning_progress (
          user_id, meaning_id, learned_at, learned_session_id, last_reviewed_at, next_review_at, interval_hours,
          unaided_streak, lapse_count, recognition_grace_used, scheduler_version)
        SELECT ${userId}::uuid, x.meaning_id, x.learned_at, x.learned_session_id, x.last_reviewed_at, x.next_review_at, x.interval_hours,
               x.unaided_streak, x.lapse_count, x.recognition_grace_used, ${SCHEDULER_VERSION}::varchar
        FROM p, jsonb_to_recordset(p.d->'progress') AS x(
          meaning_id uuid, learned_at timestamptz, learned_session_id uuid, last_reviewed_at timestamptz, next_review_at timestamptz,
          interval_hours numeric, unaided_streak int, lapse_count int, recognition_grace_used boolean)
        ON CONFLICT (user_id, meaning_id) DO UPDATE SET
          last_reviewed_at = EXCLUDED.last_reviewed_at,
          next_review_at = EXCLUDED.next_review_at,
          interval_hours = EXCLUDED.interval_hours,
          unaided_streak = EXCLUDED.unaided_streak,
          lapse_count = EXCLUDED.lapse_count,
          recognition_grace_used = EXCLUDED.recognition_grace_used,
          scheduler_version = EXCLUDED.scheduler_version,
          version = user_meaning_progress.version + 1
      ), consumed AS (
        UPDATE speech_assessment_receipts SET consumed_at = ${now}::timestamptz
        WHERE id IN (SELECT jsonb_array_elements_text(p.d->'consumed')::uuid FROM p)
      )
      UPDATE learning_sessions
      SET status = ${SESSION_STATUS.COMMITTED}, committed_at = ${now}::timestamptz,
          commit_request_sha256 = ${requestHash}, commit_response = ${JSON.stringify(response)}::jsonb,
          raw_events = p.d->'rawEvents', result = p.d->'result'
      FROM p
      WHERE id = ${sessionId}::uuid`);
  }
}
