-- Removes the work queue (both generations: the file-indexed `work_*` tables and the older backlog items and
-- milestones) and the session → item link.
-- Only database rows go. Files under <repo>/.odin/work/ and ODIN_HOME stay on disk; Odin stops reading them.
DROP TABLE IF EXISTS work_leases;
DROP TABLE IF EXISTS work_inbox;
DROP TABLE IF EXISTS work_items;
DROP TABLE IF EXISTS session_items;
ALTER TABLE sessions DROP COLUMN item_id;
DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS milestones;
-- gh_map keeps its pull rows; item and milestone mappings point at nothing now.
DELETE FROM gh_map WHERE kind IN ('item', 'milestone');
