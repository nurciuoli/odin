-- Notebooks are plain files: no session links, no pending notices, no execution attribution.
DROP TABLE notebook_notices;
DROP TABLE notebook_session_links;
CREATE TABLE notebook_executions_new (
  id TEXT PRIMARY KEY,
  kernel_id TEXT NOT NULL REFERENCES notebook_kernels(id) ON DELETE CASCADE,
  cell_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT
);
INSERT INTO notebook_executions_new (id, kernel_id, cell_id, state, started_at, finished_at, error)
  SELECT id, kernel_id, cell_id, state, started_at, finished_at, error FROM notebook_executions;
DROP TABLE notebook_executions;
ALTER TABLE notebook_executions_new RENAME TO notebook_executions;
