import { eq } from 'drizzle-orm';
import { newId } from '../src/common/ids';
import { collections, learningSessions, memoryObservations, topicMeanings, topics, userCollectionReviewPauses, userMeaningProgress, userReviewLoadPrompts, userSettings } from '../src/db/schema';
import { CAPS, createHarness, Harness, seedWord } from './support/app';
import { answers, correctEvents, learnIds, tasksOf, wrongEvents } from './support/driver';

const words = (n: number, from = 0) => Array.from({ length: n }, (_, i) => seedWord(i + from));
type Step = { type: string; phase?: string; sourceTopic?: { id: string; name: string } };

describe('scope completion and review load', () => {
  let h: Harness;
  let auth: string;

  const api = (method: 'get' | 'post' | 'put' | 'delete', path: string) =>
    h.http()[method](path).set('Authorization', `Bearer ${auth}`);
  const setScope = (seeded: { collectionId: string; topicId: string }) =>
    api('put', '/v1/me/scope').send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
  async function onboard(slugWords = words(6), slug = 'topic-a') {
    const seeded = await h.seed(slug, slugWords);
    await api('put', '/v1/me/levels').send({ proficiencyLevel: 'B1' }).expect(200);
    await setScope(seeded);
    return seeded;
  }
  const plan = async (extra: object = {}, mode = 'daily') =>
    (await api('post', '/v1/sessions/plan').send({ mode, capabilities: CAPS, ...extra }).expect(200)).body;
  const commit = (p: { sessionId: string }, body: object) => api('post', `/v1/sessions/${p.sessionId}/commit`).send(body);
  const goal = (n: number) => api('put', '/v1/me/settings').send({ dailyNewWordGoal: n }).expect(200);
  const home = async () => (await api('get', '/v1/me/learn-home').expect(200)).body;
  const reviews = (p: { steps: Step[] }) => p.steps.filter((s) => s.phase === 'due_review');
  async function learn(n: number) {
    await goal(n);
    const p = await plan();
    return (await commit(p, answers(p)).expect(200)).body;
  }

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    h.planner.setRng(Math.random);
    auth = await h.token('user-1');
  });

  describe('running out of new words', () => {
    it('limits to what is left, reports the transition once, and replays it on retry', async () => {
      const seeded = await onboard(words(2));
      const first = await plan();
      expect(first.newWords).toEqual({ requested: 5, issued: 2, withheldReason: 'scope_limited' });

      const body = answers(first);
      const committed = (await commit(first, body).expect(200)).body;
      expect(committed.scopeEvents).toEqual({ completedTopicIds: [seeded.topicId], scopeExhausted: true, collectionCompleted: true });
      expect((await commit(first, body).expect(200)).body).toEqual(committed);

      const rows = await h.db.select({ via: userMeaningProgress.learnedViaTopicId }).from(userMeaningProgress);
      expect(rows.map((r) => r.via)).toEqual([seeded.topicId, seeded.topicId]);

      const view = await home();
      expect(view.scope).toMatchObject({ status: 'exhausted', remainingNewMeanings: 0, pendingCustomMeanings: 0 });
      expect(view.scope.topics).toEqual([{ topicId: seeded.topicId, remainingNewMeanings: 0, totalMeanings: 2 }]);
      expect((await plan()).newWords).toEqual({ requested: 5, issued: 0, withheldReason: 'scope_exhausted' });
      expect((await api('get', '/v1/me/journey').expect(200)).body.newWordsBlockedReason).toBe('scope_exhausted');
      expect((await api('get', '/v1/me/challenge-map').expect(200)).body.newWordsBlockedReason).toBe('scope_exhausted');
    });

    it('sends no scope events when the commit leaves new words', async () => {
      await onboard(words(4));
      expect((await learn(1)).scopeEvents).toEqual({ completedTopicIds: [], scopeExhausted: false, collectionCompleted: false });
      expect((await home()).scope).toMatchObject({ status: 'low', remainingNewMeanings: 3, sessionsLeftEstimate: 3 });
    });

    it('reopens a finished topic when content is added', async () => {
      await onboard(words(4));
      await learn(4);
      expect((await home()).scope.status).toBe('exhausted');
      await h.seed('topic-a', words(1, 5));
      expect((await home()).scope).toMatchObject({ status: 'low', remainingNewMeanings: 1 });
    });
  });

  describe('changing scope', () => {
    it('keeps reviewing old words with their topic label and never re-teaches them', async () => {
      const a = await onboard(words(4));
      await learn(4);
      const before = await h.db.select().from(userMeaningProgress);
      const b = await h.seed('topic-b', words(4, 10));
      await setScope(b);
      expect(await h.db.select().from(userMeaningProgress)).toEqual(before);

      h.clock.advance(100);
      const p = await plan();
      expect(reviews(p).length).toBeGreaterThan(0);
      expect(reviews(p).every((s) => s.sourceTopic?.id === a.topicId && s.sourceTopic.name === 'topic-a')).toBe(true);
      expect(p.reviewWords.length).toBeGreaterThan(0);
      expect(p.reviewWords.every((w: { sourceTopic: { id: string } }) => w.sourceTopic.id === a.topicId)).toBe(true);
      const learnedIds = new Set(before.map((r) => r.meaningId));
      expect(learnIds(p).some((id: string) => learnedIds.has(id))).toBe(false);
    });

    it('reports catalog progress per collection and topic', async () => {
      const a = await onboard(words(3));
      await learn(1);
      const { collections } = (await api('get', '/v1/catalog/collections').expect(200)).body;
      const collection = collections.find((c: { id: string }) => c.id === a.collectionId);
      expect(collection).toMatchObject({ learnedMeanings: 1, totalMeanings: 3 });
      expect(collection.topics[0]).toMatchObject({ id: a.topicId, learnedMeanings: 1, totalMeanings: 3 });
    });
  });

  describe('review load', () => {
    it('keeps the goal whatever the backlog when the learner chose nothing', async () => {
      await onboard(words(50));
      await learn(22);
      h.clock.advance(1000);
      const view = await home();
      expect(view.reviewLoad).toMatchObject({ backlog: 22, dueCap: 10, effectiveNewPerSession: 22, newWordReason: 'goal', promptChoice: true });
      await api('post', '/v1/me/review-load/ack').send({ backlog: 22 }).expect(200);
      expect((await home()).reviewLoad.promptChoice).toBe(false);
    });

    it('auto-balance lowers new words only when enabled', async () => {
      await onboard(words(30));
      await learn(22);
      h.clock.advance(1000);
      await goal(5);
      await api('put', '/v1/me/settings').send({ autoBalanceNewWords: true }).expect(200);
      expect((await home()).reviewLoad).toMatchObject({ effectiveNewPerSession: 2, newWordReason: 'auto_balanced', autoBalance: true });
      expect((await plan()).newWords).toEqual({ requested: 5, issued: 2, withheldReason: 'auto_balanced' });
    });

    it('review-only plans no new words, moves the schedule and takes no journey slot', async () => {
      await onboard(words(6));
      await learn(2);
      h.clock.advance(100);
      const p = await plan({ reviewOnly: true });
      expect(p.newWords).toEqual({ requested: 2, issued: 0, withheldReason: 'review_only' });
      expect(learnIds(p)).toEqual([]);
      expect(reviews(p).length).toBeGreaterThan(0);
      const due = await h.db.select().from(userMeaningProgress);
      await commit(p, answers(p)).expect(200);
      const after = await h.db.select().from(userMeaningProgress);
      expect(after.every((r) => r.nextReviewAt > h.clock.now())).toBe(true);
      expect(after.map((r) => r.learnedSessionId)).toEqual(due.map((r) => r.learnedSessionId));
    });

    it('rejects reviewOnly outside daily and filter outside random practice', async () => {
      await onboard();
      await api('post', '/v1/sessions/plan').send({ mode: 'random_practice', capabilities: CAPS, reviewOnly: true }).expect(400);
      await api('post', '/v1/sessions/plan').send({ mode: 'daily', capabilities: CAPS, filter: { customOnly: true } }).expect(400);
    });

    it('a temporary override ends on the local Sunday, and a new goal cancels it', async () => {
      await onboard(words(10));
      await api('put', '/v1/me/new-word-override').send({ value: 5, mode: 'until_date' }).expect(400);
      const { override } = (await api('put', '/v1/me/new-word-override').send({ value: 2, mode: 'until_date' }).expect(200)).body;
      const until = new Date(override.until);
      expect(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
        .format(until)).toBe('Sun, 23');
      expect(until > h.clock.now()).toBe(true);
      expect((await plan()).newWords).toEqual({ requested: 5, issued: 2, withheldReason: 'user_override' });

      h.clock.advance((until.getTime() - h.clock.now().getTime()) / 3_600_000 + 1);
      expect((await home()).reviewLoad).toMatchObject({ override: null, effectiveNewPerSession: 5 });

      await api('put', '/v1/me/new-word-override').send({ value: 3, mode: 'until_backlog_clear' }).expect(200);
      await goal(6);
      expect((await h.first(userSettings)).newWordOverride).toBeNull();
    });

    it('rejects an until in the past', async () => {
      await onboard();
      const past = new Date(h.clock.now().getTime() - 1000).toISOString();
      await api('put', '/v1/me/new-word-override').send({ value: 2, mode: 'until_date', until: past }).expect(400);
    });

    it('an until_backlog_clear override and the prompt state clear at the first commit with a small backlog', async () => {
      await onboard(words(10));
      await api('put', '/v1/me/new-word-override').send({ value: 2, mode: 'until_backlog_clear' }).expect(200);
      await api('post', '/v1/me/review-load/ack').send({ backlog: 25 }).expect(200);
      const p = await plan();
      expect(p.newWords.issued).toBe(2);
      await commit(p, answers(p)).expect(200);
      expect((await h.first(userSettings)).newWordOverrideMode).toBeNull();
      expect((await h.first(userReviewLoadPrompts)).lastPromptedBacklog).toBeNull();
    });
  });

  describe('review pauses and practice source', () => {
    async function learnedInOldCollection() {
      const a = await onboard(words(4));
      await learn(2);
      const b = await h.seed('topic-b', words(4, 10));
      await setScope(b);
      h.clock.advance(100);
      return { a, b };
    }

    it('a paused collection leaves daily, backlog and random-all, but stays in its own filter', async () => {
      const { a, b } = await learnedInOldCollection();
      await api('put', `/v1/me/review-pauses/${a.collectionId}`).expect(200);
      expect((await api('get', '/v1/me').expect(200)).body.reviewPauses).toEqual([
        { collectionId: a.collectionId, pausedAt: expect.any(String) },
      ]);
      expect(reviews(await plan())).toEqual([]);
      expect((await home()).dueCount).toBe(0);
      expect((await plan({}, 'random_practice')).steps).toEqual([]);
      expect((await plan({}, 'weak_words_practice')).steps).toEqual([]);
      expect((await plan({ filter: { collectionId: a.collectionId } }, 'random_practice')).steps.length).toBeGreaterThan(0);

      await api('put', `/v1/me/review-pauses/${b.collectionId}`).expect(422);
      await api('put', '/v1/me/review-pauses/01a18d69-b8c8-7699-b121-735a85b63537').expect(404);

      await api('delete', `/v1/me/review-pauses/${a.collectionId}`).expect(200);
      expect(reviews(await plan()).length).toBeGreaterThan(0);
    });

    it('keeps reviewing a paused Meaning that is also in the active collection', async () => {
      const a = await onboard(words(4));
      await learn(1);
      const [learned] = await h.db.select().from(userMeaningProgress);
      const b = await h.seed('topic-b', words(4, 10));
      await h.db.insert(topicMeanings).values({ topicId: b.topicId, meaningId: learned.meaningId, curatedRank: 100 });
      await setScope(b);
      await api('put', `/v1/me/review-pauses/${a.collectionId}`).expect(200);
      h.clock.advance(100);
      expect(reviews(await plan()).length).toBeGreaterThan(0);
    });

    it('filters random practice by topic, and 404s an unknown topic', async () => {
      const { a, b } = await learnedInOldCollection();
      expect((await plan({ filter: { topicIds: [a.topicId] } }, 'random_practice')).steps.length).toBeGreaterThan(0);
      expect((await plan({ filter: { topicIds: [b.topicId] } }, 'random_practice')).steps).toEqual([]);
      expect((await plan({ filter: { customOnly: true } }, 'random_practice')).steps).toEqual([]);
      await api('post', '/v1/sessions/plan')
        .send({ mode: 'random_practice', capabilities: CAPS, filter: { topicIds: ['01a18d69-b8c8-7699-b121-735a85b63537'] } }).expect(404);
      await api('post', '/v1/sessions/plan').send({ mode: 'random_practice', capabilities: CAPS, filter: { topicIds: [] } }).expect(400);
    });

    it('account deletion removes pauses and prompt state', async () => {
      const { a } = await learnedInOldCollection();
      await api('put', `/v1/me/review-pauses/${a.collectionId}`).expect(200);
      await api('post', '/v1/me/review-load/ack').send({ backlog: 30 }).expect(200);
      await api('delete', '/v1/me').expect(200);
      expect(await h.count(userCollectionReviewPauses)).toBe(0);
      expect(await h.count(userReviewLoadPrompts)).toBe(0);
      expect(await h.count(learningSessions, eq(learningSessions.mode, 'daily'))).toBe(0);
    });
  });

  describe('"I know this" known check', () => {
    type Learn = { id: string; knownCheckTaskId: string; skippableTaskIds: string[] };
    const learnSteps = (p: { steps: (Step & Partial<Learn>)[] }) => p.steps.filter((s) => s.type === 'learn') as unknown as Learn[];
    const known = async () => {
      await onboard(words(6));
      await goal(2);
      return plan({ knownCheck: true });
    };

    it('puts an optional recall right before each Learn card', async () => {
      const p = await known();
      const steps = learnSteps(p);
      expect(steps).toHaveLength(2);
      for (const step of steps) {
        const index = p.steps.findIndex((s: { id?: string; task?: { id: string } }) => s.id === step.id);
        expect(p.steps[index - 1]).toMatchObject({ phase: 'known_check', task: { id: step.knownCheckTaskId, template: 'typing' } });
      }
      await api('post', '/v1/sessions/plan').send({ mode: 'random_practice', capabilities: CAPS, knownCheck: true }).expect(400);
    });

    it('a passed check learns the word with a long first interval and skips its teaching', async () => {
      const p = await known();
      const steps = learnSteps(p);
      const skipped = new Set(steps.flatMap((s) => s.skippableTaskIds));
      expect(skipped.size).toBeGreaterThan(0);
      const body = {
        learnStepsCompleted: [],
        taskResults: tasksOf(p).filter((t) => !skipped.has(t.id)).map((t) => ({ taskId: t.id, events: correctEvents(t), ...(t.prompt?.type === 'audio' && { deliveryMode: 'audio' }) })),
      };
      const committed = (await commit(p, body).expect(200)).body;
      expect(committed.summary.knownMeanings).toBe(2);
      const rows = await h.db.select().from(userMeaningProgress);
      expect(rows.map((r) => Number(r.intervalHours))).toEqual([168, 168]);
    });

    it('a declined or failed check teaches as usual without penalty', async () => {
      const p = await known();
      const [declined, failed] = learnSteps(p);
      const body = answers(p, { override: (t) => (t.id === failed.knownCheckTaskId ? wrongEvents(t) : undefined) });
      body.taskResults = body.taskResults.filter((r: { taskId: string }) => r.taskId !== declined.knownCheckTaskId);
      expect((await commit(p, body).expect(200)).body.summary.knownMeanings).toBe(0);
      // The failed check is not a failed recall; priming elsewhere in the plan may still lower credit.
      const observed = await h.db.select().from(memoryObservations);
      expect(observed.map((o) => o.signal).every((signal) => signal === 'unaided_recall')).toBe(true);
      expect(observed.flatMap((o) => o.sourceTaskIds as string[])).not.toContain(failed.knownCheckTaskId);
    });

    it('a failed check cannot skip teaching', async () => {
      const p = await known();
      const [step] = learnSteps(p);
      const body = answers(p, { override: (t) => (t.id === step.knownCheckTaskId ? wrongEvents(t) : undefined) });
      body.taskResults = body.taskResults.filter((r: { taskId: string }) => !step.skippableTaskIds.includes(r.taskId));
      body.learnStepsCompleted = body.learnStepsCompleted.filter((id: string) => id !== step.id);
      await commit(p, body).expect(422);
    });
  });

  describe('performance: query count does not grow with topics or pauses', () => {
    // n extra active topics and n paused collections, each holding one learned Meaning.
    const measure = async (n: number) => {
      await h.reset();
      auth = await h.token('user-1');
      const a = await onboard(words(6));
      await learn(2);
      const learned = await h.db.select({ meaningId: userMeaningProgress.meaningId }).from(userMeaningProgress);
      const topicRows = Array.from({ length: n }, (_, i) => ({ id: newId(), collectionId: a.collectionId, slug: `extra-${i}`, title: `extra-${i}`, status: 'published' as const }));
      const pausedCollections = Array.from({ length: n }, (_, i) => ({ id: newId(), slug: `paused-${i}`, title: `paused-${i}`, status: 'published' as const }));
      const pausedTopics = pausedCollections.map((c) => ({ id: newId(), collectionId: c.id, slug: c.slug, title: c.title, status: 'published' as const }));
      await h.db.insert(collections).values(pausedCollections);
      await h.db.insert(topics).values([...topicRows, ...pausedTopics]);
      await h.db.insert(topicMeanings).values([...topicRows, ...pausedTopics].map((t, i) => ({ topicId: t.id, meaningId: learned[i % learned.length].meaningId, curatedRank: 1 })));
      const userId = (await h.first(userSettings)).userId;
      await h.db.insert(userCollectionReviewPauses).values(pausedCollections.map((c) => ({ userId, collectionId: c.id })));
      await api('put', '/v1/me/scope').send({ collectionId: a.collectionId, topicIds: [a.topicId, ...topicRows.map((t) => t.id)] }).expect(200);
      h.clock.advance(100);

      const planned = await h.countQueries(() => plan());
      const committed = await h.countQueries(() => commit(planned.result, answers(planned.result)).expect(200));
      const view = await h.countQueries(() => api('get', '/v1/me/learn-home').expect(200));
      const catalog = await h.countQueries(() => api('get', '/v1/catalog/collections').expect(200));
      const random = await h.countQueries(() => plan({}, 'random_practice'));
      return { plan: planned.queries, commit: committed.queries, home: view.queries, catalog: catalog.queries, random: random.queries };
    };

    it('stays constant from 1 to 20 topics and paused collections', async () => {
      const small = await measure(1);
      const large = await measure(20);
      expect(large).toEqual(small);
      expect(small.commit).toBeLessThan(8);
    }, 120_000);
  });
});
