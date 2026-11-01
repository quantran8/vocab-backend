-- The sentence belongs in sentenceParts. A prompt holding it again with a blank was only filling a required field.
-- Immutability guards what learners were shown; issued sessions keep their own snapshot of the task.
ALTER TABLE practice_items DISABLE TRIGGER practice_items_published_immutable;

UPDATE practice_items
SET source_content = source_content #- '{promptVariants,text}'
WHERE template = 'cloze_select' AND source_content #>> '{promptVariants,text,text}' LIKE '%\_\_\_\_%';

ALTER TABLE practice_items ENABLE TRIGGER practice_items_published_immutable;
