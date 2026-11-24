import { ENTITLEMENT_SOURCE, ENTITLEMENT_STATUS } from '../../../common/constants/domain';
import { entitlementFrom, NOTIFICATION, type AppStoreTransaction } from './appstore';
import { AppleJwsError, verifyAppleJws } from './apple-jws';
import { currentEntitlement, freeRemaining, normalizeCode, planView, redeemExpiry, type EntitlementRow } from './entitlement';

const now = new Date('2026-11-20T00:00:00Z');
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const row = (over: Partial<EntitlementRow> = {}): EntitlementRow => ({
  source: ENTITLEMENT_SOURCE.APPSTORE, status: ENTITLEMENT_STATUS.ACTIVE, expiresAt: days(10), productId: 'syll.premium.monthly', autoRenew: true, ...over,
});
const free = { enabled: true, maxTopics: 3, maxNewWords: 150, newWordsUsed: 40 };

describe('planView', () => {
  it('is Premium while an active or grace entitlement has not expired, keeping the longest', () => {
    const redeem = row({ source: ENTITLEMENT_SOURCE.REDEEM, expiresAt: days(30), productId: null, autoRenew: null });
    expect(currentEntitlement([row(), redeem], now)).toBe(redeem);
    expect(planView([row({ status: ENTITLEMENT_STATUS.GRACE })], now, free)).toMatchObject({ tier: 'premium', limits: null });
  });
  it('ignores expired, revoked and past entitlements', () => {
    const rows = [row({ status: ENTITLEMENT_STATUS.REVOKED }), row({ status: ENTITLEMENT_STATUS.EXPIRED }), row({ expiresAt: days(-1) })];
    expect(planView(rows, now, free)).toEqual({
      tier: 'free', premiumUntil: null, source: null, productId: null, autoRenew: null, limits: { maxTopics: 3, maxNewWords: 150, newWordsUsed: 40 },
    });
  });
  it('sets no limits while freemium is off', () => {
    const plan = planView([], now, { ...free, enabled: false });
    expect(plan).toMatchObject({ tier: 'free', limits: null });
    expect(freeRemaining(plan)).toBeNull();
  });
  it('never reports a negative allowance', () => {
    expect(freeRemaining(planView([], now, { ...free, newWordsUsed: 200 }))).toBe(0);
    expect(freeRemaining(planView([], now, free))).toBe(110);
  });
});

describe('redeemExpiry', () => {
  it('adds the days after redeemed time still left, else from now', () => {
    expect(redeemExpiry(null, 30, now)).toEqual(days(30));
    expect(redeemExpiry(days(5), 30, now)).toEqual(days(35));
    expect(redeemExpiry(days(-5), 30, now)).toEqual(days(30));
  });
  it('normalizes codes', () => {
    expect(normalizeCode('  syll-ab 12 ')).toBe('SYLL-AB12');
  });
});

describe('entitlementFrom', () => {
  const tx: AppStoreTransaction = {
    transactionId: '2', originalTransactionId: '1', bundleId: 'b', productId: 'p', expiresDate: days(30).getTime(), environment: 'Sandbox', signedDate: now.getTime(),
  };
  it('is active until the expiry, with auto-renew from the renewal info', () => {
    expect(entitlementFrom(tx, { originalTransactionId: '1', autoRenewStatus: 0, signedDate: now.getTime() + 1 }, NOTIFICATION.DID_CHANGE_RENEWAL_STATUS)).toEqual({
      productId: 'p', originalTransactionId: '1', environment: 'Sandbox', status: 'active', expiresAt: days(30), autoRenew: false, signedAt: new Date(now.getTime() + 1),
    });
  });
  it('extends into the grace period', () => {
    const grace = { originalTransactionId: '1', gracePeriodExpiresDate: days(46).getTime(), signedDate: now.getTime() };
    expect(entitlementFrom(tx, grace, NOTIFICATION.DID_FAIL_TO_RENEW)).toMatchObject({ status: 'grace', expiresAt: days(46) });
  });
  it('closes on expiry and revocation', () => {
    expect(entitlementFrom(tx, null, NOTIFICATION.EXPIRED).status).toBe('expired');
    expect(entitlementFrom(tx, null, NOTIFICATION.GRACE_PERIOD_EXPIRED).status).toBe('expired');
    expect(entitlementFrom({ ...tx, revocationDate: now.getTime() }, null, NOTIFICATION.REFUND).status).toBe('revoked');
  });
});

describe('verifyAppleJws', () => {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const jws = (payload: object, header: object = { alg: 'ES256' }) => `${b64(header)}.${b64(payload)}.c2ln`;
  const options = { rootFingerprints: ['00'], now, allowXcode: false };

  it('rejects anything that is not a JWS', async () => {
    await expect(verifyAppleJws('nope', options)).rejects.toBeInstanceOf(AppleJwsError);
  });
  it('rejects a payload without the Apple certificate chain', async () => {
    await expect(verifyAppleJws(jws({ environment: 'Production' }), options)).rejects.toThrow('Unexpected JWS header');
    await expect(verifyAppleJws(jws({ environment: 'Production' }, { alg: 'ES256', x5c: ['AA', 'AA', 'AA'] }), options)).rejects.toBeInstanceOf(AppleJwsError);
  });
  it('decodes Xcode StoreKit testing payloads only when allowed', async () => {
    const xcode = jws({ environment: 'Xcode', productId: 'p' });
    await expect(verifyAppleJws(xcode, options)).rejects.toBeInstanceOf(AppleJwsError);
    await expect(verifyAppleJws(xcode, { ...options, allowXcode: true })).resolves.toMatchObject({ productId: 'p' });
    await expect(verifyAppleJws(jws({ data: { environment: 'Xcode' } }), { ...options, allowXcode: true })).resolves.toBeTruthy();
    await expect(verifyAppleJws(jws({ environment: 'Sandbox' }), { ...options, allowXcode: true })).rejects.toBeInstanceOf(AppleJwsError);
  });
});
