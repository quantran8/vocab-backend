import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, or, sql, SQL } from 'drizzle-orm';
import { CHECKPOINT_STATE, DEFAULT_ACCENT, Skill, VALIDITY } from '../../../common/constants/domain';
import { DB, Db } from '../../../db/db';
import { skillEvidence } from '../../../db/schema';
import { MeaningOverride } from '../../practice-resolver/meaning-override';
import { MeaningSnapshot } from '../../practice-resolver/task.types';
import { EvidenceRow } from '../../skill-verification/skill-evidence';
import { openSkillIssuesSql, skillStateReasonsSql } from '../../skill-verification/skill-issue.sql';

export type RawMeaningRow = {
  wordId: string;
  meaningId: string;
  snapshot: MeaningSnapshot;
  learnedAt: string | null;
  nextReviewAt: string | null;
  override: MeaningOverride | null;
};

export interface EvidenceQueryRow extends EvidenceRow {
  skill: Skill;
  meaningId: string | null;
  pronunciationId: string | null;
}

const DIACRITICS: Record<string, string> = {
  a: 'àáảãạăằắẳẵặâầấẩẫậ', e: 'èéẻẽẹêềếểễệ', i: 'ìíỉĩị', o: 'òóỏõọôồốổỗộơờớởỡợ', u: 'ùúủũụưừứửữự', y: 'ỳýỷỹỵ', d: 'đ',
};
const FOLD_PAIRS = Object.entries(DIACRITICS).flatMap(([base, marked]) =>
  [...marked, ...marked.toUpperCase()].map((char) => [char, base] as const));
const FOLD_FROM = FOLD_PAIRS.map(([char]) => char).join('');
const FOLD_TO = FOLD_PAIRS.map(([, base]) => base).join('');
const FOLD_MAP = new Map(FOLD_PAIRS);

const foldedColumn = (column: SQL) => sql`translate(lower(${column}), ${FOLD_FROM}, ${FOLD_TO})`;

/** Case- and diacritic-insensitive LIKE pattern; the query's own wildcards match literally. */
const searchPattern = (query: string) => {
  const folded = [...query.normalize('NFC').toLowerCase()].map((char) => FOLD_MAP.get(char) ?? char).join('');
  return `%${folded.replace(/[\\%_]/g, '\\$&')}%`;
};

