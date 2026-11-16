// Which port this home's core is on, or should be started on (docs/contracts.md#desktop-shell).
// 1. <home>/runtime.json names a port that answers with our instance id: attach there.
// 2. The channel's port: ours → attach, free → spawn there.
// 3. Taken (another program, or another home's core): spawn on a free port the OS hands out.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { ProbeResult } from "./health.ts";

export type PortPlan = { action: "attach" | "spawn"; port: number; moved: boolean };

export interface PlanInput {
  preferred: number;
  /** The port from <home>/runtime.json, if any. */
  recorded: number | null;
  probe: (port: number) => Promise<ProbeResult>;
  freePort: () => Promise<number>;
}

export async function planPort({ preferred, recorded, probe, freePort }: PlanInput): Promise<PortPlan> {
  if (recorded && recorded !== preferred && (await probe(recorded)) === "odin") return { action: "attach", port: recorded, moved: true };
  const result = await probe(preferred);
  if (result === "odin") return { action: "attach", port: preferred, moved: false };
  if (result === "free") return { action: "spawn", port: preferred, moved: false };
  return { action: "spawn", port: await freePort(), moved: true };
}

/** A port nothing is listening on right now (127.0.0.1, OS-assigned). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error("no port assigned"))));
    });
  });
}

/** The port in <home>/runtime.json, or null. */
export function recordedPort(home: string): number | null {
  try {
    const port = (JSON.parse(readFileSync(join(home, "runtime.json"), "utf8")) as { port?: unknown }).port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

/** <home>/instance, created if missing (core does the same; whichever writes first wins). */
export function homeInstance(home: string): string {
  const file = join(home, "instance");
  const read = () => {
    try {
      const id = readFileSync(file, "utf8").trim();
      return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
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
