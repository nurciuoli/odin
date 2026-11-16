// Probing the core port: is a Odin core there, nothing, or something else? (docs/desktop.md#core-lifecycle)
import { request } from "node:http";

/** "foreign": an Odin core for a different home (its instance id is not the one asked for). */
export type ProbeResult = "odin" | "foreign" | "free" | "other";

export interface Health {
  ok: true;
  app: "odin";
  version: string;
  /** The core's home id (<home>/instance). Older cores leave it out. */
  instance?: string;
  now: string;
}

export function isOdinHealth(body: unknown): body is Health {
  return !!body && typeof body === "object" && (body as { app?: unknown }).app === "odin";
}

/**
 * One GET /api/health. Connection refused means the port is free; any other answer that is not Odin is "other".
 * With `instance`, an Odin core reporting a different id is "foreign"; one reporting none (an older core) counts as ours.
 */
export function probe(port: number, opts: { instance?: string; host?: string; timeoutMs?: number } = {}): Promise<ProbeResult> {
  const { instance, host = "127.0.0.1", timeoutMs = 1500 } = opts;
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ProbeResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = request({ host, port, path: "/api/health", method: "GET", timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024) req.destroy();
      });
      res.on("end", () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200 || !isOdinHealth(body)) return done("other");
          done(instance && body.instance && body.instance !== instance ? "foreign" : "odin");
        } catch {
          done("other");
        }
      });
      res.on("error", () => done("other"));
    });
    req.on("timeout", () => {
      req.destroy();
      done("other");
    });
    req.on("error", (err: NodeJS.ErrnoException) => done(err.code === "ECONNREFUSED" ? "free" : "other"));
    req.end();
  });
}

export type StartDecision = "attach" | "spawn" | "port-taken";

export function decide(result: ProbeResult): StartDecision {
  return result === "odin" ? "attach" : result === "free" ? "spawn" : "port-taken";
}

/** Probes one port with this home's instance id, for checks repeated against the same core. */
export function prober(instance: string) {
  return (port: number) => probe(port, { instance });
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Polls until a Odin core answers or the timeout passes (20 s by default). */
export async function waitForHealth(
  check: () => Promise<ProbeResult>,
  opts: { timeoutMs?: number; intervalMs?: number; clock?: Clock; abort?: () => boolean } = {},
): Promise<boolean> {
  const { timeoutMs = 20_000, intervalMs = 250, clock = realClock, abort } = opts;
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    if (abort?.()) return false;
    if ((await check()) === "odin") return true;
    if (clock.now() + intervalMs > deadline) return false;
    await clock.sleep(intervalMs);
  }
}
