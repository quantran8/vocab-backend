-- The focus word was authored but never reached the stored content, so "the highlighted word" had nothing to point at.
-- Immutability guards what learners were shown; issued sessions keep their own snapshot of the task.
ALTER TABLE practice_items DISABLE TRIGGER practice_items_published_immutable;

UPDATE practice_items AS item
SET source_content = jsonb_set(
  item.source_content,
  '{promptVariants,text,highlight}',
  jsonb_build_object(
    'start', strpos(lower(item.source_content #>> '{promptVariants,text,text}'), focus.word) - 1,
    'end', strpos(lower(item.source_content #>> '{promptVariants,text,text}'), focus.word) - 1 + length(focus.word)
  )
)
FROM (VALUES
  ('01a18faf-6900-7b12-bb61-6475df1bb0fc'::uuid, 'order'),
  ('01a18faf-6900-7a57-a4d0-4aefe2e1a1af'::uuid, 'invoice'),
  ('01a18faf-6900-7aa6-bcea-317bf4ce44d0'::uuid, 'receipt'),
  ('01a18faf-6900-7273-a9ad-17444ec8af03'::uuid, 'contract')
) AS focus(id, word)
WHERE item.id = focus.id AND strpos(lower(item.source_content #>> '{promptVariants,text,text}'), focus.word) > 0;

ALTER TABLE practice_items ENABLE TRIGGER practice_items_published_immutable;
