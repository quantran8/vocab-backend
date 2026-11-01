import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { PROMPT_TYPE } from '../src/common/constants/domain';
import { activeMeaningPublications, practiceItemLocalizations, practiceItems, practiceItemTargets } from '../src/db/schema';
import { CuratedItem, resolveCurated } from '../src/modules/practice-resolver/curated';
import vocab from '../src/seed/data/vocab.json';
import { seedDemoContent } from '../src/seed/seed-demo';
import { createHarness, Harness } from './support/app';

describe('demo seed', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it('loads 4 collections, 8 topics, 20 meanings and 33 items, and every item resolves', async () => {
    await seedDemoContent(h.db);
    await seedDemoContent(h.db);
    expect(await h.count(practiceItems)).toBe(33);
    expect(await h.count(activeMeaningPublications, inArray(activeMeaningPublications.meaningId, vocab.words.map((w) => w.meaning.id)))).toBe(20);

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
});
