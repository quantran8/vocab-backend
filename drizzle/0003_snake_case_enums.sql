-- Enum values are stored as lower_snake_case, in columns and inside JSONB. Single-word values are unchanged.
CREATE FUNCTION pg_temp.snake(v text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(replace(replace(regexp_replace(v, '([a-z0-9])([A-Z])', '\1_\2', 'g'), ' ', '_'), '-', '_'))
$$;

CREATE FUNCTION pg_temp.snake_enums(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(j) = 'array' THEN
    RETURN (SELECT COALESCE(jsonb_agg(pg_temp.snake_enums(e) ORDER BY o), '[]'::jsonb) FROM jsonb_array_elements(j) WITH ORDINALITY x(e, o));
  ELSIF jsonb_typeof(j) = 'object' THEN
    RETURN (SELECT COALESCE(jsonb_object_agg(k, CASE
      WHEN jsonb_typeof(v) = 'string' AND k IN ('template', 'variant', 'phase', 'intent', 'outcome', 'action')
        THEN to_jsonb(pg_temp.snake(v #>> '{}'))
      ELSE pg_temp.snake_enums(v) END), '{}'::jsonb)
      FROM jsonb_each(j) x(k, v));
  END IF;
  RETURN j;
END $$;

ALTER TABLE practice_items DROP CONSTRAINT practice_items_template_check;
ALTER TABLE learning_sessions DROP CONSTRAINT learning_sessions_mode_check;
ALTER TABLE memory_observations DROP CONSTRAINT memory_observations_signal_check;

-- Immutability guards the content of snapshots; this rewrite only changes the spelling of enum values.
ALTER TABLE practice_items DISABLE TRIGGER practice_items_published_immutable;
ALTER TABLE learning_sessions DISABLE TRIGGER learning_sessions_plan_immutable;

UPDATE word_types SET part_of_speech = pg_temp.snake(part_of_speech);
UPDATE practice_items SET template = pg_temp.snake(template), variant = pg_temp.snake(variant);
UPDATE learning_sessions SET
  mode = pg_temp.snake(mode),
  plan = pg_temp.snake_enums(plan),
  raw_events = pg_temp.snake_enums(raw_events),
  result = pg_temp.snake_enums(result);
UPDATE memory_observations SET signal = pg_temp.snake(signal);

ALTER TABLE practice_items ENABLE TRIGGER practice_items_published_immutable;
ALTER TABLE learning_sessions ENABLE TRIGGER learning_sessions_plan_immutable;

ALTER TABLE word_types ADD CONSTRAINT word_types_part_of_speech_check CHECK (part_of_speech IN
  ('noun','verb','adjective','adverb','pronoun','preposition','conjunction','interjection','phrasal_verb'));
ALTER TABLE practice_items
  ADD CONSTRAINT practice_items_template_check CHECK (template IN ('select','match','cloze_select','typing','fly_reorder','surgery','recording')),
  ADD CONSTRAINT practice_items_variant_check CHECK (variant IN ('gloss','reverse_gloss','meaning_clash','phonetic_choice','stress_choice',
    'meaning_pairs','word_pairs','single_blank','context_meaning','meaning_recall','transcription','spelling_recall','fix_spelling','scripted_pronunciation'));
ALTER TABLE learning_sessions ADD CONSTRAINT learning_sessions_mode_check CHECK (mode IN ('daily','weekly_challenge','random_practice','weak_words_practice'));
ALTER TABLE memory_observations ADD CONSTRAINT memory_observations_signal_check CHECK (signal IN
  ('unaided_recall','assisted_recall','failed_recall','recognition_success','failed_recognition'));
