-- odin: foreign-keys-off
-- The app was renamed: sessions it starts have origin 'odin'. A CHECK can only change by rebuilding the table.
CREATE TABLE sessions_new (
  id              TEXT PRIMARY KEY,
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
  parent_id       TEXT,
  pull            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  ended_at        TEXT,
  error           TEXT,
  metrics         TEXT NOT NULL,
  slash_commands  TEXT,
  projects        TEXT NOT NULL DEFAULT '[]',
  aside           INTEGER NOT NULL DEFAULT 0,
  launch_config   TEXT,
  effort          TEXT
);

INSERT INTO sessions_new (
  id, harness, project, title, first_prompt, tags, pinned, archived, origin, state, waiting_for, cwd, workspace, branch,
  model, permission_mode, agent, agent_version, template_id, parent_id, pull, created_at, updated_at, ended_at, error,
  metrics, slash_commands, projects, aside, launch_config, effort
)
SELECT
  id, harness, project, title, first_prompt, tags, pinned, archived,
  CASE WHEN origin = 'external' THEN 'external' ELSE 'odin' END,
  state, waiting_for, cwd, workspace, branch,
  model, permission_mode, agent, agent_version, template_id, parent_id, pull, created_at, updated_at, ended_at, error,
  metrics, slash_commands, projects, aside, launch_config, effort
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX sessions_project ON sessions(project, updated_at DESC);
CREATE INDEX sessions_updated ON sessions(updated_at DESC);
CREATE INDEX sessions_branch ON sessions(project, branch);
CREATE INDEX sessions_parent ON sessions(parent_id);
