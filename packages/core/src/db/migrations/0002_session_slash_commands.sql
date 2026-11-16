-- The slash commands the harness last reported for a session (its `init` event), as a JSON array of names, so the
-- composer can offer them before the session is live again. NULL until a live handle reported some. Owner: sessions.
ALTER TABLE sessions ADD COLUMN slash_commands TEXT;
