CREATE INDEX idx_sessions_user_committed ON learning_sessions (user_id, committed_at) WHERE status = 'committed';
