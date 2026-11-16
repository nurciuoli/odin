import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, schemaVersion, SCHEMA_FILE, MIGRATIONS_DIR } from "./db.ts";

test("workspace session migration preserves old conversations and is repeatable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(SCHEMA_FILE, "utf8"));
    db.exec(readFileSync(join(MIGRATIONS_DIR, "0002_session_slash_commands.sql"), "utf8"));
    db.exec(readFileSync(join(MIGRATIONS_DIR, "0003_harness_session_links.sql"), "utf8"));
    db.exec("INSERT INTO meta VALUES ('schema_version', '3'); INSERT INTO projects (name, path, created_at, updated_at) VALUES ('demo', '/demo', 't', 't')");
    db.exec("INSERT INTO sessions (id, harness, project, title, origin, state, cwd, metrics, created_at, updated_at) VALUES ('old', 'claude', 'demo', 'Keep me', 'external', 'ended', '/demo', '{}', 't', 't')");
    migrate(db);
    assert.ok(schemaVersion(db) >= 5);
    const row = db.prepare("SELECT title, projects FROM sessions WHERE id = 'old'").get()!;
    assert.equal(row.title, "Keep me");
    assert.deepEqual(JSON.parse(row.projects as string), ["demo"]);
    migrate(db);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get()!.n, 1);
  } finally { db.close(); }
});
