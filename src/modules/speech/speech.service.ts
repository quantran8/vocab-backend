import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Clock } from '../../common/clock';
import { SESSION_STATUS, TEMPLATE, VALIDITY } from '../../common/constants/domain';
import { addHours } from '../../common/constants/time';
import { ApiError } from '../../common/http/api-error';
import { POLICY } from '../../config/policy';
import { DB, Db } from '../../db/db';
import { learningSessions, sessionTasks, speechAssessmentReceipts } from '../../db/schema';
import { ServerEvaluation } from '../practice-resolver/task.types';
import { SpeechProvider } from './speech.provider';

interface AudioUpload {
  buffer: Buffer;
  mimetype: string;
}

@Injectable()
export class SpeechService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly provider: SpeechProvider,
    private readonly clock: Clock,
  ) {}

  async assess(userId: string, sessionId: string, taskId: string, audio: AudioUpload | undefined) {
    if (!audio?.buffer.length) throw new ApiError('INVALID_SUBMISSION', 'Audio is required');

    const [task] = await this.db
      .select({
        template: sessionTasks.template,
        serverEvaluation: sessionTasks.serverEvaluation,
        ownerId: learningSessions.userId,
        status: learningSessions.status,
        expiresAt: learningSessions.expiresAt,
      })
      .from(sessionTasks)
      .innerJoin(learningSessions, eq(learningSessions.id, sessionTasks.sessionId))
      .where(and(eq(sessionTasks.sessionId, sessionId), eq(sessionTasks.id, taskId)));
    if (!task) throw new ApiError('NOT_FOUND', 'Task not found');
    if (task.ownerId !== userId) throw new ApiError('SESSION_NOT_OWNED');
    if (task.template !== TEMPLATE.recording) throw new ApiError('INVALID_SUBMISSION', 'Not a recording task');

    const now = this.clock.now();
    if (task.status === SESSION_STATUS.committed) throw new ApiError('SESSION_STALE', 'Session already committed');
    if (task.status === SESSION_STATUS.expired || task.expiresAt <= now) throw new ApiError('SESSION_EXPIRED');

    const { referenceText, referenceLocale } = task.serverEvaluation as ServerEvaluation;
    if (!referenceText || !referenceLocale) throw new ApiError('TASK_DATA_INVALID', 'Recording has no reference');

    // Audio stays in memory only and is dropped after this call; never inside a DB transaction.
    const result = await this.provider.assess({ audio: audio.buffer, contentType: audio.mimetype, referenceText, locale: referenceLocale });

    const valid = result.validity === VALIDITY.valid;
    const passed = valid ? (result.accuracyScore ?? 0) >= POLICY.speech.passAccuracy : null;
    const [receipt] = await this.db
      .insert(speechAssessmentReceipts)
      .values({
        sessionId,
        taskId,
        validity: result.validity,
        passed,
        accuracyScore: result.accuracyScore,
        providerMeta: result.meta,
        assessedAt: now,
        expiresAt: addHours(now, POLICY.speech.receiptTtlHours),
      })
      .returning({ id: speechAssessmentReceipts.id });
    return { assessmentReceiptId: receipt.id, validity: result.validity, passed, accuracyScore: result.accuracyScore };
  }
}
