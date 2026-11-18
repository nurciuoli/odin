-- Project coordinator and threads (docs/plans/project-coordinator.md). No foreign keys to sessions: the role row is
-- written just before sessions.start creates the session record; listings join sessions and skip orphans.
CREATE TABLE coordinators (
  session_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX coordinators_project ON coordinators(project);
CREATE TABLE threads (
  session_id TEXT PRIMARY KEY,
  coordinator_id TEXT NOT NULL,
  project TEXT NOT NULL,
  task TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX threads_coordinator ON threads(coordinator_id);
CREATE TABLE project_briefs (
  project TEXT PRIMARY KEY,
  instructions TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
