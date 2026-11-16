-- Work queue (docs/contracts.md#work-queue). work_items is an index rebuilt from the item files; work_leases is the
-- only home of live claims; work_inbox indexes inbox entries.
CREATE TABLE work_items (
  project     TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL,
  priority    INTEGER,
  size        TEXT,
  parent      TEXT,
  depends_on  TEXT NOT NULL DEFAULT '[]',
  source      TEXT,
  pr          INTEGER,
  updated     TEXT NOT NULL,
  path        TEXT NOT NULL,
  mtime_ms    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project, id)
);
CREATE INDEX work_items_status ON work_items(project, status, priority);
CREATE INDEX work_items_parent ON work_items(project, parent);

CREATE TABLE work_leases (
  project     TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  holder      TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  branch      TEXT,
  PRIMARY KEY (project, item_id),
  FOREIGN KEY (project, item_id) REFERENCES work_items(project, id) ON DELETE CASCADE
);
CREATE INDEX work_leases_holder ON work_leases(holder);
CREATE INDEX work_leases_expires ON work_leases(expires_at);

CREATE TABLE work_inbox (
  project     TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  author      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  triaged_at  TEXT,
  item_ids    TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (project, id)
);
