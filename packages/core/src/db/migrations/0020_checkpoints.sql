-- Session checkpoints: one row per turn (and per pre-restore safety snapshot). The snapshots themselves are commits in
-- an Odin-owned shadow git store under <home>/checkpoints/; these rows hold the tree ids. docs/contracts.md#checkpoints
CREATE TABLE checkpoints (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('turn', 'pre-restore')),
  message_id  TEXT,
  turn        INTEGER NOT NULL,
  at          TEXT NOT NULL,
  before_tree TEXT,                -- tree id before the agent acted; null unless snapshot = 'ok'
  end_tree    TEXT,                -- tree id when the turn ended; null until then
  files       TEXT,                -- {changed, added, removed} JSON, null until the turn ends
  snapshot    TEXT NOT NULL CHECK (snapshot IN ('ok', 'skipped', 'failed')),
  PRIMARY KEY (session_id, id)
);
CREATE INDEX checkpoints_session ON checkpoints(session_id, turn);
