-- One row can be non-direct for several reasons at once, so a single directness value cannot say why.
ALTER TABLE skill_evidence ADD COLUMN reasons JSONB;

UPDATE skill_evidence SET reasons = '[]'::jsonb WHERE directness = 'direct';

-- Mirrors deriveEvidence. `result` is never cleared; `plan` (phase, priming, quality) may be.
WITH facts AS (
  SELECT e.id, e.skill, e.validity, p.task IS NOT NULL AS has_plan,
         r.task ->> 'template' AS template, r.task ->> 'intent' AS intent,
         g.target ->> 'outcome' AS outcome, COALESCE((g.target ->> 'hintCount')::int, 0) AS hint_count,
         p.task ->> 'phase' AS phase, p.task -> 'serverEvaluation' AS server
  FROM skill_evidence e
  JOIN learning_sessions s ON s.id = e.session_id
  LEFT JOIN LATERAL (SELECT x AS task FROM jsonb_array_elements(s.result -> 'tasks') x
                     WHERE x ->> 'taskId' = e.task_id::text) r ON true
  LEFT JOIN LATERAL (SELECT y AS target FROM jsonb_array_elements(r.task -> 'targets') y
                     WHERE (y ->> 'ordinal')::int = e.target_ordinal) g ON true
  LEFT JOIN LATERAL (SELECT z AS task FROM jsonb_array_elements(s.plan -> 'tasks') z
                     WHERE z ->> 'id' = e.task_id::text) p ON true
  WHERE e.reasons IS NULL
), derived AS (
  SELECT f.id, f.has_plan, COALESCE((
    SELECT jsonb_agg(c.reason ORDER BY c.ord) FROM (VALUES
      (1, 'new_practice', f.phase = 'new_practice'),
      (2, 'audio_not_played', f.skill = 'listening' AND f.validity = 'invalid'),
      (3, 'weak_template', (f.skill = 'listening' AND f.intent = 'sound_discrimination')
                        OR (f.skill IN ('reading', 'writing') AND (f.intent IN ('pairing', 'spelling_repair')
                            OR (f.intent = 'meaning_recognition' AND f.template <> 'select')))),
      (4, 'quality_unqualified', f.skill IN ('reading', 'writing') AND NOT (f.server ->> 'qualityQualified')::boolean),
      (5, 'hinted', f.skill <> 'speaking' AND f.hint_count > 0),
      (6, 'revealed', f.skill <> 'speaking' AND f.outcome = 'revealed'),
      (7, 'primed', f.skill <> 'speaking' AND (f.server ->> 'isPrimed')::boolean),
      (8, 'invalid_recording', f.skill = 'speaking' AND f.validity = 'invalid')
    ) AS c(ord, reason, applies) WHERE c.applies), '[]'::jsonb) AS reasons
  FROM facts f
)
UPDATE skill_evidence e
SET reasons = CASE
    -- Without the plan the list may be incomplete; never let a non-direct row read as direct.
    WHEN d.reasons = '[]'::jsonb THEN '["unknown"]'::jsonb
    WHEN NOT d.has_plan THEN d.reasons || '["unknown"]'::jsonb
    ELSE d.reasons
  END
FROM derived d WHERE d.id = e.id;

ALTER TABLE skill_evidence ALTER COLUMN reasons SET NOT NULL;
ALTER TABLE skill_evidence ADD CONSTRAINT skill_evidence_reasons_check CHECK (jsonb_typeof(reasons) = 'array' AND reasons <@ '["new_practice","hinted","revealed","primed","weak_template","quality_unqualified","audio_not_played","invalid_recording","unknown"]'::jsonb);
ALTER TABLE skill_evidence DROP COLUMN directness;
