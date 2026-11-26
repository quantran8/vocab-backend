import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { ApiError } from '../../../common/http/api-error';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { isUuid } from '../../../common/ids';
import { AppConfig } from '../../../config/app-config';
import { Executor } from '../../../db/db';
import { ourLineItem, playEntitlementFrom, type PlaySubscription } from '../domain/playstore';
import { developerNotificationSchema, pubSubPushSchema } from '../dto/entitlement.schemas';
import { GooglePlayClient } from '../providers/google-play.client';
import { PubSubPushVerifier } from '../providers/pubsub-push.verifier';
import { EntitlementRepository } from '../repositories/entitlement.repository';
import { EntitlementService } from './entitlement.service';

const pushPipe = new ZodPipe(pubSubPushSchema, 'VALIDATION_FAILED');

@Injectable()
export class PlayStoreService {
  private readonly logger = new Logger(PlayStoreService.name);

  constructor(
    private readonly repository: EntitlementRepository,
    private readonly entitlements: EntitlementService,
    private readonly play: GooglePlayClient,
    private readonly push: PubSubPushVerifier,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /**
   * The app sends every purchase Play Billing reports (new, restored, renewed) and acknowledges it only after
   * this answers, so the server never acknowledges. Ownership follows the App Store rules: the first account
   * keeps the subscription, another live account gets 409, a deleted account frees it.
   */
  async syncPurchase(userId: string, purchaseToken: string, productId: string) {
    if (!this.config.playStoreProductIds.includes(productId)) throw new ApiError('PLAYSTORE_PURCHASE_INVALID', 'Unknown product');
    const sub = await this.play.subscription(this.config.playStorePackageName, purchaseToken);
    if (!sub) throw new ApiError('PLAYSTORE_PURCHASE_INVALID', 'Unknown purchase token');
    const item = ourLineItem(sub, this.config.playStoreProductIds);
    if (!item) throw new ApiError('PLAYSTORE_PURCHASE_INVALID', 'Unknown product');
    const now = this.clock.now();
    const update = playEntitlementFrom(sub, item, purchaseToken, now);
    // A pending purchase grants nothing yet; its notification or the next sync stores it.
    if (!update) return this.entitlements.plan(userId, now);

    const owner = await this.repository.transactionOwner(purchaseToken);
    if (owner && owner !== userId) throw new ApiError('PLAYSTORE_PURCHASE_OWNED');
    const accountId = accountIdOf(sub);
    if (accountId && accountId !== userId && (await this.repository.userExists(accountId))) throw new ApiError('PLAYSTORE_PURCHASE_OWNED');
    await this.repository.upsertPlayStore(userId, update, sub.linkedPurchaseToken ?? null, now);
    return this.entitlements.plan(userId, now);
  }

  /**
   * Real-time Developer Notifications through a Pub/Sub push. Answers 200 once handled, seen or ignored;
   * a Google API failure answers 503 so Pub/Sub delivers it again.
   */
  async handleNotification(authorization: string | undefined, body: unknown) {
    await this.push.verify(authorization);
    const { message } = pushPipe.transform(body);
    const notification = decodeData(message.data);
    if (!notification) {
      this.logger.warn(`Unreadable Play notification ${message.messageId}`);
      return { applied: false };
    }
    if (notification.packageName !== this.config.playStorePackageName) {
      this.logger.warn(`Play notification ${message.messageId} for another package`);
      return { applied: false };
    }
    const subscription = notification.subscriptionNotification;
    const token = subscription?.purchaseToken ?? null;
    // Read before recording the message, so a failure here is retried.
    const sub = token ? await this.play.subscription(this.config.playStorePackageName, token) : null;
    const eventMs = notification.eventTimeMillis ?? (message.publishTime ? Date.parse(message.publishTime) : this.clock.now().getTime());

    const applied = await this.repository.onceForPlayNotification({
      messageId: message.messageId,
      notificationType: subscription?.notificationType ?? null,
      purchaseToken: token,
      eventAt: new Date(eventMs),
    }, async (db) => {
      if (!token || !sub) return;
      const item = ourLineItem(sub, this.config.playStoreProductIds);
      const now = this.clock.now();
      const update = item && playEntitlementFrom(sub, item, token, now, subscription?.notificationType ?? null);
      if (!update) return;
      const userId = await this.ownerFor(token, sub, db);
      if (!userId) {
        // Bought on an account that never synced it: the app's next sync links it.
        this.logger.warn(`No account for Play purchase token ${token.slice(0, 12)}…`);
        return;
      }
      await this.repository.upsertPlayStore(userId, update, sub.linkedPurchaseToken ?? null, now, db);
    });
    return { applied };
  }

  private async ownerFor(token: string, sub: PlaySubscription, db: Executor) {
    const owner = await this.repository.transactionOwner(token, db);
    if (owner) return owner;
    const accountId = accountIdOf(sub);
    return accountId && (await this.repository.userExists(accountId, db)) ? accountId : null;
  }
}

/** The app launches billing with `obfuscatedAccountId` = the user id. */
function accountIdOf(sub: PlaySubscription) {
  const id = sub.externalAccountIdentifiers?.obfuscatedExternalAccountId;
  return id && isUuid(id) ? id : null;
}

function decodeData(data: string) {
  try {
    const parsed = developerNotificationSchema.safeParse(JSON.parse(Buffer.from(data, 'base64').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
