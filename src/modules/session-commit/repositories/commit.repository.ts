import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { CHECKPOINT_STATE, SCHEDULER_VERSION, SESSION_STATUS } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';
import { DB, Db, toDate, Tx } from '../../../db/db';
import { checkpointChallenges, learningSessions } from '../../../db/schema';
import { SrsState } from '../../memory-srs/srs';
import { SessionPlan } from '../../session-planner/domain/session-plan';
import { TargetRow } from '../domain/commit-evaluator';

export interface ProgressRow extends SrsState { meaningId: string }
type SrsDates = Pick<SrsState, 'learnedAt' | 'lastReviewedAt' | 'nextReviewAt'>;

@Injectable()
export class CommitRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  transaction<T>(run: (tx: Tx) => Promise<T>) {
    return this.db.transaction(run);
  }

  async findStatus(sessionId: string) {
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
    return session;
  }

  // The user lock serialises a user's commits, so it must be taken before loadSession snapshots progress.
  // The timeout bounds each later statement, including waits on row locks.
  async lockUser(tx: Tx, userId: string) {
    await tx.execute(sql`
      SELECT set_config('statement_timeout', ${String(POLICY.session.commitTimeoutMs)}, true),
             (SELECT id FROM app_user WHERE id = ${userId}::uuid FOR UPDATE)`);
  }

  // One statement reads the session and everything it needs. Progress rows are locked here, so no separate lock query.
  async loadSession(tx: Tx, userId: string, sessionId: string, now: Date) {
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

  async completeChallenge(tx: Tx, challengeId: string, userId: string, sessionId: string) {
    const completed = await tx
      .update(checkpointChallenges)
      .set({ state: CHECKPOINT_STATE.COMPLETED, completedSessionId: sessionId })
      .where(and(eq(checkpointChallenges.id, challengeId), eq(checkpointChallenges.userId, userId), eq(checkpointChallenges.state, CHECKPOINT_STATE.AVAILABLE)))
      .returning({ id: checkpointChallenges.id });
    return completed.length > 0;
  }

  // One statement writes every commit row; FKs are checked at its end, so CTE order does not matter.
  // learned_at is deliberately never overwritten on conflict.
  async writeCommit(tx: Tx, input: { userId: string; sessionId: string; now: Date; requestHash: string; response: object; data: string }) {
    const { userId, sessionId, now, requestHash, response, data } = input;
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
