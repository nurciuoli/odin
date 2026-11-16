// The shell's own subscription to GET /api/events: a small SSE client that reconnects (with backoff, and when nothing
// arrives for STALE_MS) and calls `onOpen` on every (re)connect so the caller re-seeds from REST.
import { get as httpGet, type ClientRequest } from "node:http";

export const STALE_MS = 45_000;

/** Splits an SSE byte stream into `data` payloads, one per frame. Comments and `retry:` lines are ignored. */
export function sseParser(onData: (data: string) => void) {
  let buf = "";
  return (chunk: string) => {
    buf += chunk.replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""));
      if (data.length) onData(data.join("\n"));
    }
  };
}

export interface EventClientOptions {
  url: string;
  onOpen(): void;
  onEvent(event: { type: string; [k: string]: unknown }): void;
  log?(msg: string): void;
}

export function eventClient(opts: EventClientOptions) {
  let req: ClientRequest | null = null;
  let retryTimer: NodeJS.Timeout | undefined;
  let staleTimer: NodeJS.Timeout | undefined;
  let attempt = 0;
  let stopped = true;

  const schedule = () => {
    if (stopped) return;
    clearTimeout(retryTimer);
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5));
    retryTimer = setTimeout(connect, delay);
  };
  const touch = () => {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      opts.log?.("event stream stale; reconnecting");
      req?.destroy();
    }, STALE_MS);
  };

  function connect() {
    if (stopped) return;
    const r = httpGet(opts.url, { headers: { accept: "text/event-stream" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        r.destroy();
        return;
      }
      attempt = 0;
      res.setEncoding("utf8");
      touch();
      const parse = sseParser((data) => {
        try {
          const ev = JSON.parse(data) as { type?: unknown };
          if (ev && typeof ev.type === "string") opts.onEvent(ev as { type: string });
        } catch {
          // a malformed frame is skipped
        }
      });
      res.on("data", (c: string) => {
        touch();
        parse(c);
      });
      opts.onOpen();
    });
    req = r;
    r.on("error", () => {});
    r.on("close", () => {
      if (req === r) req = null;
      clearTimeout(staleTimer);
      schedule();
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      connect();
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(staleTimer);
      req?.destroy();
      req = null;
    },
  };
}

/** GET a JSON body from core. */
export function getJson(url: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const r = httpGet(url, { timeout: timeoutMs, headers: { accept: "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`GET ${new URL(url).pathname}: ${res.statusCode}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
      res.on("error", reject);
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
  });
}
