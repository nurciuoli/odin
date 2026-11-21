-- Keep prior unread and read markers comparable across the upgrade.
ALTER TABLE sessions ADD COLUMN activity_at TEXT;
UPDATE sessions SET activity_at = updated_at;

-- Native metadata as last observed by discovery, independent of Odin metadata changes.
ALTER TABLE sessions ADD COLUMN discovery_updated_at TEXT;
ALTER TABLE sessions ADD COLUMN discovery_title TEXT;

-- A project and harness start tracking new activity with their first discovery attempt.
CREATE TABLE session_discovery_baselines (
  project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  harness TEXT NOT NULL,
  started_at TEXT NOT NULL,
  PRIMARY KEY (project, harness)
);
