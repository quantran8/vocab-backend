-- IPA and audio belong to a Meaning, not a word type: senses of one spelling can sound different (read /riːd/, /rɛd/).
-- Each existing pronunciation is copied to every Meaning of its type. The first Meaning keeps the original id,
-- so skill evidence (keyed by pronunciation only) stays with it; the others get new ids.
CREATE TEMP TABLE pronunciation_map ON COMMIT DROP AS
SELECT pr.id AS old_id, m.id AS meaning_id,
       CASE WHEN row_number() OVER (PARTITION BY pr.id ORDER BY m.created_at, m.id) = 1 THEN pr.id ELSE gen_random_uuid() END AS new_id
FROM pronunciations pr
JOIN meanings m ON m.type_id = pr.type_id;

DROP INDEX pronunciations_type_id_accent_locale_key;
ALTER TABLE pronunciations ADD COLUMN meaning_id UUID;

UPDATE pronunciations pr SET meaning_id = map.meaning_id
FROM pronunciation_map map WHERE map.old_id = pr.id AND map.new_id = pr.id;

INSERT INTO pronunciations (id, type_id, meaning_id, accent_locale, ipa, audio_asset_key, created_at)
SELECT map.new_id, pr.type_id, map.meaning_id, pr.accent_locale, pr.ipa, pr.audio_asset_key, pr.created_at
FROM pronunciation_map map JOIN pronunciations pr ON pr.id = map.old_id
WHERE map.new_id <> map.old_id;

-- Targets that name both a Meaning and a pronunciation move to that Meaning's copy.
UPDATE practice_item_targets t SET pronunciation_id = map.new_id
FROM pronunciation_map map
WHERE t.pronunciation_id = map.old_id AND t.meaning_id = map.meaning_id AND map.new_id <> map.old_id;

-- Publications are immutable: a snapshot naming another Meaning's copy gets a new revision with its own ids.
CREATE TEMP TABLE pronunciation_republish ON COMMIT DROP AS
SELECT gen_random_uuid() AS id, p.meaning_id, p.locale, p.approved_at,
       (SELECT max(r.revision) FROM meaning_publications r WHERE r.meaning_id = p.meaning_id AND r.locale = p.locale) + 1 AS revision,
       jsonb_set(p.snapshot, '{pronunciations}', (
         SELECT COALESCE(jsonb_agg(e || jsonb_build_object('id', COALESCE(map.new_id, (e->>'id')::uuid)) ORDER BY t.ord), '[]'::jsonb)
         FROM jsonb_array_elements(p.snapshot->'pronunciations') WITH ORDINALITY AS t(e, ord)
         LEFT JOIN pronunciation_map map ON map.old_id = (t.e->>'id')::uuid AND map.meaning_id = p.meaning_id)) AS snapshot
FROM active_meaning_publications a
JOIN meaning_publications p ON p.id = a.publication_id
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(p.snapshot->'pronunciations') e
  JOIN pronunciation_map map ON map.old_id = (e->>'id')::uuid AND map.meaning_id = p.meaning_id
  WHERE map.new_id <> map.old_id);

INSERT INTO meaning_publications (id, meaning_id, locale, revision, snapshot, approved_at, published_at)
SELECT id, meaning_id, locale, revision, snapshot, approved_at, now() FROM pronunciation_republish;
UPDATE active_meaning_publications a SET publication_id = r.id
FROM pronunciation_republish r WHERE a.meaning_id = r.meaning_id AND a.locale = r.locale;

-- A type without Meanings has no one to own its pronunciation.
DELETE FROM pronunciations WHERE meaning_id IS NULL;

ALTER TABLE pronunciations DROP CONSTRAINT pronunciations_type_id_fkey;
ALTER TABLE pronunciations DROP COLUMN type_id;
ALTER TABLE pronunciations ALTER COLUMN meaning_id SET NOT NULL;
ALTER TABLE pronunciations ADD CONSTRAINT pronunciations_meaning_id_fkey FOREIGN KEY (meaning_id) REFERENCES meanings(id);
CREATE UNIQUE INDEX pronunciations_meaning_id_accent_locale_key ON pronunciations (meaning_id, accent_locale);
