import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { SESSION_STATUS, TEMPLATE, VALIDITY } from '../../../common/constants/domain';
import { addHours } from '../../../common/constants/time';
import { ApiError } from '../../../common/http/api-error';
import { POLICY } from '../../../config/policy';
import { toDate } from '../../../db/db';
import { SpeechProvider } from '../providers/speech.provider';
import { SpeechRepository } from '../repositories/speech.repository';

interface AudioUpload {
  buffer: Buffer;
  mimetype: string;
}

@Injectable()
export class SpeechService {
  constructor(
    private readonly repository: SpeechRepository,
    private readonly provider: SpeechProvider,
    private readonly clock: Clock,
  ) {}

  async assess(userId: string, sessionId: string, taskId: string, audio: AudioUpload | undefined) {
    if (!audio?.buffer.length) throw new ApiError('INVALID_SUBMISSION', 'Audio is required');

    const task = await this.repository.findTask(sessionId, taskId);
    if (!task) throw new ApiError('NOT_FOUND', 'Task not found');
    if (task.ownerId !== userId) throw new ApiError('SESSION_NOT_OWNED');
    if (task.template !== TEMPLATE.RECORDING) throw new ApiError('INVALID_SUBMISSION', 'Not a recording task');

    const now = this.clock.now();
    if (task.status === SESSION_STATUS.COMMITTED) throw new ApiError('SESSION_STALE', 'Session already committed');
    if (task.status === SESSION_STATUS.EXPIRED || toDate(task.expiresAt) <= now) throw new ApiError('SESSION_EXPIRED');

    if (task.maxRetries !== null && task.attemptsUsed > task.maxRetries) throw new ApiError('INVALID_SUBMISSION', 'Attempt limit exceeded');

    const { referenceText, referenceLocale } = task.serverEvaluation;
    if (!referenceText || !referenceLocale) throw new ApiError('TASK_DATA_INVALID', 'Recording has no reference');

    // Audio stays in memory only and is dropped after this call; never inside a DB transaction.
    const result = await this.provider.assess({ audio: audio.buffer, contentType: audio.mimetype, referenceText, locale: referenceLocale });

    const valid = result.validity === VALIDITY.VALID;
    const passed = valid ? (result.accuracyScore ?? 0) >= POLICY.speech.passAccuracy : null;
    const receiptId = await this.repository.insertReceipt({
      sessionId,
      taskId,
      validity: result.validity,
      passed,
      accuracyScore: result.accuracyScore,
      providerMeta: result.meta,
      assessedAt: now,
      expiresAt: addHours(now, POLICY.speech.receiptTtlHours),
    });
    return { assessmentReceiptId: receiptId, validity: result.validity, passed, accuracyScore: result.accuracyScore };
  }
}
