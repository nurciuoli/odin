-- Side threads: forks for a question asked during the parent session, kept out of session lists.
ALTER TABLE sessions ADD COLUMN aside INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sessions_parent ON sessions(parent_id);
