-- Saved document sources for a project. NULL means discovery is in effect.
ALTER TABLE projects ADD COLUMN sources TEXT;
-- Fingerprint of the discovered source files so a status or readme edit emits project.updated.
ALTER TABLE projects ADD COLUMN source_stamp TEXT NOT NULL DEFAULT '';
