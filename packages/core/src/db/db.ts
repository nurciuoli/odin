// SQLite via node:sqlite. Baseline schema.sql is version 1; migrations/NNNN_*.sql bump it from there.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const HERE = import.meta.dirname;
export const SCHEMA_FILE = join(HERE, "schema.sql");
export const MIGRATIONS_DIR = join(HERE, "migrations");
/** A migration starting with this line runs with foreign keys off (see migrate). */
const FK_OFF_MARKER = /^-- odin: foreign-keys-off\b/;

/** Pre-migration snapshots kept in `<db dir>/backups/`; older ones are deleted. */
export const BACKUPS_KEPT = 5;

export interface OpenDbOptions {
  migrationsDir?: string;
  /** Clock for backup file names (tests). */
  now?: () => Date;
}

export function openDb(path: string, options: OpenDbOptions = {}): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
    if (path !== ":memory:") backupBeforeMigrate(db, path, migrationsDir, options.now?.() ?? new Date());
    migrate(db, migrationsDir);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Snapshot an existing database before migrations change it, so a bad upgrade can be undone by copying the file back.
 * Writes `<db dir>/backups/<name>.v<version>.<timestamp>.db` (one file, WAL included) and returns its path, or null
 * when the database is new or already current. A failed backup throws: migrations do not run without one.
 */
export function backupBeforeMigrate(db: DatabaseSync, path: string, migrationsDir: string, now: Date): string | null {
  const version = schemaVersion(db);
  if (version === 0) return null;
  if (!listMigrations(migrationsDir).some((m) => m.version > version)) return null;
  const dir = join(dirname(path), "backups");
  mkdirSync(dir, { recursive: true });
  const stem = basename(path).replace(/\.db$/, "");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const target = join(dir, `${stem}.v${version}.${stamp}.db`);
  db.prepare("VACUUM INTO ?").run(target);
  const mine = readdirSync(dir)
    .filter((name) => name.startsWith(`${stem}.v`) && name.endsWith(".db"))
    .map((name) => ({ name, stamp: name.split(".").at(-2) ?? "" }))
    .sort((a, b) => a.stamp.localeCompare(b.stamp));
  for (const old of mine.slice(0, -BACKUPS_KEPT)) rmSync(join(dir, old.name), { force: true });
  return target;
}

export function schemaVersion(db: DatabaseSync): number {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

function inTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function setVersion(db: DatabaseSync, version: number): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(version));
}

/** Numbered migration files, sorted. Names look like 0002_add_column.sql. */
export function listMigrations(dir: string): { version: number; file: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, m: /^(\d{4,})_[\w-]+\.sql$/.exec(name) }))
    .filter((x) => x.m)
    .map((x) => ({ version: Number(x.m![1]), file: join(dir, x.name) }))
    .sort((a, b) => a.version - b.version);
}

export function migrate(db: DatabaseSync, migrationsDir: string = MIGRATIONS_DIR): number {
  let version = schemaVersion(db);
  if (version === 0) {
    inTransaction(db, () => {
      db.exec(readFileSync(SCHEMA_FILE, "utf8"));
      setVersion(db, 1);
    });
    version = 1;
  }
  for (const m of listMigrations(migrationsDir)) {
    if (m.version <= version) continue;
    if (m.version === 1) throw new Error(`migration ${m.file}: version 1 is the baseline schema.sql`);
    const sql = readFileSync(m.file, "utf8");
    // Table rebuilds (the only way to change a CHECK) need foreign keys off, which SQLite ignores inside a
    // transaction. Such a migration opts in with this marker and gets a foreign_key_check before commit.
    const fkOff = FK_OFF_MARKER.test(sql);
    if (fkOff) db.exec("PRAGMA foreign_keys = OFF");
    try {
      inTransaction(db, () => {
        db.exec(sql);
        if (fkOff && db.prepare("PRAGMA foreign_key_check").all().length) {
          throw new Error(`migration ${m.file}: foreign key check failed`);
        }
        setVersion(db, m.version);
      });
    } finally {
      if (fkOff) db.exec("PRAGMA foreign_keys = ON");
    }
    version = m.version;
  }
  return version;
}
