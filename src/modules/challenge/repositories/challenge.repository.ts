import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lte, SQL, sql } from 'drizzle-orm';
import { CHALLENGE_OPEN_STATUSES, CHALLENGE_ROLE, CHALLENGE_RUN_STATUS, ChallengeRunStatus, NewWordsBlockedReason } from '../../../common/constants/domain';
import { POLICY } from '../../../config/policy';
import { DB, Db, toDate, Tx } from '../../../db/db';
import { challengeChapterMeanings, challengeChapters, challengeLevelProgress, challengeRuns } from '../../../db/schema';
import { newWordsBlockedSql } from '../../review-load/repositories/review-scope.sql';
import { ChapterSummary } from '../domain/challenge-map';
import { Slot } from '../domain/chapter-content';
import { RunPlan, SlotContent } from '../domain/match-madness';

const { challenge } = POLICY;
const OPEN = sql.join(CHALLENGE_OPEN_STATUSES.map((s) => sql`${s}`), sql`, `);
const LAST_LEVEL = challenge.levels.length;

export type CandidateRow = SlotContent;
export type SlotRow = Slot & { id: string; valid: boolean };
export interface LevelProgressRow { bestStars: number; bestScore: number; bestCompletionMs: number | null; firstClearedAt: string | null }

/** Shared content, or the learner's own private Meaning while it is still in their personal list. */
const visibleTo = (userId: string, meaning: SQL) => sql`(${meaning}.owner_user_id IS NULL OR (${meaning}.owner_user_id = ${userId}::uuid AND EXISTS (
  SELECT 1 FROM topic_meanings tm JOIN topics t ON t.id = tm.topic_id
  WHERE t.owner_user_id = ${userId}::uuid AND tm.meaning_id = ${meaning}.id)))`;

/** Learned Meanings usable on a board in `locale`, oldest first; the learner's own edit replaces the gloss. */
const learnedContent = (userId: string, locale: SQL) => sql`
  SELECT ump.meaning_id AS "meaningId", ump.learned_at,
    p.snapshot->>'lemma' AS lemma, COALESCE(o.content->>'meaningText', p.snapshot->>'meaningText') AS gloss
  FROM user_meaning_progress ump
  JOIN meanings m ON m.id = ump.meaning_id
  JOIN active_meaning_publications a ON a.meaning_id = ump.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
  JOIN meaning_publications p ON p.id = a.publication_id
  LEFT JOIN user_meaning_overrides o ON o.user_id = ump.user_id AND o.meaning_id = ump.meaning_id AND o.locale = a.locale
  WHERE ump.user_id = ${userId}::uuid AND ${visibleTo(userId, sql`m`)}`;

const unallocated = (userId: string, locale: SQL) => sql`
  SELECT l."meaningId", l.lemma, l.gloss FROM (${learnedContent(userId, locale)}) l
  WHERE NOT EXISTS (
    SELECT 1 FROM challenge_chapter_meanings x
    WHERE x.user_id = ${userId}::uuid AND x.meaning_id = l."meaningId" AND x.role = ${CHALLENGE_ROLE.CORE} AND x.retired_in_version IS NULL)
  ORDER BY l.learned_at, l."meaningId"
  LIMIT ${challenge.candidateScanLimit}`;

const slotValid = (userId: string, slot: SQL, locale: SQL) => sql`EXISTS (
  SELECT 1 FROM active_meaning_publications a JOIN meanings m ON m.id = a.meaning_id
  WHERE a.meaning_id = ${slot}.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL AND ${visibleTo(userId, sql`m`)})`;

const slotsOf = (userId: string, chapterId: SQL, locale: SQL) => sql`
  COALESCE((SELECT json_agg(json_build_object(
      'id', s.id, 'meaningId', s.meaning_id, 'role', s.role, 'sortIndex', s.sort_index, 'lemma', s.lemma, 'gloss', s.gloss,
      'wordKey', s.word_key, 'glossKey', s.gloss_key, 'valid', ${slotValid(userId, sql`s`, locale)})
    ORDER BY s.role, s.sort_index)
  FROM challenge_chapter_meanings s WHERE s.chapter_id = ${chapterId} AND s.retired_in_version IS NULL), '[]'::json)`;

const asJsonArray = (query: SQL) => sql`COALESCE((SELECT json_agg(q) FROM (${query}) q), '[]'::json)`;

