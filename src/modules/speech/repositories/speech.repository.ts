import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, Db } from '../../../db/db';
import { speechAssessmentReceipts } from '../../../db/schema';
import { ServerEvaluation } from '../../practice-resolver/task.types';

export type RecordingTask = {
  template: string;
  serverEvaluation: ServerEvaluation;
  maxRetries: number | null;
  attemptsUsed: number;
  ownerId: string;
  status: string;
  expiresAt: string;
};

@Injectable()
export class SpeechRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findTask(sessionId: string, taskId: string) {
    const { rows: [task] } = await this.db.execute<RecordingTask>(sql`
      SELECT t->>'template' AS template, t->'serverEvaluation' AS "serverEvaluation",
             (t->'clientPayload'->>'maxRetries')::int AS "maxRetries",
             (SELECT count(*)::int FROM speech_assessment_receipts r WHERE r.session_id = s.id AND r.task_id = ${taskId}::uuid) AS "attemptsUsed",
             s.user_id AS "ownerId", s.status, s.expires_at AS "expiresAt"
      FROM learning_sessions s, jsonb_array_elements(s.plan->'tasks') t
      WHERE s.id = ${sessionId}::uuid AND t->>'id' = ${taskId}::text`);
    return task;
  }

  async insertReceipt(receipt: typeof speechAssessmentReceipts.$inferInsert) {
    const [row] = await this.db.insert(speechAssessmentReceipts).values(receipt).returning({ id: speechAssessmentReceipts.id });
    return row.id;
  }
}
