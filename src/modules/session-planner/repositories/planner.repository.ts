import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, exists, inArray, or, SQL, sql } from 'drizzle-orm';
import { CEFR_LEVELS, CONTENT_STATUS, NewWordOverrideMode, DEFAULT_ACCENT, EDITORIAL_STATE, ITEM_STATUS, MEANING_ORIGIN, MEMORY_SIGNAL, CHECKPOINT_STATE, SKILL, Skill } from '../../../common/constants/domain';
import { ApiError } from '../../../common/http/api-error';
import { POLICY } from '../../../config/policy';
import { DB, Db, toDate } from '../../../db/db';
import { practiceItemLocalizations, practiceItemTargets, checkpointChallenges, learningSessions, userMeaningOverrides } from '../../../db/schema';
import { CuratedItem } from '../../practice-resolver/curated';
import { DistractorView, MeaningSnapshot } from '../../practice-resolver/task.types';
import { openSkillIssuesSql } from '../../skill-verification/skill-issue.sql';
import { NewWordOverride } from '../../review-load/domain/review-load';
import { backlogSql, pendingCustomSql, remainingNewSql, reviewableSql } from '../../review-load/repositories/review-scope.sql';

type SnapshotRow = { snapshot: MeaningSnapshot };

export interface SourceTopic { id: string; name: string; personal: boolean }
export type DueTarget = { snapshot: MeaningSnapshot; sourceTopic: SourceTopic | null };
export type NewTarget = { snapshot: MeaningSnapshot; viaTopicId: string | null };

/** Random practice source (§9); unset means every reviewable learned Meaning. */
export type PracticeFilter = { collectionId: string } | { topicIds: string[] } | { customOnly: true };

export interface Learner {
  proficiencyLevel: string | null;
  settings: {
    explanationLocale: string;
    uiLocale: string;
    dailyNewWordGoal: number;
    weeklySessionGoal: number;
    autoBalanceNewWords: boolean;
    override: NewWordOverride | null;
  };
  activeTopics: { topicId: string }[];
  // Daily only.
  budget: { remaining: number; pendingCustom: number; backlog: number } | null;
}

export const CEFR_ARRAY = sql`ARRAY[${sql.join(CEFR_LEVELS.map((l) => sql`${l}`), sql`, `)}]::text[]`;

const uuidList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

const inScope = (rows: SnapshotRow[]) => rows.map((r) => r.snapshot);

const hasPronunciation = (extra = sql``) => sql`AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(p.snapshot->'pronunciations') pr
  WHERE pr->>'accentLocale' = ${DEFAULT_ACCENT} ${extra})`;

// Most catalog words have no audio; without this the oldest words could leave a Listening plan empty.
// Only filters when every chosen skill needs a pronunciation: other skills can still use a word without one.
function skillFilter(skills?: Skill[]) {
  if (!skills?.length || skills.some((s) => s !== SKILL.LISTENING && s !== SKILL.SPEAKING)) return sql``;
  if (skills.every((s) => s === SKILL.LISTENING)) return hasPronunciation(sql`AND pr->>'audioUrl' IS NOT NULL`);
  return hasPronunciation();
}

function practiceSource(userId: string, filter?: PracticeFilter) {
  if (!filter) return reviewableSql(userId, sql`ump.meaning_id`);
  const member = (condition: SQL) => sql`EXISTS (
    SELECT 1 FROM topic_meanings tm_f JOIN topics t_f ON t_f.id = tm_f.topic_id
    WHERE tm_f.meaning_id = ump.meaning_id AND ${condition})`;
  if ('collectionId' in filter) return member(sql`t_f.collection_id = ${filter.collectionId}::uuid`);
  if ('topicIds' in filter) return member(sql`t_f.id IN (${uuidList(filter.topicIds)})`);
  return member(sql`t_f.owner_user_id = ${userId}::uuid`);
}

