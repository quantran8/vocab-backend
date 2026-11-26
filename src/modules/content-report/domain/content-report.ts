import {
  CONTENT_REPORT_REASON, CONTENT_REPORT_SOURCE, CONTENT_REPORT_STATUS, ContentReportReason, ContentReportSource, ContentReportStatus,
} from '../../../common/constants/domain';

// Rules: docs/content-reports.md
export const OPEN_REPORT_STATUSES: ContentReportStatus[] = [CONTENT_REPORT_STATUS.PENDING, CONTENT_REPORT_STATUS.UNDER_REVIEW];

const { PENDING, UNDER_REVIEW, RESOLVED, DISMISSED } = CONTENT_REPORT_STATUS;
const TRANSITIONS: Record<ContentReportStatus, ContentReportStatus[]> = {
  [PENDING]: [UNDER_REVIEW, RESOLVED, DISMISSED],
  [UNDER_REVIEW]: [PENDING, RESOLVED, DISMISSED],
  [RESOLVED]: [PENDING],
  [DISMISSED]: [PENDING],
};
export const canTransition = (from: ContentReportStatus, to: ContentReportStatus) => TRANSITIONS[from].includes(to);
export const isClosed = (status: ContentReportStatus) => status === RESOLVED || status === DISMISSED;

const TASK_ONLY = new Set<ContentReportReason>([CONTENT_REPORT_REASON.INCORRECT_QUESTION, CONTENT_REPORT_REASON.ANSWER_SHOULD_BE_ACCEPTED]);

/** Why this reason cannot be sent from this source, or null when it can. */
export function reasonProblem(source: ContentReportSource, reason: ContentReportReason, opts: { note?: string; hasAttempt: boolean }) {
  if (TASK_ONLY.has(reason) && source !== CONTENT_REPORT_SOURCE.PRACTICE_TASK) return `${reason} is only for practice tasks`;
  if (reason === CONTENT_REPORT_REASON.ANSWER_SHOULD_BE_ACCEPTED && !opts.hasAttempt) return `${reason} needs attemptExcerpt`;
  if (reason === CONTENT_REPORT_REASON.OTHER && !opts.note) return `${reason} needs a note`;
  return null;
}

export type ReportedMeaning = { meaningId: string; publicationId: string | null };
export type ReportedTask = { template: string; variant: string | null; curatedItemId: string | null };

/** The content revision a report is about; reports with the same key, reason and locale are one group. */
export function reportTarget(meanings: ReportedMeaning[], task?: ReportedTask) {
  const sorted = [...meanings].sort((a, b) => (a.meaningId < b.meaningId ? -1 : 1));
  const publications = sorted.map((m) => m.publicationId ?? '-').join(',');
  if (task?.curatedItemId) return { targetKey: `item:${task.curatedItemId}`, contentVersion: task.curatedItemId };
  if (task) {
    return { targetKey: `task:${task.template}/${task.variant ?? '-'}:${sorted.map((m) => m.meaningId).join(',')}@${publications}`, contentVersion: publications };
  }
  return { targetKey: `meaning:${sorted[0].meaningId}@${publications}`, contentVersion: publications };
}
