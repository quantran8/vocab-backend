import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, isNull, lte, max, or, sql } from 'drizzle-orm';
import { ENTITLEMENT_SOURCE, ENTITLEMENT_STATUS } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { DB, Db, Executor } from '../../../db/db';
import { appStoreNotifications, appUsers, redeemCodeUses, redeemCodes, userEntitlements, userLearningScope, userMeaningProgress } from '../../../db/schema';
import type { EntitlementUpdate } from '../domain/appstore';
import type { EntitlementRow } from '../domain/entitlement';
import { redeemExpiry } from '../domain/entitlement';

export interface NotificationRecord {
  notificationUuid: string;
  notificationType: string;
  subtype: string | null;
  environment: string | null;
  originalTransactionId: string | null;
  signedAt: Date;
}

export interface NewRedeemCode {
  code: string;
  durationDays: number;
  maxUses: number;
  expiresAt: Date | null;
  note: string | null;
}

@Injectable()
export class EntitlementRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  entitlements(userId: string): Promise<EntitlementRow[]> {
    return this.db
      .select({
        source: userEntitlements.source, status: userEntitlements.status, expiresAt: userEntitlements.expiresAt,
        productId: userEntitlements.productId, autoRenew: userEntitlements.autoRenew,
      })
      .from(userEntitlements)
      .where(eq(userEntitlements.userId, userId));
  }

  async scopeCollectionId(userId: string): Promise<string | null> {
    const [row] = await this.db.select({ collectionId: userLearningScope.collectionId }).from(userLearningScope).where(eq(userLearningScope.userId, userId));
    return row?.collectionId ?? null;
  }

  /** Every Meaning the learner has started, custom words and "I know this" included. */
  async learnedCount(userId: string) {
    const [{ n }] = await this.db.select({ n: count() }).from(userMeaningProgress).where(eq(userMeaningProgress.userId, userId));
    return n;
  }

  async transactionOwner(originalTransactionId: string, db: Executor = this.db) {
    const [row] = await db.select({ userId: userEntitlements.userId }).from(userEntitlements)
      .where(eq(userEntitlements.originalTransactionId, originalTransactionId));
    return row?.userId ?? null;
  }

  async userExists(userId: string, db: Executor = this.db) {
    const [row] = await db.select({ id: appUsers.id }).from(appUsers).where(eq(appUsers.id, userId));
    return !!row;
  }

  /** Inserts or moves the subscription to `userId`; a payload older than the stored one changes nothing. */
  async upsertAppStore(userId: string, update: EntitlementUpdate, now: Date, db: Executor = this.db) {
    const values = { ...update, userId, source: ENTITLEMENT_SOURCE.APPSTORE, updatedAt: now };
    await db.insert(userEntitlements).values(values).onConflictDoUpdate({
      target: userEntitlements.originalTransactionId,
      set: {
        userId, productId: update.productId, environment: update.environment, status: update.status, expiresAt: update.expiresAt,
        autoRenew: sql`COALESCE(excluded.auto_renew, ${userEntitlements.autoRenew})`, signedAt: update.signedAt, updatedAt: now,
      },
      setWhere: or(isNull(userEntitlements.signedAt), lte(userEntitlements.signedAt, update.signedAt)),
    });
  }

  /** Runs `apply` once per notification UUID: a redelivery finds the row and skips it. */
  async onceForNotification(record: NotificationRecord, apply: (tx: Executor) => Promise<void>) {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.insert(appStoreNotifications).values(record).onConflictDoNothing().returning({ id: appStoreNotifications.notificationUuid });
      if (inserted.length === 0) return false;
      await apply(tx);
      return true;
    });
  }

  async redeem(userId: string, code: string, now: Date) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(redeemCodes).where(eq(redeemCodes.code, code)).for('update');
      if (!row || row.disabledAt) throw new ApiError('REDEEM_INVALID');
      if (row.expiresAt && row.expiresAt <= now) throw new ApiError('REDEEM_EXPIRED');
      const [used] = await tx.select({ code: redeemCodeUses.code }).from(redeemCodeUses)
        .where(and(eq(redeemCodeUses.code, code), eq(redeemCodeUses.userId, userId)));
      if (used) throw new ApiError('REDEEM_ALREADY_USED');
      if (row.usedCount >= row.maxUses) throw new ApiError('REDEEM_EXHAUSTED');

      const [{ until }] = await tx.select({ until: max(userEntitlements.expiresAt) }).from(userEntitlements)
        .where(and(eq(userEntitlements.userId, userId), eq(userEntitlements.source, ENTITLEMENT_SOURCE.REDEEM), eq(userEntitlements.status, ENTITLEMENT_STATUS.ACTIVE)));
      const expiresAt = redeemExpiry(until ?? null, row.durationDays, now);
      await tx.insert(redeemCodeUses).values({ code, userId, redeemedAt: now });
      await tx.update(redeemCodes).set({ usedCount: sql`${redeemCodes.usedCount} + 1` }).where(eq(redeemCodes.code, code));
      await tx.insert(userEntitlements).values({
        userId, source: ENTITLEMENT_SOURCE.REDEEM, status: ENTITLEMENT_STATUS.ACTIVE, expiresAt, redeemCode: code, updatedAt: now,
      });
      return expiresAt;
    });
  }

  async createCode(code: NewRedeemCode) {
    const rows = await this.db.insert(redeemCodes).values(code).onConflictDoNothing().returning();
    if (rows.length === 0) throw new ApiError('REDEEM_CODE_EXISTS');
    return rows[0];
  }

  listCodes(limit: number, offset: number) {
    return this.db.select().from(redeemCodes).orderBy(desc(redeemCodes.createdAt)).limit(limit).offset(offset);
  }

  async disableCode(code: string, now: Date) {
    const [row] = await this.db.update(redeemCodes).set({ disabledAt: now }).where(eq(redeemCodes.code, code)).returning();
    if (!row) throw new ApiError('NOT_FOUND', 'Redeem code not found');
    return row;
  }
}
