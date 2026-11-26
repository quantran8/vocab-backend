import { ENTITLEMENT_STATUS } from '../../../common/constants/domain';
import { ourLineItem, PLAY_NOTIFICATION, playEntitlementFrom, SUBSCRIPTION_STATE, type PlaySubscription } from './playstore';

const now = new Date('2026-11-20T00:00:00Z');
const PRODUCTS = ['syll.premium.monthly', 'syll.premium.yearly'];
const EXPIRY = '2026-12-20T00:00:00.000Z';
const sub = (over: Partial<PlaySubscription> = {}): PlaySubscription => ({
  subscriptionState: SUBSCRIPTION_STATE.ACTIVE,
  lineItems: [{ productId: 'syll.premium.monthly', expiryTime: EXPIRY, autoRenewingPlan: { autoRenewEnabled: true } }],
  ...over,
});
const map = (s: PlaySubscription, type: number | null = null) => playEntitlementFrom(s, ourLineItem(s, PRODUCTS)!, 'token-1', now, type);

describe('ourLineItem', () => {
  it('keeps our product that runs the longest and ignores others', () => {
    const s = sub({ lineItems: [
      { productId: 'other', expiryTime: '2030-01-01T00:00:00Z' },
      { productId: 'syll.premium.monthly', expiryTime: EXPIRY },
      { productId: 'syll.premium.yearly', expiryTime: '2027-11-20T00:00:00Z' },
    ] });
    expect(ourLineItem(s, PRODUCTS)?.productId).toBe('syll.premium.yearly');
    expect(ourLineItem(sub({ lineItems: [{ productId: 'other' }] }), PRODUCTS)).toBeNull();
    expect(ourLineItem(sub({ lineItems: undefined }), PRODUCTS)).toBeNull();
  });
});

describe('playEntitlementFrom', () => {
  it('maps an active subscription', () => {
    expect(map(sub())).toEqual({
      productId: 'syll.premium.monthly', originalTransactionId: 'token-1', environment: 'production', status: ENTITLEMENT_STATUS.ACTIVE,
      expiresAt: new Date(EXPIRY), autoRenew: true, signedAt: now,
    });
  });

  it('keeps a canceled subscription until it expires, without renewal', () => {
    expect(map(sub({ subscriptionState: SUBSCRIPTION_STATE.CANCELED }))).toMatchObject({ status: ENTITLEMENT_STATUS.ACTIVE, autoRenew: false, expiresAt: new Date(EXPIRY) });
  });

  it('maps grace, hold, pause and expiry', () => {
    expect(map(sub({ subscriptionState: SUBSCRIPTION_STATE.IN_GRACE_PERIOD }))?.status).toBe(ENTITLEMENT_STATUS.GRACE);
    for (const state of [SUBSCRIPTION_STATE.ON_HOLD, SUBSCRIPTION_STATE.PAUSED, SUBSCRIPTION_STATE.EXPIRED]) {
      expect(map(sub({ subscriptionState: state }))?.status).toBe(ENTITLEMENT_STATUS.EXPIRED);
    }
  });

  it('grants nothing for a pending purchase or an unknown state', () => {
    for (const state of [SUBSCRIPTION_STATE.PENDING, SUBSCRIPTION_STATE.PENDING_PURCHASE_CANCELED, 'SUBSCRIPTION_STATE_UNSPECIFIED', undefined]) {
      expect(map(sub({ subscriptionState: state }))).toBeNull();
    }
  });

  it('marks test purchases as sandbox and a revocation as revoked', () => {
    expect(map(sub({ testPurchase: {} }))?.environment).toBe('sandbox');
    expect(map(sub({ subscriptionState: SUBSCRIPTION_STATE.EXPIRED }), PLAY_NOTIFICATION.REVOKED)?.status).toBe(ENTITLEMENT_STATUS.REVOKED);
  });

  it('leaves auto-renew unknown when Google omits the plan', () => {
    expect(map(sub({ lineItems: [{ productId: 'syll.premium.monthly', expiryTime: EXPIRY }] }))?.autoRenew).toBeNull();
  });
});
