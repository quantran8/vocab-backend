import { Injectable } from '@nestjs/common';
import { AuthUser } from '../../../common/auth/auth.decorators';
import { Clock } from '../../../common/clock';
import { CONTENT_REPORT_SOURCE, ContentReportStatus } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { POLICY } from '../../../config/policy';
import { mapPgErrors } from '../../admin/domain/admin.errors';
import { canonicalHash } from '../../session-commit/domain/canonical';
import { canTransition, reasonProblem, reportTarget, ReportedTask } from '../domain/content-report';
import { ListReports, SubmitReport } from '../dto/content-report.schemas';
import { ContentReportRepository, ResolvedContext } from '../repositories/content-report.repository';

export type SubmitResult = { reportId: string; duplicate: boolean; status: 'received'; replayed: boolean };

// Rules: docs/content-reports.md. Nothing here touches sessions, SRS or LP.
@Injectable()
export class ContentReportService {
  constructor(private readonly repository: ContentReportRepository, private readonly clock: Clock) {}

  async submit(userId: string, body: SubmitReport): Promise<SubmitResult> {
    const requestSha256 = canonicalHash(body);
    const prior = await this.repository.byClientId(userId, body.clientReportId);
    if (prior) return this.replay(prior, requestSha256);

    const context = await this.resolve(userId, body);
    if (!context || context.meanings.length === 0) throw new ApiError('REPORT_CONTEXT_UNAVAILABLE', 'The reported content cannot be found');
    if (context.overridden) throw new ApiError('REPORT_TARGET_OVERRIDDEN', 'Your own edit of this meaning cannot be reported');
    const attemptExcerpt = body.source === CONTENT_REPORT_SOURCE.PRACTICE_TASK ? body.context.attemptExcerpt ?? null : null;
    const problem = reasonProblem(body.source, body.reason, { note: body.note, hasAttempt: !!attemptExcerpt });
    if (problem) throw new ApiError('VALIDATION_FAILED', problem);

    const task = body.source === CONTENT_REPORT_SOURCE.PRACTICE_TASK ? (context.element as unknown as ReportedTask) : undefined;
    const report = {
      reporterId: userId, clientReportId: body.clientReportId, requestSha256, source: body.source, reason: body.reason,
      note: body.note ?? null,
      sessionId: 'sessionId' in body.context ? body.context.sessionId : null,
      taskId: 'taskId' in body.context ? body.context.taskId : null,
      learnStepId: 'learnStepId' in body.context ? body.context.learnStepId : null,
      meaningIds: context.meanings.map((m) => m.meaningId),
      ...reportTarget(context.meanings, task && { template: task.template, variant: task.variant, curatedItemId: task.curatedItemId }),
      explanationLocale: context.locale,
      snapshot: context.element,
      attemptExcerpt,
      now: this.clock.now(),
    };

    // A second pass settles a concurrent send that won the unique index first.
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await this.repository.insert(report);
      if (row.insertedId) return { reportId: row.insertedId, duplicate: false, status: 'received', replayed: false };
      if (row.duplicateId) return { reportId: row.duplicateId, duplicate: true, status: 'received', replayed: false };
      if (row.recent >= POLICY.contentReport.perDay) throw new ApiError('REPORT_LIMIT_REACHED');
      const raced = await this.repository.byClientId(userId, body.clientReportId);
      if (raced) return this.replay(raced, requestSha256);
    }
    throw new ApiError('INTERNAL_ERROR', 'Report could not be stored');
  }

  private replay(prior: { id: string; requestSha256: string }, requestSha256: string): SubmitResult {
    if (prior.requestSha256 !== requestSha256) throw new ApiError('REPORT_IDEMPOTENCY_CONFLICT', 'clientReportId was used for a different report');
    return { reportId: prior.id, duplicate: false, status: 'received', replayed: true };
  }

  private resolve(userId: string, body: SubmitReport): Promise<ResolvedContext | null> {
    switch (body.source) {
      case CONTENT_REPORT_SOURCE.LEARN_CARD:
        return this.repository.sessionContext(userId, body.context.sessionId, 'learnSteps', body.context.learnStepId);
      case CONTENT_REPORT_SOURCE.PRACTICE_TASK:
        return this.repository.sessionContext(userId, body.context.sessionId, 'tasks', body.context.taskId);
      case CONTENT_REPORT_SOURCE.WORD_DETAIL:
        return this.repository.meaningContext(userId, body.context.meaningId);
    }
  }

  async list(query: ListReports) {
    return { items: await this.repository.list(query) };
  }

  async detail(id: string) {
    const row = await this.repository.detail(id);
    if (!row) throw new ApiError('NOT_FOUND', 'Report not found');
    return row;
  }

  async transition(actor: AuthUser, id: string, to: ContentReportStatus, note: string | undefined) {
    const from = await this.repository.status(id);
    if (!from) throw new ApiError('NOT_FOUND', 'Report not found');
    if (!canTransition(from, to)) throw new ApiError('VALIDATION_FAILED', `A ${from} report cannot move to ${to}`);
    const row = await mapPgErrors(
      this.repository.transition({ id, from, to, actorId: actor.id, note: note ?? null, now: this.clock.now() }),
      { unique: 'The reporter already has an open report on this content', uniqueCode: 'CONTENT_LOCKED' },
    );
    if (!row) throw new ApiError('CONTENT_LOCKED', 'The report was changed by someone else; reload it');
    return row;
  }
}
