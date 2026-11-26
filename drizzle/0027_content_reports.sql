CREATE TABLE content_reports (
    id UUID PRIMARY KEY,
    reporter_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    client_report_id UUID NOT NULL,
    request_sha256 CHAR(64) NOT NULL,
    source VARCHAR(16) NOT NULL CHECK (source IN ('learn_card','practice_task','word_detail')),
    reason VARCHAR(32) NOT NULL CHECK (reason IN ('incorrect_meaning','incorrect_definition','incorrect_example','answer_should_be_accepted','incorrect_question','audio_issue','other')),
    note TEXT CHECK (char_length(note) BETWEEN 1 AND 500),
    session_id UUID,
    task_id UUID,
    learn_step_id UUID,
    meaning_ids JSONB NOT NULL CHECK (jsonb_typeof(meaning_ids) = 'array'),
    target_key TEXT NOT NULL,
    content_version TEXT,
    explanation_locale VARCHAR(32) NOT NULL,
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    attempt_excerpt JSONB CHECK (jsonb_typeof(attempt_excerpt) = 'object'),
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','under_review','resolved','dismissed')),
    reviewed_by UUID,
    reviewed_at TIMESTAMPTZ,
    resolution_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT content_reports_reporter_id_client_report_id_key UNIQUE (reporter_id, client_report_id),
    CHECK ((source = 'word_detail') = (session_id IS NULL)),
    CHECK (reason <> 'other' OR note IS NOT NULL),
    CHECK (status IN ('pending','under_review') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND resolution_note IS NOT NULL))
);
-- One open report per reporter, target, reason and locale; a closed one does not block a new report.
CREATE UNIQUE INDEX content_reports_open_target_key ON content_reports (reporter_id, target_key, reason, explanation_locale)
    WHERE status IN ('pending','under_review');
CREATE INDEX idx_content_reports_queue ON content_reports (status, created_at);
CREATE INDEX idx_content_reports_target ON content_reports (target_key, reason, explanation_locale);
CREATE INDEX idx_content_reports_reporter ON content_reports (reporter_id, created_at);

CREATE TABLE content_report_events (
    id UUID PRIMARY KEY,
    report_id UUID NOT NULL REFERENCES content_reports(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL,
    from_status VARCHAR(16) NOT NULL CHECK (from_status IN ('pending','under_review','resolved','dismissed')),
    to_status VARCHAR(16) NOT NULL CHECK (to_status IN ('pending','under_review','resolved','dismissed')),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_content_report_events_report ON content_report_events (report_id, created_at);

ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_report_events ENABLE ROW LEVEL SECURITY;
