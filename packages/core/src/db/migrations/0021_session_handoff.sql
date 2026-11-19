-- A session that continues another one on a different harness. JSON {from, harness, at}; NULL otherwise.
ALTER TABLE sessions ADD COLUMN handoff TEXT;