@Injectable()
export class PlannerRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async insertSession(session: typeof learningSessions.$inferInsert) {
    await this.db.insert(learningSessions).values(session);
  }

  // One round trip; the R, C and B counts are read only when Daily needs them.
  async loadLearner(userId: string, now: Date, withBudget: boolean): Promise<Learner> {
    const locale = sql`us.explanation_locale`;
    const budget = withBudget
      ? sql`, ${remainingNewSql(userId, locale)} AS remaining, ${pendingCustomSql(userId, locale)} AS "pendingCustom",
          ${backlogSql(userId, locale, now)} AS backlog`
      : sql``;
    const { rows: [row] } = await this.db.execute<{
      proficiencyLevel: string | null; explanationLocale: string; uiLocale: string; dailyNewWordGoal: number; weeklySessionGoal: number;
      autoBalanceNewWords: boolean; overrideValue: number | null; overrideMode: NewWordOverrideMode | null; overrideUntil: string | null;
      topicIds: string[]; remaining?: number; pendingCustom?: number; backlog?: number;
    }>(sql`
      SELECT u.proficiency_level AS "proficiencyLevel", us.explanation_locale AS "explanationLocale", us.ui_locale AS "uiLocale",
        us.daily_new_word_goal AS "dailyNewWordGoal", us.weekly_session_goal AS "weeklySessionGoal",
        us.auto_balance_new_words AS "autoBalanceNewWords", us.new_word_override AS "overrideValue",
        us.new_word_override_mode AS "overrideMode", us.new_word_override_until AS "overrideUntil",
        ARRAY(SELECT uat.topic_id::text FROM user_active_topics uat WHERE uat.user_id = u.id ORDER BY uat.topic_id) AS "topicIds"
        ${budget}
      FROM app_user u JOIN user_settings us ON us.user_id = u.id
      WHERE u.id = ${userId}::uuid`);
    if (!row) throw new ApiError('NOT_FOUND', 'User not found');
    return {
      proficiencyLevel: row.proficiencyLevel,
      settings: {
        explanationLocale: row.explanationLocale,
        uiLocale: row.uiLocale,
        dailyNewWordGoal: row.dailyNewWordGoal,
        weeklySessionGoal: row.weeklySessionGoal,
        autoBalanceNewWords: row.autoBalanceNewWords,
        override: row.overrideValue === null || row.overrideMode === null ? null : {
          value: row.overrideValue, mode: row.overrideMode, until: row.overrideUntil === null ? null : toDate(row.overrideUntil),
        },
      },
      activeTopics: row.topicIds.map((topicId) => ({ topicId })),
      budget: withBudget ? { remaining: row.remaining!, pendingCustom: row.pendingCustom!, backlog: row.backlog! } : null,
    };
  }

  // Every reviewable learned Meaning, not only the current scope (D2). The label follows §6.3:
  // a scope topic, then the topic it was learned from, then the first curated membership.
  async dueTargets(userId: string, locale: string, uiLocale: string, now: Date, limit: number): Promise<DueTarget[]> {
    const { rows } = await this.db.execute<{ snapshot: MeaningSnapshot; topicId: string | null; topicName: string | null; personal: boolean | null }>(sql`
      SELECT p.snapshot, st.id AS "topicId", st.name AS "topicName", st.personal
      FROM user_meaning_progress ump
      JOIN active_meaning_publications a ON a.meaning_id = ump.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
      JOIN meaning_publications p ON p.id = a.publication_id
      LEFT JOIN LATERAL (
        SELECT t.id, COALESCE(tl.title, t.title) AS name, t.owner_user_id IS NOT NULL AS personal
        FROM topic_meanings tm
        JOIN topics t ON t.id = tm.topic_id
        JOIN collections c ON c.id = t.collection_id
        LEFT JOIN user_learning_scope s ON s.user_id = ump.user_id AND s.collection_id = t.collection_id
        LEFT JOIN user_active_topics uat ON uat.user_id = ump.user_id AND uat.topic_id = t.id
        LEFT JOIN topic_localizations tl ON tl.topic_id = t.id AND tl.locale = ${uiLocale}
        WHERE tm.meaning_id = ump.meaning_id
          AND (t.owner_user_id = ump.user_id OR (t.owner_user_id IS NULL AND t.status = ${CONTENT_STATUS.PUBLISHED}))
        ORDER BY (t.owner_user_id IS NULL AND s.user_id IS NOT NULL AND uat.topic_id IS NOT NULL) DESC,
          (t.id = ump.learned_via_topic_id) IS TRUE DESC,
          t.owner_user_id IS NOT NULL, c.slug, t.slug, tm.curated_rank
        LIMIT 1) st ON true
      WHERE ump.user_id = ${userId}::uuid AND ump.next_review_at <= ${now}::timestamptz
        AND ${reviewableSql(userId, sql`ump.meaning_id`)}
      ORDER BY ump.next_review_at, ump.meaning_id
      LIMIT ${limit}`);
    return rows.map((r) => ({
      snapshot: r.snapshot,
      sourceTopic: r.topicId ? { id: r.topicId, name: r.topicName!, personal: r.personal! } : null,
    }));
  }

  // Goal is per session, not per day: a finished session never blocks the next one.
  // Level only orders: at or above it first, nearest first, then easier ones; it never empties the pool.
  // Words the learner added come first: they asked for them, and CEFR gap could bury them.
  // Within one word the most popular meaning goes first, ahead of level — see memory meaning-popularity.
  async newTargets(userId: string, locale: string, level: string | null, goal: number): Promise<NewTarget[]> {
    if (goal <= 0) return [];
    return (await this.db.execute<{ snapshot: MeaningSnapshot; viaTopicId: string }>(sql`
      WITH ranked AS (
        SELECT tm.meaning_id, min(tm.curated_rank) AS curated_rank, bool_or(t.owner_user_id IS NOT NULL) AS personal,
          (array_agg(tm.topic_id ORDER BY t.owner_user_id IS NULL, tm.curated_rank, tm.topic_id))[1] AS via_topic_id
        FROM topic_meanings tm
        JOIN user_active_topics uat ON uat.topic_id = tm.topic_id AND uat.user_id = ${userId}::uuid
        JOIN topics t ON t.id = tm.topic_id AND t.status = ${CONTENT_STATUS.PUBLISHED}
        GROUP BY tm.meaning_id
      ), eligible AS (
        SELECT DISTINCT ON (wt.word_id) r.meaning_id, r.curated_rank, r.personal, r.via_topic_id, p.snapshot,
          COALESCE(lv.d < 0, false) AS below, COALESCE(abs(lv.d), 0) AS gap
        FROM ranked r
        JOIN active_meaning_publications a ON a.meaning_id = r.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
        JOIN meaning_publications p ON p.id = a.publication_id
        JOIN meanings m ON m.id = r.meaning_id
        JOIN word_types wt ON wt.id = m.type_id
        CROSS JOIN LATERAL (SELECT array_position(${CEFR_ARRAY}, m.cefr_level) - array_position(${CEFR_ARRAY}, ${level}::text) AS d) lv
        WHERE NOT EXISTS (
            SELECT 1 FROM user_meaning_progress ump
            WHERE ump.user_id = ${userId}::uuid AND ump.meaning_id = r.meaning_id)
        ORDER BY wt.word_id, r.personal DESC, m.popularity DESC NULLS LAST, below, gap, r.curated_rank, r.meaning_id
      )
      SELECT snapshot, via_topic_id AS "viaTopicId" FROM eligible
      ORDER BY personal DESC, below, gap, curated_rank, meaning_id
      LIMIT ${goal}::int`)).rows;
  }

  // A filter is an explicit choice, so paused collections apply only to the unfiltered pool (§8).
  async randomTargets(userId: string, locale: string, limit: number, skills?: Skill[], filter?: PracticeFilter) {
    return inScope((await this.db.execute<SnapshotRow>(sql`
      SELECT p.snapshot
      FROM user_meaning_progress ump
      JOIN active_meaning_publications a ON a.meaning_id = ump.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
      JOIN meaning_publications p ON p.id = a.publication_id
      WHERE ump.user_id = ${userId}::uuid ${skillFilter(skills)} AND ${practiceSource(userId, filter)}
      ORDER BY ump.last_reviewed_at NULLS FIRST, ump.meaning_id
      LIMIT ${limit}`)).rows);
  }

  /** True when every filtered collection or topic exists and is published. */
  async filterExists(filter: PracticeFilter) {
    if ('customOnly' in filter) return true;
    const { rows: [row] } = await this.db.execute<{ ok: boolean }>('collectionId' in filter
      ? sql`SELECT EXISTS (SELECT 1 FROM collections WHERE id = ${filter.collectionId}::uuid AND status = ${CONTENT_STATUS.PUBLISHED}) AS ok`
      : sql`SELECT count(*) = ${new Set(filter.topicIds).size}::int AS ok
          FROM topics t JOIN collections c ON c.id = t.collection_id
          WHERE t.id IN (${uuidList(filter.topicIds)}) AND t.status = ${CONTENT_STATUS.PUBLISHED}
            AND c.status = ${CONTENT_STATUS.PUBLISHED} AND t.owner_user_id IS NULL`);
    return row.ok;
  }

  // Rolling window, not lifetime wrong counts (§8.3). Rotates by last practice so repeat failures cannot hold every slot.
  async weakTargets(userId: string, locale: string, since: Date, minAttempts: number, limit: number) {
    const { rows } = await this.db.execute<SnapshotRow & { skills: Skill[] | null }>(sql`
      WITH learned AS (
        SELECT ump.meaning_id, ump.last_reviewed_at, p.snapshot,
          (SELECT (e->>'id')::uuid FROM jsonb_array_elements(p.snapshot->'pronunciations') e
           WHERE e->>'accentLocale' = ${DEFAULT_ACCENT} LIMIT 1) AS pronunciation_id
        FROM user_meaning_progress ump
        JOIN active_meaning_publications a ON a.meaning_id = ump.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
        JOIN meaning_publications p ON p.id = a.publication_id
        WHERE ump.user_id = ${userId}::uuid AND ${reviewableSql(userId, sql`ump.meaning_id`)}
      ), open_issue AS (${openSkillIssuesSql(userId, since)}
      ), attempts AS (
        SELECT o.meaning_id, count(*) AS total,
               count(*) FILTER (WHERE o.signal NOT IN (${MEMORY_SIGNAL.UNAIDED_RECALL}, ${MEMORY_SIGNAL.RECOGNITION_SUCCESS})) AS weak
        FROM memory_observations o
        JOIN user_meaning_progress ump ON ump.user_id = o.user_id AND ump.meaning_id = o.meaning_id
        WHERE o.user_id = ${userId}::uuid AND o.observed_at >= ${since}::timestamptz
          AND o.session_id IS DISTINCT FROM ump.learned_session_id
        GROUP BY o.meaning_id
      ), candidates AS (
        SELECT l.snapshot, l.meaning_id, l.pronunciation_id, l.last_reviewed_at, i.skills
        FROM learned l
        LEFT JOIN attempts x ON x.meaning_id = l.meaning_id
        CROSS JOIN LATERAL (
          SELECT array_agg(DISTINCT e.skill::text) AS skills FROM open_issue e
          WHERE e.meaning_id = l.meaning_id OR e.pronunciation_id = l.pronunciation_id) i
        WHERE i.skills IS NOT NULL OR (x.weak > 0 AND x.total >= ${minAttempts})
        ORDER BY i.skills IS NOT NULL DESC, COALESCE(x.weak::numeric / x.total, 0) DESC, l.meaning_id
        LIMIT ${limit * POLICY.review.candidateMultiplier}
      )
      SELECT c.snapshot, c.skills
      FROM candidates c
      ORDER BY GREATEST(c.last_reviewed_at, (
        SELECT max(e.committed_at) FROM skill_evidence e
        WHERE e.user_id = ${userId}::uuid AND (e.meaning_id = c.meaning_id OR e.pronunciation_id = c.pronunciation_id)
      )) NULLS FIRST, c.meaning_id
      LIMIT ${limit}`);
    return rows;
  }

  async oldestChallenge(userId: string, challengeId?: string) {
    const [challenge] = await this.db
      .select({ id: checkpointChallenges.id })
      .from(checkpointChallenges)
      .where(and(
        eq(checkpointChallenges.userId, userId),
        eq(checkpointChallenges.state, CHECKPOINT_STATE.AVAILABLE),
        challengeId ? eq(checkpointChallenges.id, challengeId) : undefined,
      ))
      .orderBy(asc(checkpointChallenges.sequence))
      .limit(1);
    return challenge;
  }

  async challengeTargets(challengeId: string, locale: string) {
    return inScope((await this.db.execute<SnapshotRow>(sql`
      SELECT p.snapshot
      FROM checkpoint_challenge_meanings w
      JOIN active_meaning_publications a ON a.meaning_id = w.meaning_id AND a.locale = ${locale} AND a.recalled_at IS NULL
      JOIN meaning_publications p ON p.id = a.publication_id
      WHERE w.challenge_id = ${challengeId}::uuid
      ORDER BY w.meaning_id`)).rows);
  }

  // Unreviewed AI text stays out, including AI translations of curated meanings: it reaches only learners who chose it.
  distractorPool(locale: string, limit: number) {
    return this.db.execute<DistractorView>(sql`
      SELECT p.snapshot->>'wordId' AS "wordId", p.snapshot->>'lemma' AS lemma, p.snapshot->>'meaningText' AS "meaningText"
      FROM active_meaning_publications a
      JOIN meaning_publications p ON p.id = a.publication_id
      JOIN meaning_localizations ml ON ml.meaning_id = a.meaning_id AND ml.locale = a.locale
      WHERE a.locale = ${locale} AND a.recalled_at IS NULL AND ml.origin = ${MEANING_ORIGIN.CURATED}
      ORDER BY random()
      LIMIT ${limit}`).then((r) => r.rows);
  }

  overrides(userId: string, meaningIds: string[], locale: string) {
    return this.db
      .select({ meaningId: userMeaningOverrides.meaningId, content: userMeaningOverrides.content })
      .from(userMeaningOverrides)
      .where(and(
        eq(userMeaningOverrides.userId, userId),
        eq(userMeaningOverrides.locale, locale),
        inArray(userMeaningOverrides.meaningId, meaningIds),
      ));
  }

  async curatedItems(meaningIds: string[], pronunciationIds: string[], locale: string): Promise<CuratedItem[]> {
    if (meaningIds.length === 0 && pronunciationIds.length === 0) return [];
    const items = await this.db.query.practiceItems.findMany({
      where: (item) => and(
        eq(item.status, ITEM_STATUS.PUBLISHED),
        exists(
          this.db.select({ one: sql`1` }).from(practiceItemTargets).where(and(
            eq(practiceItemTargets.practiceItemId, item.id),
            or(inArray(practiceItemTargets.meaningId, meaningIds), inArray(practiceItemTargets.pronunciationId, pronunciationIds)),
          )),
        ),
        exists(
          this.db.select({ one: sql`1` }).from(practiceItemLocalizations).where(and(
            eq(practiceItemLocalizations.practiceItemId, item.id),
            eq(practiceItemLocalizations.locale, locale),
            eq(practiceItemLocalizations.editorialState, EDITORIAL_STATE.APPROVED),
          )),
        ),
      ),
      columns: { id: true, template: true, variant: true, contextCefrLevel: true, sourceContent: true, sourceEvaluation: true },
      with: {
        localizations: { where: (l) => eq(l.locale, locale), columns: { localizedContent: true } },
        targets: { orderBy: (t) => asc(t.ordinal), columns: { meaningId: true, pronunciationId: true } },
      },
    });
    return items.map(({ localizations, ...item }) => ({
      ...item,
      localizedContent: localizations[0].localizedContent,
    }));
  }
}
