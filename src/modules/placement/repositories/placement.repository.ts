import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { MEANING_ORIGIN } from '../../../common/constants/domain';
import { DB, Db } from '../../../db/db';
import { meanings, userSettings, wordTypes } from '../../../db/schema';
import { CEFR_ARRAY } from '../../session-planner/repositories/planner.repository';
import { PlacementCandidate } from '../domain/placement';

@Injectable()
export class PlacementRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async explanationLocale(userId: string) {
    const [row] = await this.db
      .select({ locale: userSettings.explanationLocale })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    return row?.locale;
  }

  // Reviewed shared content only, easiest first; one Meaning per Word so no word is asked twice.
  candidates(locale: string, perLevel: number) {
    return this.db.execute<PlacementCandidate>(sql`
      WITH candidates AS (
        SELECT DISTINCT ON (wt.word_id) wt.word_id, m.id AS meaning_id, m.cefr_level,
          p.snapshot->>'lemma' AS lemma, p.snapshot->>'meaningText' AS meaning_text
        FROM active_meaning_publications a
        JOIN meaning_publications p ON p.id = a.publication_id
        JOIN meaning_localizations ml ON ml.meaning_id = a.meaning_id AND ml.locale = a.locale
        JOIN meanings m ON m.id = a.meaning_id
        JOIN word_types wt ON wt.id = m.type_id
        WHERE a.locale = ${locale} AND a.recalled_at IS NULL AND ml.origin = ${MEANING_ORIGIN.CURATED}
          AND m.owner_user_id IS NULL AND m.cefr_level IS NOT NULL
        ORDER BY wt.word_id, random()
      ), ranked AS (
        SELECT *, row_number() OVER (PARTITION BY cefr_level ORDER BY random()) AS rn FROM candidates
      )
      SELECT meaning_id AS "meaningId", word_id AS "wordId", lemma, meaning_text AS "meaningText"
      FROM ranked
      WHERE rn <= ${perLevel}::int
      ORDER BY array_position(${CEFR_ARRAY}, cefr_level), rn`).then((r) => r.rows);
  }

  questionKeys(meaningIds: string[]) {
    return this.db
      .select({ meaningId: meanings.id, level: meanings.cefrLevel, wordId: wordTypes.wordId })
      .from(meanings)
      .innerJoin(wordTypes, eq(wordTypes.id, meanings.typeId))
      .where(and(inArray(meanings.id, meaningIds), isNull(meanings.ownerUserId), isNotNull(meanings.cefrLevel)));
  }
}
