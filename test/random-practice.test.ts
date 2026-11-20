import { eq } from 'drizzle-orm';
import { learningSessions } from '../src/db/schema';
import { CAPS, createHarness, Harness, seedWord } from './support/app';
import { answers, tasksOf } from './support/driver';

const USER = 'random-user';
const LEARNED = 6;

describe('random practice', () => {
  let h: Harness;
  let auth: string;

  const api = (method: 'get' | 'post' | 'put', path: string) =>
    h.http()[method](path).set('Authorization', `Bearer ${auth}`);
  const plan = async (extra: object = {}, capabilities = CAPS) =>
    (await api('post', '/v1/sessions/plan').send({ mode: 'random_practice', capabilities, ...extra }).expect(200)).body;
  const commit = (p: { sessionId: string }, body: object) => api('post', `/v1/sessions/${p.sessionId}/commit`).send(body);
  const scope = async (sessionId: string) => (await h.first(learningSessions, eq(learningSessions.id, sessionId))).scopeSnapshot;

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    h.planner.setRng(Math.random);
    auth = await h.token(USER);
    const seeded = await h.seed('topic-a', Array.from({ length: LEARNED + 4 }, (_, i) => seedWord(i)));
    await api('put', '/v1/me/levels').send({ proficiencyLevel: 'B1' }).expect(200);
    await api('put', '/v1/me/scope').send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
    await api('put', '/v1/me/settings').send({ dailyNewWordGoal: LEARNED }).expect(200);
    const daily = (await api('post', '/v1/sessions/plan').send({ mode: 'daily', capabilities: CAPS }).expect(200)).body;
    await commit(daily, answers(daily)).expect(200);
  });

  it('is mixed practice over the learned words, and commits', async () => {
    const p = await plan();
    const { plan: stored } = await h.first(learningSessions, eq(learningSessions.id, p.sessionId));
    const practised = new Set(stored!.tasks.flatMap((t) => t.targets.flatMap((g) => g.meaningId ?? [])));
    expect(practised.size).toBeGreaterThan(0);
    expect(practised.size).toBeLessThanOrEqual(LEARNED);
    expect(await scope(p.sessionId)).not.toHaveProperty('skills');
    await commit(p, answers(p)).expect(200);
  });

  it('ignores a skill choice from older clients', async () => {
    const legacy = await plan({ skills: ['speaking'] }, { ...CAPS, microphone: false });
    expect(tasksOf(legacy).length).toBeGreaterThan(0);
    expect(await scope(legacy.sessionId)).not.toHaveProperty('skills');
    expect(tasksOf(await plan({ skill: 'reading' })).length).toBeGreaterThan(0);
  });
});
