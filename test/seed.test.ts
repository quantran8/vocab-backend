import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { DEFAULT_ACCENT, LEARNING_LANGUAGE, PROMPT_TYPE } from '../src/common/constants/domain';
import {
  activeMeaningPublications, meaningPublications, meanings, practiceItemLocalizations, practiceItems, practiceItemTargets, pronunciations, topics, words, wordTypes,
} from '../src/db/schema';
import { CuratedItem, resolveCurated } from '../src/modules/practice-resolver/curated';
import vocabPack2 from '../src/seed/data/vocab-pack-2.json';
import vocab from '../src/seed/data/vocab.json';
import { seedDemoContent } from '../src/seed/seed-demo';
import { createHarness, Harness } from './support/app';

describe('demo seed', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); await h.reset(); });
  afterAll(async () => { await h.close(); });

  it('loads 13 topics, 120 meanings and 218 items, and every item resolves', async () => {
    // A learner's custom word got there first: the seed must attach to it, not fail on the unique lemma.
    const [custom] = await h.db.insert(words).values({ language: LEARNING_LANGUAGE, lemma: 'Doctor' }).returning({ id: words.id });
    const [customType] = await h.db.insert(wordTypes).values({ wordId: custom.id, partOfSpeech: 'noun' }).returning({ id: wordTypes.id });
    const [customPronunciation] = await h.db
      .insert(pronunciations)
      .values({ typeId: customType.id, accentLocale: DEFAULT_ACCENT, ipa: '/private/' })
      .returning({ id: pronunciations.id });

    // Shared content on an unrelated word must not stop the private row from giving way.
    const [other] = await h.db.insert(words).values({ language: LEARNING_LANGUAGE, lemma: 'unrelated' }).returning({ id: words.id });
    const [otherType] = await h.db.insert(wordTypes).values({ wordId: other.id, partOfSpeech: 'noun' }).returning({ id: wordTypes.id });
    await h.db.insert(meanings).values({ typeId: otherType.id });

    await seedDemoContent(h.db);
    await seedDemoContent(h.db);
    expect(await h.count(practiceItems)).toBe(218);
    const meaningIds = [...vocab.words, ...vocabPack2.words].map((w) => w.meaning.id);
    expect(await h.count(activeMeaningPublications, inArray(activeMeaningPublications.meaningId, meaningIds))).toBe(120);
    expect(await h.count(topics, inArray(topics.id, vocabPack2.topics.map((t) => t.id)))).toBe(5);

    expect(await h.count(words, sql`lower(btrim(${words.lemma})) = 'doctor'`)).toBe(1);
    const doctor = vocabPack2.words.find((w) => w.lemma === 'doctor')!;
    const [publication] = await h.db
      .select({ snapshot: meaningPublications.snapshot })
      .from(meaningPublications)
      .where(eq(meaningPublications.meaningId, doctor.meaning.id));
    expect(publication.snapshot).toMatchObject({
      wordId: custom.id,
      typeId: customType.id,
      pronunciations: [{ id: customPronunciation.id, ipa: doctor.pronunciation.ipa }],
    });

    const items = await h.db.select().from(practiceItems);
    const locales = await h.db.select().from(practiceItemLocalizations);
    const targets = await h.db.select().from(practiceItemTargets);
    const ctx = { locale: 'vi-VN', accent: 'en-US', audioPlayback: false, allowPlaceholderAudio: false };
    for (const item of items) {
      const curated: CuratedItem = {
        ...item,
        localizedContent: locales.find((l) => l.practiceItemId === item.id)!.localizedContent,
        targets: targets.filter((t) => t.practiceItemId === item.id),
      };
      const task = resolveCurated(curated, PROMPT_TYPE.TEXT, ctx);
      expect(task, `${item.variant} ${item.id}`).not.toBeNull();
      if (item.variant === 'meaning_clash') {
        const prompt = task!.clientPayload.prompt as { text: string; highlight: { start: number; end: number } };
        expect(prompt.text.slice(prompt.highlight.start, prompt.highlight.end).toLowerCase()).toMatch(/^\w+$/);
      }
    }
  });

  it('keeps pack 2 answers consistent with its words', () => {
    for (const w of vocabPack2.words) {
      expect(w.example.text.slice(w.example.start, w.example.end).toLowerCase()).toBe(w.lemma);
    }
    for (const item of vocabPack2.items) {
      const { lemmaForQA } = item.targets[0];
      const body = item.sourceContent.body as { word?: string; options?: { id: number; text: string }[] };
      const key = item.sourceEvaluation as { correctOptionId?: number; wrongGraphemeIndex?: number; replacement?: string };
      if (item.template === 'cloze_select' || item.variant === 'phonetic_choice') {
        expect(body.options!.find((o) => o.id === key.correctOptionId)?.text, item.key).toBe(lemmaForQA);
      }
      if (item.template === 'surgery') {
        const repaired = [...body.word!];
        repaired[key.wrongGraphemeIndex!] = key.replacement!;
        expect(repaired.join(''), item.key).toBe(lemmaForQA);
      }
    }
  });
});
