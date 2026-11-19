import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKUPS_KEPT, openDb, schemaVersion } from "./db.ts";
import { tempDir, removeTempDir } from "../test-helpers.ts";

function scratch(): { dir: string; path: string; migrations: string; done: () => void } {
  const dir = tempDir("db-backup-");
  const migrations = join(dir, "migrations");
  mkdirSync(migrations);
  return { dir, path: join(dir, "state.db"), migrations, done: () => removeTempDir(dir) };
}

const backups = (dir: string): string[] => (existsSync(join(dir, "backups")) ? readdirSync(join(dir, "backups")).sort() : []);

test("a new database and an up-to-date one are opened without a backup", () => {
  const s = scratch();
  try {
    openDb(s.path, { migrationsDir: s.migrations }).close();
    openDb(s.path, { migrationsDir: s.migrations }).close();
    assert.deepEqual(backups(s.dir), []);
  } finally {
    s.done();
  }
});

test("pending migrations snapshot the database first, at its old version and with its data", () => {
  const s = scratch();
  try {
    const db = openDb(s.path, { migrationsDir: s.migrations });
    db.exec("INSERT INTO app_settings (key, value) VALUES ('kept', '\"yes\"')");
    db.close();
    writeFileSync(join(s.migrations, "0002_drop.sql"), "DELETE FROM app_settings;\n");

    const after = openDb(s.path, { migrationsDir: s.migrations, now: () => new Date("2026-11-14T10:20:30.123Z") });
    try {
      assert.equal(schemaVersion(after), 2);
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM app_settings").get()!.n, 0);
    } finally {
      after.close();
    }

    assert.deepEqual(backups(s.dir), ["state.v1.20261114T102030Z.db"]);
    const snapshot = new DatabaseSync(join(s.dir, "backups", "state.v1.20261114T102030Z.db"));
    try {
      assert.equal(schemaVersion(snapshot), 1);
      assert.equal(snapshot.prepare("SELECT value FROM app_settings WHERE key = 'kept'").get()!.value, '"yes"');
    } finally {
      snapshot.close();
    }
  } finally {
    s.done();
  }
});

test("a migration that fails leaves the snapshot behind and the database at its old version", () => {
  const s = scratch();
  try {
    openDb(s.path, { migrationsDir: s.migrations }).close();
    writeFileSync(join(s.migrations, "0002_bad.sql"), "DELETE FROM app_settings; SELECT * FROM no_such_table;\n");
    assert.throws(() => openDb(s.path, { migrationsDir: s.migrations }));
    assert.equal(backups(s.dir).length, 1);
    const db = new DatabaseSync(s.path);
    try {
      assert.equal(schemaVersion(db), 1);
    } finally {
      db.close();
    }
  } finally {
    s.done();
  }
});

test(`only the newest ${BACKUPS_KEPT} snapshots are kept`, () => {
  const s = scratch();
  try {
    openDb(s.path, { migrationsDir: s.migrations }).close();
    const total = BACKUPS_KEPT + 2;
    for (let i = 0; i < total; i++) {
      writeFileSync(join(s.migrations, `${String(i + 2).padStart(4, "0")}_noop.sql`), "SELECT 1;\n");
      openDb(s.path, { migrationsDir: s.migrations, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, i)) }).close();
    }
    const kept = backups(s.dir);
    assert.equal(kept.length, BACKUPS_KEPT);
    assert.equal(kept[0], "state.v3.20260101T000002Z.db");
    assert.equal(kept.at(-1), `state.v${total}.20260101T00000${total - 1}Z.db`);
  } finally {
    s.done();
  }
});
