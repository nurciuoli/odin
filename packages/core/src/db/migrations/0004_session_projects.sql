-- Sessions are workspace conversations with one working repository and optional additional repositories.
ALTER TABLE sessions ADD COLUMN projects TEXT NOT NULL DEFAULT '[]';
UPDATE sessions SET projects = json_array(project);
