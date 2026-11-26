import { z } from 'zod';
import {
  CONTENT_REPORT_REASONS, CONTENT_REPORT_SORT, CONTENT_REPORT_SOURCE, CONTENT_REPORT_SOURCE as SOURCE, CONTENT_REPORT_STATUS, CONTENT_REPORT_STATUSES,
} from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';

const { noteMaxChars, excerptMaxChars } = POLICY.contentReport;
// Lengths count Unicode scalars, as Postgres char_length does.
const scalars = (max: number) => z.string().refine((s) => [...s].length <= max, `At most ${max} characters`);
const shortId = z.string().min(1).max(64);

const base = {
  clientReportId: z.uuid(),
  reason: z.enum(CONTENT_REPORT_REASONS),
  note: z.string().trim().pipe(scalars(noteMaxChars)).transform((s) => s || undefined).optional(),
};

export const attemptExcerptSchema = z.strictObject({
  submittedText: scalars(excerptMaxChars).optional(),
  optionId: shortId.optional(),
  tileIds: z.array(shortId).max(excerptMaxChars).optional(),
  receiptId: z.uuid().optional(),
}).refine((e) => Object.values(e).some((v) => v !== undefined), 'attemptExcerpt is empty');

export const submitReportSchema = z.discriminatedUnion('source', [
  z.strictObject({ ...base, source: z.literal(SOURCE.LEARN_CARD), context: z.strictObject({ sessionId: z.uuid(), learnStepId: z.uuid() }) }),
  z.strictObject({
    ...base, source: z.literal(SOURCE.PRACTICE_TASK),
    context: z.strictObject({ sessionId: z.uuid(), taskId: z.uuid(), attemptExcerpt: attemptExcerptSchema.optional() }),
  }),
  z.strictObject({ ...base, source: z.literal(SOURCE.WORD_DETAIL), context: z.strictObject({ meaningId: z.uuid() }) }),
]);
export type SubmitReport = z.infer<typeof submitReportSchema>;

export const listReportsSchema = z.object({
  status: z.enum(CONTENT_REPORT_STATUSES).default(CONTENT_REPORT_STATUS.PENDING),
  reason: z.enum(CONTENT_REPORT_REASONS).optional(),
  source: z.enum(Object.values(CONTENT_REPORT_SOURCE)).optional(),
  locale: z.string().max(32).optional(),
  sort: z.enum(Object.values(CONTENT_REPORT_SORT)).default(CONTENT_REPORT_SORT.OLDEST),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListReports = z.infer<typeof listReportsSchema>;

const CLOSING: string[] = [CONTENT_REPORT_STATUS.RESOLVED, CONTENT_REPORT_STATUS.DISMISSED];
export const transitionSchema = z.strictObject({
  status: z.enum(CONTENT_REPORT_STATUSES),
  note: z.string().trim().min(1).max(2000).optional(),
}).refine((b) => !CLOSING.includes(b.status) || b.note, { message: 'A resolution note is required', path: ['note'] });
