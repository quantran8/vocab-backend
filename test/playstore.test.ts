import { eq } from 'drizzle-orm';
import { ApiError } from '../src/common/http/api-error';
import { PLAY_NOTIFICATION, SUBSCRIPTION_STATE, type PlaySubscription } from '../src/modules/entitlement/domain/playstore';
import { playStoreNotifications, userEntitlements } from '../src/db/schema';
import { createHarness, Harness, PLAY_PACKAGE, PUSH_TOKEN } from './support/app';

const DAY = 86_400_000;
const PRODUCT = 'syll.premium.monthly';
const FLAGS = { FREEMIUM_ENABLED: 'true', FREE_MAX_TOPICS: '2', FREE_MAX_NEW_WORDS: '3' };

describe('Google Play subscriptions', () => {
  let h: Harness;
  let auth: string;
  let userId: string;

  const api = (method: 'get' | 'post' | 'delete', path: string, token = auth) => h.http()[method](path).set('Authorization', `Bearer ${token}`);
  const me = async (token = auth) => (await api('get', '/v1/me', token).expect(200)).body;
  const sync = (purchaseToken = 'token-1', token = auth, productId = PRODUCT) =>
    api('post', '/v1/me/subscriptions/playstore', token).send({ purchaseToken, productId });
  const subscription = (over: Partial<PlaySubscription> = {}): PlaySubscription => ({
    subscriptionState: SUBSCRIPTION_STATE.ACTIVE,
    lineItems: [{ productId: PRODUCT, expiryTime: new Date(h.clock.now().getTime() + 30 * DAY).toISOString(), autoRenewingPlan: { autoRenewEnabled: true } }],
    externalAccountIdentifiers: { obfuscatedExternalAccountId: userId },
    ...over,
  });
  const push = (data: object, messageId = crypto.randomUUID(), authorization = `Bearer ${PUSH_TOKEN}`) =>
    h.http().post('/v1/playstore/notifications').set('Authorization', authorization).send({
      message: { data: Buffer.from(JSON.stringify(data)).toString('base64'), messageId, publishTime: h.clock.now().toISOString() },
      subscription: 'projects/p/subscriptions/play-rtdn',
    });
  const notification = (notificationType: number, purchaseToken = 'token-1', packageName = PLAY_PACKAGE) => ({
    version: '1.0', packageName, eventTimeMillis: String(h.clock.now().getTime()),
    subscriptionNotification: { version: '1.0', notificationType, purchaseToken, subscriptionId: PRODUCT },
  });
  const row = (token = 'token-1') => h.first(userEntitlements, eq(userEntitlements.originalTransactionId, token));

  beforeAll(async () => {
    Object.assign(process.env, FLAGS);
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
    for (const key of Object.keys(FLAGS)) delete process.env[key];
  });
  beforeEach(async () => {
    await h.reset();
    auth = await h.token('play-1');
    userId = (await me()).id;
  });

  describe('sync', () => {
    it('grants Premium from a verified purchase and keeps it with its first account', async () => {
      h.play.subscriptions.set('token-1', subscription({ testPurchase: {} }));
      const { body } = await sync().expect(200);
      expect(body).toMatchObject({ tier: 'premium', source: 'playstore', productId: PRODUCT, autoRenew: true, limits: null });
      expect(await row()).toMatchObject({ source: 'playstore', userId, environment: 'sandbox', status: 'active' });

      const other = await h.token('play-2');
      expect((await sync('token-1', other).expect(409)).body.code).toBe('PLAYSTORE_PURCHASE_OWNED');
    });

    it('refuses unknown products, unknown tokens and other packages', async () => {
      h.play.subscriptions.set('token-1', subscription({ lineItems: [{ productId: 'other.product', expiryTime: new Date(h.clock.now().getTime() + DAY).toISOString() }] }));
      expect((await sync().expect(422)).body.code).toBe('PLAYSTORE_PURCHASE_INVALID');
      expect((await sync('token-1', auth, 'other.product').expect(422)).body.code).toBe('PLAYSTORE_PURCHASE_INVALID');
      // The fake knows tokens of PLAY_PACKAGE only, as Google answers 404 for another package's token.
      expect((await sync('unknown-token').expect(422)).body.code).toBe('PLAYSTORE_PURCHASE_INVALID');
      await api('post', '/v1/me/subscriptions/playstore').send({ purchaseToken: 'token-1' }).expect(400);
      expect(await h.count(userEntitlements)).toBe(0);
    });

    it('stores nothing for a pending purchase', async () => {
      h.play.subscriptions.set('token-1', subscription({ subscriptionState: SUBSCRIPTION_STATE.PENDING, lineItems: [{ productId: PRODUCT }] }));
      expect((await sync().expect(200)).body).toMatchObject({ tier: 'free' });
      expect(await h.count(userEntitlements)).toBe(0);
    });

    it('refuses a purchase made for another live account', async () => {
      const other = await h.token('play-2');
      const otherId = (await me(other)).id;
      h.play.subscriptions.set('token-1', subscription({ externalAccountIdentifiers: { obfuscatedExternalAccountId: otherId } }));
      expect((await sync().expect(409)).body.code).toBe('PLAYSTORE_PURCHASE_OWNED');
      await sync('token-1', other).expect(200);
    });

    it('frees a subscription when its account is deleted', async () => {
      h.play.subscriptions.set('token-1', subscription());
      await sync().expect(200);
      await api('delete', '/v1/me').expect(200);

      const next = await h.token('play-2');
      expect((await sync('token-1', next).expect(200)).body.tier).toBe('premium');
    });

    it('ends the subscription an upgrade replaced', async () => {
      h.play.subscriptions.set('token-1', subscription());
      await sync().expect(200);
      h.clock.advance(1);
      h.play.subscriptions.set('token-2', subscription({ linkedPurchaseToken: 'token-1', lineItems: [{ productId: 'syll.premium.yearly', expiryTime: new Date(h.clock.now().getTime() + 365 * DAY).toISOString() }] }));
      expect((await sync('token-2').expect(200)).body).toMatchObject({ tier: 'premium', productId: 'syll.premium.yearly' });
      expect((await row('token-1')).status).toBe('expired');
      expect((await row('token-2')).status).toBe('active');
    });

    it('keeps a canceled subscription until it expires', async () => {
      h.play.subscriptions.set('token-1', subscription({ subscriptionState: SUBSCRIPTION_STATE.CANCELED }));
      expect((await sync().expect(200)).body).toMatchObject({ tier: 'premium', autoRenew: false });
      h.clock.advance(31 * 24);
      expect((await me()).plan.tier).toBe('free');
    });

    it('answers 503 while Google cannot be reached', async () => {
      h.play.error = new ApiError('PLAYSTORE_UNAVAILABLE');
      expect((await sync().expect(503)).body).toMatchObject({ code: 'PLAYSTORE_UNAVAILABLE', retryable: true });
    });
  });

  describe('notifications', () => {
    it('refuses a push without the subscription token', async () => {
      await push(notification(PLAY_NOTIFICATION.PURCHASED), undefined, 'Bearer forged').expect(401);
      await h.http().post('/v1/playstore/notifications').send({ message: { data: '', messageId: '1' } }).expect(401);
      expect(await h.count(playStoreNotifications)).toBe(0);
    });

    it('applies a purchase for the account it was made for, once per message', async () => {
      h.play.subscriptions.set('token-1', subscription());
      const id = 'msg-1';
      expect((await push(notification(PLAY_NOTIFICATION.PURCHASED), id).expect(200)).body).toEqual({ applied: true });
      expect((await me()).plan).toMatchObject({ tier: 'premium', source: 'playstore' });
      expect((await push(notification(PLAY_NOTIFICATION.PURCHASED), id).expect(200)).body).toEqual({ applied: false });
      expect(await h.count(playStoreNotifications)).toBe(1);
    });

    it('ends Premium on a revocation', async () => {
      h.play.subscriptions.set('token-1', subscription());
      await sync().expect(200);
      h.clock.advance(1);
      h.play.subscriptions.set('token-1', subscription({ subscriptionState: SUBSCRIPTION_STATE.EXPIRED }));
      await push(notification(PLAY_NOTIFICATION.REVOKED)).expect(200);
      expect((await row()).status).toBe('revoked');
      expect((await me()).plan.tier).toBe('free');
    });

    it('skips a purchase whose account is unknown, and other packages', async () => {
      h.play.subscriptions.set('token-1', subscription({ externalAccountIdentifiers: { obfuscatedExternalAccountId: crypto.randomUUID() } }));
      expect((await push(notification(PLAY_NOTIFICATION.PURCHASED)).expect(200)).body).toEqual({ applied: true });
      expect((await push(notification(PLAY_NOTIFICATION.PURCHASED, 'token-1', 'other.app')).expect(200)).body).toEqual({ applied: false });
      expect(await h.count(userEntitlements)).toBe(0);
      expect(await h.count(playStoreNotifications)).toBe(1);
    });

    it('records test notifications and fails so Pub/Sub retries while Google is down', async () => {
      expect((await push({ version: '1.0', packageName: PLAY_PACKAGE, eventTimeMillis: '1', testNotification: { version: '1.0' } }).expect(200)).body).toEqual({ applied: true });
      h.play.error = new ApiError('PLAYSTORE_UNAVAILABLE');
      await push(notification(PLAY_NOTIFICATION.RENEWED), 'msg-retry').expect(503);
      h.play.error = undefined;
      h.play.subscriptions.set('token-1', subscription());
      expect((await push(notification(PLAY_NOTIFICATION.RENEWED), 'msg-retry').expect(200)).body).toEqual({ applied: true });
      expect((await me()).plan.tier).toBe('premium');
    });
  });
});
