// The vault's file backend: <home>/secrets.json, mode 600, replaced atomically. Values live only here and in memory
// while a launch is being resolved. docs/contracts.md#secrets. A keychain-backed store can replace this behind the
// same two methods.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface StoredSecret {
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretStore {
  read(): Record<string, StoredSecret>;
  write(secrets: Record<string, StoredSecret>): void;
}

/** Writes JSON to a temp file with mode 600 and renames it over `file`, so a reader never sees half a file. */
export function writeJson600(file: string, doc: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function createFileSecretStore(file: string): SecretStore {
  return {
    read() {
      if (!existsSync(file)) return Object.create(null);
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        // Never echo file content: it holds secrets.
        throw new Error(`${file} is not valid JSON`);
      }
      const secrets = (doc as { secrets?: unknown } | null)?.secrets;
      if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) throw new Error(`${file} has no secrets map`);
      const out: Record<string, StoredSecret> = Object.create(null);
      for (const [name, entry] of Object.entries(secrets)) {
        const e = entry as Partial<StoredSecret> | null;
        if (!e || typeof e.value !== "string" || typeof e.createdAt !== "string" || typeof e.updatedAt !== "string") {
          throw new Error(`${file} entry ${JSON.stringify(name.slice(0, 64))} is malformed`);
        }
        out[name] = { value: e.value, createdAt: e.createdAt, updatedAt: e.updatedAt };
      }
      return out;
    },
    write(secrets) {
      writeJson600(file, { version: 1, secrets });
    },
  };
}
