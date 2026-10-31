import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Clock } from '../../common/clock';
import { DEFAULT_ACCENT, DIRECTNESS, Skill, SKILL, VALIDITY, WEEKLY_STATE } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { DB, Db, toDate } from '../../db/db';
import { skillEvidence } from '../../db/schema';
import { MeaningSnapshot } from '../practice-resolver/task.types';
import { deriveSkillStatus, EvidenceRow, isWordFullyVerified, SkillState } from '../skill-verification/skill-evidence';

interface MeaningRow {
  wordId: string;
  meaningId: string;
  snapshot: MeaningSnapshot;
  learnedAt: Date | null;
  nextReviewAt: Date | null;
}

type RawMeaningRow = Omit<MeaningRow, 'learnedAt' | 'nextReviewAt'> & { learnedAt: string | null; nextReviewAt: string | null };

const parseMeaningRows = (rows: RawMeaningRow[]): MeaningRow[] =>
  rows.map((r) => ({
    ...r,
    learnedAt: r.learnedAt ? toDate(r.learnedAt) : null,
    nextReviewAt: r.nextReviewAt ? toDate(r.nextReviewAt) : null,
  }));

interface EvidenceQueryRow extends EvidenceRow {
  skill: Skill;
  meaningId: string | null;
  pronunciationId: string | null;
}

type EvidenceIndex = Map<string, EvidenceRow[]>;

const scopeKey = (skill: Skill, id: string) => `${skill}:${id}`;

const indexEvidence = (rows: EvidenceQueryRow[]) =>
  Map.groupBy(rows, (r) => scopeKey(r.skill, (r.meaningId ?? r.pronunciationId)!)) as EvidenceIndex;

const stateOf = (index: EvidenceIndex, skill: Skill, id: string): SkillState =>
  deriveSkillStatus(index.get(scopeKey(skill, id)) ?? []);

function meaningView(row: MeaningRow, index: EvidenceIndex) {
  const pronunciation = row.snapshot.pronunciations.find((p) => p.accentLocale === DEFAULT_ACCENT);
  const reading = stateOf(index, SKILL.reading, row.meaningId);
  const writing = stateOf(index, SKILL.writing, row.meaningId);
  const listening = pronunciation ? stateOf(index, SKILL.listening, pronunciation.id) : undefined;
  const speaking = pronunciation ? stateOf(index, SKILL.speaking, pronunciation.id) : undefined;
  return {
    meaning: { partOfSpeech: row.snapshot.partOfSpeech, text: row.snapshot.meaningText, ipa: pronunciation?.ipa },
    learnedAt: row.learnedAt,
    nextReviewAt: row.nextReviewAt,
    skills: { reading, writing, listening, speaking },
    needsPractice: [reading, writing, listening, speaking].some((s) => s?.needsPractice),
  };
}

function wordView(rows: MeaningRow[], index: EvidenceIndex) {
  const meanings = rows.map((row) => meaningView(row, index));
  const learned = meanings.filter((m) => m.learnedAt);
  return {
    wordId: rows[0].wordId,
    lemma: rows[0].snapshot.lemma,
    meanings,
    needsPractice: learned.some((m) => m.needsPractice),
    fullyVerified: isWordFullyVerified({
      learnedMeaningCount: learned.length,
      readingWriting: learned.flatMap((m) => [m.skills.reading.status, m.skills.writing.status]),
      listeningSpeaking: learned.flatMap((m) => [m.skills.listening?.status ?? 'notVerified', m.skills.speaking?.status ?? 'notVerified'] as const),
    }),
  };
}

@Injectable()
export class ProgressService {
  constructor(@Inject(DB) private readonly db: Db, private readonly clock: Clock) {}

  // Single statement: the home screen never needs more than one round trip.
  async learnHome(userId: string) {
    const now = this.clock.now();
    const { rows: [row] } = await this.db.execute<{ dueCount: number; weeklyAvailable: number; learnedTotal: number }>(sql`
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
        (SELECT count(*)::int FROM weekly_challenges
         WHERE user_id = ${userId}::uuid AND state = ${WEEKLY_STATE.available}) AS "weeklyAvailable",
        (SELECT count(*)::int FROM user_meaning_progress WHERE user_id = ${userId}::uuid) AS "learnedTotal"`);
    return row;
  }

  async words(userId: string, limit: number, offset: number) {
    const [rows, evidence] = await Promise.all([
      this.db.execute<RawMeaningRow>(sql`
        WITH learned AS (
          SELECT ump.meaning_id, ump.learned_at, ump.next_review_at, wt.word_id
          FROM user_meaning_progress ump
          JOIN meanings m ON m.id = ump.meaning_id
          JOIN word_types wt ON wt.id = m.type_id
          WHERE ump.user_id = ${userId}::uuid
        ), page AS (
          SELECT word_id, max(learned_at) AS last_learned
          FROM learned GROUP BY word_id
          ORDER BY last_learned DESC, word_id LIMIT ${limit} OFFSET ${offset}
        )
        SELECT l.word_id AS "wordId", l.meaning_id AS "meaningId", p.snapshot,
               l.learned_at AS "learnedAt", l.next_review_at AS "nextReviewAt"
        FROM learned l
        JOIN page ON page.word_id = l.word_id
        JOIN user_settings s ON s.user_id = ${userId}::uuid
        JOIN active_meaning_publications a ON a.meaning_id = l.meaning_id AND a.locale = s.explanation_locale
        JOIN meaning_publications p ON p.id = a.publication_id
        ORDER BY page.last_learned DESC, l.word_id, l.learned_at`),
      this.evidence(userId),
    ]);
    const index = indexEvidence(evidence);
    return { words: [...Map.groupBy(parseMeaningRows(rows.rows), (r) => r.wordId).values()].map((group) => wordView(group, index)) };
  }

  async word(userId: string, wordId: string) {
    const [rows, evidence] = await Promise.all([
      this.db.execute<RawMeaningRow>(sql`
        SELECT wt.word_id AS "wordId", m.id AS "meaningId", p.snapshot,
               ump.learned_at AS "learnedAt", ump.next_review_at AS "nextReviewAt"
        FROM word_types wt
        JOIN meanings m ON m.type_id = wt.id
        JOIN user_settings s ON s.user_id = ${userId}::uuid
        JOIN active_meaning_publications a ON a.meaning_id = m.id AND a.locale = s.explanation_locale
        JOIN meaning_publications p ON p.id = a.publication_id
        LEFT JOIN user_meaning_progress ump ON ump.meaning_id = m.id AND ump.user_id = s.user_id
        WHERE wt.word_id = ${wordId}::uuid AND (a.recalled_at IS NULL OR ump.user_id IS NOT NULL)
        ORDER BY m.id`),
      this.evidence(userId),
    ]);
    if (rows.rows.length === 0) throw new ApiError('NOT_FOUND', 'Word not found');
    return wordView(parseMeaningRows(rows.rows), indexEvidence(evidence));
  }

  private async evidence(userId: string) {
    const rows = await this.db
      .select({
        sessionId: skillEvidence.sessionId,
        skill: skillEvidence.skill,
        passed: skillEvidence.passed,
        committedAt: skillEvidence.committedAt,
        meaningId: skillEvidence.meaningId,
        pronunciationId: skillEvidence.pronunciationId,
      })
      .from(skillEvidence)
      .where(and(eq(skillEvidence.userId, userId), eq(skillEvidence.directness, DIRECTNESS.direct), eq(skillEvidence.validity, VALIDITY.valid)))
      .orderBy(asc(skillEvidence.committedAt), asc(skillEvidence.id));
    return rows as EvidenceQueryRow[];
  }
}
