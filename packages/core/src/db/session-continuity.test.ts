import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { listMigrations, migrate, schemaVersion, SCHEMA_FILE, MIGRATIONS_DIR } from "./db.ts";

test("continuity migration preserves prioritized receipts, payloads and foreign keys", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(SCHEMA_FILE, "utf8"));
    for (const migration of listMigrations(MIGRATIONS_DIR).filter(m => m.version <= 8))
      db.exec(readFileSync(migration.file, "utf8"));
    db.exec("INSERT INTO meta VALUES ('schema_version', '8')");
    db.exec("INSERT INTO projects (name,path,created_at,updated_at) VALUES ('demo','/demo','t','t')");
    db.exec("INSERT INTO sessions(id,harness,project,title,origin,state,cwd,metrics,created_at,updated_at) VALUES ('s','grok','demo','Keep me','odin','idle','/demo','{}','t','t')");
    const insert = db.prepare("INSERT INTO session_messages(sequence,id,session_id,request_hash,payload,state,created_at,updated_at) VALUES (?,?,'s','hash',?,'queued','t','t')");
    insert.run(7, "normal", '{"text":"later"}');
    insert.run(-1, "priority", '{"text":"first"}');
    migrate(db);
    assert.ok(schemaVersion(db) >= 9);
    assert.deepEqual(db.prepare("SELECT id,sort_order,payload FROM session_messages ORDER BY sort_order,sequence").all().map(r => ({ ...r })), [
      { id: "priority", sort_order: -1, payload: '{"text":"first"}' },
      { id: "normal", sort_order: 7, payload: '{"text":"later"}' },
    ]);
    assert.equal(db.prepare("SELECT launch_config FROM sessions WHERE id='s'").get()!.launch_config, null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    migrate(db);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM session_messages").get()!.n, 2);
  } finally { db.close(); }
});
