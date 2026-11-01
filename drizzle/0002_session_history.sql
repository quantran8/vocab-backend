-- One session is one practice-history row. Snapshots and raw events are purgeable; result is kept.
ALTER TABLE learning_sessions
  ADD COLUMN plan JSONB,
  ADD COLUMN raw_events JSONB,
  ADD COLUMN result JSONB;

UPDATE learning_sessions s SET plan = jsonb_build_object(
  'tasks', (
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id, 'ordinal', t.ordinal, 'phase', t.phase, 'template', t.template, 'variant', t.variant,
      'curatedItemId', t.curated_item_id, 'clientPayload', t.client_payload,
      'serverEvaluation', t.server_evaluation, 'evaluatorVersion', t.evaluator_version,
      'targets', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('ordinal', g.ordinal, 'meaningId', g.meaning_id, 'pronunciationId', g.pronunciation_id) ORDER BY g.ordinal)
        FROM session_task_targets g WHERE g.session_id = t.session_id AND g.task_id = t.id), '[]'::jsonb)
    ) ORDER BY t.ordinal)
    FROM session_tasks t WHERE t.session_id = s.id),
  'learnSteps', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', l.id, 'meaningId', l.meaning_id, 'ordinal', l.ordinal, 'clientCard', l.client_card, 'firstRecallTaskId', l.first_recall_task_id
    ) ORDER BY l.ordinal)
    FROM session_learn_steps l WHERE l.session_id = s.id), '[]'::jsonb))
WHERE EXISTS (SELECT 1 FROM session_tasks t WHERE t.session_id = s.id);

UPDATE learning_sessions s SET
  raw_events = COALESCE((
    SELECT jsonb_agg(jsonb_build_object('taskId', r.task_id, 'events', r.raw_events))
    FROM practice_task_results r WHERE r.session_id = s.id), '[]'::jsonb),
  result = jsonb_build_object('tasks', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'taskId', r.task_id, 'template', t.template, 'variant', t.variant, 'intent', t.server_evaluation->>'intent',
      'deliveryMode', r.normalized_result->>'deliveryMode',
      'accuracyScore', (SELECT a.accuracy_score FROM speech_assessment_receipts a
                        WHERE a.session_id = r.session_id AND a.task_id = r.task_id AND a.consumed_at IS NOT NULL LIMIT 1),
      'targets', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'ordinal', x.target_ordinal, 'meaningId', g.meaning_id, 'pronunciationId', g.pronunciation_id, 'outcome', x.outcome,
          'firstAttemptCorrect', x.first_attempt_correct, 'attemptCount', x.attempt_count, 'hintCount', x.hint_count
        ) ORDER BY x.target_ordinal)
        FROM practice_target_results x
        JOIN session_task_targets g ON g.session_id = x.session_id AND g.task_id = x.task_id AND g.ordinal = x.target_ordinal
        WHERE x.session_id = r.session_id AND x.task_id = r.task_id), '[]'::jsonb)
    ))
    FROM practice_task_results r
    JOIN session_tasks t ON t.session_id = r.session_id AND t.id = r.task_id
    WHERE r.session_id = s.id), '[]'::jsonb))
WHERE s.status = 'committed';

ALTER TABLE skill_evidence DROP CONSTRAINT skill_evidence_session_id_task_id_target_ordinal_fkey;
ALTER TABLE speech_assessment_receipts DROP CONSTRAINT speech_assessment_receipts_session_id_task_id_fkey;
DROP TABLE practice_target_results, practice_task_results, session_learn_steps, session_task_targets, session_tasks;

ALTER TABLE skill_evidence
  ADD CONSTRAINT skill_evidence_session_id_user_id_fkey FOREIGN KEY (session_id, user_id) REFERENCES learning_sessions (id, user_id);
ALTER TABLE speech_assessment_receipts
  ADD CONSTRAINT speech_assessment_receipts_session_id_fkey FOREIGN KEY (session_id) REFERENCES learning_sessions (id);

ALTER TABLE learning_sessions
  DROP CONSTRAINT learning_sessions_check1,
  ADD CONSTRAINT learning_sessions_check1 CHECK (
    (status = 'committed' AND committed_at IS NOT NULL AND commit_request_sha256 IS NOT NULL AND commit_response IS NOT NULL AND result IS NOT NULL)
    OR (status <> 'committed' AND committed_at IS NULL AND commit_request_sha256 IS NULL AND commit_response IS NULL AND result IS NULL)
  ),
  ADD CONSTRAINT learning_sessions_check2 CHECK (status <> 'issued' OR plan IS NOT NULL),
  ADD CONSTRAINT learning_sessions_plan_check CHECK (jsonb_typeof(plan) = 'object'),
  ADD CONSTRAINT learning_sessions_raw_events_check CHECK (jsonb_typeof(raw_events) = 'array'),
  ADD CONSTRAINT learning_sessions_result_check CHECK (jsonb_typeof(result) = 'object');

-- An issued plan never changes; retention may only clear it.
CREATE FUNCTION forbid_session_plan_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plan IS NOT NULL AND NEW.plan IS DISTINCT FROM OLD.plan THEN
    RAISE EXCEPTION 'learning_sessions.plan is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER learning_sessions_plan_immutable
  BEFORE UPDATE OF plan ON learning_sessions
  FOR EACH ROW EXECUTE FUNCTION forbid_session_plan_rewrite();
