import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { Clock } from '../../common/clock';
import { EDITORIAL_STATE, ITEM_STATUS, Template, TEMPLATE_VARIANTS, Variant } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { newId } from '../../common/ids';
import { DB, Db } from '../../db/db';
import {
  exampleLocalizations, meaningExamples, meaningLocalizations, meanings, practiceItemLocalizations, practiceItems,
  practiceItemTargets, pronunciations, words, wordTypes,
} from '../../db/schema';
import { curatedContentSchema } from '../practice-resolver/curated';
import { CreateItem, CreateWord, ItemLocale, MeaningLocale } from './admin.schemas';

@Injectable()
export class AdminService {
  constructor(@Inject(DB) private readonly db: Db, private readonly clock: Clock) {}

  async createWord(body: CreateWord) {
    const wordId = newId();
    const types = body.types.map((type) => ({
      ...type,
      id: newId(),
      pronunciations: type.pronunciations.map((p) => ({ ...p, id: newId() })),
      meanings: type.meanings.map((meaning) => ({
        ...meaning,
        id: newId(),
        examples: meaning.examples.map((example) => ({ ...example, id: newId() })),
      })),
    }));
    const typeMeanings = types.flatMap((t) => t.meanings.map((m) => ({ ...m, typeId: t.id })));
    const pronunciationRows = types.flatMap((t) => t.pronunciations.map((p) => ({ ...p, typeId: t.id })));
    const exampleRows = typeMeanings.flatMap((m) =>
      m.examples.map(({ id, sourceText, targetLocator }) => ({ id, meaningId: m.id, sourceText, targetLocator })),
    );

    await this.db.transaction(async (tx) => {
      await tx.insert(words).values({ id: wordId, language: body.language, lemma: body.lemma, homographKey: body.homographKey });
      await tx.insert(wordTypes).values(types.map(({ id, partOfSpeech }) => ({ id, wordId, partOfSpeech })));
      if (pronunciationRows.length > 0) await tx.insert(pronunciations).values(pronunciationRows);
      await tx.insert(meanings).values(typeMeanings.map(({ id, typeId, cefrLevel, coreDefinition }) => ({ id, typeId, cefrLevel, coreDefinition })));
      if (exampleRows.length > 0) await tx.insert(meaningExamples).values(exampleRows);
    });
    return { wordId, types };
  }

  async putMeaningLocale(meaningId: string, locale: string, body: MeaningLocale) {
    const { exampleTranslations, ...text } = body;
    const updatedAt = this.clock.now();
    const exampleIds = exampleTranslations.map((t) => t.exampleId);
    const [{ owned }] = await this.db
      .select({ owned: count() })
      .from(meaningExamples)
      .where(and(eq(meaningExamples.meaningId, meaningId), inArray(meaningExamples.id, exampleIds)));
    if (owned !== exampleIds.length) throw new ApiError('VALIDATION_FAILED', 'Example does not belong to this Meaning');

    await this.db.transaction(async (tx) => {
      await tx
        .insert(meaningLocalizations)
        .values({ meaningId, locale, ...text, updatedAt })
        .onConflictDoUpdate({ target: [meaningLocalizations.meaningId, meaningLocalizations.locale], set: { ...text, updatedAt } });
      if (exampleIds.length === 0) return;
      await tx.delete(exampleLocalizations).where(and(eq(exampleLocalizations.locale, locale), inArray(exampleLocalizations.exampleId, exampleIds)));
      await tx.insert(exampleLocalizations).values(exampleTranslations.map((t) => ({ ...t, locale })));
    });
    return { meaningId, locale, editorialState: text.editorialState };
  }

  async createItem(body: CreateItem) {
    if (!TEMPLATE_VARIANTS[body.template as Template].includes(body.variant as Variant)) {
      throw new ApiError('TASK_DATA_INVALID', `Variant ${body.variant} is not valid for ${body.template}`);
    }
    if (!curatedContentSchema.safeParse(body.sourceContent).success) throw new ApiError('TASK_DATA_INVALID', 'promptVariants missing');

    const { targets, ...item } = body;
    await this.assertAligned(targets);
    const id = newId();
    await this.db.transaction(async (tx) => {
      await tx.insert(practiceItems).values({ ...item, id });
      await tx.insert(practiceItemTargets).values(targets.map((target, ordinal) => ({ ...target, practiceItemId: id, ordinal })));
    });
    return { id };
  }

  // C52: a dual target must point at the same Word/Type.
  private async assertAligned(targets: CreateItem['targets']) {
    const dual = targets.filter((t) => t.meaningId && t.pronunciationId);
    if (dual.length === 0) return;
    const { rows } = await this.db.execute<{ aligned: number }>(sql`
      SELECT count(*)::int AS aligned
      FROM jsonb_to_recordset(${JSON.stringify(dual)}::jsonb) AS x("meaningId" uuid, "pronunciationId" uuid)
      JOIN meanings m ON m.id = x."meaningId"
      JOIN pronunciations p ON p.id = x."pronunciationId" AND p.type_id = m.type_id`);
    if (rows[0].aligned !== dual.length) throw new ApiError('TASK_DATA_INVALID', 'Meaning and pronunciation targets differ in Word/Type');
  }

  async putItemLocale(practiceItemId: string, locale: string, body: ItemLocale) {
    const approvedAt = body.editorialState === EDITORIAL_STATE.APPROVED ? this.clock.now() : null;
    const data = { ...body, approvedAt };
    await this.db
      .insert(practiceItemLocalizations)
      .values({ practiceItemId, locale, ...data })
      .onConflictDoUpdate({ target: [practiceItemLocalizations.practiceItemId, practiceItemLocalizations.locale], set: data });
    return { practiceItemId, locale, editorialState: body.editorialState };
  }

  async publishItem(id: string) {
    const { rows: [item] } = await this.db.execute<{ status: string; supersedesItemId: string | null; targets: number; approvedLocales: number }>(sql`
      SELECT i.status, i.supersedes_item_id AS "supersedesItemId",
             (SELECT count(*)::int FROM practice_item_targets t WHERE t.practice_item_id = i.id) AS targets,
             (SELECT count(*)::int FROM practice_item_localizations l
              WHERE l.practice_item_id = i.id AND l.editorial_state = ${EDITORIAL_STATE.APPROVED}) AS "approvedLocales"
      FROM practice_items i WHERE i.id = ${id}::uuid`);
    if (!item) throw new ApiError('NOT_FOUND', 'Practice item not found');
    if (item.targets === 0) throw new ApiError('TASK_DATA_INVALID', 'Item has no target');
    if (item.approvedLocales === 0) throw new ApiError('TASK_DATA_INVALID', 'Item has no approved locale');

    const now = this.clock.now();
    const publish = { status: ITEM_STATUS.PUBLISHED, approvedAt: now };
    if (!item.supersedesItemId) {
      await this.db.update(practiceItems).set(publish).where(eq(practiceItems.id, id));
    } else {
      const supersedesItemId = item.supersedesItemId;
      await this.db.transaction(async (tx) => {
        await tx.update(practiceItems).set(publish).where(eq(practiceItems.id, id));
        await tx
          .update(practiceItems)
          .set({ status: ITEM_STATUS.RETIRED })
          .where(and(eq(practiceItems.id, supersedesItemId), eq(practiceItems.status, ITEM_STATUS.PUBLISHED)));
      });
    }
    return { id, status: ITEM_STATUS.PUBLISHED };
  }
}
