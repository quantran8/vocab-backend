ALTER TABLE skill_evidence DROP CONSTRAINT skill_evidence_reasons_check;
ALTER TABLE skill_evidence ADD CONSTRAINT skill_evidence_reasons_check CHECK (jsonb_typeof(reasons) = 'array' AND reasons <@ '["new_practice","hinted","revealed","retried","primed","weak_template","quality_unqualified","audio_not_played","invalid_recording","unknown"]'::jsonb);
