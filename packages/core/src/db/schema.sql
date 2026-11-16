-- Odin v2 baseline schema (version 1 of <ODIN_HOME>/state.db; the v1 odin.db is not read or migrated).
-- Changes after this are numbered files in migrations/. Times are ISO-8601 TEXT (UTC). JSON columns are TEXT.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Odin's own settings (AppSettings), one row per key, JSON values. Owner: settings.
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A registered directory. Owner: projects.
CREATE TABLE projects (
  name           TEXT PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  settings       TEXT NOT NULL DEFAULT '{}',     -- user overrides (UpdateProjectSettingsRequest, nulls dropped)
  manifest       TEXT NOT NULL DEFAULT '{}',     -- PROJECT.md frontmatter values as read, or {} when absent
  manifest_error TEXT,
  git            TEXT NOT NULL DEFAULT '{}',     -- GitState
  agents         TEXT NOT NULL DEFAULT '[]',     -- ProjectAgent[] as last read from .claude/agents
  written_files  TEXT NOT NULL DEFAULT '[]',     -- repo-relative files other modules wrote (noteWritten)
  missing        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- GitHub mirror (v1). items, milestones, session_items and sessions.item_id are dropped by 0011_remove_work_queue.sql.
-- Owner of what remains: sync (gh_map, sync_state, pulls).
CREATE TABLE milestones (
  id          INTEGER PRIMARY KEY,
  project     TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  number      INTEGER,
  url         TEXT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_on      TEXT,
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (project, number)
);

CREATE TABLE items (
  id             INTEGER PRIMARY KEY,
  project        TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  number         INTEGER,
  url            TEXT,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  state_reason   TEXT,
  labels         TEXT NOT NULL DEFAULT '[]',
  milestone_id   INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  assignee_id    TEXT,
  created_by_id  TEXT NOT NULL,                  -- 'system:sync' for mirrored issues, 'system:odin' otherwise
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  closed_at      TEXT,
  reopened_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project, number)
);
CREATE INDEX items_project ON items(project, state);

-- One row per session Odin knows: started here, or external (found in the harness's list or through ingest).
-- The conversation itself stays in the harness's own files. Owner: sessions.
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,              -- the harness's session id
  harness         TEXT NOT NULL,
  project         TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  first_prompt    TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  pinned          INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  origin          TEXT NOT NULL CHECK (origin IN ('odin', 'external')),
  state           TEXT NOT NULL CHECK (state IN ('idle', 'running', 'waiting', 'ended', 'failed')),
  waiting_for     TEXT CHECK (waiting_for IN ('permission', 'question')),
  cwd             TEXT NOT NULL,
  workspace       TEXT NOT NULL DEFAULT '{"kind":"checkout"}',
  branch          TEXT,
  model           TEXT,
  permission_mode TEXT,
  agent           TEXT,
  agent_version   TEXT,
  template_id     TEXT,
  item_id         INTEGER REFERENCES items(id) ON DELETE SET NULL,
  parent_id       TEXT,
  pull            TEXT,                          -- PullRef JSON
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  ended_at        TEXT,
  error           TEXT,
  metrics         TEXT NOT NULL                  -- SessionMetrics JSON
);
CREATE INDEX sessions_project ON sessions(project, updated_at DESC);
CREATE INDEX sessions_updated ON sessions(updated_at DESC);
CREATE INDEX sessions_branch ON sessions(project, branch);

CREATE TABLE session_items (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, item_id)
);

-- Measurement facts for metrics: ingested hook events (external sessions) and facts recorded from the live harness
-- stream (Odin sessions). `id` is the producer's id; duplicates are ignored. Owner: ingest.
CREATE TABLE session_events (
  id          TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL UNIQUE,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source      TEXT NOT NULL CHECK (source IN ('ingest', 'harness')),
  kind        TEXT NOT NULL,                     -- IngestKind
  ts          TEXT NOT NULL,
  data        TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX session_events_session ON session_events(session_id, seq);

-- Artifacts posted in sessions. Owner: artifacts.
CREATE TABLE artifacts (
  id         INTEGER PRIMARY KEY,
  project    TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX artifacts_session ON artifacts(session_id, id);

CREATE TABLE artifact_versions (
  artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  html        TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

-- Library history: every distinct content of an asset Odin has seen (the files themselves are the current
-- version). Owner: library.
CREATE TABLE library_versions (
  kind          TEXT NOT NULL,
  asset_id      TEXT NOT NULL,
  version       TEXT NOT NULL,                   -- libraryHash of the files
  files         TEXT NOT NULL,                   -- AssetFiles JSON
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (kind, asset_id, version)
);

-- Library assets installed into projects. Owner: library.
CREATE TABLE installations (
  project           TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  asset_id          TEXT NOT NULL,
  installed_version TEXT NOT NULL,
  paths             TEXT NOT NULL DEFAULT '[]',
  merged            TEXT,                        -- for merge kinds: the fragment Odin wrote (to diff and remove)
  installed_at      TEXT NOT NULL,
  PRIMARY KEY (project, kind, asset_id)
);

-- GitHub sync bookkeeping (unchanged from v1).
CREATE TABLE gh_map (
  project           TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('item', 'milestone', 'pull')),
  local_id          INTEGER NOT NULL,
  number            INTEGER,
  node_id           TEXT,
  etag              TEXT,
  local_updated_at  TEXT,
  remote_updated_at TEXT,
  pending           INTEGER NOT NULL DEFAULT 0,
  snapshot          TEXT,
  PRIMARY KEY (project, kind, local_id)
);

CREATE TABLE sync_state (
  project      TEXT PRIMARY KEY REFERENCES projects(name) ON DELETE CASCADE,
  state        TEXT NOT NULL DEFAULT 'idle',
  last_sync_at TEXT,
  error        TEXT,
  cursor       TEXT
);

CREATE TABLE pulls (
  project       TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  number        INTEGER NOT NULL,
  head_branch   TEXT NOT NULL,
  state         TEXT NOT NULL,
  merged        INTEGER NOT NULL DEFAULT 0,
  review_rounds INTEGER NOT NULL DEFAULT 0,
  files         TEXT NOT NULL DEFAULT '[]',
  closes        TEXT NOT NULL DEFAULT '[]',
  labels        TEXT NOT NULL DEFAULT '[]',
  url           TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  merged_at     TEXT,
  PRIMARY KEY (project, number)
);
