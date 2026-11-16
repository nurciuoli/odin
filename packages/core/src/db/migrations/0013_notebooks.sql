CREATE TABLE notebook_kernels (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL REFERENCES projects(name) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  interpreter TEXT NOT NULL,
  location TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'stopped',
  editor TEXT NOT NULL DEFAULT 'odin',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project, name)
);
CREATE TABLE notebook_session_links (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kernel_id TEXT NOT NULL REFERENCES notebook_kernels(id) ON DELETE CASCADE,
  PRIMARY KEY(session_id, kernel_id)
);
CREATE TABLE notebook_executions (
  id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL REFERENCES notebook_kernels(id) ON DELETE CASCADE,
  cell_id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  state TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT
);
CREATE TABLE notebook_notices (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kernel_id TEXT NOT NULL REFERENCES notebook_kernels(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
