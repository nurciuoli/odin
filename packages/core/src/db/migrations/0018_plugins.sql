-- Plugins: a member installed by a plugin can have a different id in the project than in the library (own members),
-- and an included member can be pinned to a library version. A plugin install is one row listing its members.
ALTER TABLE installations ADD COLUMN project_id TEXT;
ALTER TABLE installations ADD COLUMN pinned_version TEXT;

CREATE TABLE plugin_installations (
  project           TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
  plugin_id         TEXT NOT NULL,
  installed_version TEXT NOT NULL,
  runs_hash         TEXT NOT NULL,               -- hash of what the person confirmed would run
  members           TEXT NOT NULL DEFAULT '[]',  -- [{ kind, asset, pid, origin, adopted }]
  installed_at      TEXT NOT NULL,
  PRIMARY KEY (project, plugin_id)
);
