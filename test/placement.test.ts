import { eq, inArray } from 'drizzle-orm';
import { appUsers, meaningLocalizations, meanings, skillEvidence, userMeaningProgress } from '../src/db/schema';
import { CEFR_LEVELS, MEANING_ORIGIN } from '../src/common/constants/domain';
import { createHarness, Harness, seedWord } from './support/app';

type Question = { id: string; template: string; variant: string; prompt: { text: string }; options: { id: string; text: string }[] };

const USER = 'placement-user';
const PER_LEVEL = 3;
const WORDS_PER_LEVEL = PER_LEVEL + 1;

describe('placement test', () => {
  let h: Harness;
  let auth: string;
  const text = new Map<string, string>();
  const levelOf = new Map<string, string>();

  const api = (method: 'get' | 'post', path = '/v1/me/placement-test') =>
    h.http()[method](path).set('Authorization', `Bearer ${auth}`);
  const getTest = async (): Promise<Question[]> => (await api('get').expect(200)).body.questions;
  const correctOption = (q: Question) => q.options.find((o) => o.text === text.get(q.prompt.text))!.id;
  const wrongOption = (q: Question) => q.options.find((o) => o.text !== text.get(q.prompt.text))!.id;

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    auth = await h.token(USER);
    text.clear();
    levelOf.clear();
    const seeded = CEFR_LEVELS.flatMap((cefrLevel, l) =>
      Array.from({ length: WORDS_PER_LEVEL }, (_, i) => seedWord(l * WORDS_PER_LEVEL + i, { cefrLevel, meaningText: `nghĩa ${cefrLevel} ${i}` })),
    );
    for (const word of seeded) {
      text.set(word.lemma, word.meaningText);
      levelOf.set(word.lemma, word.cefrLevel);
    }
    await h.seed('placement', seeded);
  });

  it('asks select-only questions per level, easiest first, without the answer', async () => {
    const questions = await getTest();
    expect(questions).toHaveLength(PER_LEVEL * CEFR_LEVELS.length);
    expect(new Set(questions.map((q) => `${q.template}/${q.variant}`))).toEqual(new Set(['select/gloss']));
    const levels = questions.map((q) => levelOf.get(q.prompt.text));
    expect(levels).toEqual(CEFR_LEVELS.flatMap((l) => Array(PER_LEVEL).fill(l)));
    expect(questions[0].options.map((o) => o.text)).toContain(text.get(questions[0].prompt.text));
    expect(JSON.stringify(questions)).not.toContain('evaluation');
  });

  it('sets the level from the answers and records no learning data', async () => {
    const questions = await getTest();
    const answers = questions.map((q) => {
      const known = ['A1', 'A2', 'B1'].includes(levelOf.get(q.prompt.text)!);
      return { questionId: q.id, optionId: known ? correctOption(q) : wrongOption(q) };
    });
    const { body } = await api('post').send({ answers }).expect(200);
    expect(body).toEqual({ proficiencyLevel: 'B1', correctCount: PER_LEVEL * 3, totalCount: questions.length });
    expect((await api('get', '/v1/me').expect(200)).body.proficiencyLevel).toBe('B1');
    expect(await h.count(userMeaningProgress)).toBe(0);
    expect(await h.count(skillEvidence)).toBe(0);
  });

  it('treats "I don\'t know" as wrong', async () => {
    const answers = (await getTest()).map((q) => ({ questionId: q.id, optionId: null }));
    const { body } = await api('post').send({ answers }).expect(200);
    expect(body).toMatchObject({ proficiencyLevel: 'A1', correctCount: 0 });
  });

  it('rejects duplicate and unknown questions without changing the level', async () => {
    const [q] = await getTest();
    const answer = { questionId: q.id, optionId: correctOption(q) };
    await api('post').send({ answers: [answer, answer] }).expect(400);
    await api('post').send({ answers: [{ questionId: '01a18d69-b8c8-7699-b121-735a85b63537', optionId: null }] }).expect(400);
    expect((await api('get', '/v1/me').expect(200)).body.proficiencyLevel).toBeNull();
  });

  it('keeps unreviewed AI text and private meanings out', async () => {
    await getTest(); // the first request provisions the user
    const owner = await h.first(appUsers);
    const [aiWord, privateWord] = ['nghĩa A1 0', 'nghĩa A1 1'];
    const localized = await h.first(meaningLocalizations, eq(meaningLocalizations.meaningText, privateWord));
    // A private meaning is always AI text until an admin approves it.
    await h.db.update(meaningLocalizations).set({ origin: MEANING_ORIGIN.AI_GENERATED }).where(inArray(meaningLocalizations.meaningText, [aiWord, privateWord]));
    await h.db.update(meanings).set({ ownerUserId: owner.id }).where(eq(meanings.id, localized.meaningId));

    const shown = JSON.stringify(await getTest());
    expect(shown).not.toContain(aiWord);
    expect(shown).not.toContain(privateWord);
    await api('post').send({ answers: [{ questionId: localized.meaningId, optionId: null }] }).expect(400);
  });

  it('returns no questions when there is no content, and a constant query count otherwise', async () => {
    const { queries } = await h.countQueries(() => getTest());
    await h.reset();
    auth = await h.token(USER);
    const empty = await h.countQueries(() => getTest());
    expect(empty.result).toEqual([]);
    expect(empty.queries).toBe(queries);
  });
});
