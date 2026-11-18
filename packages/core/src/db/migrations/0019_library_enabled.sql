-- Library assets can be switched off without deleting them. Absence of a row means enabled.
CREATE TABLE library_disabled (
  kind        TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  disabled_at TEXT NOT NULL,
  PRIMARY KEY (kind, asset_id)
);
