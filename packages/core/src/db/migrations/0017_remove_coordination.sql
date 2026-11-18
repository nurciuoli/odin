-- The project coordinator and threads prototype was removed. Databases that already ran 0016 (since deleted) still
-- have its tables; databases that never did, skip them.
DROP TABLE IF EXISTS coordinators;
DROP TABLE IF EXISTS threads;
DROP TABLE IF EXISTS project_briefs;
