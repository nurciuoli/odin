-- Codex owns thread IDs; Odin's public session IDs stay stable across native runtimes and restarts.
CREATE TABLE harness_session_links (
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  native_id TEXT NOT NULL,
  PRIMARY KEY (harness, session_id),
  UNIQUE (harness, native_id)
);
