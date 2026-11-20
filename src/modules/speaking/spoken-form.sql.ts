import { SQL, sql } from 'drizzle-orm';
import { DEFAULT_ACCENT } from '../../common/constants/domain';

// Meanings that share a spelling and IPA share one recording and one speaking status. Mirrors spokenForm().
export const spokenFormSql = (lemma: SQL, ipa: SQL) => sql`lower(btrim(${lemma})) || '|' || COALESCE(btrim(${ipa}), '')`;

/** Each learned Meaning with the pronunciation a recording targets and its spoken form. */
export const learnedFormsSql = (userId: string) => sql`
  SELECT ump.meaning_id, pr.id AS pronunciation_id, ${spokenFormSql(sql`w.lemma`, sql`pr.ipa`)} AS form
  FROM user_meaning_progress ump
  JOIN pronunciations pr ON pr.meaning_id = ump.meaning_id AND pr.accent_locale = ${DEFAULT_ACCENT}
  JOIN meanings m ON m.id = ump.meaning_id
  JOIN word_types wt ON wt.id = m.type_id
  JOIN words w ON w.id = wt.word_id
  WHERE ump.user_id = ${userId}::uuid`;

/** A spoken form's speaking state is its most recently assessed row. */
export const formStateSql = (userId: string) => sql`
  SELECT DISTINCT ON (f.form) f.form, sp.status, sp.last_passed, sp.last_assessed_at
  FROM (${learnedFormsSql(userId)}) f
  JOIN user_speaking_progress sp ON sp.user_id = ${userId}::uuid AND sp.pronunciation_id = f.pronunciation_id
  ORDER BY f.form, sp.last_assessed_at DESC, sp.pronunciation_id`;
