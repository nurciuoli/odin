import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMigrations, migrate, schemaVersion, SCHEMA_FILE, MIGRATIONS_DIR } from "./db.ts";

test("work queue migration drops work/backlog tables and sessions.item_id, keeps sessions, pulls and files", () => {
  const dir = mkdtempSync(join(tmpdir(), "odin-remove-work-"));
  const workFile = join(dir, ".odin", "work", "w-1.md");
  mkdirSync(join(dir, ".odin", "work"), { recursive: true });
  writeFileSync(workFile, "# keep me\n");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(SCHEMA_FILE, "utf8"));
    for (const migration of listMigrations(MIGRATIONS_DIR).filter((m) => m.version <= 9)) db.exec(readFileSync(migration.file, "utf8"));
    db.exec("INSERT INTO meta VALUES ('schema_version', '9')");
    db.exec(`INSERT INTO projects (name,path,created_at,updated_at) VALUES ('demo','${dir}','t','t')`);
    db.exec("INSERT INTO items (id,project,title,created_by_id,created_at,updated_at) VALUES (1,'demo','Old','system:odin','t','t')");
    db.exec("INSERT INTO sessions(id,harness,project,title,origin,state,cwd,metrics,item_id,created_at,updated_at) VALUES ('s','claude','demo','Keep me','odin','idle','/demo','{}',1,'t','t')");
    db.exec("INSERT INTO session_items (session_id,item_id) VALUES ('s',1)");
    db.exec("INSERT INTO work_items (project,id,title,kind,status,updated,path) VALUES ('demo','w-1','x','task','ready','t','p')");
    db.exec("INSERT INTO gh_map (project,kind,local_id) VALUES ('demo','item',1), ('demo','pull',4)");
    db.exec("INSERT INTO pulls (project,number,head_branch,state,url,updated_at) VALUES ('demo',4,'b','open','u','t')");
    migrate(db);
    assert.ok(schemaVersion(db) >= 10);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name));
    for (const t of ["items", "milestones", "session_items", "work_items", "work_leases", "work_inbox"]) assert.ok(!tables.has(t), t);
    const columns = db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((r: any) => r.name);
    assert.ok(!columns.includes("item_id"));
    assert.equal((db.prepare("SELECT title FROM sessions WHERE id='s'").get() as any).title, "Keep me");
    assert.deepEqual(db.prepare("SELECT kind FROM gh_map").all().map((r: any) => r.kind), ["pull"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pulls").get() as any).n, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.ok(existsSync(workFile), "work files stay on disk");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
