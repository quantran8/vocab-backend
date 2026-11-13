import { z } from 'zod';
import { LEADERBOARD_VIEW, REPORT_REASONS, REPORT_RESOLUTIONS, REPORT_STATUS } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';

// Shape only: username format and the avatar allowlist answer with their own codes (spec §9.3).
export const profileSchema = z
  .strictObject({ username: z.string().max(64).optional(), avatarKey: z.string().max(64).optional() })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const leaderboardQuerySchema = z.object({ view: z.enum(Object.values(LEADERBOARD_VIEW)).default(LEADERBOARD_VIEW.TOP) });

export const historyQuerySchema = z.object({
  weeks: z.coerce.number().int().min(1).max(POLICY.ranking.historyWeeks).default(POLICY.ranking.historyWeeks),
});

export const reportSchema = z.strictObject({ username: z.string().min(1).max(64), reason: z.enum(REPORT_REASONS) });

export const listReportsSchema = z.object({
  status: z.enum(Object.values(REPORT_STATUS)).default(REPORT_STATUS.OPEN),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
});

export const resolveReportSchema = z.strictObject({ resolution: z.enum(REPORT_RESOLUTIONS) });

export const eligibilitySchema = z.strictObject({ eligible: z.boolean(), reason: z.string().trim().min(1).max(500) });
