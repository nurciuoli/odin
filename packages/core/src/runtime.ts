// <home>/instance and <home>/runtime.json (docs/contracts.md#desktop-shell). The instance id tells a client whether
// the core on a port serves its home; runtime.json says which port that core is on, for hooks and the shell.
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTANCE_FILE, RUNTIME_FILE, type RuntimeInfo } from "@odin/shared";

const ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Reads <home>/instance, creating it on first use. A concurrent creator (the shell) wins and its id is used. */
export function instanceId(home: string): string {
  const file = join(home, INSTANCE_FILE);
  const read = () => {
    try {
      const id = readFileSync(file, "utf8").trim();
      return ID.test(id) ? id : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  const id = randomBytes(12).toString("base64url");
  try {
    writeFileSync(file, id + "\n", { flag: "wx" });
    return id;
  } catch {
    const raced = read();
    if (raced) return raced;
    writeFileSync(file, id + "\n");
    return id;
  }
}

export function writeRuntime(home: string, info: RuntimeInfo): void {
  writeFileSync(join(home, RUNTIME_FILE), JSON.stringify(info) + "\n");
}

export function readRuntime(home: string): RuntimeInfo | null {
  try {
    const v = JSON.parse(readFileSync(join(home, RUNTIME_FILE), "utf8")) as Partial<RuntimeInfo>;
    if (typeof v.port !== "number" || !Number.isInteger(v.port) || v.port <= 0 || v.port > 65535) return null;
    if (typeof v.pid !== "number" || typeof v.instance !== "string") return null;
    return { port: v.port, pid: v.pid, instance: v.instance, startedAt: String(v.startedAt ?? "") };
  } catch {
    return null;
  }
}

/** Removes runtime.json if it still names this process (a newer core may have replaced it). */
export function clearRuntime(home: string, pid: number): void {
  if (readRuntime(home)?.pid === pid) rmSync(join(home, RUNTIME_FILE), { force: true });
}
