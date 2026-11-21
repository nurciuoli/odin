ALTER TABLE sessions ADD COLUMN last_run_at TEXT;
UPDATE sessions
SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(activity_at, discovery_updated_at, created_at));
CREATE INDEX sessions_last_run ON sessions(last_run_at DESC, created_at DESC, id);
