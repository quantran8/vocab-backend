import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, SQL } from 'drizzle-orm';
import { EDITORIAL_STATE, ITEM_STATUS } from '../../../common/constants/domain';
import { DB, Db, toDate } from '../../../db/db';
import { practiceItemLocalizations, practiceItems, practiceItemTargets } from '../../../db/schema';
import { TargetRef } from '../../practice-resolver/task.types';
import { IN_USE, mapPgErrors } from '../domain/admin.errors';
import { CreateItem, ItemLocale, ListItems, PatchItem } from '../dto/admin.schemas';

type Targets = CreateItem['targets'];
type ItemFields = Omit<CreateItem, 'targets'>;

const targetsJson = (itemId: SQL) => sql`
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'ordinal', t.ordinal, 'meaningId', t.meaning_id, 'pronunciationId', t.pronunciation_id, 'lemma', COALESCE(w.lemma, pw.lemma)) ORDER BY t.ordinal)
    FROM practice_item_targets t
    LEFT JOIN meanings m ON m.id = t.meaning_id
    LEFT JOIN word_types mt ON mt.id = m.type_id
    LEFT JOIN words w ON w.id = mt.word_id
    LEFT JOIN pronunciations pr ON pr.id = t.pronunciation_id
    LEFT JOIN word_types pt ON pt.id = pr.type_id
    LEFT JOIN words pw ON pw.id = pt.word_id
    WHERE t.practice_item_id = ${itemId}), '[]')`;

export type ItemForPublish = {
  status: string; supersedesItemId: string | null; template: string; variant: string | null; contextCefrLevel: string | null;
  sourceContent: unknown; sourceEvaluation: unknown; targets: TargetRef[]; approved: { locale: string; content: Record<string, unknown> }[];
};

