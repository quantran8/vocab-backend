import { ENTITLEMENT_STATUS, type EntitlementStatus } from '../../../common/constants/domain';

/** JWSTransactionDecodedPayload: only the fields the server reads. Dates are epoch milliseconds. */
export interface AppStoreTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  appAccountToken?: string;
  environment: string;
  signedDate: number;
  type?: string;
}

/** JWSRenewalInfoDecodedPayload. */
export interface AppStoreRenewalInfo {
  originalTransactionId: string;
  autoRenewStatus?: number;
  gracePeriodExpiresDate?: number;
  signedDate: number;
}

/** ResponseBodyV2DecodedPayload of App Store Server Notifications V2. */
export interface AppStoreNotification {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  signedDate: number;
  data?: {
    bundleId?: string;
    environment?: string;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
}

export const NOTIFICATION = {
  SUBSCRIBED: 'SUBSCRIBED',
  DID_RENEW: 'DID_RENEW',
  DID_CHANGE_RENEWAL_STATUS: 'DID_CHANGE_RENEWAL_STATUS',
  DID_CHANGE_RENEWAL_PREF: 'DID_CHANGE_RENEWAL_PREF',
  DID_FAIL_TO_RENEW: 'DID_FAIL_TO_RENEW',
  GRACE_PERIOD_EXPIRED: 'GRACE_PERIOD_EXPIRED',
  EXPIRED: 'EXPIRED',
  REFUND: 'REFUND',
  REFUND_REVERSED: 'REFUND_REVERSED',
  REVOKE: 'REVOKE',
  OFFER_REDEEMED: 'OFFER_REDEEMED',
  RENEWAL_EXTENDED: 'RENEWAL_EXTENDED',
  TEST: 'TEST',
} as const;

/** Types that change who has Premium; anything else is recorded and otherwise ignored. */
export const HANDLED_NOTIFICATIONS = new Set<string>(Object.values(NOTIFICATION).filter((t) => t !== NOTIFICATION.TEST));

export interface EntitlementUpdate {
  productId: string;
  originalTransactionId: string;
  environment: string;
  status: EntitlementStatus;
  expiresAt: Date;
  autoRenew: boolean | null;
  signedAt: Date;
}

/**
 * The entitlement a transaction (plus its renewal info) describes. The transaction is the truth:
 * a revocation wins, a grace period extends the expiry, and EXPIRED / GRACE_PERIOD_EXPIRED close it.
 */
export function entitlementFrom(tx: AppStoreTransaction, renewal: AppStoreRenewalInfo | null, notificationType: string | null): EntitlementUpdate {
  const expires = tx.expiresDate ?? 0;
  const grace = renewal?.gracePeriodExpiresDate ?? 0;
  let status: EntitlementStatus = ENTITLEMENT_STATUS.ACTIVE;
  if (tx.revocationDate) status = ENTITLEMENT_STATUS.REVOKED;
  else if (notificationType === NOTIFICATION.EXPIRED || notificationType === NOTIFICATION.GRACE_PERIOD_EXPIRED) status = ENTITLEMENT_STATUS.EXPIRED;
  else if (grace > expires) status = ENTITLEMENT_STATUS.GRACE;
  const autoRenew = renewal?.autoRenewStatus === undefined ? null : renewal.autoRenewStatus === 1;
  return {
    productId: tx.productId,
    originalTransactionId: tx.originalTransactionId,
    environment: tx.environment,
    status,
    expiresAt: new Date(Math.max(expires, grace)),
    autoRenew,
    signedAt: new Date(Math.max(tx.signedDate, renewal?.signedDate ?? 0)),
  };
}
