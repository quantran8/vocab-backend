import { eq } from 'drizzle-orm';
import { SKILL, SKILLS, TEMPLATE } from '../src/common/constants/domain';
import { learningSessions, skillEvidence } from '../src/db/schema';
import { ServerEvaluation } from '../src/modules/practice-resolver/task.types';
import { skillOf } from '../src/modules/skill-verification/skill-evidence';
import { CAPS, createHarness, Harness, seedWord } from './support/app';
import { answers, tasksOf } from './support/driver';

const USER = 'skill-user';
const LEARNED = 6;
const WITH_AUDIO = 3;

describe('practice by skill', () => {
  let h: Harness;
  let auth: string;

  const api = (method: 'get' | 'post' | 'put', path: string) =>
    h.http()[method](path).set('Authorization', `Bearer ${auth}`);
  const planBody = (skill?: string, capabilities = CAPS, mode = 'random_practice') => ({ mode, capabilities, ...(skill && { skill }) });
  const plan = async (skill?: string, capabilities = CAPS) =>
    (await api('post', '/v1/sessions/plan').send(planBody(skill, capabilities)).expect(200)).body;
  const planSkills = async (skills: string[], capabilities = CAPS) =>
    (await api('post', '/v1/sessions/plan').send({ mode: 'random_practice', capabilities, skills }).expect(200)).body;
  const skillsOf = async (sessionId: string) =>
    (await stored(sessionId)).map((t) => {
      const { intent, promptIsTargetAudio } = t.serverEvaluation as ServerEvaluation;
      return skillOf(intent, promptIsTargetAudio);
    });
  const commit = (p: { sessionId: string }, body: object) => api('post', `/v1/sessions/${p.sessionId}/commit`).send(body);
  const stored = async (sessionId: string) => (await h.first(learningSessions, eq(learningSessions.id, sessionId))).plan!.tasks;

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    h.planner.setRng(Math.random);
    auth = await h.token(USER);
    // Distractors come from the extra words; only some learned words have audio.
    const seeded = await h.seed('topic-a', Array.from({ length: LEARNED + 4 }, (_, i) =>
      seedWord(i, i >= WITH_AUDIO ? { audioUrl: undefined } : {})));
    await api('put', '/v1/me/levels').send({ proficiencyLevel: 'B1' }).expect(200);
    await api('put', '/v1/me/scope').send({ collectionId: seeded.collectionId, topicIds: [seeded.topicId] }).expect(200);
    await api('put', '/v1/me/settings').send({ dailyNewWordGoal: LEARNED }).expect(200);
    const daily = (await api('post', '/v1/sessions/plan').send(planBody(undefined, CAPS, 'daily')).expect(200)).body;
    await commit(daily, answers(daily)).expect(200);
  });

  it.each(SKILLS)('issues only %s tasks, one per word', async (skill) => {
    const p = await plan(skill);
    const tasks = await stored(p.sessionId);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.length).toBeLessThanOrEqual(LEARNED);
    for (const task of tasks) {
      const { intent, promptIsTargetAudio } = task.serverEvaluation as ServerEvaluation;
      expect(skillOf(intent, promptIsTargetAudio)).toBe(skill);
    }
    await commit(p, answers(p)).expect(200);
  });

  it('skips words a skill cannot use', async () => {
    const listening = await plan(SKILL.LISTENING);
    expect(tasksOf(listening)).toHaveLength(WITH_AUDIO);
    expect(tasksOf(listening).every((t: { prompt: { type: string } }) => t.prompt.type === 'audio')).toBe(true);
    expect(tasksOf(await plan(SKILL.WRITING))).toHaveLength(LEARNED);
  });

  it('records evidence for the chosen skill only', async () => {
    const p = await plan(SKILL.WRITING);
    await commit(p, answers(p)).expect(200);
    const rows = await h.db.select({ skill: skillEvidence.skill }).from(skillEvidence).where(eq(skillEvidence.sessionId, p.sessionId));
    expect(new Set(rows.map((r) => r.skill))).toEqual(new Set([SKILL.WRITING]));
  });

  it('speaking issues recording tasks', async () => {
    const tasks = tasksOf(await plan(SKILL.SPEAKING));
    expect(tasks.every((t: { template: string }) => t.template === TEMPLATE.RECORDING)).toBe(true);
  });

  it('keeps the skill in the session scope', async () => {
    const p = await plan(SKILL.READING);
    expect((await h.first(learningSessions, eq(learningSessions.id, p.sessionId))).scopeSnapshot).toMatchObject({ skills: [SKILL.READING] });
  });

  it('returns an empty plan when the device cannot train the skill', async () => {
    expect(await plan(SKILL.SPEAKING, { ...CAPS, microphone: false })).toEqual({ sessionId: null, mode: 'random_practice', steps: [] });
    expect(await plan(SKILL.LISTENING, { ...CAPS, audioPlayback: false })).toEqual({ sessionId: null, mode: 'random_practice', steps: [] });
  });

  it('rejects a skill outside random practice, and an unknown skill', async () => {
    await api('post', '/v1/sessions/plan').send(planBody(SKILL.READING, CAPS, 'daily')).expect(400);
    await api('post', '/v1/sessions/plan').send(planBody('grammar')).expect(400);
  });

  it('without a skill stays mixed practice', async () => {
    const p = await plan();
    expect(tasksOf(p).length).toBeGreaterThan(0);
    expect((await h.first(learningSessions, eq(learningSessions.id, p.sessionId))).scopeSnapshot).not.toHaveProperty('skills');
  });

  it('several skills: one task per word, only the chosen skills, each one used', async () => {
    const p = await planSkills([SKILL.READING, SKILL.WRITING]);
    const skills = await skillsOf(p.sessionId);
    expect(skills).toHaveLength(LEARNED);
    expect(new Set(skills)).toEqual(new Set([SKILL.READING, SKILL.WRITING]));
    expect((await h.first(learningSessions, eq(learningSessions.id, p.sessionId))).scopeSnapshot).toMatchObject({ skills: [SKILL.READING, SKILL.WRITING] });
    await commit(p, answers(p)).expect(200);
  });

  it('several skills: a word without audio trains another chosen skill instead of listening', async () => {
    const p = await planSkills([SKILL.LISTENING, SKILL.READING]);
    const skills = await skillsOf(p.sessionId);
    expect(skills).toHaveLength(LEARNED);
    expect(skills.filter((s) => s === SKILL.LISTENING).length).toBeLessThanOrEqual(WITH_AUDIO);
    expect(skills.every((s) => s === SKILL.LISTENING || s === SKILL.READING)).toBe(true);
  });

  it('several skills: drops the ones the device cannot train', async () => {
    const p = await planSkills([SKILL.SPEAKING, SKILL.WRITING], { ...CAPS, microphone: false });
    expect(new Set(await skillsOf(p.sessionId))).toEqual(new Set([SKILL.WRITING]));
    expect(await planSkills([SKILL.SPEAKING, SKILL.LISTENING], { audioPlayback: false, microphone: false }))
      .toEqual({ sessionId: null, mode: 'random_practice', steps: [] });
  });

  it('rejects empty, duplicate or mixed skill fields', async () => {
    const send = (body: object) => api('post', '/v1/sessions/plan').send({ mode: 'random_practice', capabilities: CAPS, ...body });
    await send({ skills: [] }).expect(400);
    await send({ skills: [SKILL.READING, SKILL.READING] }).expect(400);
    await send({ skill: SKILL.READING, skills: [SKILL.WRITING] }).expect(400);
    await api('post', '/v1/sessions/plan').send({ mode: 'daily', capabilities: CAPS, skills: [SKILL.READING] }).expect(400);
  });
});
