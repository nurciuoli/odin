-- Receipt identity remains global; ordering is independently scoped to each session.
ALTER TABLE session_messages ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE session_messages SET sort_order = sequence;
DROP INDEX session_messages_pending;
CREATE INDEX session_messages_pending ON session_messages(session_id, state, sort_order, sequence);

-- Only selected library MCP ids are persisted, never resolved credentials/configuration.
-- Existing sessions have no recorded selection and keep their native runtime configuration.
ALTER TABLE sessions ADD COLUMN launch_config TEXT;
