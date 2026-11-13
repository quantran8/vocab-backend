import { and, eq, sql } from 'drizzle-orm';
import { addHours } from '../src/common/constants/time';
import { AppConfig } from '../src/config/app-config';
import {
  appUsers, learningPointAwards, rankingEligibilityAudit, userEffortDays, userEffortTotals, userReports, userTierUnlocks, weeklyLpScores, weeklyRankSnapshots,
} from '../src/db/schema';
import { MaintenanceService } from '../src/modules/maintenance/services/maintenance.service';
import { CAPS, createHarness, Harness, seedWord, START } from './support/app';
import { answers } from './support/driver';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const words = (n: number, from = 0) => Array.from({ length: n }, (_, i) => seedWord(i + from));
const WEEK = '2026-11-02';
const LAST_WEEK = '2026-10-26';

describe('LP, Tier and weekly ranking', () => {
  let h: Harness;
  let auth: string;
  let other: string;
  let admin: string;

  const api = (method: 'get' | 'post' | 'put' | 'delete', path: string, token = auth) =>
    h.http()[method](path).set('Authorization', `Bearer ${token}`);
  const maintenance = () => h.app.get(MaintenanceService);
  const me = async (token = auth): Promise<Json> => (await api('get', '/v1/me', token).expect(200)).body;

  async function onboard(n: number, token = auth) {
    const seeded = await h.seed('topic-a', words(n));
    await api('put', '/v1/me/levels', token).send({ proficiencyLevel: 'B1' }).expect(200);
    await api('put', '/v1/me/scope', token).send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
  }
  const plan = async (mode = 'daily', token = auth): Promise<Json> =>
    (await api('post', '/v1/sessions/plan', token).send({ mode, capabilities: CAPS }).expect(200)).body;
  const commit = (p: Json, body: Json = answers(p), token = auth) => api('post', `/v1/sessions/${p.sessionId}/commit`, token).send(body);
  async function learn(n: number, token = auth): Promise<Json> {
    await api('put', '/v1/me/settings', token).send({ dailyNewWordGoal: n }).expect(200);
    return (await commit(await plan('daily', token), undefined, token).expect(200)).body;
  }
  const optIn = (visible = true, token = auth) => api('put', '/v1/me/settings', token).send({ leaderboardVisible: visible }).expect(200);
  const board = async (view = 'top', token = auth): Promise<Json[]> =>
    (await api('get', `/v1/ranking/leaderboard?view=${view}`, token).expect(200)).body.rows;

  // Learners who exist only on the board: one listed weekly score each, the earliest award first.
  async function seedBoard(points: number[], week = WEEK, listed = true, from = 0) {
    await h.db.execute(sql`
      WITH input AS (
        SELECT p.points, p.i FROM jsonb_array_elements_text(${JSON.stringify(points)}::jsonb) WITH ORDINALITY AS p(points, i)
      ), users AS (
        INSERT INTO app_user (id, identity_subject, username, avatar_key)
        SELECT gen_random_uuid(), 'board-' || (i + ${from}), 'board_' || lpad((i + ${from})::text, 5, '0'), 'syllie_calm' FROM input
        RETURNING id, username
      )
      INSERT INTO weekly_lp_scores (user_id, week_start, points, last_award_at, listed)
      SELECT u.id, ${week}::date, input.points::bigint, ${START}::timestamptz - interval '1 day' + input.i * interval '1 second', ${listed}
      FROM users u JOIN input ON 'board_' || lpad((input.i + ${from})::text, 5, '0') = u.username`);
  }

  beforeAll(async () => { h = await createHarness(); });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    h.planner.setRng(Math.random);
    auth = await h.token('user-1');
    other = await h.token('user-2');
    admin = await h.token('admin-1', 'admin');
  });
  afterEach(() => { Object.assign(h.app.get(AppConfig), { rankingEnabled: true }); });

  describe('earning LP on commit', () => {
    it('awards +5 per new Meaning, counts the day, and replays the same answer on retry', async () => {
      await onboard(6);
      await api('put', '/v1/me/settings').send({ dailyNewWordGoal: 3 }).expect(200);
      const p = await plan();
      const body = answers(p);
      const first = (await commit(p, body).expect(200)).body;
      expect(first.lp).toEqual({
        earned: 15, breakdown: { newMeaningLP: 15, dueReviewLP: 0, extraPracticeLP: 0 }, lpPolicyVersion: 'lp_effort_trial_v1', weeklyLP: 15, lifetimeLP: 15,
      });
      expect(first.tier).toMatchObject({ level: 0, key: null, lifetimeActiveDays: 1, tierUps: [], nextTier: { level: 1, minLifetimeLP: 40, minLifetimeActiveDays: 1 } });
      expect(first.ranking).toEqual({ weeklyLP: 15, listed: false });

      expect((await commit(p, body).expect(200)).body).toEqual(first);
      expect(await h.count(learningPointAwards, sql`true`)).toBe(3);
      expect(await h.first(userEffortTotals, sql`true`)).toMatchObject({ lifetimeLp: 15, lifetimeActiveDays: 1, tierLevel: 0 });

      const second = await learn(3);
      expect(second.lp).toMatchObject({ earned: 15, lifetimeLP: 30 });
      expect(second.tier.lifetimeActiveDays).toBe(1);
    });

    it('unlocks every Tier a single commit crosses', async () => {
      await onboard(4);
      const { id } = await me();
      await h.db.insert(userEffortTotals).values({ userId: id, lifetimeLp: 590, lifetimeActiveDays: 29, tierLevel: 1, tierPolicyVersion: 'tier_lifetime_trial_v1' });
      await h.db.insert(userTierUnlocks).values({ userId: id, tierLevel: 1, tierKey: 'first_steps', unlockedAt: addHours(START, -24 * 40), tierPolicyVersion: 'v', source: 'live' });

      const body = await learn(2);
      expect(body.tier).toMatchObject({ level: 3, key: 'building_up', lifetimeActiveDays: 30 });
      expect(body.tier.tierUps).toEqual([
        { level: 2, key: 'in_motion', unlockedAt: START.toISOString() },
        { level: 3, key: 'building_up', unlockedAt: START.toISOString() },
      ]);
      const tier = (await api('get', '/v1/me/tier').expect(200)).body;
      expect(tier.milestones.map((m: Json) => m.level)).toEqual([1, 2, 3]);
      expect(tier.nextTier).toMatchObject({ level: 4, remainingLP: 900, remainingActiveDays: 60 });
    });

    it('counts a day only once its LP reaches 5, and pays practice once per Meaning a day', async () => {
      await onboard(4);
      expect((await learn(3)).lp.earned).toBe(15);
      // Next UTC day, before the shortest first interval (24 h) makes anything due.
      h.clock.advance(22);

      const practiced = (await commit(await plan('random_practice')).expect(200)).body;
      expect(practiced.lp).toMatchObject({ earned: 3, breakdown: { newMeaningLP: 0, dueReviewLP: 0, extraPracticeLP: 3 } });
      expect(practiced.tier.lifetimeActiveDays).toBe(1);
      expect((await commit(await plan('random_practice')).expect(200)).body.lp.earned).toBe(0);

      const learned = await learn(1);
      expect(learned.lp).toMatchObject({ earned: 5, weeklyLP: 23, lifetimeLP: 23 });
      expect(learned.tier.lifetimeActiveDays).toBe(2);
      expect(await h.first(userEffortDays, eq(userEffortDays.scoringDay, '2026-11-03'))).toMatchObject({ earnedLp: 8 });
    });
  });

  describe('profile and privacy', () => {
    it('starts hidden with a generated identity; seeing the intro does not opt in', async () => {
      const profile = await me();
      expect(profile.username).toMatch(/^[a-z]+_[a-z]+_\d{4}$/);
      expect(profile).toMatchObject({
        rankingIntroSeen: false, usernameChangeAvailableAt: null,
        settings: { leaderboardVisible: false }, tierSummary: { level: 0, key: null, lifetimeLP: 0, lifetimeActiveDays: 0 },
      });
      expect(profile).not.toHaveProperty('usernameGenerated');
      await api('post', '/v1/me/ranking/intro-seen').expect(200);
      expect(await me()).toMatchObject({ rankingIntroSeen: true, settings: { leaderboardVisible: false } });
    });

    it('lists only learners who opted in, and drops them at once when they opt out', async () => {
      await onboard(4);
      await learn(2);
      await seedBoard([50]);
      expect((await board()).map((r) => r.username)).toEqual(['board_00001']);
      expect((await api('get', '/v1/me/ranking').expect(200)).body).toMatchObject({ weeklyLP: 10, listed: false, position: null });

      await optIn();
      expect(await board()).toEqual([
        expect.objectContaining({ rank: 1, username: 'board_00001', weeklyLP: 50, lifetimeTier: { level: 0, key: null }, isMe: false }),
        expect.objectContaining({ rank: 2, weeklyLP: 10, isMe: true }),
      ]);
      expect((await api('get', '/v1/me/ranking').expect(200)).body).toMatchObject({
        listed: true, position: { kind: 'rank', rank: 2, percentile: null }, tier: { lifetimeLP: 10, lifetimeActiveDays: 1 },
      });
      expect(Object.keys((await board())[0]).sort()).toEqual(['avatarKey', 'isMe', 'lifetimeTier', 'rank', 'username', 'weeklyLP']);

      await optIn(false);
      expect((await board()).map((r) => r.isMe)).toEqual([false]);
      expect(await board('around')).toEqual([]);
      expect((await me()).tierSummary).toMatchObject({ lifetimeLP: 10 });
    });

    it('renames under the rules and answers each problem with its own code', async () => {
      const renamed = (await api('put', '/v1/me/profile').send({ username: ' Alan.Lee ', avatarKey: 'syllie_brave' }).expect(200)).body;
      expect(renamed).toEqual({ username: 'alan.lee', avatarKey: 'syllie_brave', usernameChangeAvailableAt: addHours(START, 24 * 30).toISOString() });
      expect((await api('put', '/v1/me/profile').send({ username: 'alan_two' }).expect(429)).body.code).toBe('USERNAME_CHANGE_TOO_SOON');
      await api('put', '/v1/me/profile').send({ avatarKey: 'syllie_calm' }).expect(200);
      await api('put', '/v1/me/profile').send({ username: 'ALAN.LEE' }).expect(200);

      expect((await api('put', '/v1/me/profile', other).send({ username: 'alan.lee' }).expect(409)).body.code).toBe('USERNAME_TAKEN');
      expect((await api('put', '/v1/me/profile', other).send({ username: 'the_4dm1n' }).expect(422)).body.code).toBe('USERNAME_NOT_ALLOWED');
      expect((await api('put', '/v1/me/profile', other).send({ username: 'x' }).expect(422)).body.code).toBe('USERNAME_INVALID');
      expect((await api('put', '/v1/me/profile', other).send({ avatarKey: 'gold_crown' }).expect(422)).body.code).toBe('AVATAR_INVALID');
    });
  });

  describe('board', () => {
    it('gives tied learners the same rank and orders them by who got there first', async () => {
      await seedBoard([50, 30, 30, 10]);
      const rows = await board();
      expect(rows.map((r) => [r.rank, r.username, r.weeklyLP])).toEqual([
        [1, 'board_00001', 50], [2, 'board_00002', 30], [2, 'board_00003', 30], [4, 'board_00004', 10],
      ]);
    });

    it('shows five neighbours on each side with their real ranks', async () => {
      await onboard(4);
      await optIn();
      await learn(3);
      await seedBoard([100, 90, 80, 70, 50, 20, 15]);
      await seedBoard([15, 10, 5, 4, 3, 2], WEEK, true, 100);
      await h.db.update(weeklyLpScores).set({ lastAwardAt: addHours(START, 1) }).where(sql`points < 15 OR user_id IN (SELECT id FROM app_user WHERE username = 'board_00101')`);

      const rows = await board('around');
      expect(rows.map((r) => [r.rank, r.weeklyLP, r.isMe])).toEqual([
        [3, 80, false], [4, 70, false], [5, 50, false], [6, 20, false], [7, 15, false],
        [7, 15, true],
        [7, 15, false], [10, 10, false], [11, 5, false], [12, 4, false], [13, 3, false],
      ]);
    });

    it('proves an exact rank inside the top 1 000 and estimates beyond it', async () => {
      await onboard(4);
      await optIn();
      await learn(1);
      await seedBoard(Array.from({ length: 999 }, () => 500));
      const position = async () => (await api('get', '/v1/me/ranking').expect(200)).body.position;
      expect(await position()).toEqual({ kind: 'rank', rank: 1000, percentile: null, estimated: false });

      await seedBoard([500], WEEK, true, 5000);
      expect((await position()).kind).toBe('unranked');
      await maintenance().refreshRankStats();
      expect(await position()).toEqual({ kind: 'unranked', rank: null, percentile: null, estimated: true });

      const { id } = await me();
      await h.db.update(weeklyLpScores).set({ points: 300 }).where(eq(weeklyLpScores.userId, id));
      await seedBoard(Array.from({ length: 1500 }, () => 1), WEEK, true, 6000);
      await maintenance().refreshRankStats();
      expect(await position()).toEqual({ kind: 'percentile', rank: null, percentile: 41, estimated: true });
    });

    it('stays closed while the launch flag is off, but Tier and LP still work', async () => {
      Object.assign(h.app.get(AppConfig), { rankingEnabled: false });
      expect((await api('get', '/v1/ranking/leaderboard').expect(403)).body.code).toBe('RANKING_DISABLED');
      await api('post', '/v1/ranking/reports').send({ username: 'board_00001', reason: 'other' }).expect(403);
      await api('get', '/v1/me/tier').expect(200);
      expect((await api('get', '/v1/ranking/meta').expect(200)).body).toMatchObject({ rankingEnabled: false, weekStart: WEEK, weekEndsAt: '2026-11-09T00:00:00.000Z' });
    });
  });

  describe('closing a week', () => {
    it('snapshots last week once, after the delay, without touching Tier', async () => {
      await seedBoard([40, 40], LAST_WEEK);
      await seedBoard([20], LAST_WEEK, false, 10);
      h.clock.current = new Date('2026-11-02T00:05:00Z');
      expect(await maintenance().closeWeeks()).toBe(0);
      h.clock.current = new Date('2026-11-02T00:15:00Z');
      expect(await maintenance().closeWeeks()).toBe(1);
      expect(await maintenance().closeWeeks()).toBe(0);

      const rows = await h.db.select({ points: weeklyRankSnapshots.points, rank: weeklyRankSnapshots.rank, listed: weeklyRankSnapshots.listedAtClose })
        .from(weeklyRankSnapshots).orderBy(weeklyRankSnapshots.points);
      expect(rows).toEqual([{ points: 20, rank: null, listed: false }, { points: 40, rank: 1, listed: true }, { points: 40, rank: 1, listed: true }]);
      await expect(h.db.update(weeklyRankSnapshots).set({ rank: 2 })).rejects.toThrow();
    });

    it('shows closed weeks in the history with the live week first', async () => {
      await onboard(4);
      await optIn();
      await learn(2);
      const { id } = await me();
      await h.db.insert(weeklyRankSnapshots).values({
        weekStart: LAST_WEEK, userId: id, points: 33, rank: 4, listedAtClose: true, rankingPolicyVersion: 'ranking_v1', closedAt: START,
      });
      const history = (await api('get', '/v1/me/ranking/history?weeks=2').expect(200)).body;
      expect(history).toEqual({
        currentWeek: { weekStart: WEEK, weeklyLP: 10 },
        weeks: [{ weekStart: LAST_WEEK, weeklyLP: 33, rank: 4 }, { weekStart: '2026-10-19', weeklyLP: 0, rank: null }],
      });
    });
  });

  describe('moderation', () => {
    it('takes reports on listed learners, ignores repeats and caps a day at 10', async () => {
      await seedBoard(Array.from({ length: 11 }, (_, i) => 50 - i));
      const report = (username: string) => api('post', '/v1/ranking/reports', other).send({ username, reason: 'offensive_name' });
      await report('board_00001').expect(202);
      await report('BOARD_00001').expect(202);
      expect(await h.count(userReports, sql`true`)).toBe(1);
      for (let i = 2; i <= 10; i++) await report(`board_${String(i).padStart(5, '0')}`).expect(202);
      expect((await report('board_00011').expect(429)).body.code).toBe('REPORT_LIMIT_REACHED');
      await report('nobody_here').expect(404);
    });

    it('lets an admin resolve a report, reset the name and hide a learner without touching their Tier', async () => {
      await onboard(4);
      await optIn();
      await learn(2);
      await api('put', '/v1/me/profile').send({ username: 'rude.name' }).expect(200);
      const { id } = await me();
      await api('post', '/v1/ranking/reports', other).send({ username: 'rude.name', reason: 'offensive_name' }).expect(202);

      const [item] = (await api('get', '/admin/ranking/reports', admin).expect(200)).body.items;
      expect(item).toMatchObject({ reason: 'offensive_name', targetUserId: id, targetUsername: 'rude.name', resolvedAt: null });
      await api('get', '/admin/ranking/reports', auth).expect(403);
      await api('post', `/admin/ranking/reports/${item.id}/resolve`, admin).send({ resolution: 'username_reset' }).expect(200);
      await api('post', `/admin/ranking/reports/${item.id}/resolve`, admin).send({ resolution: 'dismissed' }).expect(409);
      expect((await api('get', '/admin/ranking/reports?status=resolved', admin).expect(200)).body.items).toHaveLength(1);

      const reset = (await api('post', `/admin/users/${id}/username/reset`, admin).expect(200)).body;
      expect(reset.username).toMatch(/^[a-z]+_[a-z]+_\d{4}$/);
      expect((await me()).usernameChangeAvailableAt).toBeNull();
      await api('put', '/v1/me/profile').send({ username: 'kind.name' }).expect(200);

      await api('put', `/admin/users/${id}/ranking-eligibility`, admin).send({ eligible: false, reason: 'farming review' }).expect(200);
      expect((await board()).some((r) => r.isMe)).toBe(false);
      expect((await api('get', '/v1/me/ranking').expect(200)).body).toMatchObject({ listed: false, position: null, weeklyLP: 10, tier: { lifetimeLP: 10 } });
      const audit = await h.first(rankingEligibilityAudit, eq(rankingEligibilityAudit.userId, id));
      expect(audit).toMatchObject({ eligible: false, reason: 'farming review' });

      await api('put', `/admin/users/${id}/ranking-eligibility`, admin).send({ eligible: true, reason: 'cleared' }).expect(200);
      expect((await board()).some((r) => r.isMe)).toBe(true);
      expect(await h.first(appUsers, and(eq(appUsers.id, id), eq(appUsers.rankingEligible, true)))).toBeTruthy();
    });
  });
});