@Injectable()
export class ChallengeRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  transaction<T>(run: (tx: Tx) => Promise<T>) {
    return this.db.transaction(run);
  }

  /** Serialises a learner's materialisation, repair and commits; the timeout bounds every later statement. */
  async lockUser(tx: Tx, userId: string) {
    await tx.execute(sql`
      SELECT set_config('statement_timeout', ${String(POLICY.session.commitTimeoutMs)}, true),
             (SELECT id FROM app_user WHERE id = ${userId}::uuid FOR UPDATE)`);
  }

  /**
   * The whole map in one statement. Slots and candidates are for the earliest uncleared chapter (in its frozen locale),
   * so the map can tell whether a repair would succeed without writing anything.
   */
  async mapState(userId: string) {
    const { rows: [row] } = await this.db.execute<{
      locale: string; chapters: ChapterSummary[]; activeSlots: SlotRow[]; candidates: CandidateRow[];
      /** Only when the active chapter's frozen locale differs from the current one. */
      activeCandidates: CandidateRow[] | null;
      newWordsBlockedReason: NewWordsBlockedReason | null;
    }>(sql`
      WITH settings AS (SELECT explanation_locale AS locale FROM user_settings WHERE user_id = ${userId}::uuid),
      active AS (
        SELECT c.id, c.explanation_locale AS locale FROM challenge_chapters c
        WHERE c.user_id = ${userId}::uuid AND NOT EXISTS (
          SELECT 1 FROM challenge_level_progress lp
          WHERE lp.user_id = c.user_id AND lp.chapter_id = c.id AND lp.level_no = ${LAST_LEVEL} AND lp.best_stars > 0)
        ORDER BY c.chapter_no LIMIT 1)
      SELECT (SELECT locale FROM settings) AS locale,
        COALESCE((SELECT json_agg(json_build_object(
            'id', c.id, 'chapterNo', c.chapter_no, 'explanationLocale', c.explanation_locale,
            'coreMeaningCount', (SELECT count(*) FROM challenge_chapter_meanings s
              WHERE s.chapter_id = c.id AND s.role = ${CHALLENGE_ROLE.CORE} AND s.retired_in_version IS NULL),
            'reviewMeaningCount', (SELECT count(*) FROM challenge_chapter_meanings s
              WHERE s.chapter_id = c.id AND s.role = ${CHALLENGE_ROLE.REVIEW} AND s.retired_in_version IS NULL),
            'levels', COALESCE((SELECT json_agg(json_build_object('levelNo', lp.level_no, 'bestStars', lp.best_stars, 'bestScore', lp.best_score))
              FROM challenge_level_progress lp WHERE lp.user_id = c.user_id AND lp.chapter_id = c.id), '[]'::json))
          ORDER BY c.chapter_no)
          FROM challenge_chapters c WHERE c.user_id = ${userId}::uuid), '[]'::json) AS chapters,
        COALESCE((SELECT ${slotsOf(userId, sql`active.id`, sql`active.locale`)} FROM active), '[]'::json) AS "activeSlots",
        ${asJsonArray(unallocated(userId, sql`(SELECT locale FROM settings)`))} AS candidates,
        CASE WHEN (SELECT locale FROM active) IS DISTINCT FROM (SELECT locale FROM settings)
          THEN ${asJsonArray(unallocated(userId, sql`(SELECT locale FROM active)`))} END AS "activeCandidates",
        ${newWordsBlockedSql(userId, sql`(SELECT locale FROM settings)`)} AS "newWordsBlockedReason"`);
    return row;
  }

  /** Ends the learner's timed-out runs and returns the one still live, if any. */
  async openRun(tx: Tx, userId: string, now: Date) {
    const { rows: [row] } = await tx.execute<{ id: string }>(sql`
      WITH expired AS (
        UPDATE challenge_runs SET status = ${CHALLENGE_RUN_STATUS.EXPIRED}
        WHERE user_id = ${userId}::uuid AND status IN (${OPEN}) AND expires_at <= ${now}::timestamptz)
      SELECT id FROM challenge_runs
      WHERE user_id = ${userId}::uuid AND status IN (${OPEN}) AND expires_at > ${now}::timestamptz`);
    return row?.id;
  }

  /** What issuing a run on `chapterNo` needs: chapter count, the previous chapter's last level, and the chapter's slots and bests. */
  async issueState(tx: Tx, userId: string, chapterNo: number) {
    const { rows: [row] } = await tx.execute<{
      locale: string; lastChapterNo: number; previousCleared: boolean;
      chapter: { id: string; explanationLocale: string; contentVersion: number } | null;
      levels: { levelNo: number; bestStars: number; bestScore: number }[]; slots: SlotRow[];
    }>(sql`
      WITH c AS (SELECT * FROM challenge_chapters WHERE user_id = ${userId}::uuid AND chapter_no = ${chapterNo}::int)
      SELECT (SELECT explanation_locale FROM user_settings WHERE user_id = ${userId}::uuid) AS locale,
        (SELECT COALESCE(max(chapter_no), 0)::int FROM challenge_chapters WHERE user_id = ${userId}::uuid) AS "lastChapterNo",
        ${chapterNo}::int = 1 OR EXISTS (
          SELECT 1 FROM challenge_chapters p JOIN challenge_level_progress lp ON lp.chapter_id = p.id AND lp.user_id = p.user_id
          WHERE p.user_id = ${userId}::uuid AND p.chapter_no = ${chapterNo - 1}::int
            AND lp.level_no = ${LAST_LEVEL} AND lp.best_stars > 0) AS "previousCleared",
        (SELECT json_build_object('id', id, 'explanationLocale', explanation_locale, 'contentVersion', content_version) FROM c) AS chapter,
        COALESCE((SELECT json_agg(json_build_object('levelNo', lp.level_no, 'bestStars', lp.best_stars, 'bestScore', lp.best_score))
          FROM challenge_level_progress lp JOIN c ON lp.chapter_id = c.id AND lp.user_id = c.user_id), '[]'::json) AS levels,
        COALESCE((SELECT ${slotsOf(userId, sql`c.id`, sql`c.explanation_locale`)} FROM c), '[]'::json) AS slots`);
    return row;
  }

  /** Unallocated Meanings for new core slots, and earlier chapters' core Meanings for review, both in `locale`. */
  async candidates(executor: Db | Tx, userId: string, locale: string, beforeChapterNo: number) {
    const { rows: [row] } = await executor.execute<{ unallocated: CandidateRow[]; priorCores: CandidateRow[] }>(sql`
      SELECT ${asJsonArray(unallocated(userId, sql`${locale}`))} AS unallocated,
        ${asJsonArray(sql`
          SELECT l."meaningId", l.lemma, l.gloss FROM (${learnedContent(userId, sql`${locale}`)}) l
          JOIN challenge_chapter_meanings x ON x.meaning_id = l."meaningId" AND x.user_id = ${userId}::uuid
            AND x.role = ${CHALLENGE_ROLE.CORE} AND x.retired_in_version IS NULL
          JOIN challenge_chapters c ON c.id = x.chapter_id AND c.chapter_no < ${beforeChapterNo}::int`)} AS "priorCores"`);
    return row;
  }

  async insertChapter(tx: Tx, chapter: { id: string; userId: string; chapterNo: number; explanationLocale: string; now: Date }, slots: Slot[]) {
    const { now, ...values } = chapter;
    await tx.insert(challengeChapters).values({ ...values, createdAt: now, updatedAt: now });
    await this.insertSlots(tx, chapter.id, chapter.userId, 1, slots);
  }

  /** Retires the invalid slots and adds their replacements as the chapter's next content version. */
  async replaceSlots(tx: Tx, input: { chapterId: string; userId: string; version: number; retiredIds: string[]; added: Slot[]; now: Date }) {
    await tx.update(challengeChapters).set({ contentVersion: input.version, updatedAt: input.now }).where(eq(challengeChapters.id, input.chapterId));
    if (input.retiredIds.length > 0) {
      await tx.update(challengeChapterMeanings).set({ retiredInVersion: input.version }).where(inArray(challengeChapterMeanings.id, input.retiredIds));
    }
    await this.insertSlots(tx, input.chapterId, input.userId, input.version, input.added);
  }

  private async insertSlots(tx: Tx, chapterId: string, userId: string, version: number, slots: Slot[]) {
    if (slots.length === 0) return;
    await tx.insert(challengeChapterMeanings).values(slots.map((s) => ({
      chapterId, userId, meaningId: s.meaningId, role: s.role, sortIndex: s.sortIndex,
      lemma: s.lemma, gloss: s.gloss, wordKey: s.wordKey, glossKey: s.glossKey, contentVersion: version,
    })));
  }

  async insertRun(tx: Tx, run: typeof challengeRuns.$inferInsert) {
    await tx.insert(challengeRuns).values(run);
  }

  /** Locks the run row; `progress` is the learner's current best on that level, `locale` their current one. */
  async loadRun(tx: Tx, runId: string) {
    const { rows: [row] } = await tx.execute<{
      userId: string; chapterId: string; chapterNo: number; levelNo: number; status: ChallengeRunStatus; plan: RunPlan | null; locale: string;
      startedAt: string | null; expiresAt: string; commitRequestSha256: string | null; commitResponse: unknown; progress: LevelProgressRow | null;
    }>(sql`
      SELECT r.user_id AS "userId", r.chapter_id AS "chapterId", c.chapter_no AS "chapterNo", r.level_no AS "levelNo", r.status,
        r.plan, r.started_at AS "startedAt", r.expires_at AS "expiresAt",
        (SELECT explanation_locale FROM user_settings WHERE user_id = r.user_id) AS locale,
        r.commit_request_sha256 AS "commitRequestSha256", r.commit_response AS "commitResponse",
        (SELECT json_build_object('bestStars', lp.best_stars, 'bestScore', lp.best_score,
            'bestCompletionMs', lp.best_completion_ms, 'firstClearedAt', lp.first_cleared_at)
         FROM challenge_level_progress lp
         WHERE lp.user_id = r.user_id AND lp.chapter_id = r.chapter_id AND lp.level_no = r.level_no) AS progress
      FROM challenge_runs r JOIN challenge_chapters c ON c.id = r.chapter_id
      WHERE r.id = ${runId}::uuid
      FOR UPDATE OF r`);
    if (!row) return undefined;
    return { ...row, startedAt: row.startedAt === null ? null : toDate(row.startedAt), expiresAt: toDate(row.expiresAt) };
  }

  async setStatus(tx: Tx, runId: string, patch: Partial<typeof challengeRuns.$inferInsert>) {
    await tx.update(challengeRuns).set(patch).where(eq(challengeRuns.id, runId));
  }

  /** Bests only ever rise; the first clear time is never moved. */
  async recordAttempt(tx: Tx, input: {
    userId: string; chapterId: string; levelNo: number; stars: number; score: number; completionMs: number | null; now: Date;
  }) {
    const cleared = input.stars > 0;
    const p = challengeLevelProgress;
    await tx.insert(p).values({
      userId: input.userId, chapterId: input.chapterId, levelNo: input.levelNo, bestStars: input.stars, bestScore: input.score,
      bestCompletionMs: cleared ? input.completionMs : null, firstClearedAt: cleared ? input.now : null, attemptCount: 1, updatedAt: input.now,
    }).onConflictDoUpdate({
      target: [p.userId, p.chapterId, p.levelNo],
      set: {
        bestStars: sql`GREATEST(${p.bestStars}, excluded.best_stars)`,
        bestScore: sql`GREATEST(${p.bestScore}, excluded.best_score)`,
        bestCompletionMs: sql`LEAST(${p.bestCompletionMs}, excluded.best_completion_ms)`,
        firstClearedAt: sql`COALESCE(${p.firstClearedAt}, excluded.first_cleared_at)`,
        attemptCount: sql`${p.attemptCount} + 1`,
        updatedAt: input.now,
      },
    });
  }

  async findRun(userId: string, runId: string) {
    const [row] = await this.db
      .select({
        status: challengeRuns.status, levelNo: challengeRuns.levelNo, chapterNo: challengeChapters.chapterNo,
        contentVersion: challengeRuns.contentVersion, plan: challengeRuns.plan, startedAt: challengeRuns.startedAt,
        expiresAt: challengeRuns.expiresAt, commitResponse: challengeRuns.commitResponse,
      })
      .from(challengeRuns)
      .innerJoin(challengeChapters, eq(challengeChapters.id, challengeRuns.chapterId))
      .where(and(eq(challengeRuns.id, runId), eq(challengeRuns.userId, userId)));
    return row;
  }

  async expireRuns(now: Date) {
    const { rowCount } = await this.db.update(challengeRuns).set({ status: CHALLENGE_RUN_STATUS.EXPIRED })
      .where(and(inArray(challengeRuns.status, [...CHALLENGE_OPEN_STATUSES]), lte(challengeRuns.expiresAt, now)));
    return rowCount ?? 0;
  }

  /** Raw events and the plan go after retention; result and the commit response stay as history. */
  async purgeRuns(cutoff: Date) {
    await this.db.execute(sql`
      UPDATE challenge_runs SET plan = NULL, events = NULL
      WHERE plan IS NOT NULL AND status NOT IN (${OPEN}) AND COALESCE(committed_at, expires_at) <= ${cutoff}::timestamptz`);
  }
}