@Injectable()
export class AdminPracticeItemsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list({ template, variant, status, meaningId, limit, offset }: ListItems) {
    const conditions = [
      template ? sql`i.template = ${template}` : sql`true`,
      variant ? sql`i.variant = ${variant}` : sql`true`,
      status ? sql`i.status = ${status}` : sql`true`,
      meaningId ? sql`EXISTS (SELECT 1 FROM practice_item_targets t WHERE t.practice_item_id = i.id AND t.meaning_id = ${meaningId}::uuid)` : sql`true`,
    ];
    const { rows: [page] } = await this.db.execute<{ total: number; items: { createdAt: string }[] }>(sql`
      WITH filtered AS (
        SELECT i.id, i.template, i.variant, i.status, i.context_cefr_level, i.supersedes_item_id, i.approved_at, i.created_at
        FROM practice_items i WHERE ${sql.join(conditions, sql` AND `)}
      ), page AS (
        SELECT * FROM filtered ORDER BY created_at DESC, id LIMIT ${limit} OFFSET ${offset}
      )
      SELECT (SELECT count(*)::int FROM filtered) AS total, COALESCE(jsonb_agg(row ORDER BY row."createdAt" DESC, row.id), '[]') AS items
      FROM (
        SELECT p.id, p.template, p.variant, p.status, p.context_cefr_level AS "contextCefrLevel", p.supersedes_item_id AS "supersedesItemId",
          p.approved_at AS "approvedAt", p.created_at AS "createdAt",
          ${targetsJson(sql`p.id`)} AS targets,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('locale', l.locale, 'editorialState', l.editorial_state) ORDER BY l.locale)
                    FROM practice_item_localizations l WHERE l.practice_item_id = p.id), '[]') AS locales
        FROM page p
      ) row`);
    return { total: page.total, items: page.items.map((i) => ({ ...i, createdAt: toDate(i.createdAt) })) };
  }

  async find(id: string) {
    const { rows: [item] } = await this.db.execute<{ createdAt: string }>(sql`
      SELECT i.id, i.template, i.variant, i.status, i.context_cefr_level AS "contextCefrLevel", i.supersedes_item_id AS "supersedesItemId",
        i.source_content AS "sourceContent", i.source_evaluation AS "sourceEvaluation", i.approved_at AS "approvedAt", i.created_at AS "createdAt",
        ${targetsJson(sql`i.id`)} AS targets,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'locale', l.locale, 'localizedContent', l.localized_content, 'contextualExplain', l.contextual_explain,
            'editorialState', l.editorial_state, 'approvedAt', l.approved_at) ORDER BY l.locale)
          FROM practice_item_localizations l WHERE l.practice_item_id = i.id), '[]') AS localizations,
        (SELECT s.id FROM practice_items s WHERE s.supersedes_item_id = i.id LIMIT 1) AS "supersededByItemId"
      FROM practice_items i WHERE i.id = ${id}::uuid`);
    return item && { ...item, createdAt: toDate(item.createdAt) };
  }

  async findShape(id: string) {
    const [row] = await this.db
      .select({ status: practiceItems.status, template: practiceItems.template, variant: practiceItems.variant })
      .from(practiceItems)
      .where(eq(practiceItems.id, id));
    return row;
  }

  async statusOf(id: string) {
    const [item] = await this.db.select({ status: practiceItems.status }).from(practiceItems).where(eq(practiceItems.id, id));
    return item?.status;
  }

  async insert(id: string, item: ItemFields, targets: Targets) {
    await this.db.transaction(async (tx) => {
      await mapPgErrors(tx.insert(practiceItems).values({ ...item, id }), { fk: 'Superseded item does not exist', fkCode: 'TASK_DATA_INVALID' });
      await tx.insert(practiceItemTargets).values(targets.map((target, ordinal) => ({ ...target, practiceItemId: id, ordinal })));
    });
  }

  // Only a draft is touched, so a concurrent publish wins over the edit.
  async updateDraft(id: string, fields: Omit<PatchItem, 'targets'>, targets?: Targets) {
    await this.db.transaction(async (tx) => {
      if (Object.keys(fields).length > 0) {
        await tx.update(practiceItems).set(fields).where(and(eq(practiceItems.id, id), eq(practiceItems.status, ITEM_STATUS.DRAFT)));
      }
      if (targets) {
        await tx.delete(practiceItemTargets).where(eq(practiceItemTargets.practiceItemId, id));
        await tx.insert(practiceItemTargets).values(targets.map((target, ordinal) => ({ ...target, practiceItemId: id, ordinal })));
      }
    });
  }

  async removeDraft(id: string) {
    await mapPgErrors(this.db.execute(sql`
      WITH del_locales AS (DELETE FROM practice_item_localizations WHERE practice_item_id = ${id}::uuid),
      del_targets AS (DELETE FROM practice_item_targets WHERE practice_item_id = ${id}::uuid)
      DELETE FROM practice_items WHERE id = ${id}::uuid AND status = ${ITEM_STATUS.DRAFT}`), { fk: IN_USE });
  }

  async retire(id: string) {
    const [row] = await this.db
      .update(practiceItems)
      .set({ status: ITEM_STATUS.RETIRED })
      .where(and(eq(practiceItems.id, id), eq(practiceItems.status, ITEM_STATUS.PUBLISHED)))
      .returning({ id: practiceItems.id });
    return Boolean(row);
  }

  async upsertLocale(practiceItemId: string, locale: string, body: ItemLocale, approvedAt: Date | null) {
    const data = { ...body, approvedAt };
    await mapPgErrors(
      this.db
        .insert(practiceItemLocalizations)
        .values({ practiceItemId, locale, ...data })
        .onConflictDoUpdate({ target: [practiceItemLocalizations.practiceItemId, practiceItemLocalizations.locale], set: data }),
      { fk: 'Practice item not found', fkCode: 'NOT_FOUND' },
    );
  }

  async findForPublish(id: string) {
    const { rows: [item] } = await this.db.execute<ItemForPublish>(sql`
      SELECT i.status, i.supersedes_item_id AS "supersedesItemId", i.template, i.variant, i.context_cefr_level AS "contextCefrLevel",
             i.source_content AS "sourceContent", i.source_evaluation AS "sourceEvaluation",
             COALESCE((SELECT jsonb_agg(jsonb_build_object('meaningId', t.meaning_id, 'pronunciationId', t.pronunciation_id) ORDER BY t.ordinal)
                       FROM practice_item_targets t WHERE t.practice_item_id = i.id), '[]') AS targets,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('locale', l.locale, 'content', l.localized_content))
                       FROM practice_item_localizations l
                       WHERE l.practice_item_id = i.id AND l.editorial_state = ${EDITORIAL_STATE.APPROVED}), '[]') AS approved
      FROM practice_items i WHERE i.id = ${id}::uuid`);
    return item;
  }

  // The superseded item retires in the same transaction, so a revision never leaves two live versions.
  async publish(id: string, approvedAt: Date, supersedesItemId: string | null) {
    const publish = { status: ITEM_STATUS.PUBLISHED, approvedAt };
    if (!supersedesItemId) {
      await this.db.update(practiceItems).set(publish).where(eq(practiceItems.id, id));
      return;
    }
    await this.db.transaction(async (tx) => {
      await tx.update(practiceItems).set(publish).where(eq(practiceItems.id, id));
      await tx
        .update(practiceItems)
        .set({ status: ITEM_STATUS.RETIRED })
        .where(and(eq(practiceItems.id, supersedesItemId), eq(practiceItems.status, ITEM_STATUS.PUBLISHED)));
    });
  }

  async countMissingTargets(targets: Targets) {
    const { rows: [known] } = await this.db.execute<{ missing: number }>(sql`
      SELECT count(*)::int AS missing
      FROM jsonb_to_recordset(${JSON.stringify(targets)}::jsonb) AS x("meaningId" uuid, "pronunciationId" uuid)
      LEFT JOIN meanings m ON m.id = x."meaningId" AND m.owner_user_id IS NULL
      LEFT JOIN pronunciations p ON p.id = x."pronunciationId"
      WHERE (x."meaningId" IS NOT NULL AND m.id IS NULL) OR (x."pronunciationId" IS NOT NULL AND p.id IS NULL)`);
    return known.missing;
  }

  async countAlignedTargets(dual: Targets) {
    const { rows: [row] } = await this.db.execute<{ aligned: number }>(sql`
      SELECT count(*)::int AS aligned
      FROM jsonb_to_recordset(${JSON.stringify(dual)}::jsonb) AS x("meaningId" uuid, "pronunciationId" uuid)
      JOIN meanings m ON m.id = x."meaningId"
      JOIN pronunciations p ON p.id = x."pronunciationId" AND p.type_id = m.type_id`);
    return row.aligned;
  }
}
