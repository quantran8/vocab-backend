import { ENTITLEMENT_STATUS, PLAYSTORE_ENVIRONMENT, type EntitlementStatus } from '../../../common/constants/domain';
import type { EntitlementUpdate } from './appstore';

/** purchases.subscriptionsv2 SubscriptionPurchaseV2: only the fields the server reads. */
export interface PlaySubscription {
  subscriptionState?: string;
  linkedPurchaseToken?: string;
  testPurchase?: object;
  lineItems?: PlayLineItem[];
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
}

export interface PlayLineItem {
  productId: string;
  expiryTime?: string;
  autoRenewingPlan?: { autoRenewEnabled?: boolean };
}

export const SUBSCRIPTION_STATE = {
  PENDING: 'SUBSCRIPTION_STATE_PENDING',
  ACTIVE: 'SUBSCRIPTION_STATE_ACTIVE',
  PAUSED: 'SUBSCRIPTION_STATE_PAUSED',
  IN_GRACE_PERIOD: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  ON_HOLD: 'SUBSCRIPTION_STATE_ON_HOLD',
  CANCELED: 'SUBSCRIPTION_STATE_CANCELED',
  EXPIRED: 'SUBSCRIPTION_STATE_EXPIRED',
  PENDING_PURCHASE_CANCELED: 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED',
} as const;

/** SubscriptionNotification.notificationType values of Real-time Developer Notifications. */
export const PLAY_NOTIFICATION = {
  RECOVERED: 1,
  RENEWED: 2,
  CANCELED: 3,
  PURCHASED: 4,
  ON_HOLD: 5,
  IN_GRACE_PERIOD: 6,
  RESTARTED: 7,
  PRICE_CHANGE_CONFIRMED: 8,
  DEFERRED: 9,
  PAUSED: 10,
  PAUSE_SCHEDULE_CHANGED: 11,
  REVOKED: 12,
  EXPIRED: 13,
  PENDING_PURCHASE_CANCELED: 20,
} as const;

const STATUS_BY_STATE: Record<string, EntitlementStatus> = {
  [SUBSCRIPTION_STATE.ACTIVE]: ENTITLEMENT_STATUS.ACTIVE,
  [SUBSCRIPTION_STATE.CANCELED]: ENTITLEMENT_STATUS.ACTIVE,
  [SUBSCRIPTION_STATE.IN_GRACE_PERIOD]: ENTITLEMENT_STATUS.GRACE,
  [SUBSCRIPTION_STATE.ON_HOLD]: ENTITLEMENT_STATUS.EXPIRED,
  [SUBSCRIPTION_STATE.PAUSED]: ENTITLEMENT_STATUS.EXPIRED,
  [SUBSCRIPTION_STATE.EXPIRED]: ENTITLEMENT_STATUS.EXPIRED,
};

const expiryOf = (item: PlayLineItem) => (item.expiryTime ? Date.parse(item.expiryTime) || 0 : 0);

/** The line item of ours that runs the longest, or null when the subscription holds none of our products. */
export function ourLineItem(sub: PlaySubscription, productIds: readonly string[]): PlayLineItem | null {
  return (sub.lineItems ?? []).filter((i) => productIds.includes(i.productId))
    .reduce<PlayLineItem | null>((best, i) => (!best || expiryOf(i) > expiryOf(best) ? i : best), null);
}

/**
 * The entitlement a Play subscription describes, or null when it grants nothing yet (pending, unknown state).
 * The state is read live from Google, so `checkedAt` orders it against what is stored.
 */
export function playEntitlementFrom(
  sub: PlaySubscription, item: PlayLineItem, purchaseToken: string, checkedAt: Date, notificationType: number | null = null,
): EntitlementUpdate | null {
  const mapped = sub.subscriptionState ? STATUS_BY_STATE[sub.subscriptionState] : undefined;
  if (!mapped) return null;
  const canceled = sub.subscriptionState === SUBSCRIPTION_STATE.CANCELED;
  const autoRenew = item.autoRenewingPlan?.autoRenewEnabled;
  return {
    productId: item.productId,
    originalTransactionId: purchaseToken,
    environment: sub.testPurchase ? PLAYSTORE_ENVIRONMENT.SANDBOX : PLAYSTORE_ENVIRONMENT.PRODUCTION,
    status: notificationType === PLAY_NOTIFICATION.REVOKED ? ENTITLEMENT_STATUS.REVOKED : mapped,
    expiresAt: new Date(expiryOf(item)),
    autoRenew: canceled ? false : autoRenew ?? null,
    signedAt: checkedAt,
  };
}