@Injectable()
export class ProgressRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // Single statement: the home screen never needs more than one round trip.
  async learnHomeCounts(userId: string, now: Date, required: number) {
    const { rows: [row] } = await this.db.execute<{ dueCount: number; checkpointAvailable: number; checkpointSessionsDone: number; learnedTotal: number }>(sql`
      SELECT
        (SELECT count(*)::int
         FROM user_meaning_progress ump
         JOIN user_settings s ON s.user_id = ump.user_id
         JOIN active_meaning_publications a
           ON a.meaning_id = ump.meaning_id AND a.locale = s.explanation_locale AND a.recalled_at IS NULL
         WHERE ump.user_id = ${userId}::uuid AND ump.next_review_at <= ${now}::timestamptz
           AND EXISTS (
             SELECT 1 FROM topic_meanings tm
             JOIN user_active_topics uat ON uat.topic_id = tm.topic_id AND uat.user_id = ump.user_id
             WHERE tm.meaning_id = ump.meaning_id)) AS "dueCount",
        (SELECT count(*)::int FROM checkpoint_challenges
         WHERE user_id = ${userId}::uuid AND state = ${CHECKPOINT_STATE.AVAILABLE}) AS "checkpointAvailable",
        -- Same pending set as CheckpointService.generateFor.
        (SELECT LEAST(count(DISTINCT p.learned_session_id), ${required}::int)::int
         FROM user_meaning_progress p
         WHERE p.user_id = ${userId}::uuid AND p.learned_session_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM checkpoint_challenge_meanings m
             JOIN checkpoint_challenges c ON c.id = m.challenge_id
             WHERE c.user_id = p.user_id AND m.meaning_id = p.meaning_id)) AS "checkpointSessionsDone",
        (SELECT count(*)::int FROM user_meaning_progress WHERE user_id = ${userId}::uuid) AS "learnedTotal"`);
    return row;
  }

  async learnedWordsPage(userId: string, limit: number, offset: number, query?: string) {
    const matches = query
      ? sql`bool_or(${foldedColumn(sql`snapshot->>'lemma'`)} LIKE ${searchPattern(query)}
          OR ${foldedColumn(sql`COALESCE(override->>'meaningText', snapshot->>'meaningText')`)} LIKE ${searchPattern(query)})`
      : sql`true`;
    // The publication join sits inside `learned` so a page is always full while more words remain.
    const { rows } = await this.db.execute<RawMeaningRow & { meaningCount: number }>(sql`
      WITH learned AS (
        SELECT ump.meaning_id, ump.learned_at, ump.next_review_at, wt.word_id, p.snapshot, o.content AS override
        FROM user_meaning_progress ump
        JOIN meanings m ON m.id = ump.meaning_id
        JOIN word_types wt ON wt.id = m.type_id
        JOIN user_settings s ON s.user_id = ump.user_id
        JOIN active_meaning_publications a ON a.meaning_id = ump.meaning_id AND a.locale = s.explanation_locale
        JOIN meaning_publications p ON p.id = a.publication_id
        LEFT JOIN user_meaning_overrides o ON o.user_id = ump.user_id AND o.meaning_id = ump.meaning_id AND o.locale = s.explanation_locale
        WHERE ump.user_id = ${userId}::uuid
      ), page AS (
        SELECT word_id, max(learned_at) AS last_learned
        FROM learned GROUP BY word_id HAVING ${matches}
        ORDER BY last_learned DESC, word_id LIMIT ${limit} OFFSET ${offset}
      ), totals AS (
        -- Same visibility as wordMeanings, so the count matches the word detail.
        SELECT page.word_id, count(*)::int AS meaning_count
        FROM page
        JOIN word_types wt ON wt.word_id = page.word_id
        JOIN meanings m ON m.type_id = wt.id
        JOIN user_settings s ON s.user_id = ${userId}::uuid
        JOIN active_meaning_publications a ON a.meaning_id = m.id AND a.locale = s.explanation_locale
        LEFT JOIN user_meaning_progress ump ON ump.meaning_id = m.id AND ump.user_id = s.user_id
        WHERE (a.recalled_at IS NULL OR ump.user_id IS NOT NULL)
          AND (m.owner_user_id IS NULL OR m.owner_user_id = s.user_id)
        GROUP BY page.word_id
      )
      SELECT l.word_id AS "wordId", l.meaning_id AS "meaningId", l.snapshot, l.override,
             l.learned_at AS "learnedAt", l.next_review_at AS "nextReviewAt", t.meaning_count AS "meaningCount"
      FROM learned l
      JOIN page ON page.word_id = l.word_id
      JOIN totals t ON t.word_id = l.word_id
      ORDER BY page.last_learned DESC, l.word_id, l.learned_at`);
    return rows;
  }

  /** Mirrors deriveSkillStatus's needsPractice (latest skill issue not yet recovered) in one statement. */
  async wordStats(userId: string) {
    const { rows: [row] } = await this.db.execute<{ learnedWords: number; needPracticeWords: number }>(sql`
      WITH learned AS (
        SELECT wt.word_id, ump.meaning_id,
          (SELECT (e->>'id')::uuid FROM jsonb_array_elements(p.snapshot->'pronunciations') e
           WHERE e->>'accentLocale' = ${DEFAULT_ACCENT} LIMIT 1) AS pronunciation_id
        FROM user_meaning_progress ump
        JOIN meanings m ON m.id = ump.meaning_id
        JOIN word_types wt ON wt.id = m.type_id
        JOIN user_settings s ON s.user_id = ump.user_id
        JOIN active_meaning_publications a ON a.meaning_id = ump.meaning_id AND a.locale = s.explanation_locale
        JOIN meaning_publications p ON p.id = a.publication_id
        WHERE ump.user_id = ${userId}::uuid
      ), open_issue AS (${openSkillIssuesSql(userId)})
      SELECT count(DISTINCT l.word_id)::int AS "learnedWords",
        count(DISTINCT l.word_id) FILTER (WHERE EXISTS (
          SELECT 1 FROM open_issue e
          WHERE e.meaning_id = l.meaning_id OR e.pronunciation_id = l.pronunciation_id))::int AS "needPracticeWords"
      FROM learned l`);
    return row;
  }

  async wordMeanings(userId: string, wordId: string) {
    const { rows } = await this.db.execute<RawMeaningRow>(sql`
        SELECT wt.word_id AS "wordId", m.id AS "meaningId", p.snapshot, o.content AS override,
               ump.learned_at AS "learnedAt", ump.next_review_at AS "nextReviewAt"
        FROM word_types wt
        JOIN meanings m ON m.type_id = wt.id
        JOIN user_settings s ON s.user_id = ${userId}::uuid
        JOIN active_meaning_publications a ON a.meaning_id = m.id AND a.locale = s.explanation_locale
        JOIN meaning_publications p ON p.id = a.publication_id
        LEFT JOIN user_meaning_progress ump ON ump.meaning_id = m.id AND ump.user_id = s.user_id
        LEFT JOIN user_meaning_overrides o ON o.user_id = s.user_id AND o.meaning_id = m.id AND o.locale = s.explanation_locale
        WHERE wt.word_id = ${wordId}::uuid AND (a.recalled_at IS NULL OR ump.user_id IS NOT NULL)
          AND (m.owner_user_id IS NULL OR m.owner_user_id = s.user_id)
        ORDER BY m.id`);
    return rows;
  }

  async evidence(userId: string, meaningIds: string[], pronunciationIds: string[]) {
    const rows = await this.db
      .select({
        sessionId: skillEvidence.sessionId,
        skill: skillEvidence.skill,
        passed: skillEvidence.passed,
        reasons: skillEvidence.reasons,
        committedAt: skillEvidence.committedAt,
        meaningId: skillEvidence.meaningId,
        pronunciationId: skillEvidence.pronunciationId,
      })
      .from(skillEvidence)
      .where(and(
        eq(skillEvidence.userId, userId),
        skillStateReasonsSql,
        eq(skillEvidence.validity, VALIDITY.VALID),
        or(inArray(skillEvidence.meaningId, meaningIds), pronunciationIds.length > 0 ? inArray(skillEvidence.pronunciationId, pronunciationIds) : undefined),
      ))
      .orderBy(asc(skillEvidence.committedAt), asc(skillEvidence.id));
    return rows as EvidenceQueryRow[];
  }
}
