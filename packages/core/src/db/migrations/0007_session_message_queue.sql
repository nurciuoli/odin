-- Durable follow-up outbox; completed/cancelled rows retain idempotency receipts.
CREATE TABLE session_message_queues (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  paused INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE session_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_id TEXT,
  request_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued', 'sending', 'uncertain', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, client_id)
);
CREATE INDEX session_messages_pending ON session_messages(session_id, state, sequence);
