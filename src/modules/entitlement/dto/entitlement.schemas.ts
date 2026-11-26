import { z } from 'zod';

export const appStoreSyncSchema = z.strictObject({ signedTransaction: z.string().min(1).max(20_000) });

export const appStoreNotificationSchema = z.object({ signedPayload: z.string().min(1).max(100_000) });

export const playStoreSyncSchema = z.strictObject({ purchaseToken: z.string().min(1).max(4096), productId: z.string().min(1).max(200) });

/** A Pub/Sub push; Pub/Sub also sends snake_case copies and attributes, which are dropped. */
export const pubSubPushSchema = z.object({
  message: z.object({ data: z.string().max(100_000).default(''), messageId: z.string().min(1).max(200), publishTime: z.iso.datetime({ offset: true }).optional() }),
  subscription: z.string().max(500).optional(),
});

/** DeveloperNotification, the JSON inside `message.data`. */
export const developerNotificationSchema = z.object({
  packageName: z.string(),
  eventTimeMillis: z.coerce.number().int().nonnegative().optional(),
  subscriptionNotification: z.object({ notificationType: z.number().int(), purchaseToken: z.string().min(1).max(4096), subscriptionId: z.string().optional() }).optional(),
});

export const redeemSchema = z.strictObject({ code: z.string().trim().min(1).max(64) });

export const createRedeemCodeSchema = z.strictObject({
  code: z.string().trim().regex(/^[A-Za-z0-9-]{4,64}$/),
  durationDays: z.number().int().min(1).max(3650),
  maxUses: z.number().int().min(1).default(1),
  expiresAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)).nullable().default(null),
  note: z.string().trim().max(500).nullable().default(null),
});

export const listRedeemCodesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
});
