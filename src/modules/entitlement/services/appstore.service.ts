import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { ENTITLEMENT_SOURCE } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { isUuid } from '../../../common/ids';
import { AppConfig } from '../../../config/app-config';
import { Executor } from '../../../db/db';
import {
  entitlementFrom, HANDLED_NOTIFICATIONS,
  type AppStoreNotification, type AppStoreRenewalInfo, type AppStoreTransaction,
} from '../domain/appstore';
import { AppleJwsError, verifyAppleJws } from '../domain/apple-jws';
import { EntitlementRepository } from '../repositories/entitlement.repository';
import { EntitlementService } from './entitlement.service';

@Injectable()
export class AppStoreService {
  private readonly logger = new Logger(AppStoreService.name);

  constructor(
    private readonly repository: EntitlementRepository,
    private readonly entitlements: EntitlementService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /**
   * The app sends every verified StoreKit transaction (purchase, renewal seen on device, restore).
   * A subscription belongs to the account that first sent it; another live account gets 409.
   * An account that was deleted frees it, so a restore on a new account works.
   */
  async syncTransaction(userId: string, signedTransaction: string) {
    const tx = await this.decode<AppStoreTransaction>(signedTransaction);
    this.assertOurs(tx.bundleId, tx.productId);
    const owner = await this.repository.transactionOwner(tx.originalTransactionId);
    if (owner && owner !== userId) throw new ApiError('APPSTORE_TRANSACTION_OWNED');
    await this.repository.upsertSubscription(userId, ENTITLEMENT_SOURCE.APPSTORE, entitlementFrom(tx, null, null), this.clock.now());
    return this.entitlements.plan(userId);
  }

  /** App Store Server Notifications V2. Answers 200 once handled or already seen; Apple retries anything else. */
  async handleNotification(signedPayload: string) {
    const notification = await this.decode<AppStoreNotification>(signedPayload);
    if (notification.data?.bundleId && notification.data.bundleId !== this.config.appStoreBundleId) {
      throw new ApiError('APPSTORE_TRANSACTION_INVALID', 'Wrong bundle');
    }
    const tx = notification.data?.signedTransactionInfo ? await this.decode<AppStoreTransaction>(notification.data.signedTransactionInfo) : null;
    const renewal = notification.data?.signedRenewalInfo ? await this.decode<AppStoreRenewalInfo>(notification.data.signedRenewalInfo) : null;

    const applied = await this.repository.onceForNotification({
      notificationUuid: notification.notificationUUID,
      notificationType: notification.notificationType,
      subtype: notification.subtype ?? null,
      environment: notification.data?.environment ?? null,
      originalTransactionId: tx?.originalTransactionId ?? null,
      signedAt: new Date(notification.signedDate),
    }, async (db) => {
      if (!tx || !HANDLED_NOTIFICATIONS.has(notification.notificationType)) return;
      if (!this.config.appStoreProductIds.includes(tx.productId) || tx.bundleId !== this.config.appStoreBundleId) return;
      const userId = await this.ownerFor(tx, db);
      if (!userId) {
        // Bought on a device whose account never synced it: the app's next sync links it.
        this.logger.warn(`No account for original transaction ${tx.originalTransactionId}`);
        return;
      }
      await this.repository.upsertSubscription(userId, ENTITLEMENT_SOURCE.APPSTORE, entitlementFrom(tx, renewal, notification.notificationType), this.clock.now(), db);
    });
    return { applied };
  }

  private async ownerFor(tx: AppStoreTransaction, db: Executor) {
    const owner = await this.repository.transactionOwner(tx.originalTransactionId, db);
    if (owner) return owner;
    const token = tx.appAccountToken;
    return token && isUuid(token) && (await this.repository.userExists(token, db)) ? token : null;
  }

  private assertOurs(bundleId: string, productId: string) {
    if (bundleId !== this.config.appStoreBundleId) throw new ApiError('APPSTORE_TRANSACTION_INVALID', 'Wrong bundle');
    if (!this.config.appStoreProductIds.includes(productId)) throw new ApiError('APPSTORE_TRANSACTION_INVALID', 'Unknown product');
  }

  private async decode<T>(jws: string): Promise<T> {
    try {
      return await verifyAppleJws<T>(jws, {
        rootFingerprints: this.config.appStoreRootFingerprints,
        now: this.clock.now(),
        allowXcode: this.config.appStoreAllowXcode,
      });
    } catch (error) {
      if (error instanceof AppleJwsError) throw new ApiError('APPSTORE_TRANSACTION_INVALID', error.message);
      throw error;
    }
  }
}
