import { eq } from 'drizzle-orm';
import { CONTENT_STATUS, TEMPLATE } from '../src/common/constants/domain';
import { appStoreNotifications, redeemCodes, topics, userEntitlements } from '../src/db/schema';
import { CAPS, createHarness, Harness, seedWord } from './support/app';
import { answers, tasksOf } from './support/driver';

const words = (n: number, from = 0) => Array.from({ length: n }, (_, i) => seedWord(i + from));
const DAY = 86_400_000;
const PRODUCT = 'syll.premium.monthly';
const BUNDLE = 'com.visiongroup.syll';

// Xcode StoreKit-testing payloads are decoded without a signature check when APPSTORE_ALLOW_XCODE is on.
const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
const jws = (payload: object) => `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(payload)}.c2ln`;

const FLAGS = { FREEMIUM_ENABLED: 'true', REDEEM_ENABLED: 'true', APPSTORE_ALLOW_XCODE: 'true', FREE_MAX_TOPICS: '2', FREE_MAX_NEW_WORDS: '3' };

describe('freemium', () => {
  let h: Harness;
  let auth: string;
  let userId: string;

  const api = (method: 'get' | 'post' | 'put', path: string, token = auth) => h.http()[method](path).set('Authorization', `Bearer ${token}`);
  const me = async (token = auth) => (await api('get', '/v1/me', token).expect(200)).body;
  const plan = async () => (await api('post', '/v1/sessions/plan').send({ mode: 'daily', capabilities: CAPS }).expect(200)).body;
  const transaction = (over: object = {}) => ({
    transactionId: 't-1', originalTransactionId: 'orig-1', bundleId: BUNDLE, productId: PRODUCT, environment: 'Xcode',
    expiresDate: h.clock.now().getTime() + 30 * DAY, signedDate: h.clock.now().getTime(), appAccountToken: userId, ...over,
  });
  const notify = (type: string, tx: object, uuid = crypto.randomUUID(), extra: object = {}) =>
    h.http().post('/v1/appstore/notifications').send({
      signedPayload: jws({
        notificationType: type, notificationUUID: uuid, signedDate: h.clock.now().getTime(),
        data: { bundleId: BUNDLE, environment: 'Xcode', signedTransactionInfo: jws(tx), ...extra },
      }),
    });

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
    auth = await h.token('free-1');
    userId = (await me()).id;
  });

  async function onboard() {
    const seeded = await h.seed('topic-a', words(6));
    await api('put', '/v1/me/levels').send({ proficiencyLevel: 'B1' }).expect(200);
    return [seeded];
  }

  it('reports the free plan and the flags on /me', async () => {
    expect(await me()).toMatchObject({
      plan: { tier: 'free', premiumUntil: null, limits: { maxTopics: 2, maxNewWords: 3, newWordsUsed: 0 } },
      features: { freemiumEnabled: true, redeemEnabled: true, adEverySessions: 3 },
    });
  });

  it('refuses more topics than the free plan allows', async () => {
    const [a] = await onboard();
    const extra = await h.db.insert(topics).values(['b', 'c'].map((slug) => ({ collectionId: a.collectionId, slug, title: slug, status: CONTENT_STATUS.PUBLISHED })))
      .returning({ id: topics.id });
    const topicIds = [a.topicId, ...extra.map((t) => t.id)];
    const res = await api('put', '/v1/me/scope').send({ collectionId: a.collectionId, topicIds }).expect(403);
    expect(res.body.code).toBe('FREE_TOPIC_LIMIT');
    await api('put', '/v1/me/scope').send({ collectionId: a.collectionId, topicIds: topicIds.slice(0, 2) }).expect(200);
  });

  it('keeps a free learner in the first Collection chosen', async () => {
    const [a] = await onboard();
    const b = await h.seed('topic-b', words(2, 10));
    await api('put', '/v1/me/scope').send({ collectionId: a.collectionId, topicIds: [a.topicId] }).expect(200);
    const res = await api('put', '/v1/me/scope').send({ collectionId: b.collectionId, topicIds: [b.topicId] }).expect(403);
    expect(res.body).toMatchObject({ code: 'FREE_COLLECTION_LOCKED', details: { collectionId: a.collectionId } });
    await api('put', '/v1/me/scope').send({ collectionId: a.collectionId, topicIds: [a.topicId] }).expect(200);

    await api('post', '/v1/me/subscriptions/appstore').send({ signedTransaction: jws(transaction()) }).expect(200);
    await api('put', '/v1/me/scope').send({ collectionId: b.collectionId, topicIds: [b.topicId] }).expect(200);
  });

  it('stops new words at the free allowance and says why', async () => {
    const [a] = await onboard();
    await api('put', '/v1/me/scope').send({ collectionId: a.collectionId, topicIds: [a.topicId] }).expect(200);
    const first = await plan();
    expect(first.newWords).toEqual({ requested: 5, issued: 3, withheldReason: 'free_limit' });
    await api('post', `/v1/sessions/${first.sessionId}/commit`).send(answers(first)).expect(200);

    expect((await me()).plan.limits.newWordsUsed).toBe(3);
    const home = (await api('get', '/v1/me/learn-home').expect(200)).body;
    expect(home.freeAllowance).toEqual({ used: 3, max: 3, remaining: 0 });
    expect(home.reviewLoad).toMatchObject({ effectiveNewPerSession: 0, newWordReason: 'free_limit' });
    expect((await plan()).newWords).toMatchObject({ issued: 0, withheldReason: 'free_limit' });
  });

  it('scores recordings on the server only for Premium', async () => {
    const [a] = await onboard();
    await api('put', '/v1/me/scope').send({ collectionId: a.collectionId, topicIds: [a.topicId] }).expect(200);
    await api('put', '/v1/me/settings').send({ dailyNewWordGoal: 1 }).expect(200);
    const p = await plan();
    const recording = tasksOf(p).find((t) => t.template === TEMPLATE.RECORDING);
    expect(recording).toBeDefined();
    const assess = () => api('post', `/v1/sessions/${p.sessionId}/recording-assess`).field('taskId', recording.id)
      .attach('audio', Buffer.from('RIFF'), { filename: 'a.wav', contentType: 'audio/wav' });
    expect((await assess().expect(403)).body.code).toBe('PREMIUM_REQUIRED');

    await api('post', '/v1/me/subscriptions/appstore').send({ signedTransaction: jws(transaction()) }).expect(200);
    await assess().expect(200);
  });

  describe('App Store', () => {
    it('syncs a purchase, lifts the limits, and keeps it with its first account', async () => {
      const { body } = await api('post', '/v1/me/subscriptions/appstore').send({ signedTransaction: jws(transaction()) }).expect(200);
      expect(body).toMatchObject({ tier: 'premium', source: 'appstore', productId: PRODUCT, limits: null });
      expect((await me()).plan.tier).toBe('premium');

      const other = await h.token('free-2');
      const res = await api('post', '/v1/me/subscriptions/appstore', other).send({ signedTransaction: jws(transaction()) }).expect(409);
      expect(res.body.code).toBe('APPSTORE_TRANSACTION_OWNED');
    });

    it('refuses other bundles, unknown products and unsigned production payloads', async () => {
      const sync = (tx: object) => api('post', '/v1/me/subscriptions/appstore').send({ signedTransaction: jws(tx) }).expect(422);
      await sync(transaction({ bundleId: 'other.app' }));
      await sync(transaction({ productId: 'other.product' }));
      await sync(transaction({ environment: 'Production' }));
    });

    it('applies renewals, expiry and refunds from notifications, once each', async () => {
      const uuid = crypto.randomUUID();
      await notify('SUBSCRIBED', transaction(), uuid).expect(200);
      expect((await me()).plan.tier).toBe('premium');
      expect((await notify('SUBSCRIBED', transaction(), uuid).expect(200)).body).toEqual({ applied: false });
      expect(await h.count(appStoreNotifications)).toBe(1);

      h.clock.advance(31 * 24);
      expect((await me()).plan.tier).toBe('free');
      await notify('DID_RENEW', transaction({ transactionId: 't-2', expiresDate: h.clock.now().getTime() + 30 * DAY, signedDate: h.clock.now().getTime() })).expect(200);
      expect((await me()).plan.tier).toBe('premium');

      h.clock.advance(1);
      await notify('REFUND', transaction({ transactionId: 't-2', revocationDate: h.clock.now().getTime(), signedDate: h.clock.now().getTime() })).expect(200);
      expect((await me()).plan.tier).toBe('free');
    });

    it('ignores a payload older than the one already applied', async () => {
      await notify('SUBSCRIBED', transaction()).expect(200);
      h.clock.advance(1);
      await notify('EXPIRED', transaction({ signedDate: h.clock.now().getTime() })).expect(200);
      await notify('DID_RENEW', transaction({ signedDate: h.clock.now().getTime() - 3_600_000 })).expect(200);
      expect((await h.first(userEntitlements)).status).toBe('expired');
    });

    it('records a notification for an account it cannot find', async () => {
      await notify('SUBSCRIBED', transaction({ appAccountToken: crypto.randomUUID() })).expect(200);
      expect(await h.count(userEntitlements)).toBe(0);
      expect(await h.count(appStoreNotifications)).toBe(1);
    });
  });

  describe('redeem codes', () => {
    let adminToken: string;
    beforeEach(async () => { adminToken = await h.token('admin-1', 'admin'); });
    const create = (body: object) => api('post', '/admin/redeem-codes', adminToken).send(body);
    const redeem = (code: string, token = auth) => api('post', '/v1/me/redeem', token).send({ code });

    it('grants Premium for its days and stacks a second code', async () => {
      await create({ code: 'WELCOME-30', durationDays: 30, maxUses: 5 }).expect(201);
      await create({ code: 'bonus-7', durationDays: 7 }).expect(201);
      const first = (await redeem('welcome-30').expect(200)).body;
      expect(first).toMatchObject({ tier: 'premium', source: 'redeem', limits: null });
      expect(new Date(first.premiumUntil).getTime()).toBe(h.clock.now().getTime() + 30 * DAY);
      const second = (await redeem(' BONUS-7 ').expect(200)).body;
      expect(new Date(second.premiumUntil).getTime()).toBe(h.clock.now().getTime() + 37 * DAY);
    });

    it('refuses unknown, reused, used-up, expired and disabled codes', async () => {
      await create({ code: 'ONCE', durationDays: 7, maxUses: 1 }).expect(201);
      await create({ code: 'OLD-ONE', durationDays: 7, expiresAt: new Date(h.clock.now().getTime() - DAY).toISOString() }).expect(201);
      await create({ code: 'OFF-CODE', durationDays: 7 }).expect(201);
      await api('post', '/admin/redeem-codes/off-code/disable', adminToken).expect(200);

      expect((await redeem('NOPE').expect(422)).body.code).toBe('REDEEM_INVALID');
      await redeem('ONCE').expect(200);
      expect((await redeem('ONCE').expect(409)).body.code).toBe('REDEEM_ALREADY_USED');
      expect((await redeem('ONCE', await h.token('free-2')).expect(422)).body.code).toBe('REDEEM_EXHAUSTED');
      expect((await redeem('OLD-ONE').expect(422)).body.code).toBe('REDEEM_EXPIRED');
      expect((await redeem('OFF-CODE').expect(422)).body.code).toBe('REDEEM_INVALID');
      expect((await h.first(redeemCodes, eq(redeemCodes.code, 'ONCE'))).usedCount).toBe(1);
    });

    it('needs an admin to create codes', async () => {
      await api('post', '/admin/redeem-codes').send({ code: 'MINE', durationDays: 7 }).expect(403);
    });
  });
});
